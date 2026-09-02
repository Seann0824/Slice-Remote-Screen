export type RemoteInteractionMode = "touch" | "mouse";

export type ViewportTransform = {
  x: number;
  y: number;
  zoom: number;
};

export type ClientRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type RemotePoint = { x: number; y: number };

export const DEFAULT_VIEWPORT: ViewportTransform = { x: 0, y: 0, zoom: 1 };
export const MIN_VIEWPORT_ZOOM = 1;
export const MAX_VIEWPORT_ZOOM = 4;

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function zoomViewportAround(
  current: ViewportTransform,
  requestedZoom: number,
  anchor: { x: number; y: number },
  transformedRect: ClientRect,
): ViewportTransform {
  const zoom = clamp(requestedZoom, MIN_VIEWPORT_ZOOM, MAX_VIEWPORT_ZOOM);
  if (zoom === current.zoom || transformedRect.width <= 0 || transformedRect.height <= 0) {
    return { ...current, zoom };
  }
  const ratio = zoom / current.zoom;
  return {
    zoom,
    x: current.x + anchor.x + (transformedRect.left - anchor.x) * ratio - transformedRect.left,
    y: current.y + anchor.y + (transformedRect.top - anchor.y) * ratio - transformedRect.top,
  };
}

export function moveTrackpadCursor(
  cursor: RemotePoint,
  delta: { x: number; y: number },
  renderedSize: { width: number; height: number },
  sensitivity = 1.35,
): RemotePoint {
  if (renderedSize.width <= 0 || renderedSize.height <= 0) return cursor;
  return {
    x: clamp(cursor.x + delta.x / renderedSize.width * sensitivity, 0, 1),
    y: clamp(cursor.y + delta.y / renderedSize.height * sensitivity, 0, 1),
  };
}

export function filterScrollAxis(deltaX: number, deltaY: number) {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (absX < 0.2 && absY < 0.2) return { deltaX, deltaY };
  if (absY >= absX * 1.6) return { deltaX: 0, deltaY };
  if (absX >= absY * 1.6) return { deltaX, deltaY: 0 };
  return { deltaX, deltaY };
}

export function shouldSuppressSyntheticTouch(
  lastMouse: { at: number; x: number; y: number } | null,
  touch: { at: number; x: number; y: number },
) {
  if (!lastMouse) return false;
  const elapsed = touch.at - lastMouse.at;
  if (elapsed < 0 || elapsed >= 700) return false;
  return Math.hypot(touch.x - lastMouse.x, touch.y - lastMouse.y) < 80;
}

export function touchCenter(points: Iterable<{ clientX: number; clientY: number }>) {
  const values = [...points];
  if (!values.length) return { x: 0, y: 0 };
  const sum = values.reduce((total, point) => ({
    x: total.x + point.clientX,
    y: total.y + point.clientY,
  }), { x: 0, y: 0 });
  return { x: sum.x / values.length, y: sum.y / values.length };
}

export function touchDistance(points: Iterable<{ clientX: number; clientY: number }>) {
  const [first, second] = [...points];
  if (!first || !second) return 1;
  return Math.max(1, Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY));
}
