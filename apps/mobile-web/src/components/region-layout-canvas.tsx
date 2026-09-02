import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import type { CanvasRect, NormalizedRegion, RemoteTarget } from "@slice/protocol";
import { Button, cn } from "@slice/design-system";
import { ChevronLeft, ChevronRight, Crop, LocateFixed, Maximize2, Minimize2, Minus, Plus, RotateCw, Trash2 } from "lucide-react";
import { RemoteCanvas, type RemoteInputChannel } from "./remote-canvas";
import { useRemoteClient } from "../remote-client-context";
import type { RemoteStream } from "./use-remote-stream";

type Camera = { x: number; y: number; zoom: number };
type LayoutGesture = {
  pointerId: number;
  regionId: string;
  kind: "move" | "resize";
  startX: number;
  startY: number;
  initial: CanvasRect;
};
type PanGesture = { pointerId: number; startX: number; startY: number; initial: Camera };
type PinchGesture = {
  pointerIds: [number, number];
  startDistance: number;
  startCenterX: number;
  startCenterY: number;
  initial: Camera;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createDefaultRegionLayouts(count: number): CanvasRect[] {
  const margin = 0.04;
  const gap = 0.04;
  const width = 0.92;
  const height = count <= 2 ? 0.42 : 0.32;
  return Array.from({ length: count }, (_, index) => ({
    x: margin,
    y: margin + index * (height + gap),
    width,
    height,
  }));
}

function moveLayout(layout: CanvasRect, deltaX: number, deltaY: number): CanvasRect {
  return { ...layout, x: layout.x + deltaX, y: layout.y + deltaY };
}

function resizeLayout(layout: CanvasRect, deltaX: number, deltaY: number): CanvasRect {
  return { ...layout, width: Math.max(0.18, layout.width + deltaX), height: Math.max(0.12, layout.height + deltaY) };
}

function resolveLayouts(regions: NormalizedRegion[]) {
  const defaults = createDefaultRegionLayouts(regions.length);
  return Object.fromEntries(regions.map((region, index) => [region.id, region.layout ?? defaults[index]!])) as Record<string, CanvasRect>;
}

export function RegionLayoutCanvas({
  target, stream, regions, editing, onCommit, onEditCrop, onRemove, onError, fullScreen = false,
}: {
  target: RemoteTarget;
  stream: RemoteStream;
  regions: NormalizedRegion[];
  editing: boolean;
  onCommit: (regions: NormalizedRegion[]) => void;
  onEditCrop: (region: NormalizedRegion) => void;
  onRemove: (regionId: string) => void;
  onError: (message: string) => void;
  fullScreen?: boolean;
}) {
  const remote = useRemoteClient();
  const canvasRef = useRef<HTMLDivElement>(null);
  const layoutGestureRef = useRef<LayoutGesture | null>(null);
  const panGestureRef = useRef<PanGesture | null>(null);
  const pinchGestureRef = useRef<PinchGesture | null>(null);
  const touchPointsRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const layoutsRef = useRef<Record<string, CanvasRect>>(resolveLayouts(regions));
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const [layouts, setLayouts] = useState(layoutsRef.current);
  const [camera, setCamera] = useState(cameraRef.current);
  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);
  const [focusedRegionId, setFocusedRegionId] = useState<string | null>(null);
  const [inputChannel, setInputChannel] = useState<RemoteInputChannel | null>(null);

  useEffect(() => {
    const next = resolveLayouts(regions);
    layoutsRef.current = next;
    setLayouts(next);
  }, [regions]);

  useEffect(() => {
    if (!editing) setActiveRegionId(null);
    if (editing) setFocusedRegionId(null);
  }, [editing]);

  useEffect(() => {
    if (focusedRegionId && !regions.some((region) => region.id === focusedRegionId)) {
      setFocusedRegionId(null);
    }
  }, [focusedRegionId, regions]);

  useEffect(() => {
    const channel = remote.inputStream(target, onError);
    setInputChannel(channel);
    return () => {
      setInputChannel(null);
      channel.close();
    };
  }, [onError, remote, target]);

  const updateLayouts = (next: Record<string, CanvasRect>) => {
    layoutsRef.current = next;
    setLayouts(next);
  };
  const updateCamera = (next: Camera) => {
    cameraRef.current = next;
    setCamera(next);
  };
  const zoomAround = (nextZoom: number, clientX?: number, clientY?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const zoom = clamp(nextZoom, 0.45, 2.5);
    const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const current = cameraRef.current;
    const ratio = zoom / current.zoom;
    updateCamera({ zoom, x: anchorX - (anchorX - current.x) * ratio, y: anchorY - (anchorY - current.y) * ratio });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-canvas-control]")) return;
    const targetElement = event.target as HTMLElement;
    const item = targetElement.closest<HTMLElement>("[data-region-id]");
    const regionId = item?.dataset.regionId;
    const layout = regionId ? layoutsRef.current[regionId] : null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    if (event.pointerType === "touch") {
      touchPointsRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (touchPointsRef.current.size === 2 && !focusedRegionId) {
        const entries = [...touchPointsRef.current.entries()] as [[number, { clientX: number; clientY: number }], [number, { clientX: number; clientY: number }]];
        const [[firstId, first], [secondId, second]] = entries;
        pinchGestureRef.current = {
          pointerIds: [firstId, secondId],
          startDistance: Math.max(1, Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)),
          startCenterX: (first.clientX + second.clientX) / 2 - rect.left,
          startCenterY: (first.clientY + second.clientY) / 2 - rect.top,
          initial: cameraRef.current,
        };
        layoutGestureRef.current = null;
        panGestureRef.current = null;
        for (const pointerId of [firstId, secondId]) {
          try { canvas.setPointerCapture(pointerId); } catch { /* Pointer may have ended between events. */ }
        }
        event.preventDefault();
        return;
      }
    }

    if (item && !editing) return;
    if (targetElement.closest("[data-region-action]")) return;

    if (editing && regionId && layout) {
      layoutGestureRef.current = {
        pointerId: event.pointerId,
        regionId,
        kind: targetElement.closest("[data-layout-handle]") ? "resize" : "move",
        startX: (event.clientX - rect.left) / (rect.width * cameraRef.current.zoom),
        startY: (event.clientY - rect.top) / (rect.height * cameraRef.current.zoom),
        initial: layout,
      };
      setActiveRegionId(regionId);
    } else {
      panGestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, initial: cameraRef.current };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (event.pointerType === "touch" && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    }
    const pinchGesture = pinchGestureRef.current;
    if (pinchGesture) {
      const first = touchPointsRef.current.get(pinchGesture.pointerIds[0]);
      const second = touchPointsRef.current.get(pinchGesture.pointerIds[1]);
      if (first && second) {
        const rect = canvas.getBoundingClientRect();
        const distance = Math.max(1, Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY));
        const zoom = clamp(pinchGesture.initial.zoom * distance / pinchGesture.startDistance, 0.45, 2.5);
        const ratio = zoom / pinchGesture.initial.zoom;
        const centerX = (first.clientX + second.clientX) / 2 - rect.left;
        const centerY = (first.clientY + second.clientY) / 2 - rect.top;
        updateCamera({
          zoom,
          x: centerX - (pinchGesture.startCenterX - pinchGesture.initial.x) * ratio,
          y: centerY - (pinchGesture.startCenterY - pinchGesture.initial.y) * ratio,
        });
      }
      event.preventDefault();
      return;
    }
    const layoutGesture = layoutGestureRef.current;
    if (layoutGesture?.pointerId === event.pointerId) {
      const rect = canvas.getBoundingClientRect();
      const currentX = (event.clientX - rect.left) / (rect.width * cameraRef.current.zoom);
      const currentY = (event.clientY - rect.top) / (rect.height * cameraRef.current.zoom);
      const deltaX = currentX - layoutGesture.startX;
      const deltaY = currentY - layoutGesture.startY;
      const nextLayout = layoutGesture.kind === "move"
        ? moveLayout(layoutGesture.initial, deltaX, deltaY)
        : resizeLayout(layoutGesture.initial, deltaX, deltaY);
      updateLayouts({ ...layoutsRef.current, [layoutGesture.regionId]: nextLayout });
      return;
    }
    const panGesture = panGestureRef.current;
    if (panGesture?.pointerId === event.pointerId) {
      updateCamera({
        ...panGesture.initial,
        x: panGesture.initial.x + event.clientX - panGesture.startX,
        y: panGesture.initial.y + event.clientY - panGesture.startY,
      });
    }
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    touchPointsRef.current.delete(event.pointerId);
    if (pinchGestureRef.current?.pointerIds.includes(event.pointerId)) {
      pinchGestureRef.current = null;
      layoutGestureRef.current = null;
      panGestureRef.current = null;
      return;
    }
    const layoutGesture = layoutGestureRef.current;
    if (layoutGesture?.pointerId === event.pointerId) {
      layoutGestureRef.current = null;
      if (cancelled) updateLayouts({ ...layoutsRef.current, [layoutGesture.regionId]: layoutGesture.initial });
      else onCommit(regions.map((region) => ({ ...region, layout: layoutsRef.current[region.id] })));
    }
    if (panGestureRef.current?.pointerId === event.pointerId) panGestureRef.current = null;
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAround(cameraRef.current.zoom * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    } else {
      updateCamera({ ...cameraRef.current, x: cameraRef.current.x - event.deltaX, y: cameraRef.current.y - event.deltaY });
    }
  };

  const focusRegion = (regionId: string | null) => {
    setFocusedRegionId(regionId);
    updateCamera({ x: 0, y: 0, zoom: 1 });
  };

  const switchFocusedRegion = (offset: number) => {
    if (!focusedRegionId || regions.length < 2) return;
    const currentIndex = regions.findIndex((region) => region.id === focusedRegionId);
    const nextIndex = (currentIndex + offset + regions.length) % regions.length;
    focusRegion(regions[nextIndex]!.id);
  };

  const rotateRegion = (regionId: string) => {
    onCommit(regions.map((region) => region.id === regionId
      ? { ...region, rotation: (((region.rotation ?? 0) + 90) % 360) as 0 | 90 | 180 | 270 }
      : region));
  };

  const visibleRegions = focusedRegionId
    ? regions.filter((region) => region.id === focusedRegionId)
    : regions;

  return (
    <div
      ref={canvasRef}
      className={cn(
        "relative touch-none overflow-hidden bg-inset",
        fullScreen ? "h-full min-h-0" : "h-[min(68dvh,44rem)] min-h-[30rem] rounded-sheet",
        editing && "bg-selected",
      )}
      aria-label="区域布局画布"
      tabIndex={focusedRegionId ? 0 : undefined}
      onKeyDown={(event) => {
        if (!focusedRegionId || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        switchFocusedRegion(event.key === "ArrowLeft" ? -1 : 1);
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishGesture(event)}
      onPointerCancel={(event) => finishGesture(event, true)}
      onLostPointerCapture={(event) => finishGesture(event, true)}
      onWheel={handleWheel}
    >
      <div className="absolute inset-0 origin-top-left" style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})` }}>
        {visibleRegions.map((region, index) => {
          const layout = layouts[region.id];
          if (!layout) return null;
          const displayLayout = focusedRegionId
            ? { x: 0.02, y: 0.02, width: 0.96, height: 0.86 }
            : layout;
          return (
            <section
              key={region.id}
              className={cn(
                "absolute overflow-hidden rounded-card border border-line-strong bg-ink shadow-overlay",
                editing && "cursor-move ring-2 ring-transparent",
                activeRegionId === region.id && "ring-primary",
              )}
              data-region-id={region.id}
              aria-label={`${region.name} 布局区域`}
              style={{
                left: `${displayLayout.x * 100}%`, top: `${displayLayout.y * 100}%`,
                width: `${displayLayout.width * 100}%`, height: `${displayLayout.height * 100}%`,
                zIndex: activeRegionId === region.id ? regions.length + 1 : index + 1,
              }}
            >
              <RemoteCanvas
                target={target}
                stream={stream}
                region={region}
                onError={onError}
                showStatus={false}
                fillContainer
                disabled={editing}
                inputChannel={inputChannel}
                allowMultiTouchScroll={Boolean(focusedRegionId)}
              />
              <p className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-7rem)] truncate rounded-full bg-overlay/90 px-2 py-1 text-label font-medium text-ink shadow-overlay">{region.name}</p>
              {editing ? (
                <div className="absolute right-2 top-2 flex gap-1" data-region-action>
                  <Button size="icon-sm" variant="secondary" aria-label={`旋转${region.name}`} onClick={() => rotateRegion(region.id)}><RotateCw data-icon="inline-start" /></Button>
                  <Button size="icon-sm" variant="secondary" aria-label={`调整${region.name}取景`} onClick={() => onEditCrop(region)}><Crop data-icon="inline-start" /></Button>
                  <Button size="icon-sm" variant="danger" aria-label={`删除${region.name}`} onClick={() => onRemove(region.id)}><Trash2 data-icon="inline-start" /></Button>
                </div>
              ) : null}
              {!editing ? (
                <div className="absolute right-2 top-2 flex gap-1" data-region-action>
                  <Button size="icon-sm" variant="secondary" aria-label={`旋转${region.name}`} onClick={() => rotateRegion(region.id)}><RotateCw /></Button>
                  <Button
                    size="icon-sm"
                    variant="secondary"
                    aria-label={focusedRegionId ? `退出${region.name}聚焦` : `聚焦${region.name}`}
                    onClick={() => focusRegion(focusedRegionId ? null : region.id)}
                  >
                    {focusedRegionId ? <Minimize2 /> : <Maximize2 />}
                  </Button>
                </div>
              ) : null}
              {editing ? (
                <button type="button" className="absolute bottom-0 right-0 grid size-11 cursor-nwse-resize place-items-end rounded-tl-control bg-overlay/90 p-2" data-layout-handle aria-label={`调整${region.name}显示大小`}>
                  <span className="size-4 border-b-2 border-r-2 border-ink" aria-hidden="true" />
                </button>
              ) : null}
            </section>
          );
        })}
      </div>
      {focusedRegionId ? (
        <div
          className="absolute left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-1 rounded-control bg-overlay/95 p-1 shadow-overlay backdrop-blur"
          data-canvas-control
        >
          <Button size="icon-sm" variant="ghost" aria-label="上一个区域" onClick={() => switchFocusedRegion(-1)} disabled={regions.length < 2}><ChevronLeft /></Button>
          <span className="min-w-20 max-w-40 truncate px-2 text-center text-xs font-medium text-ink">
            {regions.findIndex((region) => region.id === focusedRegionId) + 1}/{regions.length} · {regions.find((region) => region.id === focusedRegionId)?.name}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="下一个区域" onClick={() => switchFocusedRegion(1)} disabled={regions.length < 2}><ChevronRight /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="旋转当前区域" onClick={() => rotateRegion(focusedRegionId)}><RotateCw /></Button>
        </div>
      ) : null}
      <div
        className={cn(
          "absolute right-3 flex gap-1 rounded-control bg-overlay/95 p-1 shadow-overlay backdrop-blur",
          fullScreen ? "bottom-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))]" : "bottom-3",
        )}
        data-canvas-control
      >
        <Button size="icon-sm" variant="ghost" aria-label="缩小画布" onClick={() => zoomAround(cameraRef.current.zoom / 1.2)}><Minus /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="重置画布视图" onClick={() => updateCamera({ x: 0, y: 0, zoom: 1 })}><LocateFixed /></Button>
        <Button size="icon-sm" variant="ghost" aria-label="放大画布" onClick={() => zoomAround(cameraRef.current.zoom * 1.2)}><Plus /></Button>
      </div>
    </div>
  );
}
