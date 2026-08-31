import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

export type HostConfig = {
  bindHost: string;
  port: number;
  token: string | null;
  nativeBinary: string;
  webRoot: string;
  profilePath: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): HostConfig {
  const bindHost = environment.SLICE_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(environment.SLICE_PORT || "4173", 10);
  const token = environment.SLICE_TOKEN?.trim() || null;
  const isLoopback = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SLICE_PORT must be an integer between 1 and 65535");
  }
  if (!isLoopback && (!token || token.length < 16)) {
    throw new Error("Non-loopback hosting requires SLICE_TOKEN with at least 16 characters");
  }

  return {
    bindHost,
    port,
    token,
    nativeBinary:
      environment.SLICE_NATIVE_BINARY ||
      resolve(
        currentDirectory,
        "../../../dist/SliceRemoteScreenHost.app/Contents/MacOS/slice-mac-host",
      ),
    webRoot: environment.SLICE_WEB_ROOT || resolve(currentDirectory, "../../mobile-web/dist"),
    profilePath:
      environment.SLICE_PROFILE_PATH ||
      join(homedir(), "Library", "Application Support", "Slice Remote Screen", "profiles.json"),
  };
}
