import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { passwordDigest, passwordMatches } from "./auth.js";

type StoredAccount = {
  email: string;
  passwordHash: string;
  createdAt: string;
};

type AccountFile = {
  accounts: StoredAccount[];
};

function accountId(email: string) {
  return email.trim().toLowerCase();
}

export class AccountStore {
  private readonly accounts = new Map<string, StoredAccount>();
  private loaded = false;
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as AccountFile;
      for (const account of value.accounts || []) this.accounts.set(accountId(account.email), account);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const value: AccountFile = { accounts: [...this.accounts.values()] };
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private async write() {
    this.writeQueue = this.writeQueue.then(() => this.persist());
    await this.writeQueue;
  }

  async register(email: string, password: string) {
    await this.ensureLoaded();
    const normalizedEmail = accountId(email);
    if (this.accounts.has(normalizedEmail)) throw new Error("Account already exists");
    this.accounts.set(normalizedEmail, {
      email: normalizedEmail,
      passwordHash: passwordDigest(normalizedEmail, password).toString("base64"),
      createdAt: new Date().toISOString(),
    });
    await this.write();
    return normalizedEmail;
  }

  async verify(email: string, password: string) {
    await this.ensureLoaded();
    const account = this.accounts.get(accountId(email));
    if (!account) return null;
    const expected = Buffer.from(account.passwordHash, "base64");
    return passwordMatches(account.email, password, expected) ? account.email : null;
  }
}
