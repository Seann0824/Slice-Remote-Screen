import { appKey, appProfileSchema, type NormalizedRegion, type RemoteTarget } from "@slice/protocol";
import { hostApi } from "./api";

export async function loadProfile(target: RemoteTarget) {
  const key = appKey(target);
  return await hostApi.profile(key) ?? appProfileSchema.parse({
    version: 1,
    appKey: key,
    appName: target.appName || target.title || "未命名应用",
    bundleIdentifier: target.bundleIdentifier,
    regions: [],
  });
}

export async function saveRegions(target: RemoteTarget, regions: NormalizedRegion[]) {
  const profile = await loadProfile(target);
  return hostApi.saveProfile(appProfileSchema.parse({ ...profile, regions }));
}
