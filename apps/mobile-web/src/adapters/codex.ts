import { appKey, type AppProfile, type NormalizedRegion, type RemoteTarget } from "@slice/protocol";

/** Stable identifier used by the first-party Codex mobile adapter. */
export const CODEX_ADAPTER_ID = "codex";

/**
 * Codex is currently controlled through its desktop window. Keep detection
 * deliberately fuzzy because the bundle id differs between packaged builds
 * and local development builds.
 */
export function isCodexTarget(target: Pick<RemoteTarget, "appName" | "title" | "bundleIdentifier">) {
  return /codex/i.test(`${target.appName ?? ""} ${target.title} ${target.bundleIdentifier ?? ""}`);
}

export const CODEX_REGION_IDS = {
  sidebar: "codex-sidebar",
  conversation: "codex-conversation",
  composer: "codex-composer",
} as const;

export function createDefaultCodexRegions(): NormalizedRegion[] {
  // These are intentionally broad. The layout editor can refine them for a
  // specific window size, while the adapter still works on a fresh install.
  return [
    {
      id: CODEX_REGION_IDS.sidebar,
      name: "Codex 导航",
      x: 0,
      y: 0,
      width: 0.18,
      height: 1,
      rotation: 0,
      layout: { x: 0, y: 0, width: 0.19, height: 1 },
    },
    {
      id: CODEX_REGION_IDS.conversation,
      name: "Codex 对话",
      x: 0.18,
      y: 0.06,
      width: 0.82,
      height: 0.7,
      rotation: 0,
      layout: { x: 0.2, y: 0.08, width: 0.78, height: 0.64 },
    },
    {
      id: CODEX_REGION_IDS.composer,
      name: "Codex 输入框",
      x: 0.18,
      y: 0.76,
      width: 0.82,
      height: 0.23,
      rotation: 0,
      layout: { x: 0.2, y: 0.75, width: 0.78, height: 0.22 },
    },
  ];
}

export function defaultCodexProfile(target: RemoteTarget): AppProfile {
  return {
    version: 1,
    appKey: appKey(target),
    appName: target.appName || target.title || "Codex",
    bundleIdentifier: target.bundleIdentifier,
    regions: createDefaultCodexRegions(),
  };
}

export function getCodexRegion(regions: NormalizedRegion[], id: string) {
  return regions.find((region) => region.id === id) ?? null;
}
