import { useEffect, useMemo, useState } from "react";
import type { RemoteTarget } from "@slice/protocol";
import { useRemoteClient } from "../remote-client-context";

export type StreamState = "connecting" | "streaming" | "reconnecting";

class FrameStore {
  readonly canvas = document.createElement("canvas");
  private listeners = new Set<() => void>();
  private decoding = false;
  private pendingFrame: Blob | null = null;
  private animationFrame: number | null = null;
  private detachStream: (() => void) | null = null;
  // Native host can expose both a WebRTC video track and a JPEG fallback.
  // Once the video track produces a frame, never let the slower/lower quality
  // fallback overwrite it.
  private videoHasFrame = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  push(frame: Blob, onReady: () => void, onError: (message: string) => void) {
    if (this.videoHasFrame) return;
    this.pendingFrame = frame;
    if (this.decoding) return;
    const nextFrame = this.pendingFrame;
    this.pendingFrame = null;
    if (!nextFrame) return;
    this.decoding = true;
    void createImageBitmap(nextFrame)
      .then((bitmap) => {
        if (
          this.canvas.width !== bitmap.width ||
          this.canvas.height !== bitmap.height
        ) {
          this.canvas.width = bitmap.width;
          this.canvas.height = bitmap.height;
        }
        if (this.videoHasFrame) {
          bitmap.close();
          return;
        }
        this.canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0);
        bitmap.close();
        onReady();
        this.listeners.forEach((listener) => listener());
      })
      .catch((error) =>
        onError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        this.decoding = false;
        const pendingFrame = this.pendingFrame;
        if (pendingFrame) this.push(pendingFrame, onReady, onError);
      });
  }

  attach(stream: MediaStream, onReady: () => void, onError: (message: string) => void) {
    this.detachStream?.();
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    // Safari may not advance a detached WebRTC video element. Keep the
    // decoder attached while the old canvas-based UI consumes its frames.
    Object.assign(video.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
      zIndex: "-1",
    });
    video.srcObject = stream;
    document.body.appendChild(video);
    let stopped = false;
    const reportVideoError = () => {
      if (!stopped) onError("点对点视频轨道无法播放");
    };
    video.addEventListener("error", reportVideoError);
    const draw = () => {
      if (stopped) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight) {
        this.videoHasFrame = true;
        if (this.canvas.width !== video.videoWidth || this.canvas.height !== video.videoHeight) {
          this.canvas.width = video.videoWidth;
          this.canvas.height = video.videoHeight;
        }
        this.canvas.getContext("2d", { alpha: false })?.drawImage(video, 0, 0);
        onReady();
        this.listeners.forEach((listener) => listener());
      }
      this.animationFrame = window.requestAnimationFrame(draw);
    };
    void video.play().catch((error) => onError(error instanceof Error ? error.message : String(error)));
    this.animationFrame = window.requestAnimationFrame(draw);
    const detach = () => {
      stopped = true;
      this.videoHasFrame = false;
      if (this.animationFrame !== null) window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
      video.removeEventListener("error", reportVideoError);
      video.srcObject = null;
      video.remove();
    };
    this.detachStream = detach;
    return detach;
  }

  detach() {
    this.detachStream?.();
    this.detachStream = null;
  }
}

export type RemoteStream = {
  source: HTMLCanvasElement;
  subscribe: (listener: () => void) => () => void;
  state: StreamState;
  hasFrame: boolean;
};

export function useRemoteStream(
  target: RemoteTarget | null,
  onError: (message: string) => void,
): RemoteStream {
  const remote = useRemoteClient();
  const store = useMemo(() => new FrameStore(), [target?.kind, target?.id]);
  const [state, setState] = useState<StreamState>("connecting");
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    setState("connecting");
    setHasFrame(false);
    if (!target) return;
    const stopStream = remote.stream(target, {
      onState: setState,
      onError,
      onFrame: (frame) => store.push(frame, () => setHasFrame(true), onError),
      onStream: (stream) => store.attach(stream, () => setHasFrame(true), onError),
    });
    return () => {
      stopStream();
      store.detach();
    };
  }, [onError, remote, store, target?.id, target?.kind]);

  return { source: store.canvas, subscribe: store.subscribe, state, hasFrame };
}
