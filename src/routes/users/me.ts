import { FastifyInstance } from "fastify";
import { z } from "zod";
import { compare, hash } from "bcryptjs";
import { randomBytes, createHash } from "crypto";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { users, apiKeys } = schema;

const updateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  avatarUrl: z.string().url().optional().or(z.literal("")),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
});

const createKeySchema = z.object({
  name: z.string().min(1).max(255),
  expiresAt: z.string().datetime().optional().refine(
    (val) => !val || new Date(val) > new Date(),
    { message: "Expiration date must be in the future" }
  ),
});

export default async function userRoutes(fastify: FastifyInstance) {
  // PATCH /users/me
  fastify.patch("/users/me", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    try {
      const body = request.body as Record<string, unknown>;
      const validatedData = updateUserSchema.parse(body);

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (validatedData.name !== undefined) updateData.name = validatedData.name;
      if (validatedData.avatarUrl !== undefined) updateData.avatarUrl = validatedData.avatarUrl || null;

      const [user] = await db.update(users).set(updateData).where(eq(users.id, authResult.userId)).returning();

      return { user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl } };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "Validation error", details: error.issues });
      }
      console.error("Error updating user:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /users/me/password
  fastify.patch("/users/me/password", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    try {
      const body = request.body as Record<string, unknown>;
      const validatedData = passwordSchema.parse(body);

      const user = await db.query.users.findFirst({ where: eq(users.id, authResult.userId) });
      if (!user) return reply.status(404).send({ error: "User not found" });
      if (!user.passwordHash) return reply.status(400).send({ error: "No password set. Please use social login." });

      const isValid = await compare(validatedData.currentPassword, user.passwordHash);
      if (!isValid) return reply.status(400).send({ error: "Current password is incorrect" });

      const hashedPassword = await hash(validatedData.newPassword, 12);
      await db.update(users).set({ passwordHash: hashedPassword, updatedAt: new Date() }).where(eq(users.id, authResult.userId));

      return { success: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "Validation error", details: error.issues });
      }
      console.error("Error changing password:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /users/me/api-keys
  fastify.get("/users/me/api-keys", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    try {
      const keys = await db.query.apiKeys.findMany({
        where: eq(apiKeys.userId, authResult.userId),
        columns: { id: true, name: true, keyPrefix: true, lastUsedAt: true, expiresAt: true, createdAt: true },
      });
      return { apiKeys: keys };
    } catch (error) {
      console.error("Error fetching API keys:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /users/me/api-keys
  fastify.post("/users/me/api-keys", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    try {
      const body = request.body as Record<string, unknown>;
      const { name, expiresAt } = createKeySchema.parse(body);

      const rawKey = `tf_${randomBytes(24).toString("hex")}`;
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.slice(0, 12) + "...";

      const [created] = await db.insert(apiKeys).values({
        userId: authResult.userId,
        keyHash,
        keyPrefix,
        name,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      }).returning({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
        expiresAt: apiKeys.expiresAt,
      });

      return reply.status(201).send({ apiKey: { ...created, key: rawKey } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "Validation error", details: error.issues });
      }
      console.error("Error creating API key:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /users/me/api-keys
  fastify.delete("/users/me/api-keys", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    try {
      const { keyId } = request.query as { keyId?: string };
      if (!keyId) return reply.status(400).send({ error: "keyId parameter is required" });

      const deleted = await db.delete(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, authResult.userId)))
        .returning({ id: apiKeys.id });

      if (deleted.length === 0) return reply.status(404).send({ error: "API key not found" });
      return { success: true };
    } catch (error) {
      console.error("Error deleting API key:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
