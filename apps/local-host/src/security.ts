import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

function equals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function tokenMatches(providedToken: string | null, expectedToken: string | null) {
  if (!expectedToken) return true;
  return Boolean(providedToken && equals(providedToken, expectedToken));
}

export function isAuthorized(request: IncomingMessage, expectedToken: string | null) {
  if (!expectedToken) return true;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  return tokenMatches(authorization.slice("Bearer ".length), expectedToken);
}

export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https: wss: http://127.0.0.1:8787 ws://127.0.0.1:8787; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;
