import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { documents, documentVersions, workspaceMembers, users } = schema;

export default async function documentVersionRoutes(fastify: FastifyInstance) {
  // GET /documents/:id/versions
  fastify.get("/documents/:id/versions", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId } = request.params as { id: string };

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const versions = await db
        .select({
          id: documentVersions.id,
          versionNumber: documentVersions.versionNumber,
          title: documentVersions.title,
          createdAt: documentVersions.createdAt,
          createdBy: documentVersions.createdBy,
          userName: users.name,
        })
        .from(documentVersions)
        .leftJoin(users, eq(documentVersions.createdBy, users.id))
        .where(eq(documentVersions.documentId, documentId))
        .orderBy(desc(documentVersions.versionNumber))
        .limit(50);

      return { versions };
    } catch (error) {
      console.error("Error fetching document versions:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /documents/:id/versions/:versionId
  fastify.get("/documents/:id/versions/:versionId", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId, versionId } = request.params as { id: string; versionId: string };

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const version = await db.query.documentVersions.findFirst({
        where: and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId)),
        with: { creator: true },
      });

      if (!version) return reply.status(404).send({ error: "Version not found" });

      return {
        version: {
          id: version.id,
          versionNumber: version.versionNumber,
          title: version.title,
          content: version.content,
          createdAt: version.createdAt,
          creator: {
            id: version.creator.id,
            name: version.creator.name,
          },
        },
      };
    } catch (error) {
      console.error("Error fetching document version:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /documents/:id/versions (manual save)
  fastify.post("/documents/:id/versions", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId } = request.params as { id: string };

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      // Use atomic insert with subquery for version numbering
      const result = await db.execute(sql`
        INSERT INTO document_versions (id, document_id, version_number, title, content, ydoc_state, created_by)
        SELECT gen_random_uuid(), ${documentId}, COALESCE(MAX(version_number), 0) + 1, ${doc.title}, ${JSON.stringify(doc.content || {})}::jsonb, ${doc.ydocState || null}, ${authResult.userId}
        FROM document_versions WHERE document_id = ${documentId}
        RETURNING *
      `);

      await db
        .update(documents)
        .set({ lastVersionAt: new Date() })
        .where(eq(documents.id, documentId));

      return { version: result[0] };
    } catch (error) {
      console.error("Error creating document version:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /documents/:id/versions/:versionId/restore
  fastify.post("/documents/:id/versions/:versionId/restore", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId, versionId } = request.params as { id: string; versionId: string };

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const version = await db.query.documentVersions.findFirst({
        where: and(eq(documentVersions.id, versionId), eq(documentVersions.documentId, documentId)),
      });
      if (!version) return reply.status(404).send({ error: "Version not found" });

      // Save current state as a version before restoring (atomic)
      await db.execute(sql`
        INSERT INTO document_versions (id, document_id, version_number, title, content, ydoc_state, created_by)
        SELECT gen_random_uuid(), ${documentId}, COALESCE(MAX(version_number), 0) + 1, ${doc.title}, ${JSON.stringify(doc.content || {})}::jsonb, ${doc.ydocState || null}, ${authResult.userId}
        FROM document_versions WHERE document_id = ${documentId}
      `);

      // Restore the selected version
      await db
        .update(documents)
        .set({
          content: version.content || {},
          ydocState: version.ydocState as any,
          updatedAt: new Date(),
          lastVersionAt: new Date(),
        })
        .where(eq(documents.id, documentId));

      return { success: true, restoredVersion: version.versionNumber };
    } catch (error) {
      console.error("Error restoring document version:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
