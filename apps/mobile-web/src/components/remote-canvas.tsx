import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { mapRegionPoint, type NormalizedRegion, type PointerControl, type PointerGesture, type RemoteTarget } from "@slice/protocol";
import { Badge, Skeleton, cn } from "@slice/design-system";
import { hostApi } from "../api";
import type { RemoteStream } from "./use-remote-stream";

export const FULL_REGION: NormalizedRegion = {
  id: "full", name: "完整画面", x: 0, y: 0, width: 1, height: 1,
};

type RemoteCanvasProps = {
  target: RemoteTarget;
  stream: RemoteStream;
  region?: NormalizedRegion;
  onError: (message: string) => void;
  selectionMode?: boolean;
  selection?: NormalizedRegion | null;
  onSelectionChange?: (region: NormalizedRegion | null) => void;
  onSelectionComplete?: (region: NormalizedRegion) => void;
  showStatus?: boolean;
  fillViewport?: boolean;
  fillContainer?: boolean;
  disabled?: boolean;
  inputChannel?: RemoteInputChannel | null;
};

export type RemoteInputChannel = ReturnType<typeof hostApi.inputStream>;

type SelectionHandle = "nw" | "ne" | "sw" | "se";
type SelectionGesture = {
  kind: "create" | "move" | "resize";
  handle?: SelectionHandle;
  start: { x: number; y: number };
  initial: NormalizedRegion | null;
};
type RemoteGesture = {
  pointerId: number;
  button: "left" | "right" | "middle";
  startedAt: number;
  startClientX: number;
  startClientY: number;
  points: { x: number; y: number }[];
  moved: boolean;
  longPressed: boolean;
  realtimeStarted: boolean;
};

