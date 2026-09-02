const defaultIceServers: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

function signalingOrigin() {
  const configured =
    new URL(window.location.href).searchParams.get("server") ||
    import.meta.env.VITE_SIGNALING_SERVER ||
    window.location.origin;
  const url = new URL(configured);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("信令服务地址必须使用 HTTP 或 HTTPS");
  }
  return url.origin;
}

export function signalingHttpUrl(path: string) {
  return new URL(path, signalingOrigin()).toString();
}

export function signalingWebSocketUrl(role: "host" | "controller") {
  const url = new URL(`/ws/${role}`, signalingOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function signalingLogin(email: string, password: string) {
  const response = await fetch(signalingHttpUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `登录失败（${response.status}）`);
}

export async function signalingRegister(email: string, password: string) {
  const response = await fetch(signalingHttpUrl("/api/auth/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `注册失败（${response.status}）`);
}

export async function signalingSession() {
  const response = await fetch(signalingHttpUrl("/api/auth/me"), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return null;
  return (await response.json()) as { user: { email: string; role: string } };
}

export async function loadIceServers() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(signalingHttpUrl("/api/ice-servers"), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ICE 配置请求失败（${response.status}）`);
    const payload = (await response.json()) as { ice_servers?: RTCIceServer[] };
    return payload.ice_servers?.length ? payload.ice_servers : defaultIceServers;
  } catch {
    // STUN is still useful when TURN is unavailable; the peer will report a
    // connection failure instead of making the controller page unusable.
    return defaultIceServers;
  } finally {
    window.clearTimeout(timeout);
  }
}
