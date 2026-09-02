import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceStore } from "./device-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DeviceStore", () => {
  it("registers devices per account without exposing credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-signaling-test-"));
    directories.push(directory);
    const store = new DeviceStore(join(directory, "device.json"));
    await store.register("alice@example.com", "Test Mac");

    expect((await store.info("alice@example.com"))?.device_name).toBe("Test Mac");
    expect((await store.info("alice@example.com"))?.created_at).toBeTruthy();
    expect(await store.info("bob@example.com")).toBeNull();

    const persisted = await readFile(join(directory, "device.json"), "utf8");
    expect(persisted).not.toContain("token");
  });

  it("reloads the device from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-signaling-test-"));
    directories.push(directory);
    const filePath = join(directory, "device.json");
    await writeFile(filePath, JSON.stringify({
      devices: {
        "alice@example.com": {
          deviceName: "Test Mac",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }));

    expect(await new DeviceStore(filePath).info("alice@example.com")).toEqual({
      device_name: "Test Mac",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("removes only the selected account device", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-signaling-test-"));
    directories.push(directory);
    const store = new DeviceStore(join(directory, "device.json"));

    await store.register("alice@example.com", "Account Mac");
    await store.register("bob@example.com", "Other Mac");

    await store.remove("alice@example.com");
    expect(await store.info("alice@example.com")).toBeNull();
    expect(await store.info("bob@example.com")).toMatchObject({ device_name: "Other Mac" });
  });
});
