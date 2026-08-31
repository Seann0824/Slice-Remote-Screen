import {
  appProfileSchema,
  closeAppRequestSchema,
  installedAppSchema,
  permissionsSchema,
  remoteTargetSchema,
  type HostPermissions,
  type AppProfile,
  type InstalledApp,
  type KeyRequest,
  type PointerControl,
  type PointerGesture,
  type RemoteTarget,
} from "@slice/protocol";

const TOKEN_KEY = "slice-remote-screen.session-token";

function readToken() {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    window.sessionStorage.setItem(TOKEN_KEY, queryToken);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return queryToken;
  }
  return window.sessionStorage.getItem(TOKEN_KEY);
}

const token = readToken();

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string; detail?: string } | null;
    throw new Error(payload?.detail || payload?.error || `Request failed: ${response.status}`);
  }
  return response;
}

export const hostApi = {
  async permissions(): Promise<HostPermissions> {
    return permissionsSchema.parse(await (await request("/api/permissions")).json());
  },
  async requestPermissions(): Promise<HostPermissions> {
    return permissionsSchema.parse(await (await request("/api/permissions", { method: "POST" })).json());
  },
  async targets(): Promise<RemoteTarget[]> {
    return remoteTargetSchema.array().parse(await (await request("/api/targets")).json());
  },
  async apps(): Promise<InstalledApp[]> {
    return installedAppSchema.array().parse(await (await request("/api/apps")).json());
  },
  async launchApp(path: string) {
    await request("/api/apps/launch", { method: "POST", body: JSON.stringify({ path }) });
  },
  async closeApp(path: string) {
    closeAppRequestSchema.parse({ path });
    await request("/api/apps/close", { method: "POST", body: JSON.stringify({ path }) });
  },
  async appIcon(bundleIdentifier: string) {
    return (await request(`/api/apps/icon?bundleIdentifier=${encodeURIComponent(bundleIdentifier)}`)).blob();
  },
  async profile(appKey: string): Promise<AppProfile | null> {
    return appProfileSchema.nullable().parse(
      await (await request(`/api/profiles/${encodeURIComponent(appKey)}`)).json(),
    );
  },
  async saveProfile(profile: AppProfile): Promise<AppProfile> {
    return appProfileSchema.parse(await (await request(`/api/profiles/${encodeURIComponent(profile.appKey)}`, {
      method: "PUT",
      body: JSON.stringify(profile),
    })).json());
  },
  async frame(target: RemoteTarget) {
    return (await request(`/api/targets/${target.kind}/${target.id}/frame`)).blob();
  },
  stream(
    target: RemoteTarget,
    callbacks: {
      onFrame: (frame: Blob) => void;
      onState: (state: "connecting" | "streaming" | "reconnecting") => void;
      onError: (message: string) => void;
    },
  ) {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (stopped) return;
      callbacks.onState(socket ? "reconnecting" : "connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/stream`);
      socket.binaryType = "blob";
      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ token, kind: target.kind, id: target.id }));
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof Blob) {
          callbacks.onState("streaming");
          callbacks.onFrame(event.data);
          return;
        }
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
          if (message.type === "ready") callbacks.onState("connecting");
          if (message.type === "error") callbacks.onError(message.message || "远程画面流异常");
        } catch {
          callbacks.onError("远程画面流返回了无效消息");
        }
      });
      socket.addEventListener("close", (event) => {
        if (stopped) return;
        if (event.code === 4401) {
          callbacks.onError("远程画面鉴权失败，请重新打开带 token 的地址");
          return;
        }
        callbacks.onState("reconnecting");
        reconnectTimer = window.setTimeout(connect, 1_000);
      });
      socket.addEventListener("error", () => {
        if (!stopped) callbacks.onError("无法连接实时画面流");
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  },
  inputStream(target: RemoteTarget, onError: (message: string) => void) {
    let socket: WebSocket | null = null;
    let stopped = false;
    let ready = false;
    const queue: PointerControl[] = [];

    const send = (control: PointerControl) => {
      if (ready && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(control));
      } else if (!stopped) {
        queue.push(control);
      }
    };

    socket = new WebSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/stream`);
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify({ token, kind: target.kind, id: target.id, mode: "input" }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
        if (message.type === "ready") {
          ready = true;
          for (const control of queue.splice(0)) send(control);
        } else if (message.type === "error") {
          onError(message.message || "实时输入通道异常");
        }
      } catch {
        onError("实时输入通道返回了无效消息");
      }
    });
    socket.addEventListener("error", () => {
      if (!stopped) onError("无法连接实时输入通道");
    });
    socket.addEventListener("close", (event) => {
      if (!stopped && event.code !== 1000) onError("实时输入通道已断开");
    });

    return {
      send,
      close() {
        stopped = true;
        ready = false;
        queue.length = 0;
        socket?.close();
      },
    };
  },
  async click(target: RemoteTarget, x: number, y: number) {
    await request(`/api/targets/${target.kind}/${target.id}/click`, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    });
  },
  async gesture(target: RemoteTarget, gesture: PointerGesture) {
    await request(`/api/targets/${target.kind}/${target.id}/gesture`, {
      method: "POST",
      body: JSON.stringify(gesture),
    });
  },
  async type(target: RemoteTarget, text: string) {
    await request(`/api/targets/${target.kind}/${target.id}/type`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  },
  async key(target: RemoteTarget, value: KeyRequest) {
    await request(`/api/targets/${target.kind}/${target.id}/key`, {
      method: "POST",
      body: JSON.stringify(value),
    });
  },
};
