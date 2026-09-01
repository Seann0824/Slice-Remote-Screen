import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { securityHeaders } from "./security.js";

describe("host exposure guard", () => {
  it("allows loopback without a token", () => {
    expect(loadConfig({ SLICE_HOST: "127.0.0.1" }).token).toBeNull();
  });

  it("rejects LAN exposure without a strong token", () => {
    expect(() => loadConfig({ SLICE_HOST: "0.0.0.0", SLICE_TOKEN: "short" })).toThrow(
      /requires SLICE_TOKEN/,
    );
  });

  it("accepts LAN exposure with a strong token", () => {
    expect(loadConfig({ SLICE_HOST: "0.0.0.0", SLICE_TOKEN: "0123456789abcdef" }).token).toBe(
      "0123456789abcdef",
    );
  });
});

describe("host content security policy", () => {
  it("allows the Shiwen WebSocket signaling endpoint", () => {
    expect(securityHeaders["Content-Security-Policy"]).toContain("wss://shiwhen.com");
    expect(securityHeaders["Content-Security-Policy"]).toContain("ws://127.0.0.1:8787");
  });
});
