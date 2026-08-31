import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  installedAppSchema,
  permissionsSchema,
  remoteTargetSchema,
  type InstalledApp,
  type HostPermissions,
  type KeyRequest,
  type PointerGesture,
  type RemoteTarget,
  type TargetKind,
} from "@slice/protocol";

const execFileAsync = promisify(execFile);

export class NativeHost {
  constructor(private readonly binaryPath: string) {}

  private async run(args: string[], timeout = 15_000) {
    try {
      return await execFileAsync(this.binaryPath, args, {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Native host failed: ${detail}`);
    }
  }

  async permissions(): Promise<HostPermissions> {
    const { stdout } = await this.run(["permissions"]);
    return permissionsSchema.parse(JSON.parse(stdout));
  }

  async requestPermissions(): Promise<HostPermissions> {
    const { stdout } = await this.run(["permissions", "--request"], 60_000);
    return permissionsSchema.parse(JSON.parse(stdout));
  }

  async targets(app?: string): Promise<RemoteTarget[]> {
    const args = ["list-targets"];
    if (app) args.push("--app", app);
    const { stdout } = await this.run(args);
    return remoteTargetSchema.array().parse(JSON.parse(stdout));
  }

  async apps(): Promise<Omit<InstalledApp, "hasOpenWindow">[]> {
    const { stdout } = await this.run(["list-apps"]);
    return installedAppSchema.omit({ hasOpenWindow: true }).array().parse(JSON.parse(stdout));
  }

  async launchApp(path: string) {
    await this.run(["launch-app", "--path", path], 30_000);
  }

  async appIcon(bundleIdentifier: string) {
    const directory = await mkdtemp(join(tmpdir(), "slice-app-icon-"));
    const output = join(directory, "icon.png");
    try {
      await this.run([
        "app-icon",
        "--bundle-id",
        bundleIdentifier,
        "--output",
        output,
        "--size",
        "128",
      ]);
      return await readFile(output);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  async capture(kind: TargetKind, id: number) {
    const directory = await mkdtemp(join(tmpdir(), "slice-remote-screen-"));
    const output = join(directory, "frame.png");
    try {
      await this.run(
        ["capture", "--kind", kind, "--id", String(id), "--output", output, "--max-width", "1600"],
        20_000,
      );
      return await readFile(output);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  async click(kind: TargetKind, id: number, x: number, y: number) {
    await this.run([
      "click",
      "--kind",
      kind,
      "--id",
      String(id),
      "--x",
      String(x),
      "--y",
      String(y),
    ]);
  }

  async gesture(kind: TargetKind, id: number, request: PointerGesture) {
    await this.run([
      "gesture",
      "--kind",
      kind,
      "--id",
      String(id),
      "--payload",
      JSON.stringify(request),
    ], 30_000);
  }

  async type(kind: TargetKind, id: number, text: string) {
    await this.run(["type", "--kind", kind, "--id", String(id), "--text", text]);
  }

  async key(kind: TargetKind, id: number, request: KeyRequest) {
    const args = ["key", "--kind", kind, "--id", String(id), "--key", request.key];
    if (request.modifiers.length) args.push("--modifiers", request.modifiers.join(","));
    await this.run(args);
  }

  stream(kind: TargetKind, id: number) {
    const child = spawn(
      this.binaryPath,
      ["stream", "--kind", kind, "--id", String(id), "--max-width", "1600", "--fps", "15"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.end();
    return child;
  }
}
