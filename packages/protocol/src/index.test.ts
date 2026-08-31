import { describe, expect, it } from "vitest";
import { appProfileSchema, canvasRectSchema, clickRequestSchema, mapRegionDelta, mapRegionPoint, normalizedRegionSchema, pointerControlSchema, pointerGestureSchema, remoteTargetSchema, targetKey } from "./index";

describe("protocol schemas", () => {
  it("rejects click coordinates outside the normalized target", () => {
    expect(clickRequestSchema.safeParse({ x: 1.1, y: 0.5 }).success).toBe(false);
  });

  it("parses a window target and creates a stable key", () => {
    const target = remoteTargetSchema.parse({
      kind: "window",
      id: 42,
      title: "Codex",
      appName: "Codex",
      bundleIdentifier: "com.openai.codex",
      frame: { x: 0, y: 0, width: 1200, height: 800 },
    });

    expect(targetKey(target)).toBe("window:42");
  });

  it("normalizes Swift-omitted optional target fields to null", () => {
    const target = remoteTargetSchema.parse({
      kind: "display",
      id: 1,
      title: "显示器 1",
      frame: { x: 0, y: 0, width: 1728, height: 1117 },
    });

    expect(target.appName).toBeNull();
    expect(target.bundleIdentifier).toBeNull();
  });

  it("accepts persisted app interaction regions", () => {
    const profile = appProfileSchema.parse({
      version: 1,
      appKey: "com.openai.codex",
      appName: "Codex",
      bundleIdentifier: "com.openai.codex",
      regions: [{
        id: "composer", name: "输入区", x: 0.1, y: 0.7, width: 0.8, height: 0.2,
        layout: { x: 0.03, y: 0.55, width: 0.94, height: 0.4 },
      }],
    });
    expect(profile.regions).toHaveLength(1);
    expect(profile.regions[0]?.layout).toEqual({ x: 0.03, y: 0.55, width: 0.94, height: 0.4 });
    expect(profile.regions[0]?.rotation).toBe(0);
  });

  it("keeps old region profiles valid when layout is absent", () => {
    expect(normalizedRegionSchema.parse({
      id: "legacy", name: "旧区域", x: 0, y: 0, width: 1, height: 1,
    }).layout).toBeUndefined();
  });

  it("allows custom layouts outside the initial mobile viewport", () => {
    expect(canvasRectSchema.safeParse({ x: 1.7, y: -0.4, width: 0.8, height: 0.5 }).success).toBe(true);
  });

  it("validates batched pointer gestures", () => {
    expect(pointerGestureSchema.safeParse({
      type: "drag",
      points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }],
      durationMs: 180,
    }).success).toBe(true);
    expect(pointerGestureSchema.safeParse({
      type: "drag",
      points: [{ x: 0.1, y: 0.2 }],
    }).success).toBe(false);
    expect(pointerGestureSchema.parse({
      type: "click",
      x: 0.4,
      y: 0.5,
      clickCount: 2,
    })).toMatchObject({ type: "click", clickCount: 2 });
    expect(pointerGestureSchema.safeParse({
      type: "click",
      x: 0.4,
      y: 0.5,
      clickCount: 3,
    }).success).toBe(false);
  });

  it("validates realtime pointer controls", () => {
    expect(pointerControlSchema.safeParse({ type: "down", button: "left", x: 0.2, y: 0.3 }).success).toBe(true);
    expect(pointerControlSchema.safeParse({ type: "move", x: 0.4, y: 0.5 }).success).toBe(true);
    expect(pointerControlSchema.safeParse({ type: "up", x: 0.4, y: 0.5 }).success).toBe(true);
    expect(pointerControlSchema.parse({ type: "click", x: 0.4, y: 0.5 })).toMatchObject({
      type: "click",
      button: "left",
      clickCount: 1,
    });
  });

  it("rejects a region crossing the app boundary", () => {
    expect(normalizedRegionSchema.safeParse({
      id: "bad",
      name: "越界",
      x: 0.8,
      y: 0,
      width: 0.3,
      height: 0.5,
    }).success).toBe(false);
  });

  it("maps a region-local tap back into app coordinates", () => {
    expect(mapRegionPoint({ x: 0.2, y: 0.6, width: 0.5, height: 0.3 }, 0.4, 0.5)).toEqual({
      x: 0.4,
      y: 0.75,
    });
  });

  it("maps rotated region input back into source coordinates", () => {
    const region = { x: 0.2, y: 0.1, width: 0.4, height: 0.6, rotation: 90 as const };
    const point = mapRegionPoint(region, 0.25, 0.75);
    expect(point.x).toBeCloseTo(0.5);
    expect(point.y).toBeCloseTo(0.55);
    expect(mapRegionDelta(90, 12, 30)).toEqual({ deltaX: 30, deltaY: -12 });
    expect(mapRegionDelta(270, 12, 30)).toEqual({ deltaX: -30, deltaY: 12 });
  });
});
