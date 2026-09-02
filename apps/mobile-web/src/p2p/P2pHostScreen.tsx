import { useEffect, useRef, useState } from "react";
import type { KeyRequest, PointerGesture, RemoteTarget } from "@slice/protocol";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@slice/design-system";
import { CircleAlert, MonitorUp, Power } from "lucide-react";
import { hostApi } from "../api";
import { loadIceServers, signalingSession, signalingWebSocketUrl } from "./signaling";
import { AccountLoginCard } from "./AccountLoginCard";

type SignalMessage =
  | { type: "host.accepted" }
  | { type: "peer.ready" }
  | { type: "peer.left" }
  | { type: "signal.offer"; sdp: string }
  | { type: "signal.answer"; sdp: string }
  | { type: "signal.ice"; candidate: RTCIceCandidateInit };

type ControlMessage =
  | { type: "gesture"; value: PointerGesture }
  | { type: "type"; text: string }
  | { type: "key"; value: KeyRequest };

const remoteEnabledStorageKey = "slice-remote-screen.remote-enabled-v1";

function initialRemoteEnabled() {
  const stored = window.localStorage.getItem(remoteEnabledStorageKey);
  return stored === null ? true : stored === "true";
}

export function P2pHostScreen() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [remoteEnabled, setRemoteEnabled] = useState(initialRemoteEnabled);
  const [status, setStatus] = useState("正在验证 Slice 账号…");
  const [error, setError] = useState("");
  const [target, setTarget] = useState<RemoteTarget | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const stopFramesRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const connectRef = useRef<
    (display: RemoteTarget) => void
  >(() => undefined);

  function stopRemote(status = "远程控制已关闭") {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    stopFramesRef.current?.();
    stopFramesRef.current = null;
    socketRef.current?.close(1000, "Remote control disabled");
    socketRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidates.current = [];
    setStatus(status);
  }

  useEffect(() => {
    let cancelled = false;
    void signalingSession()
      .then((session) => {
        if (!cancelled) setAuthenticated(Boolean(session));
      })
      .catch((reason) => {
        if (!cancelled) {
          setAuthenticated(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (authenticated !== true) return;
    let cancelled = false;
    void Promise.all([hostApi.permissions(), hostApi.targets()])
      .then(([permissions, targets]) => {
        if (cancelled) return;
        if (!permissions.screenRecording || !permissions.accessibility) {
          throw new Error("Mac 必须授权屏幕录制和辅助功能");
        }
        const display = targets.find((item) => item.kind === "display");
        if (!display) throw new Error("没有找到可共享显示器");
        setTarget(display);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      cancelled = true;
      stopRemote("Host closed");
    };
  }, [authenticated]);

  function sendSignal(message: SignalMessage) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }

  async function control(display: RemoteTarget, message: ControlMessage) {
    if (message.type === "gesture")
      await hostApi.gesture(display, message.value);
    if (message.type === "type") await hostApi.type(display, message.text);
    if (message.type === "key") await hostApi.key(display, message.value);
  }

  async function acceptOffer(
    display: RemoteTarget,
    message: Extract<SignalMessage, { type: "signal.offer" }>,
  ) {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("屏幕画面尚未准备好");
    peerRef.current?.close();
    pendingCandidates.current = [];
    const iceServers = await loadIceServers();
    const peer = new RTCPeerConnection({ iceServers });
    peerRef.current = peer;
    const stream = canvas.captureStream(30);
    const senderUpdates: Promise<void>[] = [];
    for (const track of stream.getTracks()) {
      track.contentHint = "detail";
      const sender = peer.addTrack(track, stream);
      const parameters = sender.getParameters();
      if (parameters.encodings.length) {
        parameters.encodings[0]!.maxBitrate = 12_000_000;
        parameters.encodings[0]!.maxFramerate = 30;
        senderUpdates.push(sender.setParameters(parameters));
      }
    }
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ type: "signal.ice", candidate: event.candidate.toJSON() });
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected")
        setStatus("手机已建立点对点连接");
      if (peer.connectionState === "failed") setError("点对点连接失败");
    };
    peer.ondatachannel = (event) => {
      event.channel.onmessage = (controlEvent) => {
        void control(
          display,
          JSON.parse(String(controlEvent.data)) as ControlMessage,
        ).catch((reason) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      };
    };
    await peer.setRemoteDescription({ type: "offer", sdp: message.sdp });
    await Promise.all(senderUpdates);
    for (const candidate of pendingCandidates.current.splice(0)) {
      await peer.addIceCandidate(candidate);
    }
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    if (!answer.sdp) throw new Error("Mac 无法生成 WebRTC answer");
    sendSignal({ type: "signal.answer", sdp: answer.sdp });
  }

  async function handleSignal(display: RemoteTarget, message: SignalMessage) {
    if (message.type === "host.accepted") {
      setStatus("已连接信令服务，等待手机打开控制页");
    }
    if (message.type === "peer.ready") setStatus("手机已就绪，正在协商连接");
    if (message.type === "peer.left") {
      peerRef.current?.close();
      peerRef.current = null;
      pendingCandidates.current = [];
      setStatus("已连接信令服务，等待手机打开控制页");
    }
    if (message.type === "signal.offer") await acceptOffer(display, message);
    if (message.type === "signal.ice") {
      if (peerRef.current?.remoteDescription) {
        await peerRef.current.addIceCandidate(message.candidate);
      } else {
        pendingCandidates.current.push(message.candidate);
      }
    }
  }

  function startFrames(display: RemoteTarget) {
    if (stopFramesRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("屏幕画面尚未准备好");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建画布");
    const outputCanvas = canvas;
    const outputContext = context;
    let stopped = false;
    let decoding = false;
    let pendingFrame: Blob | null = null;

    async function drawLatestFrame() {
      if (decoding || stopped || !pendingFrame) return;
      const frame = pendingFrame;
      pendingFrame = null;
      decoding = true;
      try {
        const bitmap = await createImageBitmap(frame);
        if (stopped) {
          bitmap.close();
          return;
        }
        if (
          outputCanvas.width !== bitmap.width ||
          outputCanvas.height !== bitmap.height
        ) {
          outputCanvas.width = bitmap.width;
          outputCanvas.height = bitmap.height;
        }
        outputContext.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        decoding = false;
        if (pendingFrame) void drawLatestFrame();
      }
    }

    const stopSource = hostApi.stream(display, {
      onState: () => undefined,
      onError: setError,
      onFrame: (blob) => {
        pendingFrame = blob;
        void drawLatestFrame();
      },
    });
    stopFramesRef.current = () => {
      stopped = true;
      pendingFrame = null;
      stopSource();
    };
  }

  function connect(display: RemoteTarget) {
    if (!remoteEnabled) return;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setError("");
    setStatus("正在连接信令服务…");
    startFrames(display);
    socketRef.current?.close(1000, "Host reconnecting");
    const socket = new WebSocket(signalingWebSocketUrl("host"));
    socketRef.current = socket;
    let authenticated = false;
    socket.onopen = () => {
      setStatus("正在连接 Slice 服务…");
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as SignalMessage;
      if (message.type === "host.accepted") authenticated = true;
      void handleSignal(display, message).catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    };
    socket.onerror = () => {
      if (!authenticated) setError("账号会话无效或信令服务不可用");
    };
    socket.onclose = (event) => {
      if (socketRef.current !== socket || event.code === 1000) return;
      if (!authenticated) {
        setAuthenticated(false);
        setStatus("账号会话已失效，请重新登录");
        return;
      }
      setStatus("与信令服务断开，正在重连…");
      reconnectTimerRef.current = window.setTimeout(
        () => connectRef.current(display),
        3000,
      );
    };
  }
  connectRef.current = connect;

  useEffect(() => {
    if (authenticated !== true) return;
    if (!remoteEnabled) {
      stopRemote();
    } else if (target) {
      connectRef.current(target);
    }
  }, [authenticated, remoteEnabled, target]);

  function toggleRemoteControl() {
    const next = !remoteEnabled;
    window.localStorage.setItem(remoteEnabledStorageKey, String(next));
    setRemoteEnabled(next);
    if (!next) stopRemote();
  }

  if (authenticated === false) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl items-center bg-canvas p-4 sm:p-8">
        <AccountLoginCard onAuthenticated={() => { setError(""); setAuthenticated(true); }} />
      </main>
    );
  }

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-5xl gap-5 bg-canvas p-4 md:grid-cols-[0.8fr_1.2fr] md:p-8">
      <Card variant="outlined">
        <CardHeader>
          <MonitorUp className="mb-2 size-8 text-muted" />
          <CardTitle>连接 Slice 服务</CardTitle>
          <CardDescription>
            登录 Slice 账号后，这台 Mac 会自动上线。
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3 p-5 pt-0">
          <div className="flex items-center justify-between gap-3 rounded-control border border-line bg-inset px-3 py-2">
            <div className="min-w-0">
              <p className="m-0 text-body-sm font-medium">远程控制</p>
              <p className="m-0 text-xs text-muted">
                {remoteEnabled ? "允许手机连接和控制这台 Mac" : "已断开连接，不共享画面和输入"}
              </p>
            </div>
            <Button
              size="sm"
              variant={remoteEnabled ? "primary" : "secondary"}
              aria-pressed={remoteEnabled}
              onClick={toggleRemoteControl}
            >
              <Power data-icon="inline-start" />
              {remoteEnabled ? "已开启" : "已关闭"}
            </Button>
          </div>
          <p className="m-0 text-body-sm text-muted" role="status">
            {status}
          </p>
          {error ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>连接失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </Card>
      <section
        className="min-h-72 overflow-hidden rounded-card bg-ink"
        aria-label="共享的 Mac 画面"
      >
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
      </section>
    </main>
  );
}
