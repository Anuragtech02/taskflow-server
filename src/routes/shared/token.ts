import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";

const { documentShares, documents } = schema;

export default async function sharedTokenRoutes(fastify: FastifyInstance) {
  // GET /shared/:token - Public document access (no auth required)
  fastify.get("/shared/:token", async (request, reply) => {
    try {
      const { token } = request.params as { token: string };

      if (!token || token.length < 16) {
        return reply.status(400).send({ error: "Invalid share token" });
      }

      const share = await db.query.documentShares.findFirst({
        where: eq(documentShares.shareToken, token),
      });

      if (!share) return reply.status(404).send({ error: "Share link not found or expired" });

      const doc = await db.query.documents.findFirst({
        where: eq(documents.id, share.documentId),
        with: { creator: { columns: { id: true, name: true } } },
      });

      if (!doc) return reply.status(404).send({ error: "Document not found" });

      return {
        document: {
          id: doc.id,
          title: doc.title,
          content: doc.content,
          icon: doc.icon,
          coverUrl: doc.coverUrl,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          creator: {
            id: doc.creator.id,
            name: doc.creator.name,
          },
        },
        role: share.role,
      };
    } catch (error) {
      console.error("Error fetching shared document:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
