import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";

const sessionCookieName = "slice_session";
const sessionTtlSeconds = 30 * 24 * 60 * 60;

type Session = {
  accountId: string;
  expiresAt: number;
};

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private loaded = false;
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as {
        sessions?: Record<string, Session>;
      };
      const now = Date.now();
      for (const [tokenHash, session] of Object.entries(value.sessions || {})) {
        if (session.expiresAt > now) this.sessions.set(tokenHash, session);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async create(accountId: string) {
    await this.load();
    this.prune();
    const value = randomBytes(32).toString("base64url");
    this.sessions.set(hashSession(value), { accountId, expiresAt: Date.now() + sessionTtlSeconds * 1_000 });
    await this.write();
    return value;
  }

  account(value: string | null) {
    if (!value) return null;
    const session = this.sessions.get(hashSession(value));
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(hashSession(value));
      return null;
    }
    return session.accountId;
  }

  async remove(value: string | null) {
    await this.load();
    if (!value) return;
    this.sessions.delete(hashSession(value));
    await this.write();
  }

  private prune() {
    const now = Date.now();
    for (const [tokenHash, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(tokenHash);
    }
  }

  private async write() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ sessions: Object.fromEntries(this.sessions) }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    await this.writeQueue;
  }
}

function hashSession(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

export function sessionCookie(request: IncomingMessage) {
  const header = request.headers.cookie || "";
  const value = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`));
  return value ? decodeURIComponent(value.slice(sessionCookieName.length + 1)) : null;
}

export function setSessionCookie(request: IncomingMessage, response: ServerResponse, value: string) {
  const secure = request.headers["x-forwarded-proto"] === "https";
  response.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${secure ? "None; Secure" : "Lax"}; Max-Age=${sessionTtlSeconds}`,
  );
}

export function clearSessionCookie(response: ServerResponse) {
  response.setHeader("Set-Cookie", `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function passwordDigest(email: string, password: string) {
  return scryptSync(password, `slice-remote-screen:${email.toLowerCase()}`, 32);
}

export function passwordMatches(email: string, password: string, expected: Buffer) {
  const actual = passwordDigest(email, password);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
