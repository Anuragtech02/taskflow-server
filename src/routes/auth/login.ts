import { FastifyInstance } from "fastify";
import { compare } from "bcryptjs";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";

const { users } = schema;

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 5;
const WINDOW_MS = 60 * 1000;
const MAX_PASSWORD_LENGTH = 128;

// Dummy bcrypt hash used when the requested user doesn't exist.
// Without this, a missing-user response returns instantly (~5ms) while a
// wrong-password response takes ~200ms (bcrypt is intentionally slow).
// That timing difference lets attackers enumerate valid email addresses.
// By always running bcrypt.compare — against this throwaway hash when the
// user isn't found — both paths take the same ~200ms, closing the side-channel.
const DUMMY_HASH = "$2a$12$000000000000000000000uGBYHtzVCela0RCTkRJCe1eMYCEYOXyy";

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + WINDOW_MS });
    return true;
  }
  if (record.count >= RATE_LIMIT) return false;
  record.count++;
  return true;
}

// Periodic cleanup of expired rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetTime) rateLimitMap.delete(key);
  }
}, 60_000).unref();

export default async function loginRoutes(fastify: FastifyInstance) {
  fastify.post("/auth/login", async (request, reply) => {
    const clientIp = request.ip;

    if (!checkRateLimit(clientIp)) {
      return reply.status(429).send({ error: "Too many requests. Please try again later." });
    }

    try {
      const body = request.body as Record<string, unknown>;
      const email = body?.email as string | undefined;
      const password = body?.password as string | undefined;

      if (!email || !password) {
        return reply.status(400).send({ error: "Email and password are required" });
      }

      if (password.length > MAX_PASSWORD_LENGTH) {
        return reply.status(400).send({ error: "Invalid credentials" });
      }

      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });

      // Always run bcrypt compare to prevent timing-based user enumeration
      const hashToCompare = user?.passwordHash || DUMMY_HASH;
      const isPasswordValid = await compare(password, hashToCompare);

      if (!user || !user.passwordHash || !isPasswordValid) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      return reply.send({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
        },
      });
    } catch (error) {
      console.error("Login error:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
