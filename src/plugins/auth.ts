import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { createHash } from "crypto";
import { jwtDecrypt } from "jose";
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
 * matching NextAuth v5's JWE token format (A256CBC-HS512).
 */
let _encryptionKey: Uint8Array | null = null;
async function getEncryptionKey(): Promise<Uint8Array> {
  if (_encryptionKey) return _encryptionKey;

  const encoder = new TextEncoder();
  const secret = encoder.encode(config.jwtSecret);

  // NextAuth v5 derives a 64-byte key using HKDF with SHA-256
  // info = "NextAuth.js Generated Encryption Key" + salt (empty)
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(""),
      info: encoder.encode("NextAuth.js Generated Encryption Key"),
    },
    keyMaterial,
    512 // 64 bytes for A256CBC-HS512
  );

  _encryptionKey = new Uint8Array(derivedBits);
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
    // Log for debugging but don't expose details
    if (process.env.NODE_ENV !== "production") {
      console.debug("Session token verification failed:", (err as Error).message);
    }
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
