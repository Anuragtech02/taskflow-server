import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { randomBytes } from "crypto";

const { documents, documentShares, workspaceMembers, users } = schema;

const VALID_ROLES = ["viewer", "editor", "commenter"];
const VALID_SHARE_TYPES = ["user", "link"];

export default async function documentShareRoutes(fastify: FastifyInstance) {
  // GET /documents/:id/shares
  fastify.get("/documents/:id/shares", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId } = request.params as { id: string };

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const shares = await db.query.documentShares.findMany({
        where: eq(documentShares.documentId, documentId),
        with: { user: true },
      });

      return {
        shares: shares.map((s) => ({
          id: s.id,
          documentId: s.documentId,
          userId: s.userId,
          userName: s.user?.name || null,
          userEmail: s.user?.email || null,
          userAvatarUrl: s.user?.avatarUrl || null,
          role: s.role,
          shareToken: s.shareToken,
          shareType: s.shareType,
          createdAt: s.createdAt,
        })),
      };
    } catch (error) {
      console.error("Error fetching document shares:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /documents/:id/shares
  fastify.post("/documents/:id/shares", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId } = request.params as { id: string };
      const body = request.body as { userId?: string; email?: string; role?: string; shareType?: string };

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, documentId),
      });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const role = body.role || "viewer";
      if (!VALID_ROLES.includes(role)) {
        return reply.status(400).send({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
      }

      const shareType = body.shareType || "user";
      if (!VALID_SHARE_TYPES.includes(shareType)) {
        return reply.status(400).send({ error: `Invalid shareType. Must be one of: ${VALID_SHARE_TYPES.join(", ")}` });
      }

      if (shareType === "link") {
        const token = randomBytes(32).toString("hex");
        const [share] = await db
          .insert(documentShares)
          .values({ documentId, role, shareToken: token, shareType: "link" })
          .returning();
        return { share: { ...share, shareUrl: `/share/${token}` } };
      }

      // User share - find by userId or email
      let targetUserId = body.userId;
      if (!targetUserId && body.email) {
        const user = await db.query.users.findFirst({
          where: eq(users.email, body.email),
        });
        if (!user) return reply.status(404).send({ error: "User not found" });
        targetUserId = user.id;
      }
      if (!targetUserId) return reply.status(400).send({ error: "userId or email required" });

      // Check if share already exists
      const existing = await db.query.documentShares.findFirst({
        where: and(eq(documentShares.documentId, documentId), eq(documentShares.userId, targetUserId)),
      });
      if (existing) return reply.status(409).send({ error: "Share already exists" });

      const [share] = await db
        .insert(documentShares)
        .values({ documentId, userId: targetUserId, role, shareType: "user" })
        .returning();

      return { share };
    } catch (error) {
      console.error("Error creating document share:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /documents/:id/shares/:shareId
  fastify.patch("/documents/:id/shares/:shareId", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId, shareId } = request.params as { id: string; shareId: string };
      const body = request.body as { role?: string };

      if (body.role && !VALID_ROLES.includes(body.role)) {
        return reply.status(400).send({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
      }

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const [updated] = await db
        .update(documentShares)
        .set({ role: body.role })
        .where(and(eq(documentShares.id, shareId), eq(documentShares.documentId, documentId)))
        .returning();

      if (!updated) return reply.status(404).send({ error: "Share not found" });
      return { share: updated };
    } catch (error) {
      console.error("Error updating document share:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /documents/:id/shares/:shareId
  fastify.delete("/documents/:id/shares/:shareId", async (request, reply) => {
    try {
      const authResult = await authenticateRequest(request);
      if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
      const { id: documentId, shareId } = request.params as { id: string; shareId: string };

      const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
      if (!doc) return reply.status(404).send({ error: "Document not found" });

      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, doc.workspaceId), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      await db
        .delete(documentShares)
        .where(and(eq(documentShares.id, shareId), eq(documentShares.documentId, documentId)));

      return { success: true };
    } catch (error) {
      console.error("Error deleting document share:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
