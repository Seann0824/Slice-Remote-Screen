import { describe, expect, it } from "vitest";
import { loadSignalingConfig } from "./config.js";

describe("signaling configuration", () => {
  it("requires the TURN shared secret when TURN is enabled", () => {
    expect(() => loadSignalingConfig({
      TURN_URLS: "turn:turn.example.com:3478",
    })).toThrow(/TURN_SECRET is required/);
  });

  it("accepts a self-hosted TURN configuration", () => {
    const config = loadSignalingConfig({
      SIGNALING_DATA_FILE: "/data/device.json",
      TURN_SECRET: "b".repeat(32),
      TURN_URLS: "turn:turn.example.com:3478,turns:turn.example.com:443",
    });
    expect(config.turnUrls).toHaveLength(2);
    expect(config.dataFile).toBe("/data/device.json");
  });
});
