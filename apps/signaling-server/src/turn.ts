import { createHmac } from "node:crypto";
import type { SignalingConfig } from "./config.js";

export type IceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export function issueIceServers(config: SignalingConfig): IceServer[] {
  const servers: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  if (!config.turnSecret || !config.turnUrls.length) return servers;
  const username = `${Math.floor(Date.now() / 1000) + config.turnTtlSeconds}:slice`;
  const credential = createHmac("sha1", config.turnSecret).update(username).digest("base64");
  servers.push({ urls: config.turnUrls, username, credential });
  return servers;
}
