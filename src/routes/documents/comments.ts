import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { documents, documentComments, workspaceMembers } = schema;

export default async function documentCommentRoutes(fastify: FastifyInstance) {
  // GET /documents/:id/comments
  fastify.get("/documents/:id/comments", async (request, reply) => {
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

      const comments = await db.query.documentComments.findMany({
        where: eq(documentComments.documentId, documentId),
        with: { user: true, replies: { with: { user: true } } },
        orderBy: documentComments.createdAt,
      });

      return {
        comments: comments
          .filter((c) => !c.parentCommentId)
          .map((c) => ({
            id: c.id,
            content: c.content,
            markId: c.markId,
            quotedText: c.quotedText,
            resolved: c.resolved,
            resolvedAt: c.resolvedAt,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            user: { id: c.user.id, name: c.user.name, email: c.user.email, avatarUrl: c.user.avatarUrl },
            replies: c.replies.map((r) => ({
              id: r.id,
              content: r.content,
              createdAt: r.createdAt,
              user: { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl },
            })),
          })),
      };
    } catch (error) {
      console.error("Error fetching document comments:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /documents/:id/comments
  fastify.post("/documents/:id/comments", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId } = request.params as { id: string };
      const body = request.body as {
        content: string;
        markId?: string;
        quotedText?: string;
        parentCommentId?: string;
      };

      if (!body.content?.trim()) return reply.status(400).send({ error: "Content required" });

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const [comment] = await db
        .insert(documentComments)
        .values({
          documentId,
          userId: authResult.userId,
          content: body.content.trim(),
          markId: body.markId || null,
          quotedText: body.quotedText || null,
          parentCommentId: body.parentCommentId || null,
        })
        .returning();

      return { comment };
    } catch (error) {
      console.error("Error creating document comment:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /documents/:id/comments/:commentId
  fastify.patch("/documents/:id/comments/:commentId", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId, commentId } = request.params as { id: string; commentId: string };
      const body = request.body as { content?: string; resolved?: boolean };

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      // Only comment author can edit content; anyone can resolve/unresolve
      if (body.content !== undefined) {
        const comment = await db.query.documentComments.findFirst({
          where: and(eq(documentComments.id, commentId), eq(documentComments.documentId, documentId)),
        });
        if (!comment) return reply.status(404).send({ error: "Comment not found" });
        if (comment.userId !== authResult.userId) {
          return reply.status(403).send({ error: "Only the comment author can edit content" });
        }
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (body.content !== undefined) updateData.content = body.content.trim();
      if (body.resolved !== undefined) {
        updateData.resolved = body.resolved;
        updateData.resolvedBy = body.resolved ? authResult.userId : null;
        updateData.resolvedAt = body.resolved ? new Date() : null;
      }

      const [updated] = await db
        .update(documentComments)
        .set(updateData)
        .where(and(eq(documentComments.id, commentId), eq(documentComments.documentId, documentId)))
        .returning();

      if (!updated) return reply.status(404).send({ error: "Comment not found" });
      return { comment: updated };
    } catch (error) {
      console.error("Error updating document comment:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /documents/:id/comments/:commentId
  fastify.delete("/documents/:id/comments/:commentId", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId, commentId } = request.params as { id: string; commentId: string };

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      // Check workspace membership
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      // Only comment author or workspace admin/owner can delete
      const comment = await db.query.documentComments.findFirst({
        where: and(eq(documentComments.id, commentId), eq(documentComments.documentId, documentId)),
      });
      if (!comment) return reply.status(404).send({ error: "Comment not found" });

      if (comment.userId !== authResult.userId && !["owner", "admin"].includes(membership.role)) {
        return reply.status(403).send({ error: "Not authorized to delete this comment" });
      }

      await db
        .delete(documentComments)
        .where(and(eq(documentComments.id, commentId), eq(documentComments.documentId, documentId)));

      return { success: true };
    } catch (error) {
      console.error("Error deleting document comment:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
