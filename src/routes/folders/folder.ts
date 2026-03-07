import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { folders, lists, spaces, workspaceMembers } = schema;

const updateFolderSchema = z.object({ name: z.string().min(1).max(255).optional() });
const createListSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  order: z.number().optional(),
});

async function checkFolderAccess(folderId: string, userId: string) {
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, folderId), with: { space: true } });
  if (!folder) return null;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, folder.space.workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return membership ? { folder, space: folder.space, membership } : null;
}

export default async function folderRoutes(fastify: FastifyInstance) {
  // PATCH /folders/:id
  fastify.patch("/folders/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkFolderAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Folder not found" });
      const body = request.body as Record<string, unknown>;
      const parsed = updateFolderSchema.safeParse(body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid data", details: parsed.error.flatten() });
      const [updated] = await db.update(folders).set(parsed.data).where(eq(folders.id, id)).returning();
      return { folder: updated };
    } catch (error) {
      console.error("Error updating folder:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /folders/:id
  fastify.delete("/folders/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkFolderAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Folder not found" });
      if (!["owner", "admin"].includes(access.membership.role)) return reply.status(403).send({ error: "Only owners and admins can delete folders" });
      await db.delete(folders).where(eq(folders.id, id));
      return { success: true };
    } catch (error) {
      console.error("Error deleting folder:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /folders/:id/lists
  fastify.get("/folders/:id/lists", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: folderId } = request.params as { id: string };
    try {
      const access = await checkFolderAccess(folderId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Folder not found" });
      const folderLists = await db.select().from(lists).where(eq(lists.folderId, folderId)).orderBy(lists.order);
      return { lists: folderLists };
    } catch (error) {
      console.error("Error fetching lists:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /folders/:id/lists
  fastify.post("/folders/:id/lists", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: folderId } = request.params as { id: string };
    try {
      const access = await checkFolderAccess(folderId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "Folder not found" });
      const body = request.body as Record<string, unknown>;
      const validatedData = createListSchema.parse(body);
      const [list] = await db.insert(lists).values({
        folderId, spaceId: access.folder.spaceId, name: validatedData.name,
        description: validatedData.description, order: validatedData.order ?? 0,
      }).returning();
      return reply.status(201).send({ list });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating list:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
