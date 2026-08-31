import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import type { CanvasRect, NormalizedRegion, RemoteTarget } from "@slice/protocol";
import { Button, cn } from "@slice/design-system";
import { Crop, LocateFixed, Minus, Plus, Trash2 } from "lucide-react";
import { FULL_REGION, RemoteCanvas, type RemoteInputChannel } from "./remote-canvas";
import { hostApi } from "../api";
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
  const canvasRef = useRef<HTMLDivElement>(null);
  const layoutGestureRef = useRef<LayoutGesture | null>(null);
  const panGestureRef = useRef<PanGesture | null>(null);
  const layoutsRef = useRef<Record<string, CanvasRect>>(resolveLayouts(regions));
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const [layouts, setLayouts] = useState(layoutsRef.current);
  const [camera, setCamera] = useState(cameraRef.current);
  const [activeRegionId, setActiveRegionId] = useState<string | null>(null);
  const [inputChannel, setInputChannel] = useState<RemoteInputChannel | null>(null);

  useEffect(() => {
    const next = resolveLayouts(regions);
    layoutsRef.current = next;
    setLayouts(next);
  }, [regions]);

  useEffect(() => { if (!editing) setActiveRegionId(null); }, [editing]);

  useEffect(() => {
    const channel = hostApi.inputStream(target, onError);
    setInputChannel(channel);
    return () => {
      setInputChannel(null);
      channel.close();
    };
  }, [onError, target]);

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
    if (item && !editing) return;
    if (targetElement.closest("[data-region-action]")) return;
    const regionId = item?.dataset.regionId;
    const layout = regionId ? layoutsRef.current[regionId] : null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

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

  return (
    <div
      ref={canvasRef}
      className={cn(
        "relative touch-none overflow-hidden bg-inset",
        fullScreen ? "h-full min-h-0" : "h-[min(68dvh,44rem)] min-h-[30rem] rounded-sheet",
        editing && "bg-selected",
      )}
      aria-label="区域布局画布"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishGesture(event)}
      onPointerCancel={(event) => finishGesture(event, true)}
      onLostPointerCapture={(event) => finishGesture(event, true)}
      onWheel={handleWheel}
    >
      <div className="pointer-events-none absolute inset-0">
        <RemoteCanvas target={target} stream={stream} region={FULL_REGION} onError={onError} showStatus={false} fillContainer disabled />
      </div>
      <div className="absolute inset-0 origin-top-left" style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})` }}>
        {regions.map((region, index) => {
          const layout = layouts[region.id];
          if (!layout) return null;
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
                left: `${layout.x * 100}%`, top: `${layout.y * 100}%`,
                width: `${layout.width * 100}%`, height: `${layout.height * 100}%`,
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
              />
              <p className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-4rem)] truncate rounded-full bg-overlay/90 px-2 py-1 text-label font-medium text-ink shadow-overlay">{region.name}</p>
              {editing ? (
                <div className="absolute right-2 top-2 flex gap-1" data-region-action>
                  <Button size="icon-sm" variant="secondary" aria-label={`调整${region.name}取景`} onClick={() => onEditCrop(region)}><Crop data-icon="inline-start" /></Button>
                  <Button size="icon-sm" variant="danger" aria-label={`删除${region.name}`} onClick={() => onRemove(region.id)}><Trash2 data-icon="inline-start" /></Button>
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
      <p className={cn(
        "pointer-events-none absolute left-4 max-w-[calc(100%-10rem)] rounded-full bg-overlay/90 px-3 py-1.5 text-xs text-muted shadow-overlay",
        fullScreen ? "bottom-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))]" : "bottom-4",
      )}>
        空白平移 · 区域内直控 · {Math.round(camera.zoom * 100)}%
      </p>
    </div>
  );
}
