import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "./account-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AccountStore", () => {
  it("registers and verifies accounts case-insensitively", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-account-test-"));
    directories.push(directory);
    const store = new AccountStore(join(directory, "accounts.json"));

    await store.register("Alice@Example.com", "correct horse battery staple");

    expect(await store.verify("alice@example.com", "correct horse battery staple")).toBe("alice@example.com");
    expect(await store.verify("alice@example.com", "wrong password")).toBeNull();
    expect(await readFile(join(directory, "accounts.json"), "utf8")).not.toContain("correct horse battery staple");
  });

  it("rejects duplicate accounts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slice-account-test-"));
    directories.push(directory);
    const store = new AccountStore(join(directory, "accounts.json"));

    await store.register("alice@example.com", "correct horse battery staple");
    await expect(store.register("ALICE@example.com", "another password"))
      .rejects.toThrow("Account already exists");
  });
});
