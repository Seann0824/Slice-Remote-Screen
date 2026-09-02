import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./auth.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SessionStore", () => {
  it("persists sessions without writing the raw browser token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-session-test-"));
    directories.push(directory);
    const filePath = join(directory, "sessions.json");
    const store = new SessionStore(filePath);

    const token = await store.create("alice@example.com");
    expect(store.account(token)).toBe("alice@example.com");

    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain(token);
    expect(await new SessionStore(filePath).load()).toBeUndefined();
    expect(new SessionStore(filePath).account(token)).toBeNull();

    const reloaded = new SessionStore(filePath);
    await reloaded.load();
    expect(reloaded.account(token)).toBe("alice@example.com");
  });

  it("removes a session from memory and disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-session-test-"));
    directories.push(directory);
    const filePath = join(directory, "sessions.json");
    const store = new SessionStore(filePath);
    const token = await store.create("alice@example.com");

    await store.remove(token);

    const reloaded = new SessionStore(filePath);
    await reloaded.load();
    expect(reloaded.account(token)).toBeNull();
  });
});
