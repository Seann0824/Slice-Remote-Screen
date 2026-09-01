import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "../../..");

function required(environment: NodeJS.ProcessEnv, name: string, minimumLength = 1) {
  const value = environment[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} is required and must contain at least ${minimumLength} characters`);
  }
  return value;
}

function list(value: string | undefined) {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export type SignalingConfig = {
  bindHost: string;
  port: number;
  adminToken: string;
  dataFile: string;
  allowedOrigins: string[];
  webRoot: string;
  turnUrls: string[];
  turnSecret: string | null;
  turnTtlSeconds: number;
};

export function loadSignalingConfig(environment: NodeJS.ProcessEnv = process.env): SignalingConfig {
  const port = Number.parseInt(environment.SIGNALING_PORT || "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SIGNALING_PORT must be an integer between 1 and 65535");
  }

  const turnUrls = list(environment.TURN_URLS);
  const turnSecret = environment.TURN_SECRET?.trim() || null;
  if (turnUrls.length > 0 && !turnSecret) {
    throw new Error("TURN_SECRET is required when TURN_URLS is configured");
  }

  const turnTtlSeconds = Number.parseInt(environment.TURN_TTL_SECONDS || "600", 10);
  if (!Number.isInteger(turnTtlSeconds) || turnTtlSeconds < 60 || turnTtlSeconds > 86_400) {
    throw new Error("TURN_TTL_SECONDS must be between 60 and 86400");
  }

  return {
    bindHost: environment.SIGNALING_HOST?.trim() || "0.0.0.0",
    port,
    adminToken: required(environment, "SIGNALING_ADMIN_TOKEN", 32),
    dataFile: resolve(repositoryRoot, environment.SIGNALING_DATA_FILE || "data/device.json"),
    allowedOrigins: list(environment.SIGNALING_ALLOWED_ORIGINS),
    webRoot: resolve(currentDirectory, environment.SIGNALING_WEB_ROOT || "../../mobile-web/dist"),
    turnUrls,
    turnSecret,
    turnTtlSeconds,
  };
}
