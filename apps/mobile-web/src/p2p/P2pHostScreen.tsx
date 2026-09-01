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
  Input,
} from "@slice/design-system";
import { CircleAlert, MonitorUp, Unplug } from "lucide-react";
import { hostApi } from "../api";

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

const iceServers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const credentialStorageKey = "shiwen-remote-host-token-v1";

function defaultSignalUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get("server") || "wss://shiwhen.com/api/remote-control/host";
}

function initialCredential() {
  const urlToken = new URL(window.location.href).searchParams.get("token");
  return urlToken || window.localStorage.getItem(credentialStorageKey) || "";
}

export function P2pHostScreen() {
  const [token, setToken] = useState(initialCredential);
  const [savedCredential, setSavedCredential] = useState(initialCredential);
  const [status, setStatus] = useState(
    token ? "正在自动向拾文报到…" : "粘贴一次 Mac 绑定密钥，之后会自动上线",
  );
  const [error, setError] = useState("");
  const [target, setTarget] = useState<RemoteTarget | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const stopFramesRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const connectRef = useRef<(display: RemoteTarget, credential: string) => void>(() => undefined);

  useEffect(() => {
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
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      stopFramesRef.current?.();
      socketRef.current?.close(1000, "Host closed");
      peerRef.current?.close();
    };
  }, []);

  function sendSignal(message: SignalMessage) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }

  async function control(display: RemoteTarget, message: ControlMessage) {
    if (message.type === "gesture") await hostApi.gesture(display, message.value);
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
    const peer = new RTCPeerConnection({ iceServers });
    peerRef.current = peer;
    const stream = canvas.captureStream(15);
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ type: "signal.ice", candidate: event.candidate.toJSON() });
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") setStatus("手机已建立点对点连接");
      if (peer.connectionState === "failed") setError("点对点连接失败");
    };
    peer.ondatachannel = (event) => {
      event.channel.onmessage = (controlEvent) => {
        void control(display, JSON.parse(String(controlEvent.data)) as ControlMessage).catch(
          (reason) => {
            setError(reason instanceof Error ? reason.message : String(reason));
          },
        );
      };
    };
    await peer.setRemoteDescription({ type: "offer", sdp: message.sdp });
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
      setStatus("已向拾文报到，等待手机打开控制页");
    }
    if (message.type === "peer.ready") setStatus("手机已就绪，正在协商连接");
    if (message.type === "peer.left") {
      peerRef.current?.close();
      peerRef.current = null;
      pendingCandidates.current = [];
      setStatus("已向拾文报到，等待手机打开控制页");
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
    canvas.width = Math.max(1, Math.round(display.frame.width));
    canvas.height = Math.max(1, Math.round(display.frame.height));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建画布");
    stopFramesRef.current = hostApi.stream(display, {
      onState: () => undefined,
      onError: setError,
      onFrame: (blob) => {
        void createImageBitmap(blob).then((bitmap) => {
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
        });
      },
    });
  }

  function connect(display: RemoteTarget, credential: string) {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setError("");
    setStatus("正在自动向拾文报到…");
    startFrames(display);
    socketRef.current?.close(1000, "Host reconnecting");
    const socket = new WebSocket(defaultSignalUrl());
    socketRef.current = socket;
    let authenticated = false;
    socket.onopen = () => {
      setStatus("正在验证 Mac 绑定…");
      socket.send(JSON.stringify({ type: "host.auth", token: credential }));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as SignalMessage;
      if (message.type === "host.accepted") authenticated = true;
      void handleSignal(display, message).catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    };
    socket.onerror = () => {
      if (!authenticated) setError("绑定密钥无效或拾文信令服务不可用");
    };
    socket.onclose = (event) => {
      if (socketRef.current !== socket || event.code === 1000) return;
      if (!authenticated) {
        setStatus("绑定失败，请在拾文重新生成 Mac 绑定密钥");
        return;
      }
      setStatus("与拾文断开，正在重连…");
      reconnectTimerRef.current = window.setTimeout(
        () => connectRef.current(display, credential),
        3000,
      );
    };
  }
  connectRef.current = connect;

  useEffect(() => {
    if (target && savedCredential.trim()) {
      connectRef.current(target, savedCredential.trim());
    }
  }, [savedCredential, target]);

  function saveCredential() {
    const credential = token.trim();
    if (!credential) {
      setError("先输入 Mac 绑定密钥");
      return;
    }
    window.localStorage.setItem(credentialStorageKey, credential);
    setToken(credential);
    if (savedCredential === credential && target) {
      connectRef.current(target, credential);
    } else {
      setSavedCredential(credential);
    }
  }

  function clearCredential() {
    window.localStorage.removeItem(credentialStorageKey);
    setToken("");
    setSavedCredential("");
    socketRef.current?.close(1000, "Binding cleared");
    peerRef.current?.close();
    peerRef.current = null;
    setError("");
    setStatus("绑定已清除，请输入新的 Mac 绑定密钥");
  }

  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-5xl gap-5 bg-canvas p-4 md:grid-cols-[0.8fr_1.2fr] md:p-8">
      <Card variant="outlined">
        <CardHeader>
          <MonitorUp className="mb-2 size-8 text-muted" />
          <CardTitle>连接拾文</CardTitle>
          <CardDescription>绑定一次后，这台 Mac 每次启动都会自动上线。</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3 p-5 pt-0">
          <Input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Mac 绑定密钥"
            autoComplete="off"
          />
          <Button onClick={saveCredential} disabled={!target}>
            保存并上线
          </Button>
          {savedCredential ? (
            <Button variant="danger" onClick={clearCredential}>
              <Unplug />
              清除绑定
            </Button>
          ) : null}
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
