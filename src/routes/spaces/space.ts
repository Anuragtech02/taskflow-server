import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { spaces, lists, folders, workspaceMembers } = schema;

const updateSpaceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  color: z.string().max(7).optional(),
  icon: z.string().max(50).optional(),
});

const createListSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  order: z.number().optional(),
});

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  order: z.number().optional(),
});

async function checkSpaceAccess(spaceId: string, userId: string) {
  const space = await db.query.spaces.findFirst({ where: eq(spaces.id, spaceId) });
  if (!space) return null;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, space.workspaceId), eq(workspaceMembers.userId, userId)),
  });
  if (!membership) return null;
  return { space, membership };
}

export default async function spaceRoutes(fastify: FastifyInstance) {
  // GET /spaces/:id
  fastify.get("/spaces/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkSpaceAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Space not found" });
      return { space: access.space };
    } catch (error) {
      console.error("Error fetching space:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /spaces/:id
  fastify.patch("/spaces/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkSpaceAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Space not found" });
      const body = request.body as Record<string, unknown>;
      const parsed = updateSpaceSchema.safeParse(body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid data", details: parsed.error.flatten() });
      const [updated] = await db.update(spaces).set(parsed.data).where(eq(spaces.id, id)).returning();
      return { space: updated };
    } catch (error) {
      console.error("Error updating space:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /spaces/:id
  fastify.delete("/spaces/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkSpaceAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Space not found" });
      if (!["owner", "admin"].includes(access.membership.role)) return reply.status(403).send({ error: "Only owners and admins can delete spaces" });
      await db.delete(spaces).where(eq(spaces.id, id));
      return { success: true };
    } catch (error) {
      console.error("Error deleting space:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /spaces/:id/lists
  fastify.get("/spaces/:id/lists", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: spaceId } = request.params as { id: string };
    try {
      const access = await checkSpaceAccess(spaceId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Space not found" });
      const spaceLists = await db.select().from(lists).where(and(eq(lists.spaceId, spaceId), isNull(lists.folderId))).orderBy(lists.order);
      return { lists: spaceLists };
    } catch (error) {
      console.error("Error fetching lists:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /spaces/:id/lists
  fastify.post("/spaces/:id/lists", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: spaceId } = request.params as { id: string };
    try {
      const access = await checkSpaceAccess(spaceId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Space not found" });
      const body = request.body as Record<string, unknown>;
      const validatedData = createListSchema.parse(body);
      const [list] = await db.insert(lists).values({
        spaceId, folderId: null, name: validatedData.name, description: validatedData.description, order: validatedData.order ?? 0,
      }).returning();
      return reply.status(201).send({ list });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating list:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /spaces/:id/folders
  fastify.get("/spaces/:id/folders", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: spaceId } = request.params as { id: string };
    try {
      const access = await checkSpaceAccess(spaceId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Space not found" });
      const spaceFolders = await db.select().from(folders).where(eq(folders.spaceId, spaceId)).orderBy(folders.order);
      return { folders: spaceFolders };
    } catch (error) {
      console.error("Error fetching folders:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /spaces/:id/folders
  fastify.post("/spaces/:id/folders", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: spaceId } = request.params as { id: string };
    try {
      const access = await checkSpaceAccess(spaceId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Space not found" });
      const body = request.body as Record<string, unknown>;
      const validatedData = createFolderSchema.parse(body);
      const [folder] = await db.insert(folders).values({ spaceId, name: validatedData.name, order: validatedData.order ?? 0 }).returning();
      return reply.status(201).send({ folder });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating folder:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
