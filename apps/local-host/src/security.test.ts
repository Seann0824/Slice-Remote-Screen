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

describe("path configuration", () => {
  it("resolves operator-provided relative paths from the process directory", () => {
    const config = loadConfig({
      SLICE_NATIVE_BINARY: "./host",
      SLICE_WEB_ROOT: "./web",
      SLICE_PROFILE_PATH: "./profiles.json",
    });

    expect(config.nativeBinary).toMatch(/^\//);
    expect(config.webRoot).toMatch(/^\//);
    expect(config.profilePath).toMatch(/^\//);
  });
});

describe("host content security policy", () => {
  it("allows self-hosted secure signaling endpoints", () => {
    expect(securityHeaders["Content-Security-Policy"]).toContain("wss:");
    expect(securityHeaders["Content-Security-Policy"]).toContain("ws://127.0.0.1:8787");
  });
});
