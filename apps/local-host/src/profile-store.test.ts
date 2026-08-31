import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileStore } from "./profile-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProfileStore", () => {
  it("persists a profile for other clients", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-profile-test-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "profiles.json");
    const store = new ProfileStore(filePath);
    const profile = {
      version: 1 as const,
      appKey: "com.openai.codex",
      appName: "Codex",
      bundleIdentifier: "com.openai.codex",
      regions: [{
        id: "composer", name: "输入区", x: 0.1, y: 0.7, width: 0.8, height: 0.2,
        layout: { x: 0.04, y: 0.58, width: 0.92, height: 0.38 },
      }],
    };

    await store.save(profile);

    expect(await new ProfileStore(filePath).get(profile.appKey)).toEqual(profile);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ [profile.appKey]: profile });
  });

  it("returns null when an app has not been configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-profile-test-"));
    temporaryDirectories.push(directory);
    expect(await new ProfileStore(join(directory, "profiles.json")).get("missing")).toBeNull();
  });
});
