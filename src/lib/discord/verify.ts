import { createPublicKey, verify, type KeyObject } from "node:crypto";

// DER prefix that wraps a raw 32-byte Ed25519 public key as SPKI, so Node's
// built-in crypto can verify Discord's signatures without a dependency.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// Reject replays of captured requests beyond this age.
const MAX_SKEW_SECONDS = 5 * 60;

const keyCache = new Map<string, KeyObject>();
function publicKeyFor(hex: string): KeyObject {
  let key = keyCache.get(hex);
  if (!key) {
    key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
    keyCache.set(hex, key);
  }
  return key;
}

/**
 * Verify an interaction request came from Discord: Ed25519 over
 * `timestamp + rawBody` with the application's public key. Discord itself
 * probes the endpoint with invalid signatures and disables it if they're
 * accepted, so every failure path must return false.
 */
export function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  try {
    return verify(null, Buffer.from(timestamp + rawBody), publicKeyFor(publicKeyHex), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
