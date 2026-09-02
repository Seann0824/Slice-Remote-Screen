import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z, ZodError } from "zod";
import { sessionCookie, SessionStore, setSessionCookie, clearSessionCookie } from "./auth.js";
import { AccountStore } from "./account-store.js";
import { loadSignalingConfig } from "./config.js";
import { DeviceStore } from "./device-store.js";
import { issueIceServers } from "./turn.js";

const config = loadSignalingConfig();
const accountStore = new AccountStore(config.accountsFile);
const deviceStore = new DeviceStore(config.dataFile);
const sessions = new SessionStore(config.sessionsFile);
await sessions.load();
const connections = new Set<WebSocket>();
const roles = new Map<WebSocket, "host" | "controller">();
const connectionAccounts = new Map<WebSocket, string>();
const peers = new Map<WebSocket, WebSocket>();
const apiPrefix = "/api";
const mountPaths = ["/remote", "/slice-remote"];
const maxMessageBytes = 256 * 1024;
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) });
const registerSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(12).max(256) });
const signalMessageSchema = z.discriminatedUnion("type", [
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
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" }
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

function sessionAccount(request: IncomingMessage) {
  return sessions.account(sessionCookie(request));
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

  if (url.pathname === `${apiPrefix}/auth/login` && request.method === "POST") {
    const body = loginSchema.parse(await readJson(request));
    const accountId = await accountStore.verify(body.email, body.password);
    if (!accountId) {
      sendJson(request, response, 401, { error: "账号或密码错误" });
      return;
    }
    setSessionCookie(request, response, await sessions.create(accountId));
    sendJson(request, response, 200, { user: { email: accountId } });
    return;
  }
  if (url.pathname === `${apiPrefix}/auth/register` && request.method === "POST") {
    const body = registerSchema.parse(await readJson(request));
    try {
      const accountId = await accountStore.register(body.email, body.password);
      setSessionCookie(request, response, await sessions.create(accountId));
      sendJson(request, response, 201, { user: { email: accountId } });
    } catch (error) {
      if (error instanceof Error && error.message === "Account already exists") {
        sendJson(request, response, 409, { error: "账号已存在" });
        return;
      }
      throw error;
    }
    return;
  }
  if (url.pathname === `${apiPrefix}/auth/logout` && request.method === "POST") {
    await sessions.remove(sessionCookie(request));
    clearSessionCookie(response);
    sendJson(request, response, 200, { ok: true });
    return;
  }

  const accountId = sessionAccount(request);
  if (!accountId) {
    sendJson(request, response, 401, { error: "Unauthorized" });
    return;
  }
  if (url.pathname === `${apiPrefix}/auth/me` && request.method === "GET") {
    sendJson(request, response, 200, { user: { email: accountId } });
    return;
  }
  if (url.pathname === `${apiPrefix}/device` && request.method === "GET") {
    sendJson(request, response, 200, {
      device: await deviceStore.info(accountId),
      online: [...roles].some(([socket, role]) =>
        role === "host" && connectionAccounts.get(socket) === accountId && socket.readyState === WebSocket.OPEN,
      ),
    });
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

function summarizeSdp(sdp: string) {
  const counts = { host: 0, srflx: 0, relay: 0, other: 0 };
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const type = line.match(/ typ ([a-z]+)/)?.[1];
    if (type === "host" || type === "srflx" || type === "relay") counts[type] += 1;
    else counts.other += 1;
  }
  return `sdpCandidates(host=${counts.host},srflx=${counts.srflx},relay=${counts.relay},other=${counts.other})`;
}

function summarizeCandidate(candidate: Record<string, unknown>) {
  const value = typeof candidate.candidate === "string" ? candidate.candidate : "";
  const type = value.match(/ typ ([a-z]+)/)?.[1] || "unknown";
  const protocol = value.match(/^candidate:\S+ \d+ ([a-z]+) /)?.[1] || "?";
  return `candidate(type=${type},protocol=${protocol})`;
}

function attachPeer(socket: WebSocket, role: "host" | "controller", accountId: string) {
  const oppositeRole = role === "host" ? "controller" : "host";
  for (const [other, otherRole] of roles) {
    if (
      otherRole === oppositeRole &&
      connectionAccounts.get(other) === accountId &&
      other.readyState === WebSocket.OPEN
    ) {
      peers.set(socket, other);
      peers.set(other, socket);
      console.info(`[signal] peer paired (${role} + ${oppositeRole})`);
      sendPeer(socket, { type: "peer.ready" });
      sendPeer(other, { type: "peer.ready" });
      return;
    }
  }
}

function handleSocketMessage(socket: WebSocket, raw: RawData) {
  const message = signalMessageSchema.parse(JSON.parse(raw.toString()));
  const role = roles.get(socket);
  if (!role) throw new Error("Authentication required");
  const peer = peers.get(socket);
  const detail = "sdp" in message
    ? ` ${summarizeSdp(message.sdp)}`
    : message.type === "signal.ice"
      ? ` ${summarizeCandidate(message.candidate)}`
      : "";
  console.info(`[signal] ${role} -> ${message.type} (paired=${Boolean(peer)})${detail}`);
  if (!peer) return;
  sendPeer(peer, message);
}

function detachPeer(socket: WebSocket, notifyPeer = true) {
  const peer = peers.get(socket);
  peers.delete(socket);
  if (!peer || peers.get(peer) !== socket) return;

  // Only remove the reverse edge when it still points to this socket. An old
  // controller may finish closing after its replacement has already paired;
  // deleting the replacement edge here would silently drop every answer and
  // ICE candidate sent by the host.
  peers.delete(peer);
  if (notifyPeer) sendPeer(peer, { type: "peer.left" });
}

function disconnectAccountRole(accountId: string, role: "host" | "controller") {
  for (const [socket, socketRole] of roles) {
    if (socketRole === role && connectionAccounts.get(socket) === accountId) {
      detachPeer(socket);
      socket.close(4001, "Reconnected");
    }
  }
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
    const accountId = sessionAccount(request);
    if (!originAllowed(request) || !accountId || !["/ws/host", "/ws/controller"].includes(url.pathname)) {
      socket.destroy();
      return;
    }
    const role = url.pathname === "/ws/host" ? "host" : "controller";
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request, role, accountId);
    });
  } catch {
    socket.destroy();
  }
});

webSocketServer.on("connection", (
  socket: WebSocket,
  _request: IncomingMessage,
  role: "host" | "controller",
  accountId: string,
) => {
  connections.add(socket);
  disconnectAccountRole(accountId, role);
  roles.set(socket, role);
  connectionAccounts.set(socket, accountId);
  console.info(`[signal] ${role} connected`);
  if (role === "host") void deviceStore.register(accountId, "Mac");
  if (role === "host") sendPeer(socket, { type: "host.accepted" });
  attachPeer(socket, role, accountId);
  socket.on("message", (message) => {
    try {
      handleSocketMessage(socket, message);
    } catch {
      socket.close(4400, "Invalid signaling message");
    }
  });
  socket.on("close", () => {
    console.info(`[signal] ${roles.get(socket) || role} disconnected`);
    detachPeer(socket);
    roles.delete(socket);
    connectionAccounts.delete(socket);
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
