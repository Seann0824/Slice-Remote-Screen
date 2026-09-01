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

export function signalingToken() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token) {
    window.sessionStorage.setItem("slice-remote-screen.signaling-token", token);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return token;
  }
  return window.sessionStorage.getItem("slice-remote-screen.signaling-token") || "";
}

export function signalingHttpUrl(path: string) {
  return new URL(path, signalingOrigin()).toString();
}

export function signalingWebSocketUrl(role: "host" | "controller") {
  const url = new URL(`/ws/${role}`, signalingOrigin());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function loadIceServers(token: string) {
  try {
    const response = await fetch(signalingHttpUrl("/api/ice-servers"), {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`ICE 配置请求失败（${response.status}）`);
    const payload = (await response.json()) as { ice_servers?: RTCIceServer[] };
    return payload.ice_servers?.length ? payload.ice_servers : defaultIceServers;
  } catch {
    // STUN is still useful when TURN is unavailable; the peer will report a
    // connection failure instead of making the controller page unusable.
    return defaultIceServers;
  }
}
