import { FastifyInstance } from "fastify";
import { hash } from "bcryptjs";
import crypto from "crypto";
import { db, schema } from "../../db/index.js";
import { eq, and, gt } from "drizzle-orm";
import { sendPasswordResetEmail } from "../../lib/email.js";

const { users } = schema;

export default async function passwordResetRoutes(fastify: FastifyInstance) {
  // POST /auth/forgot-password
  fastify.post("/auth/forgot-password", async (request, reply) => {
    const { email } = request.body as { email?: string };

    if (!email) {
      return reply.status(400).send({ error: "Email is required" });
    }

    // Always return the same response to prevent email enumeration
    const successMessage = "If an account exists with that email, a reset link has been sent.";

    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email.toLowerCase().trim()))
        .limit(1);

      if (!user || !user.passwordHash) {
        return { message: successMessage };
      }

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await db
        .update(users)
        .set({ resetToken: token, resetTokenExpiresAt: expiresAt })
        .where(eq(users.id, user.id));

      sendPasswordResetEmail(email, token).catch(console.error);
    } catch (error) {
      console.error("Forgot password error:", error);
    }

    return { message: successMessage };
  });

  // POST /auth/reset-password
  fastify.post("/auth/reset-password", async (request, reply) => {
    const { token, password } = request.body as { token?: string; password?: string };

    if (!token || !password) {
      return reply.status(400).send({ error: "Token and password are required" });
    }

    if (password.length < 8) {
      return reply.status(400).send({ error: "Password must be at least 8 characters" });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.resetToken, token), gt(users.resetTokenExpiresAt, new Date())))
      .limit(1);

    if (!user) {
      return reply.status(400).send({ error: "Invalid or expired reset link" });
    }

    const passwordHash = await hash(password, 12);

    await db
      .update(users)
      .set({ passwordHash, resetToken: null, resetTokenExpiresAt: null })
      .where(eq(users.id, user.id));

    return { message: "Password reset successfully" };
  });
}
