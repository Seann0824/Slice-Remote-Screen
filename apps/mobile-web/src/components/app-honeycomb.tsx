import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { InstalledApp } from "@slice/protocol";
import { Button, cn } from "@slice/design-system";
import { AppIcon } from "./app-icon";

type Point = { x: number; y: number };
type CameraBounds = { minX: number; maxX: number; minY: number; maxY: number };

type DragState = {
  pointerId: number;
  targetKey: string | null;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  lastTime: number;
  velocityX: number;
  velocityY: number;
  moved: boolean;
};

const ICON_SIZE = 80;
const TAP_SLOP = 12;
const CENTER_SLOP = 18;

const HEX_DIRECTIONS = [
  { q: 1, r: 0, s: -1 },
  { q: 1, r: -1, s: 0 },
  { q: 0, r: -1, s: 1 },
  { q: -1, r: 0, s: 1 },
  { q: -1, r: 1, s: 0 },
  { q: 0, r: 1, s: -1 },
] as const;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const progress = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function addHex(
  left: { q: number; r: number; s: number },
  right: { q: number; r: number; s: number },
) {
  return { q: left.q + right.q, r: left.r + right.r, s: left.s + right.s };
}

function scaleHex(hex: { q: number; r: number; s: number }, scale: number) {
  return { q: hex.q * scale, r: hex.r * scale, s: hex.s * scale };
}

/** Generates a center-first hexagonal spiral using cube coordinates. */
export function createHoneycombPoints(count: number, spacing: number): Point[] {
  if (count <= 0) return [];

  const points: Point[] = [{ x: 0, y: 0 }];
  for (let radius = 1; points.length < count; radius += 1) {
    let hex = scaleHex(HEX_DIRECTIONS[4], radius);
    for (const direction of HEX_DIRECTIONS) {
      for (let step = 0; step < radius && points.length < count; step += 1) {
        points.push({
          x: spacing * (hex.q + hex.r / 2),
          y: spacing * (Math.sqrt(3) / 2) * hex.r,
        });
        hex = addHex(hex, direction);
      }
    }
  }
  return points;
}

export function getHoneycombVisual(
  point: Point,
  camera: Point,
  viewport: { width: number; height: number },
) {
  const offsetX = point.x + camera.x;
  const offsetY = point.y + camera.y;
  const distance = Math.hypot(offsetX, offsetY);
  const focusRadius = Math.max(1, Math.min(viewport.width, viewport.height) * 0.58);
  const focusProgress = clamp(distance / focusRadius, 0, 1);

  const radialFactor = 1 + 0.16 * (1 - focusProgress) ** 2;
  let x = viewport.width / 2 + offsetX * radialFactor;
  let y = viewport.height / 2 + offsetY * radialFactor;
  const edgeDistance = Math.min(x, y, viewport.width - x, viewport.height - y);
  const edgeProgress = smoothstep(-ICON_SIZE * 0.45, ICON_SIZE * 0.72, edgeDistance);

  if (edgeProgress < 1) {
    const edgePull = (1 - edgeProgress) * 0.12;
    x += (viewport.width / 2 - x) * edgePull;
    y += (viewport.height / 2 - y) * edgePull;
  }

  const centerScale = 0.78 + 0.42 * (1 - focusProgress) ** 2;
  const scale = centerScale * (0.5 + 0.5 * edgeProgress);

  return {
    x,
    y,
    scale,
    opacity: smoothstep(-ICON_SIZE * 0.55, ICON_SIZE * 0.32, edgeDistance),
  };
}

function getBounds(points: Point[]): CameraBounds {
  if (!points.length) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: -Math.max(...xs),
    maxX: -Math.min(...xs),
    minY: -Math.max(...ys),
    maxY: -Math.min(...ys),
  };
}

function rubberBand(value: number, minimum: number, maximum: number) {
  const resist = (distance: number) => (distance * 0.34) / (1 + distance / 180);
  if (value < minimum) return minimum - resist(minimum - value);
  if (value > maximum) return maximum + resist(value - maximum);
  return value;
}

