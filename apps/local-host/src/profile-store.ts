import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appProfileSchema, appProfilesSchema, type AppProfile } from "@slice/protocol";

export class ProfileStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<Record<string, AppProfile>> {
    try {
      return appProfilesSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async get(appKey: string) {
    await this.mutation;
    return (await this.readAll())[appKey] ?? null;
  }

  async save(value: AppProfile) {
    const profile = appProfileSchema.parse(value);
    const operation = this.mutation.then(async () => {
      const profiles = await this.readAll();
      profiles[profile.appKey] = profile;
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    this.mutation = operation.catch(() => undefined);
    await operation;
    return profile;
  }
}
