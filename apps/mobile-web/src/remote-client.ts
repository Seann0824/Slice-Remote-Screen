import type {
  AppProfile,
  HostPermissions,
  InstalledApp,
  KeyRequest,
  NormalizedRegion,
  PointerControl,
  PointerGesture,
  RemoteTarget,
} from "@slice/protocol";

export type RemoteInputChannel = {
  send(control: PointerControl): void;
  subscribeInputTarget(listener: (editable: boolean) => void): () => void;
  close(): void;
};

export type RemoteStreamCallbacks = {
  onFrame: (frame: Blob) => void;
  onStream: (stream: MediaStream) => void;
  onState: (state: "connecting" | "streaming" | "reconnecting") => void;
  onError: (message: string) => void;
};

export type RemoteClient = {
  permissions(): Promise<HostPermissions>;
  requestPermissions(): Promise<HostPermissions>;
  targets(): Promise<RemoteTarget[]>;
  apps(): Promise<InstalledApp[]>;
  launchApp(path: string): Promise<void>;
  closeApp(path: string): Promise<void>;
  appIcon(bundleIdentifier: string, path?: string): Promise<Blob>;
  profile(appKey: string): Promise<AppProfile | null>;
  saveProfile(profile: AppProfile): Promise<AppProfile>;
  stream(target: RemoteTarget, callbacks: RemoteStreamCallbacks): () => void;
  inputStream(
    target: RemoteTarget,
    onError: (message: string) => void,
    onInputTarget?: (editable: boolean) => void,
  ): RemoteInputChannel;
  click(target: RemoteTarget, x: number, y: number): Promise<void>;
  gesture(target: RemoteTarget, gesture: PointerGesture): Promise<void>;
  type(target: RemoteTarget, text: string): Promise<void>;
  key(target: RemoteTarget, value: KeyRequest): Promise<void>;
};

export function profileStorageKey(appKey: string) {
  return `slice-remote-screen.profile.${appKey}`;
}

export function readStoredProfile(appKey: string) {
  const value = window.localStorage.getItem(profileStorageKey(appKey));
  return value ? JSON.parse(value) as AppProfile : null;
}

export function storeProfile(profile: AppProfile) {
  window.localStorage.setItem(profileStorageKey(profile.appKey), JSON.stringify(profile));
}
