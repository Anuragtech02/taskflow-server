import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc, isNull } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { documents, spaces, workspaceMembers } = schema;

const updateDocumentSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  content: z.record(z.string(), z.any()).optional(),
  icon: z.string().max(50).optional(),
  coverUrl: z.string().optional(),
  spaceId: z.string().uuid().optional(),
  parentDocumentId: z.string().uuid().nullable().optional(),
});

const createDocumentSchema = z.object({
  title: z.string().min(1).max(255),
  content: z.record(z.string(), z.any()).default({}),
  icon: z.string().max(50).default("file-text"),
  coverUrl: z.string().optional(),
  spaceId: z.string().uuid().optional(),
  parentDocumentId: z.string().uuid().optional(),
});

export default async function documentRoutes(fastify: FastifyInstance) {
  // GET /documents/:id
  fastify.get("/documents/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const document = await db.query.documents.findFirst({
        where: eq(documents.id, id),
        with: { creator: { columns: { id: true, name: true, avatarUrl: true } } },
      });
      if (!document) return reply.status(404).send({ error: "Document not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, document.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const children = await db.query.documents.findMany({
        where: eq(documents.parentDocumentId, id),
        columns: { id: true, title: true, icon: true, updatedAt: true },
      });
      return { document, children };
    } catch (error) {
      console.error("Error fetching document:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /documents/:id
  fastify.patch("/documents/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const document = await db.query.documents.findFirst({ where: eq(documents.id, id) });
      if (!document) return reply.status(404).send({ error: "Document not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, document.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = updateDocumentSchema.parse(body);
      const [updated] = await db.update(documents).set({ ...validatedData, updatedAt: new Date() }).where(eq(documents.id, id)).returning();
      return { document: updated };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error updating document:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /documents/:id
  fastify.delete("/documents/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const document = await db.query.documents.findFirst({ where: eq(documents.id, id) });
      if (!document) return reply.status(404).send({ error: "Document not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, document.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      await db.delete(documents).where(eq(documents.id, id));
      return { success: true };
    } catch (error) {
      console.error("Error deleting document:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /workspaces/:id/documents
  fastify.get("/workspaces/:id/documents", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const { spaceId, parentId } = request.query as { spaceId?: string; parentId?: string };
      const whereConditions: any[] = [eq(documents.workspaceId, workspaceId)];
      if (spaceId) whereConditions.push(eq(documents.spaceId, spaceId));
      if (parentId) whereConditions.push(eq(documents.parentDocumentId, parentId));
      else if (!spaceId) whereConditions.push(isNull(documents.parentDocumentId));

      const workspaceDocuments = await db.query.documents.findMany({
        where: and(...whereConditions),
        with: { creator: { columns: { id: true, name: true, avatarUrl: true } } },
        limit: 500,
      });
      return { documents: workspaceDocuments };
    } catch (error) {
      console.error("Error fetching documents:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /workspaces/:id/documents
  fastify.post("/workspaces/:id/documents", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createDocumentSchema.parse(body);

      // Assign to provided spaceId or first space in workspace
      let spaceId = validatedData.spaceId;
      if (!spaceId) {
        const firstSpace = await db.query.spaces.findFirst({
          where: eq(spaces.workspaceId, workspaceId),
          orderBy: [asc(spaces.order)],
        });
        if (!firstSpace) return reply.status(400).send({ error: "No spaces in workspace" });
        spaceId = firstSpace.id;
      }

      const [document] = await db.insert(documents).values({ ...validatedData, workspaceId, spaceId, creatorId: authResult.userId }).returning();
      return reply.status(201).send({ document });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating document:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /spaces/:spaceId/documents
  fastify.get("/spaces/:spaceId/documents", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { spaceId } = request.params as { spaceId: string };
    try {
      const space = await db.query.spaces.findFirst({ where: eq(spaces.id, spaceId) });
      if (!space) return reply.status(404).send({ error: "Space not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, space.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const spaceDocuments = await db.query.documents.findMany({
        where: eq(documents.spaceId, spaceId),
        with: { creator: { columns: { id: true, name: true, avatarUrl: true } } },
        limit: 500,
      });
      return { documents: spaceDocuments };
    } catch (error) {
      console.error("Error fetching space documents:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /spaces/:spaceId/documents
  fastify.post("/spaces/:spaceId/documents", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { spaceId } = request.params as { spaceId: string };
    try {
      const space = await db.query.spaces.findFirst({ where: eq(spaces.id, spaceId) });
      if (!space) return reply.status(404).send({ error: "Space not found" });
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, space.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const validatedData = createDocumentSchema.parse(body);
      const [document] = await db.insert(documents).values({
        ...validatedData, workspaceId: space.workspaceId, spaceId, creatorId: authResult.userId,
      }).returning();
      return reply.status(201).send({ document });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating space document:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
