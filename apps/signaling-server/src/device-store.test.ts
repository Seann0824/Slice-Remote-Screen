import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceStore } from "./device-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DeviceStore", () => {
  it("creates a credential and only accepts the original token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-signaling-test-"));
    directories.push(directory);
    const store = new DeviceStore(join(directory, "device.json"));
    const credential = await store.create("Test Mac");

    expect(await store.matches(credential.token)).toBe(true);
    expect(await store.matches("wrong-token".repeat(4))).toBe(false);
    expect(await store.info()).toEqual({ device_name: "Test Mac", token_prefix: credential.token_prefix });

    const persisted = await readFile(join(directory, "device.json"), "utf8");
    expect(persisted).not.toContain(credential.token);
  });

  it("reloads the device from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-signaling-test-"));
    directories.push(directory);
    const filePath = join(directory, "device.json");
    const first = new DeviceStore(filePath);
    const credential = await first.create("Test Mac");

    expect(await new DeviceStore(filePath).matches(credential.token)).toBe(true);
  });
});
