import { access, readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z, ZodError } from "zod";
import { loadSignalingConfig } from "./config.js";
import { DeviceStore } from "./device-store.js";
import { issueIceServers } from "./turn.js";

const config = loadSignalingConfig();
const deviceStore = new DeviceStore(config.dataFile);
const connections = new Set<WebSocket>();
const roles = new Map<WebSocket, "host" | "controller">();
const peers = new Map<WebSocket, WebSocket>();
const apiPrefix = "/api";
const mountPaths = ["/remote", "/slice-remote"];
const maxMessageBytes = 256 * 1024;
const deviceNameSchema = z.object({ device_name: z.string().trim().min(1).max(80) });
const signalMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.auth"), token: z.string().min(16).max(256) }),
  z.object({ type: z.literal("controller.auth"), token: z.string().min(16).max(256) }),
  z.object({ type: z.literal("signal.offer"), sdp: z.string().min(1).max(128_000) }),
  z.object({ type: z.literal("signal.answer"), sdp: z.string().min(1).max(128_000) }),
  z.object({ type: z.literal("signal.ice"), candidate: z.record(z.string(), z.unknown()) }),
]);

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function requestUrl(request: IncomingMessage) {
  return new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
}

function stripMountPath(pathname: string) {
  for (const mountPath of mountPaths) {
    if (pathname === mountPath) return "/";
    if (pathname.startsWith(`${mountPath}/`)) return pathname.slice(mountPath.length);
  }
  return pathname;
}

function originAllowed(request: IncomingMessage) {
  const origin = request.headers.origin;
  return !origin || config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin);
}

function corsHeaders(request: IncomingMessage) {
  const origin = request.headers.origin;
  return origin && config.allowedOrigins.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
}

