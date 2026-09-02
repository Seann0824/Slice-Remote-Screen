import { appKey, appProfileSchema, type NormalizedRegion, type RemoteTarget } from "@slice/protocol";
import type { RemoteClient } from "./remote-client";
import { defaultCodexProfile, isCodexTarget } from "./adapters/codex";

export async function loadProfile(target: RemoteTarget, remote: RemoteClient) {
  const key = appKey(target);
  const stored = await remote.profile(key);
  if (stored) return stored;
  return appProfileSchema.parse(isCodexTarget(target)
    ? defaultCodexProfile(target)
    : {
      version: 1,
      appKey: key,
      appName: target.appName || target.title || "未命名应用",
      bundleIdentifier: target.bundleIdentifier,
      regions: [],
    });
}

export async function saveRegions(target: RemoteTarget, regions: NormalizedRegion[], remote: RemoteClient) {
  const profile = await loadProfile(target, remote);
  return remote.saveProfile(appProfileSchema.parse({ ...profile, regions }));
}
