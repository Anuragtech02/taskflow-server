import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";

/**
 * Signed, expiring OAuth `state` for the Discord link/install flows. Carries
 * who started the flow so the callback can refuse to attach a Discord
 * identity (or server) to anyone else — the callback additionally requires the
 * same TaskFlow session, which blocks login-CSRF style account swaps.
 */
export type OAuthState =
  | { kind: "link"; userId: string }
  | { kind: "install"; userId: string; workspaceId: string; timezone: string };

const TTL_MS = 10 * 60 * 1000;
const b64u = (b: Buffer) => b.toString("base64url");
const sign = (payload: string) =>
  b64u(createHmac("sha256", config.jwtSecret).update(`discord-oauth-state.${payload}`).digest());

export function createState(state: OAuthState, now = Date.now()): string {
  const payload = b64u(Buffer.from(JSON.stringify({ ...state, n: b64u(randomBytes(12)), exp: now + TTL_MS })));
  return `${payload}.${sign(payload)}`;
}

export function readState(token: string | undefined, now = Date.now()): OAuthState | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.exp !== "number" || data.exp < now) return null;
    if (data.kind === "link" && typeof data.userId === "string") return { kind: "link", userId: data.userId };
    if (data.kind === "install" && typeof data.userId === "string" && typeof data.workspaceId === "string")
      return { kind: "install", userId: data.userId, workspaceId: data.workspaceId, timezone: typeof data.timezone === "string" ? data.timezone : "UTC" };
    return null;
  } catch {
    return null;
  }
}
