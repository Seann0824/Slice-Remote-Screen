import { useCallback, useEffect, useRef, useState, type CompositionEvent, type FormEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { mapRegionDelta, mapRegionPoint, type NormalizedRegion, type PointerControl, type PointerGesture, type RemoteTarget } from "@slice/protocol";
import { Badge, Button, Skeleton, cn } from "@slice/design-system";
import { LocateFixed, Minus, Plus } from "lucide-react";
import { hostApi } from "../api";
import type { RemoteStream } from "./use-remote-stream";

export const FULL_REGION: NormalizedRegion = {
  id: "full", name: "完整画面", x: 0, y: 0, width: 1, height: 1, rotation: 0,
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
  allowMultiTouchScroll?: boolean;
};

export type RemoteInputChannel = ReturnType<typeof hostApi.inputStream>;

type SelectionHandle = "nw" | "ne" | "sw" | "se";
type SelectionGesture = {
  kind: "create" | "move" | "resize";
  handle?: SelectionHandle;
  start: { x: number; y: number };
  initial: NormalizedRegion | null;
};
type SelectionCamera = { x: number; y: number; zoom: number };
type SelectionPan = { pointerId: number; startX: number; startY: number; initial: SelectionCamera };
type SelectionPinch = {
  distance: number;
  anchorX: number;
  anchorY: number;
  surfaceRect: { left: number; top: number; width: number; height: number };
  initial: SelectionCamera;
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
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
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
  allowMultiTouchScroll = true,
}: RemoteCanvasProps) {
  const [isActing, setIsActing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mobileInputRef = useRef<HTMLTextAreaElement>(null);
  const mobilePointerRef = useRef(false);
  const mobileInputProbeTimerRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const textQueueRef = useRef(Promise.resolve());
  const selectionSurfaceRef = useRef<HTMLDivElement>(null);
  const selectionGesture = useRef<SelectionGesture | null>(null);
  const selectionPan = useRef<SelectionPan | null>(null);
  const selectionTouches = useRef(new Map<number, { clientX: number; clientY: number }>());
  const selectionPinch = useRef<SelectionPinch | null>(null);
  const activeSelection = useRef<NormalizedRegion | null>(selection);
  const selectionCameraRef = useRef<SelectionCamera>({ x: 0, y: 0, zoom: 1 });
  const [selectionCamera, setSelectionCamera] = useState(selectionCameraRef.current);
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

  const enqueueText = useCallback((text: string) => {
    if (!text) return;
    textQueueRef.current = textQueueRef.current
      .catch(() => undefined)
      .then(() => hostApi.type(target, text))
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, [onError, target]);

  const enqueueKey = useCallback((key: "enter" | "delete") => {
    textQueueRef.current = textQueueRef.current
      .catch(() => undefined)
      .then(() => hostApi.key(target, { key, modifiers: [] }))
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, [onError, target]);

  const handleInputTarget = useCallback((editable: boolean) => {
    if (mobileInputProbeTimerRef.current !== null) {
      window.clearTimeout(mobileInputProbeTimerRef.current);
      mobileInputProbeTimerRef.current = null;
    }
    if (!editable) {
      mobileInputRef.current?.blur();
      mobilePointerRef.current = false;
      return;
    }
    if (mobilePointerRef.current) {
      // Do not focus the hidden input until the native host confirms that the
      // remote click landed on an editable control. Eager focus opens the
      // virtual keyboard for every canvas tap.
      mobileInputRef.current?.focus({ preventScroll: true });
    }
    mobilePointerRef.current = false;
  }, []);

  useEffect(() => { activeSelection.current = selection; }, [selection]);

  useEffect(() => {
    const resetCamera = { x: 0, y: 0, zoom: 1 };
    selectionCameraRef.current = resetCamera;
    setSelectionCamera(resetCamera);
    selectionGesture.current = null;
    selectionPan.current = null;
    selectionTouches.current.clear();
    selectionPinch.current = null;
  }, [selectionMode, target.id]);

  useEffect(() => () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
    if (realtimeFrameRef.current !== null) window.cancelAnimationFrame(realtimeFrameRef.current);
    if (mobileInputProbeTimerRef.current !== null) window.clearTimeout(mobileInputProbeTimerRef.current);
  }, []);

  useEffect(() => {
    if (inputChannel !== undefined || selectionMode || disabled) return;
    const channel = hostApi.inputStream(target, onError, handleInputTarget);
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
  }, [disabled, handleInputTarget, inputChannel, onError, selectionMode, target]);

  useEffect(() => {
    if (!inputChannel || selectionMode || disabled) return;
    return inputChannel.subscribeInputTarget(handleInputTarget);
  }, [disabled, handleInputTarget, inputChannel, selectionMode]);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas || !stream.source.width || !stream.source.height) return;
      const sx = Math.round(region.x * stream.source.width);
      const sy = Math.round(region.y * stream.source.height);
      const sw = Math.max(1, Math.round(region.width * stream.source.width));
      const sh = Math.max(1, Math.round(region.height * stream.source.height));
      const rotation = region.rotation ?? 0;
      const outputWidth = rotation === 90 || rotation === 270 ? sh : sw;
      const outputHeight = rotation === 90 || rotation === 270 ? sw : sh;
      if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
        canvas.width = outputWidth;
        canvas.height = outputHeight;
      }
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, outputWidth, outputHeight);
      if (rotation === 90) {
        context.translate(outputWidth, 0);
        context.rotate(Math.PI / 2);
      } else if (rotation === 180) {
        context.translate(outputWidth, outputHeight);
        context.rotate(Math.PI);
      } else if (rotation === 270) {
        context.translate(0, outputHeight);
        context.rotate(-Math.PI / 2);
      }
      context.drawImage(stream.source, sx, sy, sw, sh, 0, 0, sw, sh);
    };
    draw();
    return stream.subscribe(draw);
  }, [region.height, region.rotation, region.width, region.x, region.y, stream]);

  const canvasPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const localX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const localY = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    return mapRegionPoint(region, localX, localY);
  };

  const performGesture = (gesture: PointerGesture) => {
    const input = inputChannel ?? inputStreamRef.current;
    if (gesture.type === "click" && input) {
      input.send(gesture);
      return Promise.resolve();
    }
    const mappedGesture = gesture.type === "scroll"
      ? { ...gesture, ...mapRegionDelta(region.rotation ?? 0, gesture.deltaX, gesture.deltaY) }
      : gesture;
    pendingGesturesRef.current += 1;
    setIsActing(true);
    const task = gestureQueueRef.current
      .catch(() => undefined)
      .then(() => hostApi.gesture(target, mappedGesture))
      .catch((error) => onError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        pendingGesturesRef.current -= 1;
        if (pendingGesturesRef.current === 0) setIsActing(false);
      });
    gestureQueueRef.current = task.then(() => undefined);
    return task;
  };

  const currentInputChannel = () => inputChannel ?? inputStreamRef.current;

  const performClick = (
    point: { x: number; y: number },
    button: "left" | "right" | "middle",
    clickCount: 1 | 2,
    probeMobileInput = false,
  ) => {
    const channel = currentInputChannel();
    if (probeMobileInput) {
      mobilePointerRef.current = true;
      if (mobileInputProbeTimerRef.current !== null) window.clearTimeout(mobileInputProbeTimerRef.current);
      mobileInputProbeTimerRef.current = window.setTimeout(() => {
        mobileInputProbeTimerRef.current = null;
        if (!mobilePointerRef.current) return;
        mobilePointerRef.current = false;
        mobileInputRef.current?.blur();
      }, 3_000);
    }
    if (channel) {
      channel.send({ type: "click", button, clickCount, ...point });
      return;
    }
    void performGesture({ type: "click", button, clickCount, ...point });
  };

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

  const updateSelectionCamera = (next: SelectionCamera) => {
    selectionCameraRef.current = next;
    setSelectionCamera(next);
  };

  const zoomSelectionAround = (requestedZoom: number, clientX?: number, clientY?: number) => {
    const surface = selectionSurfaceRef.current;
    const current = selectionCameraRef.current;
    const zoom = Math.min(4, Math.max(1, requestedZoom));
    if (!surface || zoom === current.zoom) return;
    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      updateSelectionCamera({ ...current, zoom });
      return;
    }
    const anchorX = clientX ?? rect.left + rect.width / 2;
    const anchorY = clientY ?? rect.top + rect.height / 2;
    const ratio = zoom / current.zoom;
    updateSelectionCamera({
      zoom,
      x: current.x + (anchorX + (rect.left - anchorX) * ratio - rect.left),
      y: current.y + (anchorY + (rect.top - anchorY) * ratio - rect.top),
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (selectionMode) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      if (event.pointerType === "touch") {
        selectionTouches.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
        if (selectionTouches.current.size >= 2) {
          selectionGesture.current = null;
          selectionPan.current = null;
          const values = [...selectionTouches.current.values()].slice(0, 2);
          const distance = Math.hypot(values[0]!.clientX - values[1]!.clientX, values[0]!.clientY - values[1]!.clientY);
          const centerX = (values[0]!.clientX + values[1]!.clientX) / 2;
          const centerY = (values[0]!.clientY + values[1]!.clientY) / 2;
          const rect = event.currentTarget.getBoundingClientRect();
          selectionPinch.current = {
            distance: Math.max(1, distance),
            anchorX: rect.width > 0 ? (centerX - rect.left) / rect.width : 0.5,
            anchorY: rect.height > 0 ? (centerY - rect.top) / rect.height : 0.5,
            surfaceRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            initial: selectionCameraRef.current,
          };
          return;
        }
      }
      const point = pointInSurface(event);
      const target = event.target as HTMLElement;
      const handle = target.closest<HTMLElement>("[data-selection-handle]")?.dataset.selectionHandle as SelectionHandle | undefined;
      const insideSelection = Boolean(target.closest("[data-selection-box]"));
      if (!handle && !insideSelection && selection) {
        selectionGesture.current = null;
        selectionPan.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          initial: selectionCameraRef.current,
        };
        return;
      }
      selectionGesture.current = {
        kind: handle ? "resize" : insideSelection && selection ? "move" : "create",
        handle,
        start: point,
        initial: selection,
      };
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
        if (!allowMultiTouchScroll) {
          touchScroll.current = null;
          return;
        }
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
      }, 520);
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (selectionMode && event.pointerType === "touch" && selectionTouches.current.has(event.pointerId)) {
      selectionTouches.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (selectionTouches.current.size >= 2 && selectionPinch.current) {
        const values = [...selectionTouches.current.values()].slice(0, 2);
        const distance = Math.hypot(values[0]!.clientX - values[1]!.clientX, values[0]!.clientY - values[1]!.clientY);
        const pinch = selectionPinch.current;
        const centerX = (values[0]!.clientX + values[1]!.clientX) / 2;
        const centerY = (values[0]!.clientY + values[1]!.clientY) / 2;
        const nextZoom = Math.min(4, Math.max(1, pinch.initial.zoom * distance / pinch.distance));
        const ratio = nextZoom / pinch.initial.zoom;
        const nextWidth = pinch.surfaceRect.width * ratio;
        const nextHeight = pinch.surfaceRect.height * ratio;
        const nextLeft = centerX - pinch.anchorX * nextWidth;
        const nextTop = centerY - pinch.anchorY * nextHeight;
        updateSelectionCamera({
          zoom: nextZoom,
          x: pinch.initial.x + nextLeft - pinch.surfaceRect.left,
          y: pinch.initial.y + nextTop - pinch.surfaceRect.top,
        });
        event.preventDefault();
        return;
      }
    }
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
      if (!gesture || gesture.pointerId !== event.pointerId) {
        if (event.pointerType === "mouse" && !disabled && stream.hasFrame) {
          const point = canvasPoint(event.clientX, event.clientY);
          if (point) queueRealtimeMove(point);
        }
        return;
      }
      const point = canvasPoint(event.clientX, event.clientY);
      if (!point) return;
      if (Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) > 7) {
        gesture.moved = true;
        if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
        const input = currentInputChannel();
        if (event.pointerType !== "mouse" && !gesture.longPressed) {
          queueRealtimeMove(point);
        } else if (!gesture.realtimeStarted && input) {
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
    const pan = selectionPan.current;
    if (pan?.pointerId === event.pointerId) {
      updateSelectionCamera({
        ...pan.initial,
        x: pan.initial.x + event.clientX - pan.startX,
        y: pan.initial.y + event.clientY - pan.startY,
      });
      event.preventDefault();
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
        rotation: gesture.initial?.rotation ?? 0,
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
      if (gesture.longPressed && !gesture.moved) {
        if (finalPoint) performClick(finalPoint, "right", 1);
        return;
      }
      if (event.pointerType !== "mouse" && gesture.moved && !gesture.longPressed) {
        if (finalPoint) queueRealtimeMove(finalPoint);
        flushRealtimeMove();
        return;
      }
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
        performClick(
          finalPoint,
          gesture.button,
          isDoubleTap ? 2 : 1,
          event.pointerType === "touch" && gesture.button === "left",
        );
      }
      return;
    }
    if (event.pointerType === "touch") {
      const wasPinching = Boolean(selectionPinch.current);
      selectionTouches.current.delete(event.pointerId);
      if (wasPinching) {
        if (selectionTouches.current.size < 2) selectionPinch.current = null;
        selectionGesture.current = null;
        return;
      }
    }
    if (selectionPan.current?.pointerId === event.pointerId) {
      selectionPan.current = null;
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
    const gesture = selectionGesture.current;
    selectionGesture.current = null;
    selectionPan.current = null;
    selectionTouches.current.clear();
    selectionPinch.current = null;
    if (gesture) {
      activeSelection.current = gesture.initial;
      onSelectionChange?.(gesture.initial);
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (selectionMode) {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        zoomSelectionAround(selectionCameraRef.current.zoom * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
      } else {
        updateSelectionCamera({
          ...selectionCameraRef.current,
          x: selectionCameraRef.current.x - event.deltaX,
          y: selectionCameraRef.current.y - event.deltaY,
        });
      }
      return;
    }
    if (disabled || !stream.hasFrame) return;
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

  const handleMobileInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const inputEvent = event.nativeEvent as InputEvent;
    if (composingRef.current || inputEvent.isComposing) return;
    const inputType = inputEvent.inputType;
    if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
      enqueueKey("delete");
      return;
    }
    if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
      event.currentTarget.value = "";
      enqueueKey("enter");
      return;
    }
    const value = event.currentTarget.value;
    if (!value) return;
    event.currentTarget.value = "";
    enqueueText(value);
  };

  const handleMobileCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    const value = event.currentTarget.value;
    if (!value) return;
    event.currentTarget.value = "";
    enqueueText(value);
  };

  const handleMobileKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.currentTarget.value = "";
    enqueueKey("enter");
  };

  return (
    <div className={cn("flex flex-col", fillViewport ? "h-dvh" : fillContainer ? "h-full" : "gap-2")}>
      <textarea
        ref={mobileInputRef}
        aria-label="远程文本输入"
        autoCapitalize="off"
        autoCorrect="off"
        className="fixed left-0 top-0 z-[-1] h-px w-px resize-none border-0 bg-transparent p-0 text-transparent opacity-0 caret-transparent outline-none"
        inputMode="text"
        onCompositionEnd={handleMobileCompositionEnd}
        onCompositionStart={() => { composingRef.current = true; }}
        onInput={handleMobileInput}
        onKeyDown={handleMobileKeyDown}
        spellCheck={false}
        tabIndex={-1}
      />
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
          ref={selectionSurfaceRef}
          className={cn(
            "relative touch-none",
            fillViewport || fillContainer ? "inline-flex max-h-full max-w-full" : "w-full",
          )}
          style={selectionMode ? {
            transform: `translate3d(${selectionCamera.x}px, ${selectionCamera.y}px, 0) scale(${selectionCamera.zoom})`,
            transformOrigin: "top left",
          } : undefined}
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
            <>
              <div className="pointer-events-none absolute left-0 right-0 top-0 bg-black/75" style={{ height: `${selection.y * 100}%` }} />
              <div
                className="pointer-events-none absolute left-0 bg-black/75"
                style={{ top: `${selection.y * 100}%`, width: `${selection.x * 100}%`, height: `${selection.height * 100}%` }}
              />
              <div
                className="pointer-events-none absolute right-0 bg-black/75"
                style={{
                  top: `${selection.y * 100}%`,
                  width: `${Math.max(0, 1 - selection.x - selection.width) * 100}%`,
                  height: `${selection.height * 100}%`,
                }}
              />
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0 bg-black/75"
                style={{ height: `${Math.max(0, 1 - selection.y - selection.height) * 100}%` }}
              />
              <div
                className="absolute cursor-move border-2 border-primary bg-primary/10"
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
            </>
          ) : null}
        </div>
        {selectionMode ? (
          <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-full border border-white/15 bg-ink/85 p-1 shadow-overlay backdrop-blur" data-canvas-control>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="缩小裁剪画面"
              disabled={selectionCamera.zoom <= 1}
              onClick={() => zoomSelectionAround(selectionCameraRef.current.zoom / 1.25)}
            >
              <Minus className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="重置裁剪画面位置和缩放"
              onClick={() => updateSelectionCamera({ x: 0, y: 0, zoom: 1 })}
            >
              <LocateFixed className="size-4" />
            </Button>
            <span className="min-w-12 text-center text-xs font-medium text-white/80">{Math.round(selectionCamera.zoom * 100)}%</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="放大裁剪画面"
              disabled={selectionCamera.zoom >= 4}
              onClick={() => zoomSelectionAround(selectionCameraRef.current.zoom * 1.25)}
            >
              <Plus className="size-4" />
            </Button>
          </div>
        ) : null}
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
