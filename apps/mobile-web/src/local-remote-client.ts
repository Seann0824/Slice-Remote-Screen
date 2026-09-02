import { hostApi } from "./api";
import type { RemoteClient } from "./remote-client";

/** Keeps the original LAN/local-host transport behind the same UI contract as P2P. */
export const localRemoteClient: RemoteClient = {
  permissions: () => hostApi.permissions(),
  requestPermissions: () => hostApi.requestPermissions(),
  targets: () => hostApi.targets(),
  apps: () => hostApi.apps(),
  launchApp: (path) => hostApi.launchApp(path),
  closeApp: (path) => hostApi.closeApp(path),
  appIcon: (bundleIdentifier) => hostApi.appIcon(bundleIdentifier),
  profile: (appKey) => hostApi.profile(appKey),
  saveProfile: (profile) => hostApi.saveProfile(profile),
  stream: (target, callbacks) => hostApi.stream(target, {
    onFrame: callbacks.onFrame,
    onState: callbacks.onState,
    onError: callbacks.onError,
  }),
  inputStream: (target, onError, onInputTarget) => hostApi.inputStream(target, onError, onInputTarget),
  click: (target, x, y) => hostApi.click(target, x, y),
  gesture: (target, gesture) => hostApi.gesture(target, gesture),
  type: (target, text) => hostApi.type(target, text),
  key: (target, value) => hostApi.key(target, value),
};