function pointInSurface(event: PointerEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function moveRegion(region: NormalizedRegion, deltaX: number, deltaY: number): NormalizedRegion {
  return {
    ...region,
    x: Math.min(1 - region.width, Math.max(0, region.x + deltaX)),
    y: Math.min(1 - region.height, Math.max(0, region.y + deltaY)),
  };
}

function resizeRegion(
  region: NormalizedRegion,
  handle: SelectionHandle,
  deltaX: number,
  deltaY: number,
): NormalizedRegion {
  const minimum = 0.03;
  const right = region.x + region.width;
  const bottom = region.y + region.height;
  let x = region.x;
  let y = region.y;
  let nextRight = right;
  let nextBottom = bottom;

  if (handle.includes("w")) x = Math.min(right - minimum, Math.max(0, region.x + deltaX));
  if (handle.includes("e")) nextRight = Math.max(region.x + minimum, Math.min(1, right + deltaX));
  if (handle.includes("n")) y = Math.min(bottom - minimum, Math.max(0, region.y + deltaY));
  if (handle.includes("s")) nextBottom = Math.max(region.y + minimum, Math.min(1, bottom + deltaY));

  return { ...region, x, y, width: nextRight - x, height: nextBottom - y };
}

export function RemoteCanvas({
  target,
  stream,
  region = FULL_REGION,
  onError,
  selectionMode = false,
  selection = null,
  onSelectionChange,
  onSelectionComplete,
  showStatus = true,
  fillViewport = false,
  fillContainer = false,
  disabled = false,
  inputChannel,
}: RemoteCanvasProps) {
  const [isActing, setIsActing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectionGesture = useRef<SelectionGesture | null>(null);
  const activeSelection = useRef<NormalizedRegion | null>(selection);
  const remoteGesture = useRef<RemoteGesture | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const wheelTimer = useRef<number | null>(null);
  const wheelGesture = useRef<{ x: number; y: number; deltaX: number; deltaY: number } | null>(null);
  const inputStreamRef = useRef<ReturnType<typeof hostApi.inputStream> | null>(null);
  const realtimeMoveRef = useRef<PointerControl | null>(null);
  const realtimeFrameRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ at: number; x: number; y: number; button: "left" | "right" | "middle" } | null>(null);
  const touchPoints = useRef(new Map<number, { clientX: number; clientY: number }>());
  const touchScroll = useRef<{ lastX: number; lastY: number; x: number; y: number; deltaX: number; deltaY: number } | null>(null);
  const gestureQueueRef = useRef(Promise.resolve());
  const pendingGesturesRef = useRef(0);

  useEffect(() => { activeSelection.current = selection; }, [selection]);

  useEffect(() => () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
    if (realtimeFrameRef.current !== null) window.cancelAnimationFrame(realtimeFrameRef.current);
  }, []);

  useEffect(() => {
    if (inputChannel !== undefined || selectionMode || disabled) return;
    const channel = hostApi.inputStream(target, onError);
    inputStreamRef.current = channel;
    return () => {
      channel.close();
      if (inputStreamRef.current === channel) inputStreamRef.current = null;
      if (realtimeFrameRef.current !== null) {
        window.cancelAnimationFrame(realtimeFrameRef.current);
        realtimeFrameRef.current = null;
      }
      realtimeMoveRef.current = null;
    };
  }, [disabled, inputChannel, onError, selectionMode, target]);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas || !stream.source.width || !stream.source.height) return;
      const sx = Math.round(region.x * stream.source.width);
      const sy = Math.round(region.y * stream.source.height);
      const sw = Math.max(1, Math.round(region.width * stream.source.width));
      const sh = Math.max(1, Math.round(region.height * stream.source.height));
      if (canvas.width !== sw || canvas.height !== sh) {
        canvas.width = sw;
        canvas.height = sh;
      }
      canvas.getContext("2d", { alpha: false })?.drawImage(stream.source, sx, sy, sw, sh, 0, 0, sw, sh);
    };
    draw();
    return stream.subscribe(draw);
  }, [region.height, region.width, region.x, region.y, stream]);

  const canvasPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const localX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const localY = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return mapRegionPoint(region, localX, localY);
  };

  const performGesture = (gesture: PointerGesture) => {
    pendingGesturesRef.current += 1;
    setIsActing(true);
    const task = gestureQueueRef.current
      .catch(() => undefined)
      .then(() => hostApi.gesture(target, gesture))
      .catch((error) => onError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        pendingGesturesRef.current -= 1;
        if (pendingGesturesRef.current === 0) setIsActing(false);
      });
    gestureQueueRef.current = task.then(() => undefined);
    return task;
  };

  const currentInputChannel = () => inputChannel ?? inputStreamRef.current;

  const flushRealtimeMove = () => {
    const move = realtimeMoveRef.current;
    realtimeMoveRef.current = null;
    if (realtimeFrameRef.current !== null) {
      window.cancelAnimationFrame(realtimeFrameRef.current);
      realtimeFrameRef.current = null;
    }
    if (move) currentInputChannel()?.send(move);
  };

  const queueRealtimeMove = (point: { x: number; y: number }) => {
    realtimeMoveRef.current = { type: "move", ...point };
    if (realtimeFrameRef.current !== null) return;
    realtimeFrameRef.current = window.requestAnimationFrame(() => {
      realtimeFrameRef.current = null;
      const move = realtimeMoveRef.current;
      realtimeMoveRef.current = null;
      if (move) currentInputChannel()?.send(move);
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (selectionMode) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointInSurface(event);
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>("[data-selection-handle]")?.dataset.selectionHandle as SelectionHandle | undefined;
    const insideSelection = Boolean(target.closest("[data-selection-box]"));
    selectionGesture.current = {
      kind: handle ? "resize" : insideSelection && selection ? "move" : "create",
      handle,
      start: point,
      initial: selection,
    };
    if (!handle && !insideSelection) {
      activeSelection.current = null;
      onSelectionChange?.(null);
    }
      return;
    }
    if (disabled || !stream.hasFrame) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch") {
      touchPoints.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (touchPoints.current.size === 2) {
        if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
        const gesture = remoteGesture.current;
        if (gesture?.realtimeStarted) {
          flushRealtimeMove();
          const last = gesture.points.at(-1);
          if (last) currentInputChannel()?.send({ type: "up", ...last });
        }
        remoteGesture.current = null;
        const values = [...touchPoints.current.values()];
        const centerX = (values[0]!.clientX + values[1]!.clientX) / 2;
        const centerY = (values[0]!.clientY + values[1]!.clientY) / 2;
        const point = canvasPoint(centerX, centerY);
        if (point) touchScroll.current = { lastX: centerX, lastY: centerY, x: point.x, y: point.y, deltaX: 0, deltaY: 0 };
        return;
      }
    }

    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    remoteGesture.current = {
      pointerId: event.pointerId,
      button,
      startedAt: event.timeStamp,
      startClientX: event.clientX,
      startClientY: event.clientY,
      points: [point],
      moved: false,
      longPressed: false,
      realtimeStarted: event.pointerType !== "touch" && Boolean(currentInputChannel()),
    };
    if (remoteGesture.current.realtimeStarted) {
      currentInputChannel()?.send({ type: "down", button, ...point });
    }
    if (event.pointerType === "touch" && button === "left") {
      longPressTimer.current = window.setTimeout(() => {
        const gesture = remoteGesture.current;
        if (!gesture || gesture.moved) return;
        gesture.longPressed = true;
        const last = gesture.points.at(-1)!;
        void performGesture({ type: "click", button: "right", clickCount: 1, ...last });
      }, 520);
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!selectionMode && event.pointerType === "touch" && touchPoints.current.has(event.pointerId)) {
      touchPoints.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      const scroll = touchScroll.current;
      if (scroll && touchPoints.current.size >= 2) {
        const values = [...touchPoints.current.values()].slice(0, 2);
        const centerX = (values[0]!.clientX + values[1]!.clientX) / 2;
        const centerY = (values[0]!.clientY + values[1]!.clientY) / 2;
        scroll.deltaX += (scroll.lastX - centerX) * 2;
        scroll.deltaY += (scroll.lastY - centerY) * 2;
        scroll.lastX = centerX;
        scroll.lastY = centerY;
        event.preventDefault();
        return;
      }
    }
    if (!selectionMode) {
      const gesture = remoteGesture.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const point = canvasPoint(event.clientX, event.clientY);
      if (!point) return;
      if (Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) > 7) {
        gesture.moved = true;
        if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
        const input = currentInputChannel();
        if (!gesture.realtimeStarted && !gesture.longPressed && input) {
          const first = gesture.points[0];
          if (first) input.send({ type: "down", button: gesture.button, ...first });
          gesture.realtimeStarted = true;
        }
      }
      const previous = gesture.points.at(-1)!;
      if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.008) {
        gesture.points.push(point);
        if (gesture.realtimeStarted) queueRealtimeMove(point);
      }
      return;
    }
    const gesture = selectionGesture.current;
    if (!selectionMode || !gesture) return;
    const point = pointInSurface(event);
    const deltaX = point.x - gesture.start.x;
    const deltaY = point.y - gesture.start.y;
    let next: NormalizedRegion;

    if (gesture.kind === "move" && gesture.initial) {
      next = moveRegion(gesture.initial, deltaX, deltaY);
    } else if (gesture.kind === "resize" && gesture.initial && gesture.handle) {
      next = resizeRegion(gesture.initial, gesture.handle, deltaX, deltaY);
    } else {
      next = {
        id: gesture.initial?.id ?? "draft",
        name: gesture.initial?.name ?? "新区域",
        layout: gesture.initial?.layout,
        x: Math.min(point.x, gesture.start.x),
        y: Math.min(point.y, gesture.start.y),
        width: Math.abs(point.x - gesture.start.x),
        height: Math.abs(point.y - gesture.start.y),
      };
    }
    activeSelection.current = next;
    onSelectionChange?.(next);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!selectionMode) {
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
      if (event.pointerType === "touch") {
        const wasScrolling = Boolean(touchScroll.current);
        touchPoints.current.delete(event.pointerId);
        if (wasScrolling) {
          const scroll = touchScroll.current;
          if (scroll && touchPoints.current.size < 2) {
            touchScroll.current = null;
            if (Math.abs(scroll.deltaX) + Math.abs(scroll.deltaY) > 3) {
              void performGesture({ type: "scroll", x: scroll.x, y: scroll.y, deltaX: scroll.deltaX, deltaY: scroll.deltaY });
            }
          }
          remoteGesture.current = null;
          return;
        }
      }
      const gesture = remoteGesture.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      remoteGesture.current = null;
      const finalPoint = canvasPoint(event.clientX, event.clientY);
      if (gesture.realtimeStarted) {
        if (finalPoint) {
          const previous = gesture.points.at(-1);
          if (!previous || Math.hypot(finalPoint.x - previous.x, finalPoint.y - previous.y) > 0.001) {
            gesture.points.push(finalPoint);
            queueRealtimeMove(finalPoint);
          }
        }
        flushRealtimeMove();
        const last = finalPoint ?? gesture.points.at(-1);
        if (last) currentInputChannel()?.send({ type: "up", ...last });
        return;
      }
      if (gesture.longPressed) return;
      if (finalPoint && gesture.moved) {
        if (Math.hypot(finalPoint.x - gesture.points.at(-1)!.x, finalPoint.y - gesture.points.at(-1)!.y) > 0.001) {
          gesture.points.push(finalPoint);
        }
        void performGesture({
          type: "drag",
          button: gesture.button,
          points: gesture.points.slice(0, 64),
          durationMs: Math.min(5_000, Math.max(40, Math.round(event.timeStamp - gesture.startedAt))),
        });
      } else if (finalPoint) {
        const lastTap = lastTapRef.current;
        const isDoubleTap = event.pointerType === "touch"
          && gesture.button === "left"
          && lastTap?.button === gesture.button
          && event.timeStamp - lastTap.at <= 360
          && Math.hypot(finalPoint.x - lastTap.x, finalPoint.y - lastTap.y) <= 0.05;
        lastTapRef.current = isDoubleTap ? null : {
          at: event.timeStamp,
          x: finalPoint.x,
          y: finalPoint.y,
          button: gesture.button,
        };
        void performGesture({
          type: "click",
          button: gesture.button,
          clickCount: isDoubleTap ? 2 : 1,
          ...finalPoint,
        });
      }
      return;
    }
    const gesture = selectionGesture.current;
    if (!selectionMode || !gesture) return;
    selectionGesture.current = null;
    const next = activeSelection.current;
    if (!next || next.width < 0.03 || next.height < 0.03) {
      activeSelection.current = gesture.initial;
      onSelectionChange?.(gesture.initial);
      return;
    }
    onSelectionComplete?.(next);
  };

  const handlePointerCancel = () => {
    if (!selectionMode) {
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
      const gesture = remoteGesture.current;
      if (gesture?.realtimeStarted) {
        flushRealtimeMove();
        const last = gesture.points.at(-1);
        if (last) currentInputChannel()?.send({ type: "up", ...last });
      }
      remoteGesture.current = null;
      touchPoints.current.clear();
      touchScroll.current = null;
      return;
    }
    const initial = selectionGesture.current?.initial ?? null;
    selectionGesture.current = null;
    activeSelection.current = initial;
    onSelectionChange?.(initial);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (selectionMode || disabled || !stream.hasFrame) return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    const current = wheelGesture.current ?? { ...point, deltaX: 0, deltaY: 0 };
    current.x = point.x;
    current.y = point.y;
    current.deltaX += event.deltaX;
    current.deltaY += event.deltaY;
    wheelGesture.current = current;
    if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => {
      const gesture = wheelGesture.current;
      wheelGesture.current = null;
      if (gesture) void performGesture({ type: "scroll", ...gesture });
    }, 70);
  };

  return (
    <div className={cn("flex flex-col", fillViewport ? "h-dvh" : fillContainer ? "h-full" : "gap-2")}>
      <div className={cn(
        "relative flex touch-none items-center justify-center overflow-hidden bg-ink",
        fillViewport
          ? "h-dvh min-h-0 rounded-none"
          : fillContainer
            ? "h-full min-h-0 rounded-card"
            : "min-h-44 rounded-card shadow-overlay",
      )}>
        {!stream.hasFrame ? <Skeleton className="absolute inset-0 rounded-none" aria-label="正在连接实时画面" /> : null}
        <div
          className={cn(
            "relative touch-none",
            fillViewport || fillContainer ? "inline-flex max-h-full max-w-full" : "w-full",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`${target.title} · ${region.name}`}
            className={cn(
              selectionMode ? "cursor-crosshair" : disabled ? "cursor-default" : "cursor-pointer",
              fillViewport || fillContainer ? "h-auto max-h-full w-auto max-w-full" : "h-auto w-full",
            )}
          />
          {selection ? (
            <div
              className="absolute cursor-move border-2 border-primary bg-primary/20"
              data-selection-box
              style={{
                left: `${selection.x * 100}%`, top: `${selection.y * 100}%`,
                width: `${selection.width * 100}%`, height: `${selection.height * 100}%`,
              }}
            >
              {([
                ["nw", "-left-5 -top-5 cursor-nwse-resize"],
                ["ne", "-right-5 -top-5 cursor-nesw-resize"],
                ["sw", "-bottom-5 -left-5 cursor-nesw-resize"],
                ["se", "-bottom-5 -right-5 cursor-nwse-resize"],
              ] as const).map(([handle, className]) => (
                <button
                  key={handle}
                  type="button"
                  className={cn("absolute grid size-10 place-items-center rounded-full", className)}
                  data-selection-handle={handle}
                  aria-label={`缩放区域 ${handle}`}
                >
                  <span className="size-3 rounded-full border-2 border-surface bg-primary shadow-overlay" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {isActing ? <div className="pointer-events-none absolute inset-0 bg-ink/10" aria-hidden="true" /> : null}
        {showStatus ? (
          <Badge className="absolute right-2 top-2" variant={stream.state === "streaming" ? "default" : "secondary"}>
            {stream.state === "streaming" ? "实时" : stream.state === "reconnecting" ? "重连" : "连接"}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
