const configuredBasePath = import.meta.env.BASE_URL.replace(/\/+$/, "");

export function remotePath(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${configuredBasePath}${normalizedPath}` || normalizedPath;
}

export function remoteWebSocketUrl(path: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${remotePath(path)}`;
}
