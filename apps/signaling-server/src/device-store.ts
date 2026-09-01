import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type StoredDevice = {
  deviceName: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: string;
};

export type DeviceInfo = {
  device_name: string;
  token_prefix: string;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class DeviceStore {
  private device: StoredDevice | null = null;
  private loaded = false;
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.device = JSON.parse(await readFile(this.filePath, "utf8")) as StoredDevice;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.device, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private async write() {
    this.writeQueue = this.writeQueue.then(() => this.persist());
    await this.writeQueue;
  }

  async info(): Promise<DeviceInfo | null> {
    await this.ensureLoaded();
    return this.device
      ? { device_name: this.device.deviceName, token_prefix: this.device.tokenPrefix }
      : null;
  }

  async create(deviceName: string) {
    await this.ensureLoaded();
    const token = randomBytes(32).toString("hex");
    this.device = {
      deviceName,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 8),
      createdAt: new Date().toISOString(),
    };
    await this.write();
    return { device_name: deviceName, token, token_prefix: this.device.tokenPrefix };
  }

  async remove() {
    await this.ensureLoaded();
    this.device = null;
    await this.write();
  }

  async matches(token: string) {
    await this.ensureLoaded();
    return Boolean(this.device && sameHash(this.device.tokenHash, hashToken(token)));
  }
}
