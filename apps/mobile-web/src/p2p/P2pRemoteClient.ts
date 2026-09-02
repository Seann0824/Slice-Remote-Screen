import type {
  AppProfile,
  HostPermissions,
  InstalledApp,
  KeyRequest,
  PointerControl,
  PointerGesture,
  RemoteTarget,
} from "@slice/protocol";
import { signalingHttpUrl, signalingWebSocketUrl, loadIceServers } from "./signaling";
import {
  readStoredProfile,
  storeProfile,
  type RemoteClient,
  type RemoteInputChannel,
  type RemoteStreamCallbacks,
} from "../remote-client";

type SignalMessage =
  | { type: "host.accepted" }
  | { type: "peer.ready" }
  | { type: "peer.left" }
  | { type: "signal.answer"; sdp: string }
  | { type: "signal.ice"; candidate: RTCIceCandidateInit };

type RpcResponse = {
  type: "rpc.result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type AssetAssembly = {
  count: number;
  chunks: Array<Uint8Array | undefined>;
  received: number;
};

export class P2pRemoteClient implements RemoteClient {
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private frameChannel: RTCDataChannel | null = null;
  private streamValue: MediaStream | null = null;
  private selectedTargetKey: string | null = null;
  private selectionQueue: Promise<void> = Promise.resolve();
  private requestCounter = 0;
  private pending = new Map<string, PendingRequest>();
  private pendingAssets = new Map<string, PendingRequest>();
  private inputTargetListeners = new Set<(editable: boolean) => void>();
  private frameListeners = new Set<(frame: Blob) => void>();
  private frameAssemblies = new Map<number, { count: number; chunks: Array<Uint8Array | undefined>; received: number }>();
  private assetAssemblies = new Map<string, AssetAssembly>();
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private peerReady: Promise<void>;
  private resolvePeerReady!: () => void;
  private rejectPeerReady!: (reason: Error) => void;
  private peerReadySettled = false;
  private streamReady: Promise<MediaStream>;
  private resolveStreamReady!: (stream: MediaStream) => void;
  private closed = false;
  private lastConnectionState = "new";
  private lastIceConnectionState = "new";
  private localCandidateTypes = new Set<string>();

  constructor() {
    this.peerReady = new Promise<void>((resolve, reject) => {
      this.resolvePeerReady = resolve;
      this.rejectPeerReady = reject;
    });
    this.streamReady = new Promise<MediaStream>((resolve) => {
      this.resolveStreamReady = resolve;
    });
  }

