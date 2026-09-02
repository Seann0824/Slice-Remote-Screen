import { describe, expect, it } from "vitest";
import {
  filterScrollAxis,
  moveTrackpadCursor,
  shouldSuppressSyntheticTouch,
  zoomViewportAround,
} from "./remote-interaction";

describe("remote interaction math", () => {
  it("keeps the zoom anchor fixed", () => {
    expect(zoomViewportAround(
      { x: 0, y: 0, zoom: 1 },
      2,
      { x: 75, y: 50 },
      { left: 25, top: 20, width: 100, height: 60 },
    )).toEqual({ x: -50, y: -30, zoom: 2 });
  });

  it("moves a trackpad cursor relatively and clamps it", () => {
    expect(moveTrackpadCursor(
      { x: 0.95, y: 0.1 },
      { x: 100, y: -100 },
      { width: 200, height: 200 },
      1,
    )).toEqual({ x: 1, y: 0 });
  });

  it("locks noisy scrolling to its dominant axis", () => {
    expect(filterScrollAxis(2, 20)).toEqual({ deltaX: 0, deltaY: 20 });
    expect(filterScrollAxis(10, 8)).toEqual({ deltaX: 10, deltaY: 8 });
  });

  it("suppresses a nearby synthesized touch after mouse input", () => {
    expect(shouldSuppressSyntheticTouch(
      { at: 1_000, x: 50, y: 50 },
      { at: 1_400, x: 70, y: 60 },
    )).toBe(true);
    expect(shouldSuppressSyntheticTouch(
      { at: 1_000, x: 50, y: 50 },
      { at: 1_800, x: 50, y: 50 },
    )).toBe(false);
  });
});
