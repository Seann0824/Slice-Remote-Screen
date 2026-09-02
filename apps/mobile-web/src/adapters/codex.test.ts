import { describe, expect, it } from "vitest";
import type { RemoteTarget } from "@slice/protocol";
import { createDefaultCodexRegions, defaultCodexProfile, isCodexTarget } from "./codex";

const target: RemoteTarget = {
  kind: "window",
  id: 42,
  title: "Codex — project",
  appName: "Codex",
  bundleIdentifier: "com.openai.codex",
  frame: { x: 0, y: 0, width: 1400, height: 900 },
};

describe("Codex adapter", () => {
  it("recognizes packaged and local Codex windows", () => {
    expect(isCodexTarget(target)).toBe(true);
    expect(isCodexTarget({ appName: "Codex Dev", title: "project", bundleIdentifier: null })).toBe(true);
    expect(isCodexTarget({ appName: "Terminal", title: "codex command", bundleIdentifier: null })).toBe(true);
    expect(isCodexTarget({ appName: "Safari", title: "OpenAI", bundleIdentifier: "com.apple.Safari" })).toBe(false);
  });

  it("ships valid, editable regions for a fresh profile", () => {
    const regions = createDefaultCodexRegions();
    expect(new Set(regions.map((region) => region.id)).size).toBe(3);
    expect(regions.every((region) => region.x >= 0 && region.y >= 0
      && region.x + region.width <= 1 && region.y + region.height <= 1)).toBe(true);
    expect(defaultCodexProfile(target).appKey).toBe("com.openai.codex");
  });
});
