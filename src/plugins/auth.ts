import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { createHash } from "crypto";
import { jwtDecrypt } from "jose";
import { hkdf } from "@panva/hkdf";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { config } from "../config.js";

export interface AuthResult {
  userId: string;
  source: "api_key" | "session";
}

declare module "fastify" {
  interface FastifyRequest {
    authResult?: AuthResult | null;
  }
}

async function authenticateApiKey(token: string): Promise<AuthResult | null> {
  const hash = createHash("sha256").update(token).digest("hex");

  const key = await db.query.apiKeys.findFirst({
    where: eq(schema.apiKeys.keyHash, hash),
  });

  if (!key) return null;

  if (key.expiresAt && key.expiresAt < new Date()) {
    return null;
  }

  // Update lastUsedAt (fire-and-forget)
  db.update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, key.id))
    .then(() => {})
    .catch((err: unknown) => console.error("Failed to update API key lastUsedAt:", err));

  return { userId: key.userId, source: "api_key" };
}

/**
 * Derive the encryption key from NEXTAUTH_SECRET using HKDF,
 * matching Auth.js v5's JWE token format (A256CBC-HS512).
 * Auth.js uses the cookie name as salt and includes it in the info string.
 */
let _encryptionKey: Uint8Array<ArrayBuffer> | null = null;
async function getEncryptionKey(): Promise<Uint8Array<ArrayBuffer>> {
  if (_encryptionKey) return _encryptionKey;

  const salt = config.sessionCookieName;
  _encryptionKey = new Uint8Array(
    await hkdf(
      "sha256",
      config.jwtSecret,
      salt,
      `Auth.js Generated Encryption Key (${salt})`,
      64 // 64 bytes for A256CBC-HS512
    )
  );
  return _encryptionKey;
}

async function verifySessionToken(token: string): Promise<{ id: string } | null> {
  try {
    const encryptionKey = await getEncryptionKey();

    // NextAuth v5 uses JWE with A256CBC-HS512 (dir key management)
    const { payload } = await jwtDecrypt(token, encryptionKey, {
      clockTolerance: 15, // 15 seconds clock skew tolerance
    });

    const userId = (payload as Record<string, unknown>).id as string
      || (payload as Record<string, unknown>).sub as string;
    if (!userId) return null;
    return { id: userId };
  } catch (err) {
    console.log("DEBUG_AUTH jwt_decrypt_failed:", (err as Error).message);
    return null;
  }
}

export async function authenticateRequest(
  request: FastifyRequest
): Promise<AuthResult | null> {
  // Try Bearer token first (API key auth)
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const result = await authenticateApiKey(token);
    if (result) return result;
    return null;
  }

  // Fall back to session cookie
  const sessionToken = (request.cookies as Record<string, string | undefined>)?.[config.sessionCookieName];
  console.log("DEBUG_AUTH cookie_name:", config.sessionCookieName, "found:", !!sessionToken, "all_cookies:", Object.keys(request.cookies || {}));
  if (sessionToken) {
    const decoded = await verifySessionToken(sessionToken);
    if (decoded) {
      return { userId: decoded.id, source: "session" };
    }
  }

  return null;
}

async function authPlugin(fastify: FastifyInstance) {
  // Decorate request with authResult
  fastify.decorateRequest("authResult", null);

  // Pre-handler that can be used with route-level onRequest
  fastify.decorate("authenticate", async function (
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    const result = await authenticateRequest(request);
    if (!result) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    request.authResult = result;
  });
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(authPlugin, { name: "auth" });
