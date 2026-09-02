import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type StoredDevice = {
  deviceName: string;
  createdAt: string;
};

type DeviceFile = {
  devices: Record<string, StoredDevice>;
};

export type DeviceInfo = {
  device_name: string;
  created_at: string;
};

export class DeviceStore {
  private readonly devices = new Map<string, StoredDevice>();
  private loaded = false;
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as DeviceFile;
      for (const [accountId, device] of Object.entries(value.devices || {})) {
        this.devices.set(accountId, device);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const value: DeviceFile = { devices: Object.fromEntries(this.devices) };
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private async write() {
    this.writeQueue = this.writeQueue.then(() => this.persist());
    await this.writeQueue;
  }

  async info(accountId: string): Promise<DeviceInfo | null> {
    await this.ensureLoaded();
    const device = this.devices.get(accountId);
    return device
      ? { device_name: device.deviceName, created_at: device.createdAt }
      : null;
  }

  async register(accountId: string, deviceName: string) {
    await this.ensureLoaded();
    const current = this.devices.get(accountId);
    if (current?.deviceName === deviceName) return;
    this.devices.set(accountId, {
      deviceName,
      createdAt: new Date().toISOString(),
    });
    await this.write();
  }

  async remove(accountId: string) {
    await this.ensureLoaded();
    this.devices.delete(accountId);
    await this.write();
  }

}
