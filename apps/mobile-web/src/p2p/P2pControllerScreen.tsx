import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import type { KeyRequest, PointerGesture } from "@slice/protocol";
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
import {
  ArrowLeft,
  CircleAlert,
  Copy,
  MonitorUp,
  RefreshCw,
  Unplug,
} from "lucide-react";
import {
  loadIceServers,
  signalingHttpUrl,
  signalingToken,
  signalingWebSocketUrl,
} from "./signaling";

type SignalMessage =
  | { type: "peer.ready" }
  | { type: "peer.left" }
  | { type: "signal.answer"; sdp: string }
  | { type: "signal.ice"; candidate: RTCIceCandidateInit };

type ControlMessage =
  | { type: "gesture"; value: PointerGesture }
  | { type: "type"; text: string }
  | { type: "key"; value: KeyRequest };

type HostStatus = {
  device: {
    device_name: string;
    token_prefix: string;
  } | null;
  online: boolean;
};

type HostCredential = {
  device_name: string;
  token: string;
  token_prefix: string;
};

async function jsonRequest<T>(
  path: string,
  csrfToken: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET")
    headers.set("X-CSRF-Token", csrfToken);
  const token = signalingToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(signalingHttpUrl(path), {
    ...init,
    headers,
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function normalizedVideoPoint(
  video: HTMLVideoElement,
  clientX: number,
  clientY: number,
) {
  if (!video.videoWidth || !video.videoHeight) return null;
  const rect = video.getBoundingClientRect();
  const scale = Math.min(
    rect.width / video.videoWidth,
    rect.height / video.videoHeight,
  );
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const x = (clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (clientY - rect.top - (rect.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function ControllerViewport({
  stream,
  sendControl,
  onExit,
}: {
  stream: MediaStream;
  sendControl: (message: ControlMessage) => void;
  onExit: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startedAt: number;
    points: Array<{ x: number; y: number }>;
  } | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  function pointerDown(event: PointerEvent<HTMLVideoElement>) {
    const video = videoRef.current;
    if (!video) return;
    const point = normalizedVideoPoint(video, event.clientX, event.clientY);
    if (!point) return;
    video.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      points: [point],
    };
  }

  function pointerMove(event: PointerEvent<HTMLVideoElement>) {
    const video = videoRef.current;
    const drag = dragRef.current;
    if (!video || !drag || drag.pointerId !== event.pointerId) return;
    const point = normalizedVideoPoint(video, event.clientX, event.clientY);
    if (!point) return;
    const previous = drag.points.at(-1)!;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.004) {
      drag.points.push(point);
      if (drag.points.length > 64) drag.points.splice(1, 1);
    }
  }

  function pointerUp(event: PointerEvent<HTMLVideoElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.points.length > 1) {
      sendControl({
        type: "gesture",
        value: {
          type: "drag",
          button: "left",
          points: drag.points,
          durationMs: Math.max(
            40,
            Math.min(5_000, Math.round(performance.now() - drag.startedAt)),
          ),
        },
      });
    } else {
      sendControl({
        type: "gesture",
        value: {
          type: "click",
          ...drag.points[0]!,
          button: "left",
          clickCount: 1,
        },
      });
    }
  }

  function scroll(event: WheelEvent<HTMLVideoElement>) {
    const video = videoRef.current;
    if (!video) return;
    event.preventDefault();
    const point = normalizedVideoPoint(video, event.clientX, event.clientY);
    if (!point) return;
    sendControl({
      type: "gesture",
      value: {
        type: "scroll",
        ...point,
        deltaX: Math.max(-4_000, Math.min(4_000, event.deltaX)),
        deltaY: Math.max(-4_000, Math.min(4_000, event.deltaY)),
      },
    });
  }

  function sendText() {
    if (!text) return;
    sendControl({ type: "type", text });
    setText("");
  }

  return (
    <main className="fixed inset-0 overflow-hidden bg-ink">
      <video
        ref={videoRef}
        className="h-full w-full touch-none object-contain"
        autoPlay
        muted
        playsInline
        disablePictureInPicture
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onWheel={scroll}
        onContextMenu={(event) => {
          event.preventDefault();
          const video = videoRef.current;
          const point = video
            ? normalizedVideoPoint(video, event.clientX, event.clientY)
            : null;
          if (point) {
            sendControl({
              type: "gesture",
              value: {
                type: "click",
                ...point,
                button: "right",
                clickCount: 1,
              },
            });
          }
        }}
      />
      <Button
        className="absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] bg-black/65 text-white hover:bg-black/80"
        variant="ghost"
        onClick={onExit}
      >
        <ArrowLeft />
        返回首页
      </Button>
      <div className="absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] mx-auto flex max-w-xl gap-2 rounded-sheet border border-white/15 bg-black/65 p-2 shadow-overlay backdrop-blur-xl">
        <Input
          className="min-w-0 flex-1 border-white/15 bg-white/10 text-white placeholder:text-white/50"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") sendText();
          }}
          placeholder="输入到 Mac"
          aria-label="输入到 Mac"
        />
        <Button variant="primary" onClick={sendText}>
          发送
        </Button>
        <Button
          className="text-white hover:bg-white/15"
          variant="ghost"
          onClick={() =>
            sendControl({ type: "key", value: { key: "enter", modifiers: [] } })
          }
        >
          回车
        </Button>
      </div>
    </main>
  );
}

export function P2pControllerScreen() {
  const [csrfToken, setCsrfToken] = useState("");
  const [status, setStatus] = useState<HostStatus>({
    device: null,
    online: false,
  });
  const [credential, setCredential] = useState<HostCredential | null>(null);
  const [message, setMessage] = useState("正在读取 Mac 状态…");
  const [error, setError] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);

  const closePeer = useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidates.current = [];
    setStream(null);
  }, []);

  const startPeer = useCallback(async () => {
    closePeer();
    setError("");
    setMessage("Mac 已上线，正在建立点对点连接…");
    const iceServers = await loadIceServers(signalingToken());
    const peer = new RTCPeerConnection({ iceServers });
    peerRef.current = peer;
    peer.addTransceiver("video", { direction: "recvonly" });
    const channel = peer.createDataChannel("control", { ordered: true });
    channelRef.current = channel;
    channel.onopen = () => setMessage("已连接 Mac · 高清 P2P");
    peer.ontrack = (event) => {
      event.track.contentHint = "detail";
      setStream(event.streams[0] || new MediaStream([event.track]));
    };
    peer.onicecandidate = (event) => {
      if (event.candidate && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({
            type: "signal.ice",
            candidate: event.candidate.toJSON(),
          }),
        );
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") setError("点对点连接失败");
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socketRef.current?.send(
      JSON.stringify({ type: "signal.offer", sdp: offer.sdp }),
    );
  }, [closePeer]);

  const handleSignal = useCallback(
    async (signal: SignalMessage) => {
      if (signal.type === "peer.ready") {
        setStatus((current) => ({ ...current, online: true }));
        await startPeer();
      }
      if (signal.type === "peer.left") {
        closePeer();
        setStatus((current) => ({ ...current, online: false }));
        setMessage("Mac 已离线，等待它重新上线…");
      }
      if (signal.type === "signal.answer" && peerRef.current) {
        await peerRef.current.setRemoteDescription({
          type: "answer",
          sdp: signal.sdp,
        });
        for (const candidate of pendingCandidates.current.splice(0)) {
          await peerRef.current.addIceCandidate(candidate);
        }
      }
      if (signal.type === "signal.ice" && peerRef.current) {
        if (peerRef.current.remoteDescription) {
          await peerRef.current.addIceCandidate(signal.candidate);
        } else {
          pendingCandidates.current.push(signal.candidate);
        }
      }
    },
    [closePeer, startPeer],
  );

  useEffect(() => {
    let cancelled = false;
    void jsonRequest<{ csrf_token: string; user: { role: string } }>(
      "/api/auth/me",
      "",
    )
      .then(async (session) => {
        if (session.user.role !== "admin")
          throw new Error("只有管理员能使用远程控制");
        const nextStatus = await jsonRequest<HostStatus>(
          "/api/device",
          session.csrf_token,
        );
        if (cancelled) return;
        setCsrfToken(session.csrf_token);
        setStatus(nextStatus);
        setMessage(
          nextStatus.online
            ? "Mac 已上线，正在等待信令…"
            : "等待 Mac 自动上线…",
        );
      })
      .catch((reason) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      });

    const socket = new WebSocket(signalingWebSocketUrl("controller"));
    socketRef.current = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "controller.auth", token: signalingToken() }));
    };
    socket.onmessage = (event) => {
      void handleSignal(JSON.parse(String(event.data)) as SignalMessage).catch(
        (reason) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    };
    socket.onerror = () => setError("无法连接信令服务");
    socket.onclose = (event) => {
      if (!cancelled && event.code !== 1000)
        setError("信令连接已关闭，请刷新重试");
    };
    return () => {
      cancelled = true;
      closePeer();
      socket.close(1000, "Controller closed");
      socketRef.current = null;
    };
  }, [closePeer, handleSignal]);

  async function createHost() {
    if (
      status.device &&
      !window.confirm("重新生成后，Mac 上保存的旧密钥立即失效。确定继续？")
    ) {
      return;
    }
    try {
      const nextCredential = await jsonRequest<HostCredential>(
        "/api/device",
        csrfToken,
        { method: "POST", body: JSON.stringify({ device_name: "我的 Mac" }) },
      );
      setCredential(nextCredential);
      setStatus(
        await jsonRequest<HostStatus>("/api/device", csrfToken),
      );
      setMessage("把绑定密钥在 Mac 输入一次，之后它会自动上线。");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function deleteHost() {
    if (!window.confirm("解除后，这台 Mac 将立即离线。确定解除绑定？")) return;
    try {
      await jsonRequest<{ ok: boolean }>(
        "/api/device",
        csrfToken,
        {
          method: "DELETE",
        },
      );
      setCredential(null);
      setStatus({ device: null, online: false });
      closePeer();
      setMessage("Mac 绑定已解除");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function sendControl(control: ControlMessage) {
    if (channelRef.current?.readyState === "open") {
      channelRef.current.send(JSON.stringify(control));
    }
  }

  if (stream) {
    return (
      <ControllerViewport
        stream={stream}
        sendControl={sendControl}
        onExit={() => window.location.assign("/")}
      />
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-5 bg-canvas p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:p-8">
      <Button
        className="self-start"
        variant="ghost"
        onClick={() => window.location.assign("/")}
      >
        <ArrowLeft />
        返回首页
      </Button>
      <Card variant="outlined">
        <CardHeader>
          <MonitorUp className="mb-2 size-8 text-muted" />
          <CardTitle>远程控制 Mac</CardTitle>
          <CardDescription>
            这是独立部署的 Slice 服务；Mac 绑定一次后会自动上线。
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-4 p-5 pt-0">
          {status.device ? (
            <div className="flex items-center gap-3 rounded-card bg-inset p-4">
              <MonitorUp className="size-5 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="m-0 text-body-sm text-ink">
                  {status.device.device_name}
                </p>
                <p className="mt-1 mb-0 font-mono text-xs text-muted">
                  {status.device.token_prefix}…
                </p>
              </div>
              <span className="text-xs text-muted">
                {status.online ? "在线" : "离线"}
              </span>
            </div>
          ) : null}
          {credential ? (
            <div className="rounded-card bg-inset p-4">
              <p className="mt-0 mb-3 text-body-sm text-ink">
                密钥只显示这一次。
              </p>
              <div className="flex items-center gap-3">
                <code className="min-w-0 flex-1 break-all text-xs">
                  {credential.token}
                </code>
                <Button
                  size="icon"
                  variant="secondary"
                  aria-label="复制 Mac 绑定密钥"
                  onClick={() =>
                    void navigator.clipboard.writeText(credential.token)
                  }
                >
                  <Copy />
                </Button>
              </div>
            </div>
          ) : null}
          <p className="m-0 text-body-sm text-muted" role="status">
            {message}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button disabled={!csrfToken} onClick={() => void createHost()}>
              {status.device ? <RefreshCw /> : <MonitorUp />}
              {status.device ? "重新生成绑定密钥" : "生成 Mac 绑定密钥"}
            </Button>
            {status.device ? (
              <Button variant="danger" onClick={() => void deleteHost()}>
                <Unplug />
                解除绑定
              </Button>
            ) : null}
          </div>
          {error ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>连接失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </Card>
    </main>
  );
}
