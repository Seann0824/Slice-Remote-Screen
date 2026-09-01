import { useEffect, useMemo, useState } from "react";
import type { RemoteTarget } from "@slice/protocol";
import { hostApi } from "../api";

export type StreamState = "connecting" | "streaming" | "reconnecting";

class FrameStore {
  readonly canvas = document.createElement("canvas");
  private listeners = new Set<() => void>();
  private decoding = false;
  private pendingFrame: Blob | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  push(frame: Blob, onReady: () => void, onError: (message: string) => void) {
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
  const store = useMemo(() => new FrameStore(), [target?.kind, target?.id]);
  const [state, setState] = useState<StreamState>("connecting");
  const [hasFrame, setHasFrame] = useState(false);

  useEffect(() => {
    setState("connecting");
    setHasFrame(false);
    if (!target) return;
    return hostApi.stream(target, {
      onState: setState,
      onError,
      onFrame: (frame) => store.push(frame, () => setHasFrame(true), onError),
    });
  }, [onError, store, target?.id, target?.kind]);

  return { source: store.canvas, subscribe: store.subscribe, state, hasFrame };
}
