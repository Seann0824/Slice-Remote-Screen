import { describe, expect, it } from "vitest";
import { loadSignalingConfig } from "./config.js";

describe("signaling configuration", () => {
  it("requires a sufficiently long admin token", () => {
    expect(() => loadSignalingConfig({ SIGNALING_ADMIN_TOKEN: "short" })).toThrow(
      /SIGNALING_ADMIN_TOKEN is required/,
    );
  });

  it("requires the TURN shared secret when TURN is enabled", () => {
    expect(() => loadSignalingConfig({
      SIGNALING_ADMIN_TOKEN: "a".repeat(32),
      TURN_URLS: "turn:turn.example.com:3478",
    })).toThrow(/TURN_SECRET is required/);
  });

  it("accepts a self-hosted TURN configuration", () => {
    const config = loadSignalingConfig({
      SIGNALING_ADMIN_TOKEN: "a".repeat(32),
      SIGNALING_DATA_FILE: "/data/device.json",
      TURN_SECRET: "b".repeat(32),
      TURN_URLS: "turn:turn.example.com:3478,turns:turn.example.com:443",
    });
    expect(config.turnUrls).toHaveLength(2);
    expect(config.dataFile).toBe("/data/device.json");
  });
});