function nearestPoint(points: Point[], camera: Point, projection: Point = { x: 0, y: 0 }) {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  const focusX = -(camera.x + projection.x);
  const focusY = -(camera.y + projection.y);

  points.forEach((point, index) => {
    const distance = Math.hypot(point.x - focusX, point.y - focusY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}

function animateIntoApplication(element: HTMLElement, open: () => void) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !element.animate) {
    open();
    return;
  }

  const rect = element.getBoundingClientRect();
  const backdrop = document.createElement("div");
  const clone = element.cloneNode(true) as HTMLElement;
  clone.setAttribute("aria-hidden", "true");
  clone.querySelectorAll<HTMLElement>("button, [tabindex]").forEach((child) => child.setAttribute("tabindex", "-1"));
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    background: "var(--color-ink)",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "2147483645",
  });
  Object.assign(clone.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    opacity: "1",
    pointerEvents: "none",
    transform: "translate3d(0, 0, 0) scale(1)",
    transformOrigin: "center",
    zIndex: "2147483646",
  });
  document.body.append(backdrop, clone);

  const translateX = window.innerWidth / 2 - (rect.left + rect.width / 2);
  const translateY = window.innerHeight / 2 - (rect.top + rect.height / 2);
  const scale = Math.max(window.innerWidth, window.innerHeight) / Math.max(rect.width, rect.height) * 1.15;
  const backdropAnimation = backdrop.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
  );
  const iconAnimation = clone.animate(
    [
      { transform: "translate3d(0, 0, 0) scale(1)", opacity: 1, filter: "blur(0)" },
      {
        transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`,
        opacity: 0,
        filter: "blur(1.5px)",
      },
    ],
    { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
  );
  open();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    backdrop.remove();
    clone.remove();
  };
  window.setTimeout(cleanup, 480);
  void Promise.allSettled([backdropAnimation.finished, iconAnimation.finished]).then(cleanup);
}

export function AppHoneycomb({
  apps,
  onSelect,
}: {
  apps: InstalledApp[];
  onSelect: (app: InstalledApp) => void | Promise<void>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const cameraRef = useRef<Point>({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);
  const wheelTimerRef = useRef<number | null>(null);
  const ignorePointerClickUntilRef = useRef(0);
  const animationRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string | null>(() => apps[0]?.appKey ?? null);

  const spacing = clamp(viewport.width * 0.255, 88, 112);
  const points = useMemo(() => createHoneycombPoints(apps.length, spacing), [spacing, apps.length]);
  const bounds = useMemo(() => getBounds(points), [points]);
  const keys = useMemo<string[]>(() => apps.map((app) => app.appKey), [apps]);
  const targetSignature = keys.join("|");
  const focusedApp = apps.find((app) => app.appKey === focusedKey) ?? apps[0];

  const cancelAnimation = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  }, []);

  const renderScene = useCallback(() => {
    if (!viewport.width || !viewport.height) return;
    points.forEach((point, index) => {
      const key = keys[index];
      if (!key) return;
      const element = itemRefs.current.get(key);
      if (!element) return;
      const visual = getHoneycombVisual(point, cameraRef.current, viewport);
      element.style.transform = `translate3d(${visual.x - ICON_SIZE / 2}px, ${visual.y - ICON_SIZE / 2}px, 0) scale(${visual.scale})`;
      element.style.opacity = String(visual.opacity);
      element.style.pointerEvents = visual.opacity < 0.16 ? "none" : "auto";
      element.style.zIndex = String(Math.round(visual.scale * 100));
    });
  }, [keys, points, viewport]);

  const startSpring = useCallback((target: Point, velocity: Point = { x: 0, y: 0 }) => {
    cancelAnimation();
    const destination = {
      x: clamp(target.x, bounds.minX, bounds.maxX),
      y: clamp(target.y, bounds.minY, bounds.maxY),
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cameraRef.current = destination;
      renderScene();
      return;
    }

    let lastTime = performance.now();
    let velocityX = clamp(velocity.x * 0.45, -1400, 1400);
    let velocityY = clamp(velocity.y * 0.45, -1400, 1400);
    const tick = (now: number) => {
      const elapsed = Math.min((now - lastTime) / 1000, 0.032);
      lastTime = now;
      const camera = cameraRef.current;
      const accelerationX = (destination.x - camera.x) * 180;
      const accelerationY = (destination.y - camera.y) * 180;
      velocityX = (velocityX + accelerationX * elapsed) * Math.exp(-23 * elapsed);
      velocityY = (velocityY + accelerationY * elapsed) * Math.exp(-23 * elapsed);
      camera.x += velocityX * elapsed;
      camera.y += velocityY * elapsed;
      renderScene();

      const settled = Math.hypot(destination.x - camera.x, destination.y - camera.y) < 0.5
        && Math.hypot(velocityX, velocityY) < 6;
      if (settled) {
        cameraRef.current = destination;
        animationRef.current = null;
        renderScene();
        return;
      }
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [bounds, cancelAnimation, renderScene]);

  const focusIndex = useCallback((index: number, velocity: Point = { x: 0, y: 0 }) => {
    const point = points[index];
    const key = keys[index];
    if (!point || !key) return;
    setFocusedKey(key);
    startSpring({ x: -point.x, y: -point.y }, velocity);
  }, [keys, points, startSpring]);

  const snapToNearest = useCallback((velocity: Point = { x: 0, y: 0 }) => {
    if (!points.length) return;
    const projected = {
      x: clamp(velocity.x, -2200, 2200) * 0.16,
      y: clamp(velocity.y, -2200, 2200) * 0.16,
    };
    focusIndex(nearestPoint(points, cameraRef.current, projected), velocity);
  }, [focusIndex, points]);

  const activate = useCallback((key: string) => {
    const index = keys.indexOf(key);
    const point = points[index];
    const app = apps[index];
    if (!point || !app) return;
    const distanceToCenter = Math.hypot(point.x + cameraRef.current.x, point.y + cameraRef.current.y);
    if (distanceToCenter <= CENTER_SLOP) {
      const element = itemRefs.current.get(key);
      if (element) animateIntoApplication(element, () => void onSelect(app));
      else void onSelect(app);
      return;
    }
    focusIndex(index);
  }, [apps, focusIndex, keys, onSelect, points]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0);
      const height = Math.round(entry?.contentRect.height ?? 0);
      setViewport((current) => current.width === width && current.height === height
        ? current
        : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    cancelAnimation();
    cameraRef.current = { x: 0, y: 0 };
    setFocusedKey(keys[0] ?? null);
  }, [cancelAnimation, targetSignature]);

  useLayoutEffect(() => {
    renderScene();
  }, [renderScene, focusedKey]);

  useEffect(() => () => {
    cancelAnimation();
    if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current);
  }, [cancelAnimation]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    cancelAnimation();
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-app-key]");
    dragRef.current = {
      pointerId: event.pointerId,
      targetKey: target?.dataset.appKey ?? null,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocityX: 0,
      velocityY: 0,
      moved: false,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.lastX;
    const deltaY = event.clientY - drag.lastY;
    const elapsed = Math.max((event.timeStamp - drag.lastTime) / 1000, 1 / 240);
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > TAP_SLOP) {
      drag.moved = true;
    }
    if (drag.moved) {
      const instantaneousX = deltaX / elapsed;
      const instantaneousY = deltaY / elapsed;
      drag.velocityX = drag.velocityX * 0.7 + instantaneousX * 0.3;
      drag.velocityY = drag.velocityY * 0.7 + instantaneousY * 0.3;
      cameraRef.current.x = rubberBand(cameraRef.current.x + deltaX, bounds.minX, bounds.maxX);
      cameraRef.current.y = rubberBand(cameraRef.current.y + deltaY, bounds.minY, bounds.maxY);
      renderScene();
    }
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!cancelled && !drag.moved && drag.targetKey) {
      ignorePointerClickUntilRef.current = performance.now() + 500;
      activate(drag.targetKey);
      return;
    }
    snapToNearest(cancelled ? undefined : { x: drag.velocityX, y: drag.velocityY });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    cancelAnimation();
    cameraRef.current.x = rubberBand(cameraRef.current.x - event.deltaX, bounds.minX, bounds.maxX);
    cameraRef.current.y = rubberBand(cameraRef.current.y - event.deltaY, bounds.minY, bounds.maxY);
    renderScene();
    if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = window.setTimeout(() => snapToNearest(), 120);
  };

  return (
    <div className="relative overflow-hidden rounded-sheet bg-inset">
      <div
        ref={viewportRef}
        className={cn(
          "relative h-[min(62dvh,34rem)] min-h-96 touch-none select-none overflow-hidden overscroll-none",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        role="list"
        aria-label="应用蜂窝盘"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onLostPointerCapture={(event) => finishPointer(event, true)}
        onWheel={handleWheel}
      >
        {apps.map((app, index) => {
          const key = keys[index]!;
          const name = app.appName;
          return (
            <div
              key={key}
              ref={(element) => {
                if (element) itemRefs.current.set(key, element);
                else itemRefs.current.delete(key);
              }}
              className="absolute left-0 top-0 size-20 origin-center opacity-0 will-change-transform"
              role="listitem"
            >
              <Button
                className={cn(
                  "size-full rounded-[1.65rem] p-1 transition-none",
                  dragging && "cursor-grabbing",
                  focusedKey === key && "ring-2 ring-ink/25 ring-offset-2 ring-offset-inset",
                )}
                size="icon"
                variant="ghost"
                data-app-key={key}
                aria-label={`${focusedKey === key ? "打开" : "居中"} ${name}`}
                aria-current={focusedKey === key ? "true" : undefined}
                title={name}
                onClick={(event) => {
                  if (event.detail > 0 && performance.now() < ignorePointerClickUntilRef.current) return;
                  activate(key);
                }}
              >
                <AppIcon target={app} className="size-full" />
                {app.isRunning ? (
                  <span
                    className={cn(
                      "absolute bottom-1 right-1 size-3 rounded-full border-2 border-inset bg-primary",
                      !app.hasOpenWindow && "border-primary bg-surface",
                    )}
                    aria-label={app.hasOpenWindow ? "已打开，可立即共享" : "正在后台运行"}
                  />
                ) : null}
              </Button>
            </div>
          );
        })}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
        <p className="max-w-full truncate rounded-full bg-surface/90 px-3 py-1.5 text-xs font-medium text-ink shadow-overlay" aria-live="polite">
          {focusedApp?.appName || "拖动选择应用"}{focusedApp?.isRunning ? " · 运行中" : ""}
        </p>
      </div>
    </div>
  );
}