function sendJson(request: IncomingMessage, response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    ...corsHeaders(request),
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function bearerToken(request: IncomingMessage) {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : null;
}

function isAdmin(request: IncomingMessage) {
  const provided = bearerToken(request);
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(config.adminToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function isDevice(request: IncomingMessage) {
  const token = bearerToken(request);
  return Boolean(token && await deviceStore.matches(token));
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
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname === `${apiPrefix}/health` && request.method === "GET") {
    sendJson(request, response, 200, { ok: true, version: "0.1.0" });
    return;
  }
  if (!originAllowed(request)) {
    sendJson(request, response, 403, { error: "Origin not allowed" });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...corsHeaders(request),
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-CSRF-Token",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    response.end();
    return;
  }
  const admin = isAdmin(request);
  const device = url.pathname === `${apiPrefix}/ice-servers` && await isDevice(request);
  if (!admin && !device) {
    sendJson(request, response, 401, { error: "Unauthorized" });
    return;
  }
  if (url.pathname === `${apiPrefix}/auth/me` && request.method === "GET") {
    sendJson(request, response, 200, { csrf_token: "bearer-authenticated", user: { role: "admin" } });
    return;
  }
  if (url.pathname === `${apiPrefix}/device` && request.method === "GET") {
    sendJson(request, response, 200, {
      device: await deviceStore.info(),
      online: [...roles].some(([socket, role]) => role === "host" && socket.readyState === WebSocket.OPEN),
    });
    return;
  }
  if (url.pathname === `${apiPrefix}/device` && request.method === "POST") {
    const body = deviceNameSchema.parse(await readJson(request));
    const credential = await deviceStore.create(body.device_name);
    disconnectRole("host", 4001, "Device replaced");
    sendJson(request, response, 200, credential);
    return;
  }
  if (url.pathname === `${apiPrefix}/device` && request.method === "DELETE") {
    await deviceStore.remove();
    disconnectRole("host", 4001, "Device revoked");
    sendJson(request, response, 200, { ok: true });
    return;
  }
  if (url.pathname === `${apiPrefix}/ice-servers` && request.method === "GET") {
    sendJson(request, response, 200, { ice_servers: issueIceServers(config) });
    return;
  }
  sendJson(request, response, 404, { error: "Route not found" });
}

async function handleStatic(response: ServerResponse, pathname: string) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  let filePath = normalize(resolve(config.webRoot, requested));
  const safeRoot = resolve(config.webRoot) + sep;
  if (!filePath.startsWith(safeRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    await access(filePath);
  } catch {
    if (extname(requested)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    filePath = resolve(config.webRoot, "index.html");
    await access(filePath);
  }
  response.writeHead(200, {
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(await readFile(filePath));
}

function sendPeer(socket: WebSocket, value: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function disconnectRole(role: "host" | "controller", code: number, reason: string) {
  for (const [socket, socketRole] of roles) {
    if (socketRole === role) socket.close(code, reason);
  }
}

function attachPeer(socket: WebSocket, role: "host" | "controller") {
  const oppositeRole = role === "host" ? "controller" : "host";
  for (const [other, otherRole] of roles) {
    if (otherRole === oppositeRole && other.readyState === WebSocket.OPEN) {
      peers.set(socket, other);
      peers.set(other, socket);
      sendPeer(socket, { type: "peer.ready" });
      sendPeer(other, { type: "peer.ready" });
      return;
    }
  }
}

function handleSocketMessage(socket: WebSocket, raw: RawData) {
  const message = signalMessageSchema.parse(JSON.parse(raw.toString()));
  const role = roles.get(socket);
  if (!role) {
    if (message.type === "host.auth") {
      void deviceStore.matches(message.token).then((valid) => {
        if (!valid) return socket.close(4401, "Invalid device token");
        disconnectRole("host", 4001, "Host reconnected");
        roles.set(socket, "host");
        sendPeer(socket, { type: "host.accepted" });
        attachPeer(socket, "host");
      });
      return;
    }
    if (message.type === "controller.auth" && message.token === config.adminToken) {
      disconnectRole("controller", 4001, "Controller reconnected");
      roles.set(socket, "controller");
      attachPeer(socket, "controller");
      return;
    }
    throw new Error("Authentication required");
  }
  if (message.type === "host.auth" || message.type === "controller.auth") {
    throw new Error("Already authenticated");
  }
  const peer = peers.get(socket);
  if (!peer) return;
  sendPeer(peer, message);
}

const server = createServer(async (request, response) => {
  try {
    const url = requestUrl(request);
    url.pathname = stripMountPath(url.pathname);
    if (url.pathname.startsWith(apiPrefix)) await handleApi(request, response, url);
    else await handleStatic(response, url.pathname);
  } catch (error) {
    const status = error instanceof ZodError || error instanceof SyntaxError ? 400 : 500;
    sendJson(request, response, status, { error: status === 400 ? "Invalid request" : "Server error" });
  }
});

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
server.on("upgrade", (request, socket, head) => {
  try {
    const url = requestUrl(request);
    url.pathname = stripMountPath(url.pathname);
    if (!originAllowed(request) || !["/ws/host", "/ws/controller"].includes(url.pathname)) {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket);
    });
  } catch {
    socket.destroy();
  }
});

webSocketServer.on("connection", (socket: WebSocket) => {
  connections.add(socket);
  const authTimeout = setTimeout(() => socket.close(4401, "Authentication timeout"), 5_000);
  socket.once("message", (raw) => {
    try {
      clearTimeout(authTimeout);
      handleSocketMessage(socket, raw);
      socket.on("message", (message) => {
        try {
          handleSocketMessage(socket, message);
        } catch {
          socket.close(4400, "Invalid signaling message");
        }
      });
    } catch {
      socket.close(4400, "Invalid authentication message");
    }
  });
  socket.on("close", () => {
    clearTimeout(authTimeout);
    const peer = peers.get(socket);
    if (peer) {
      peers.delete(peer);
      sendPeer(peer, { type: "peer.left" });
    }
    peers.delete(socket);
    roles.delete(socket);
    connections.delete(socket);
  });
});

server.listen(config.port, config.bindHost, () => {
  console.log(`Slice signaling server listening on ${config.bindHost}:${config.port}`);
});

function stopServer() {
  for (const socket of connections) socket.close(1001, "Server shutting down");
  server.close();
}
process.once("SIGINT", stopServer);
process.once("SIGTERM", stopServer);