  async connect() {
    this.closed = false;
    this.peerReadySettled = false;
    const socket = new WebSocket(signalingWebSocketUrl("controller"));
    this.socket = socket;
    socket.onmessage = (event) => {
      void this.handleSignal(JSON.parse(String(event.data)) as SignalMessage).catch((reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        this.rejectPeerReady(error);
        this.rejectPending(error);
      });
    };
    socket.onerror = () => {
      const error = new Error("无法连接信令服务");
      this.rejectPeerReady(error);
      this.rejectPending(error);
    };
    socket.onclose = () => {
      if (!this.closed) {
        const error = new Error("信令连接已关闭");
        this.rejectPeerReady(error);
        this.rejectPending(error);
      }
    };
    let timeout: number | null = null;
    try {
      await Promise.race([
        this.peerReady,
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error(
            `20 秒内未建立 P2P 控制通道（connection=${this.lastConnectionState}, ice=${this.lastIceConnectionState}, candidates=${[...this.localCandidateTypes].join(",") || "none"}）。请查看 Host 状态。`,
          )), 20_000);
        }),
      ]);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
    }
  }

  close() {
    this.closed = true;
    this.rejectPending(new Error("远程连接已关闭"));
    this.channel?.close();
    this.frameChannel?.close();
    this.peer?.close();
    this.socket?.close(1000, "Controller closed");
    this.channel = null;
    this.frameChannel = null;
    this.peer = null;
    this.socket = null;
    this.streamValue = null;
    this.selectedTargetKey = null;
    this.lastConnectionState = "new";
    this.lastIceConnectionState = "new";
    this.localCandidateTypes.clear();
    this.frameListeners.clear();
    this.frameAssemblies.clear();
    this.assetAssemblies.clear();
  }

  async permissions() {
    return await this.request<HostPermissions>("permissions");
  }

  async requestPermissions() {
    return await this.request<HostPermissions>("request-permissions");
  }

  async targets() {
    return await this.request<RemoteTarget[]>("targets");
  }

  async apps() {
    return await this.request<InstalledApp[]>("apps");
  }

  async launchApp(path: string) {
    await this.request("launch-app", { path });
  }

  async closeApp(path: string) {
    await this.request("close-app", { path });
  }

  async appIcon(bundleIdentifier: string, path?: string) {
    return await this.requestAsset("app-icon", { bundleIdentifier: bundleIdentifier || undefined, path });
  }

  async profile(appKey: string) {
    return readStoredProfile(appKey);
  }

  async saveProfile(profile: AppProfile) {
    storeProfile(profile);
    return profile;
  }

  stream(target: RemoteTarget, callbacks: RemoteStreamCallbacks) {
    let stopped = false;
    let streaming = false;
    const markStreaming = () => {
      if (!streaming) {
        streaming = true;
        callbacks.onState("streaming");
      }
    };
    const onFrame = (frame: Blob) => {
      if (stopped) return;
      callbacks.onFrame(frame);
      markStreaming();
    };
    this.frameListeners.add(onFrame);
    callbacks.onState("connecting");
    void this.selectTarget(target)
      .then(() => {
        if (stopped) return;
        if (this.streamValue) {
          callbacks.onStream(this.streamValue);
          markStreaming();
          return;
        }
        void this.streamReady.then((stream) => {
          if (stopped) return;
          callbacks.onStream(stream);
          markStreaming();
        });
      })
      .catch((reason) => {
        if (!stopped) callbacks.onError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      stopped = true;
      this.frameListeners.delete(onFrame);
    };
  }

  inputStream(target: RemoteTarget, onError: (message: string) => void, onInputTarget?: (editable: boolean) => void): RemoteInputChannel {
    let closed = false;
    const listeners = new Set<(editable: boolean) => void>();
    if (onInputTarget) {
      listeners.add(onInputTarget);
      this.inputTargetListeners.add(onInputTarget);
    }
    void this.selectTarget(target).catch((reason) => {
      if (!closed) onError(reason instanceof Error ? reason.message : String(reason));
    });
    return {
      send: (control) => {
        if (closed) return;
        this.send({ type: "input", control });
      },
      subscribeInputTarget: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => {
        closed = true;
        for (const listener of listeners) this.inputTargetListeners.delete(listener);
        listeners.clear();
      },
    };
  }

  async click(target: RemoteTarget, x: number, y: number) {
    await this.gesture(target, { type: "click", x, y, button: "left", clickCount: 1 });
  }

  async gesture(target: RemoteTarget, gesture: PointerGesture) {
    await this.selectTarget(target);
    await this.request("gesture", { gesture });
  }

  async type(target: RemoteTarget, text: string) {
    await this.selectTarget(target);
    await this.request("type", { text });
  }

  async key(target: RemoteTarget, value: KeyRequest) {
    await this.selectTarget(target);
    await this.request("key", { key: value });
  }

  private async selectTarget(target: RemoteTarget) {
    const targetKey = `${target.kind}:${target.id}`;
    const selection = this.selectionQueue.then(async () => {
      if (this.selectedTargetKey === targetKey) return;
      await this.request("select-target", { kind: target.kind, targetId: target.id });
      this.selectedTargetKey = targetKey;
    });
    // Screen and input hooks mount together. Serializing their requests keeps
    // two identical selections from racing stopCapture/startCapture on macOS.
    this.selectionQueue = selection.catch(() => undefined);
    await selection;
  }

  private async request<T = unknown>(method: string, payload: Record<string, unknown> = {}) {
    await this.peerReady;
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") throw new Error("Mac 尚未建立点对点连接");
    const id = `${Date.now()}-${this.requestCounter++}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`远程操作超时：${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          window.clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          window.clearTimeout(timeout);
          reject(reason);
        },
      });
    });
    channel.send(JSON.stringify({ type: "rpc", id, method, ...payload }));
    return await result as T;
  }

  private async requestAsset(method: string, payload: Record<string, unknown>) {
    await this.peerReady;
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") throw new Error("Mac 尚未建立点对点连接");
    const id = `${Date.now()}-${this.requestCounter++}`;
    const result = new Promise<Blob>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingAssets.delete(id);
        this.assetAssemblies.delete(id);
        reject(new Error(`远程资源超时：${method}`));
      }, 15_000);
      this.pendingAssets.set(id, {
        resolve: (value) => {
          window.clearTimeout(timeout);
          resolve(value as Blob);
        },
        reject: (reason) => {
          window.clearTimeout(timeout);
          reject(reason);
        },
      });
    });
    channel.send(JSON.stringify({ type: "rpc", id, method, binaryAsset: true, ...payload }));
    return await result;
  }

  private send(value: Record<string, unknown>) {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(value));
  }

  private async handleSignal(message: SignalMessage) {
    if (message.type === "peer.ready") {
      await this.startPeer();
      return;
    }
    if (message.type === "peer.left") {
      this.rejectPeerReady(new Error("Mac 已离线"));
      return;
    }
    if (message.type === "signal.answer" && this.peer) {
      await this.peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
      for (const candidate of this.pendingCandidates.splice(0)) await this.peer.addIceCandidate(candidate);
      return;
    }
    if (message.type === "signal.ice" && this.peer) {
      if (this.peer.remoteDescription) await this.peer.addIceCandidate(message.candidate);
      else this.pendingCandidates.push(message.candidate);
    }
  }

  private async startPeer() {
    if (this.peer) return;
    const peer = new RTCPeerConnection({ iceServers: await loadIceServers() });
    this.peer = peer;
    peer.addTransceiver("video", { direction: "recvonly" });
    const channel = peer.createDataChannel("control", { ordered: true });
    this.channel = channel;
    channel.onopen = () => {
      this.peerReadySettled = true;
      this.resolvePeerReady();
    };
    channel.onclose = () => {
      if (!this.closed && !this.peerReadySettled) {
        this.rejectPeerReady(new Error("P2P 控制通道已关闭"));
      }
    };
    channel.onmessage = (event) => this.handleData(JSON.parse(String(event.data)) as RpcResponse);
    const frameChannel = peer.createDataChannel("frames", { ordered: true });
    this.frameChannel = frameChannel;
    frameChannel.binaryType = "arraybuffer";
    frameChannel.onmessage = (event) => {
      void this.handleFrameData(event.data).catch(() => undefined);
    };
    peer.ontrack = (event) => {
      this.streamValue = event.streams[0] || new MediaStream([event.track]);
      this.resolveStreamReady(this.streamValue);
    };
    peer.onicecandidate = (event) => {
      if (event.candidate && this.socket?.readyState === WebSocket.OPEN) {
        const candidateType = event.candidate.candidate.match(/ typ ([a-z]+)/)?.[1];
        if (candidateType) this.localCandidateTypes.add(candidateType);
        this.socket.send(JSON.stringify({ type: "signal.ice", candidate: event.candidate.toJSON() }));
      }
    };
    peer.onconnectionstatechange = () => {
      this.lastConnectionState = peer.connectionState;
      console.info(`[p2p] connectionState=${peer.connectionState}`);
      if (peer.connectionState === "failed") this.rejectPeerReady(new Error("点对点连接失败"));
      if (peer.connectionState === "closed") this.rejectPeerReady(new Error("点对点连接已关闭"));
    };
    peer.oniceconnectionstatechange = () => {
      this.lastIceConnectionState = peer.iceConnectionState;
      console.info(`[p2p] iceConnectionState=${peer.iceConnectionState}`);
      if (peer.iceConnectionState === "failed") {
        this.rejectPeerReady(new Error("ICE 协商失败：当前网络可能阻止了 P2P"));
      }
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    this.socket?.send(JSON.stringify({ type: "signal.offer", sdp: offer.sdp }));
  }

  private handleData(message: RpcResponse) {
    if ((message as unknown as { type?: string }).type === "input-target") {
      const editable = Boolean((message as unknown as { editable?: boolean }).editable);
      this.inputTargetListeners.forEach((listener) => listener(editable));
      return;
    }
    if (message.type !== "rpc.result") return;
    const pending = this.pending.get(message.id);
    if (pending) {
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error || "远程操作失败"));
      return;
    }

    const pendingAsset = this.pendingAssets.get(message.id);
    if (!pendingAsset) return;
    this.pendingAssets.delete(message.id);
    if (!message.ok) {
      pendingAsset.reject(new Error(message.error || "远程资源失败"));
      return;
    }
    // Compatibility with a Host that still returns Base64 JSON icons.
    if (typeof message.value === "string") {
      try {
        const binary = atob(message.value);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        pendingAsset.resolve(new Blob([bytes], { type: "image/png" }));
      } catch {
        pendingAsset.reject(new Error("远程图标数据损坏"));
      }
    } else {
      pendingAsset.reject(new Error("远程图标响应格式错误"));
    }
  }

  private async handleFrameData(value: unknown) {
    const buffer = value instanceof Blob
      ? await value.arrayBuffer()
      : value instanceof ArrayBuffer
        ? value
        : ArrayBuffer.isView(value)
          ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
          : null;
    if (!buffer || buffer.byteLength < 10) return;
    const view = new DataView(buffer);
    const magic = view.getUint32(0);
    if (magic === 0x534c4943) {
      this.handleAssetPacket(buffer, view);
      return;
    }
    if (magic !== 0x534c4652 || buffer.byteLength < 12) return;
    const frameId = view.getUint32(4);
    const chunkIndex = view.getUint16(8);
    const chunkCount = view.getUint16(10);
    if (!chunkCount || chunkIndex >= chunkCount) return;

    let assembly = this.frameAssemblies.get(frameId);
    if (!assembly || assembly.count !== chunkCount) {
      assembly = { count: chunkCount, chunks: new Array(chunkCount), received: 0 };
      this.frameAssemblies.set(frameId, assembly);
    }
    if (!assembly.chunks[chunkIndex]) {
      assembly.chunks[chunkIndex] = new Uint8Array(buffer.slice(12));
      assembly.received += 1;
    }
    if (assembly.received !== assembly.count) return;

    this.frameAssemblies.delete(frameId);
    for (const staleFrameId of this.frameAssemblies.keys()) {
      if (staleFrameId < frameId) this.frameAssemblies.delete(staleFrameId);
    }
    const parts = assembly.chunks.map((chunk) => {
      const copy = new Uint8Array(chunk!.byteLength);
      copy.set(chunk!);
      return copy.buffer;
    });
    const frame = new Blob(parts, { type: "image/jpeg" });
    this.frameListeners.forEach((listener) => listener(frame));
  }

  private handleAssetPacket(buffer: ArrayBufferLike, view: DataView) {
    const idLength = view.getUint16(4);
    const chunkIndex = view.getUint16(6);
    const chunkCount = view.getUint16(8);
    const payloadOffset = 10 + idLength;
    if (!idLength || !chunkCount || chunkIndex >= chunkCount || buffer.byteLength < payloadOffset) return;
    const id = new TextDecoder().decode(buffer.slice(10, payloadOffset));
    if (!this.pendingAssets.has(id)) return;

    let assembly = this.assetAssemblies.get(id);
    if (!assembly || assembly.count !== chunkCount) {
      assembly = { count: chunkCount, chunks: new Array(chunkCount), received: 0 };
      this.assetAssemblies.set(id, assembly);
    }
    if (!assembly.chunks[chunkIndex]) {
      assembly.chunks[chunkIndex] = new Uint8Array(buffer.slice(payloadOffset));
      assembly.received += 1;
    }
    if (assembly.received !== assembly.count) return;

    this.assetAssemblies.delete(id);
    const pending = this.pendingAssets.get(id);
    if (!pending) return;
    this.pendingAssets.delete(id);
    const parts = assembly.chunks.map((chunk) => {
      const copy = new Uint8Array(chunk!.byteLength);
      copy.set(chunk!);
      return copy.buffer;
    });
    pending.resolve(new Blob(parts, { type: "image/png" }));
  }

  private rejectPending(error: Error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const { reject } of this.pendingAssets.values()) reject(error);
    this.pendingAssets.clear();
    this.assetAssemblies.clear();
  }
}
