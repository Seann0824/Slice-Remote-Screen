import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, normalize, resolve, sep } from "node:path";
import {
  appProfileSchema,
  closeAppRequestSchema,
  clickRequestSchema,
  keyRequestSchema,
  launchAppRequestSchema,
  pointerGestureSchema,
  pointerControlSchema,
  targetKindSchema,
  typeRequestSchema,
} from "@slice/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { z, ZodError } from "zod";
import { loadConfig } from "./config.js";
import { LengthPrefixedFrameParser } from "./frame-protocol.js";
import { NativeHost } from "./native-host.js";
import { ProfileStore } from "./profile-store.js";
import { isAuthorized, securityHeaders, tokenMatches } from "./security.js";

const config = loadConfig();
const nativeHost = new NativeHost(config.nativeBinary);
const profileStore = new ProfileStore(config.profilePath);
const appIconCache = new Map<string, Promise<Buffer>>();
const apiPrefix = "/api";

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseTarget(pathname: string) {
  const match = pathname.match(/^\/api\/targets\/(window|display)\/(\d+)(?:\/(frame|click|gesture|type|key))?$/);
  if (!match) return null;
  const kind = targetKindSchema.parse(match[1]);
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id)) throw new Error("Invalid target id");
  return { kind, id, action: match[3] };
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, version: "0.1.0", authenticated: Boolean(config.token) });
    return;
  }

  if (!isAuthorized(request, config.token)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  if (url.pathname === "/api/permissions" && request.method === "GET") {
    sendJson(response, 200, await nativeHost.permissions());
    return;
  }
  if (url.pathname === "/api/permissions" && request.method === "POST") {
    sendJson(response, 200, await nativeHost.requestPermissions());
    return;
  }
  if (url.pathname === "/api/targets" && request.method === "GET") {
    sendJson(response, 200, await nativeHost.targets(url.searchParams.get("app") || undefined));
    return;
  }
  if (url.pathname === "/api/apps" && request.method === "GET") {
    const applications = await nativeHost.apps();
    sendJson(response, 200, applications.map((application) => ({
      ...application,
      hasOpenWindow: false,
    })));
    return;
  }
  if (url.pathname === "/api/apps/launch" && request.method === "POST") {
    const body = launchAppRequestSchema.parse(await readJson(request));
    await nativeHost.launchApp(body.path);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/api/apps/close" && request.method === "POST") {
    const body = closeAppRequestSchema.parse(await readJson(request));
    await nativeHost.closeApp(body.path);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/api/apps/icon" && request.method === "GET") {
    const bundleIdentifier = z.string().min(1).max(255).parse(url.searchParams.get("bundleIdentifier"));
    let icon = appIconCache.get(bundleIdentifier);
    if (!icon) {
      icon = nativeHost.appIcon(bundleIdentifier);
      appIconCache.set(bundleIdentifier, icon);
      void icon.catch(() => appIconCache.delete(bundleIdentifier));
    }
    const body = await icon;
    response.writeHead(200, {
      ...securityHeaders,
      "Cache-Control": "private, max-age=86400",
      "Content-Length": body.length,
      "Content-Type": "image/png",
    });
    response.end(body);
    return;
  }

  const profileMatch = url.pathname.match(/^\/api\/profiles\/(.+)$/);
  if (profileMatch) {
    const profileKey = decodeURIComponent(profileMatch[1]!);
    if (request.method === "GET") {
      sendJson(response, 200, await profileStore.get(profileKey));
      return;
    }
    if (request.method === "PUT") {
      const profile = appProfileSchema.parse(await readJson(request));
      if (profile.appKey !== profileKey) {
        sendJson(response, 400, { error: "Profile key does not match URL" });
        return;
      }
      sendJson(response, 200, await profileStore.save(profile));
      return;
    }
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const target = parseTarget(url.pathname);
  if (!target) {
    sendJson(response, 404, { error: "API route not found" });
    return;
  }

  if (target.action === "frame" && request.method === "GET") {
    const frame = await nativeHost.capture(target.kind, target.id);
    response.writeHead(200, {
      ...securityHeaders,
      "Cache-Control": "no-store, max-age=0",
      "Content-Length": frame.length,
      "Content-Type": "image/png",
    });
    response.end(frame);
    return;
  }
  if (target.action === "click" && request.method === "POST") {
    const body = clickRequestSchema.parse(await readJson(request));
    await nativeHost.click(target.kind, target.id, body.x, body.y);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (target.action === "gesture" && request.method === "POST") {
    const body = pointerGestureSchema.parse(await readJson(request));
    await nativeHost.gesture(target.kind, target.id, body);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (target.action === "type" && request.method === "POST") {
    const body = typeRequestSchema.parse(await readJson(request));
    await nativeHost.type(target.kind, target.id, body.text);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (target.action === "key" && request.method === "POST") {
    const body = keyRequestSchema.parse(await readJson(request));
    await nativeHost.key(target.kind, target.id, body);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function handleStatic(response: ServerResponse, pathname: string) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  let filePath = normalize(resolve(config.webRoot, requested));
  const safeRoot = resolve(config.webRoot) + sep;
  if (!filePath.startsWith(safeRoot)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    await access(filePath);
  } catch {
    if (extname(requested)) {
      sendJson(response, 404, { error: "File not found" });
      return;
    }
    filePath = resolve(config.webRoot, "index.html");
    await access(filePath);
  }

  const body = await readFile(filePath);
  response.writeHead(200, {
    ...securityHeaders,
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith(apiPrefix)) {
      await handleApi(request, response, url);
    } else {
      await handleStatic(response, url.pathname);
    }
  } catch (error) {
    const status = error instanceof ZodError || error instanceof SyntaxError ? 400 : 500;
    const detail = error instanceof Error ? error.message : String(error);
    sendJson(response, status, { error: status === 400 ? "Invalid request" : "Host operation failed", detail });
  }
});

const streamRequestSchema = z.object({
  token: z.string().nullable(),
  kind: targetKindSchema,
  id: z.number().int().nonnegative(),
  mode: z.enum(["frames", "input"]).default("frames"),
});
const webSocketServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/api/stream") {
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

webSocketServer.on("connection", (webSocket) => {
  let nativeProcess: ReturnType<NativeHost["stream"]> | null = null;
  const authenticationTimeout = setTimeout(() => {
    webSocket.close(4401, "Authentication timeout");
  }, 5_000);

  webSocket.once("message", (rawMessage, isBinary) => {
    try {
      if (isBinary) throw new Error("Expected a JSON stream request");
      const request = streamRequestSchema.parse(JSON.parse(rawMessage.toString()));
      if (!tokenMatches(request.token, config.token)) {
        webSocket.close(4401, "Unauthorized");
        return;
      }

      clearTimeout(authenticationTimeout);
      if (request.mode === "input") {
        nativeProcess = nativeHost.inputStream(request.kind, request.id);
        let standardError = "";
        let standardOutput = "";
        nativeProcess.stderr.on("data", (chunk: Buffer) => {
          standardError = (standardError + chunk.toString("utf8")).slice(-4_096);
        });
        nativeProcess.stdout.on("data", (chunk: Buffer) => {
          standardOutput += chunk.toString("utf8");
          const lines = standardOutput.split("\n");
          standardOutput = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim() || webSocket.readyState !== WebSocket.OPEN) continue;
            try {
              const message = JSON.parse(line);
              if (message?.type === "input-target") webSocket.send(JSON.stringify(message));
            } catch {
              // Ignore malformed native status lines; stderr carries operation failures.
            }
          }
        });
        nativeProcess.on("error", (error) => {
          if (webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(JSON.stringify({ type: "error", message: error.message }));
            webSocket.close(1011, "Native input failed");
          }
        });
        nativeProcess.on("exit", (code, signal) => {
          if (webSocket.readyState !== WebSocket.OPEN) return;
          const message = standardError.trim() || `Native input exited (${code ?? signal ?? "unknown"})`;
          webSocket.send(JSON.stringify({ type: "error", message }));
          webSocket.close(1011, "Native input stopped");
        });
        webSocket.on("message", (inputMessage, inputIsBinary) => {
          if (inputIsBinary || !nativeProcess?.stdin.writable) return;
          try {
            const control = pointerControlSchema.parse(JSON.parse(inputMessage.toString()));
            nativeProcess.stdin.write(`${JSON.stringify(control)}\n`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            webSocket.send(JSON.stringify({ type: "error", message }));
            webSocket.close(4400, "Invalid input event");
          }
        });
        webSocket.send(JSON.stringify({ type: "ready" }));
        return;
      }
      const parser = new LengthPrefixedFrameParser();
      nativeProcess = nativeHost.stream(request.kind, request.id);
      let standardError = "";

      nativeProcess.stderr.on("data", (chunk: Buffer) => {
        standardError = (standardError + chunk.toString("utf8")).slice(-4_096);
      });
      nativeProcess.stdout.on("data", (chunk: Buffer) => {
        try {
          for (const frame of parser.push(chunk)) {
            if (webSocket.readyState !== WebSocket.OPEN) break;
            if (webSocket.bufferedAmount > 8 * 1024 * 1024) continue;
            webSocket.send(frame, { binary: true });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          webSocket.send(JSON.stringify({ type: "error", message }));
          webSocket.close(1011, "Frame protocol error");
        }
      });
      nativeProcess.on("error", (error) => {
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(JSON.stringify({ type: "error", message: error.message }));
          webSocket.close(1011, "Native host failed");
        }
      });
      nativeProcess.on("exit", (code, signal) => {
        if (webSocket.readyState !== WebSocket.OPEN) return;
        const message = standardError.trim() || `Native stream exited (${code ?? signal ?? "unknown"})`;
        webSocket.send(JSON.stringify({ type: "error", message }));
        webSocket.close(1011, "Native stream stopped");
      });
      webSocket.send(JSON.stringify({ type: "ready" }));
    } catch (error) {
      clearTimeout(authenticationTimeout);
      const message = error instanceof Error ? error.message : String(error);
      webSocket.send(JSON.stringify({ type: "error", message }));
      webSocket.close(4400, "Invalid stream request");
    }
  });

  webSocket.on("close", () => {
    clearTimeout(authenticationTimeout);
    if (nativeProcess && nativeProcess.exitCode === null) nativeProcess.kill("SIGTERM");
  });
});

server.listen(config.port, config.bindHost, () => {
  const suffix = config.token ? `?token=${encodeURIComponent(config.token)}` : "";
  console.log(`Slice Remote Screen: http://${config.bindHost}:${config.port}/${suffix}`);
  if (config.bindHost === "0.0.0.0") {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === "IPv4" && !address.internal) {
          console.log(`LAN: http://${address.address}:${config.port}/${suffix}`);
        }
      }
    }
  }
});
