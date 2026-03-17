import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { Server } from "@hocuspocus/server";
import { jwtVerify } from "jose";
import { db, schema } from "../db/index.js";
import { eq, and, sql } from "drizzle-orm";
import { config } from "../config.js";
import * as Y from "yjs";

const { documents, documentVersions, documentShares } = schema;

interface CollabToken {
  userId: string;
  documentId: string;
  role: "editor" | "viewer" | "commenter";
}

async function hocuspocusPlugin(fastify: FastifyInstance) {
  const server = Server.configure({
    async onAuthenticate({ token, documentName }) {
      // Collab tokens are signed JWTs (HS256) created by our collab-token route
      try {
        const secret = new TextEncoder().encode(config.jwtSecret);
        const { payload } = await jwtVerify(token, secret, {
          algorithms: ["HS256"],
        });
        const decoded = payload as unknown as CollabToken;
        if (decoded.documentId !== documentName) {
          throw new Error("Token document mismatch");
        }
        return {
          user: {
            id: decoded.userId,
            role: decoded.role,
          },
        };
      } catch {
        // Try share token
        const share = await db.query.documentShares.findFirst({
          where: and(
            eq(documentShares.shareToken, token),
            eq(documentShares.documentId, documentName)
          ),
        });
        if (share) {
          return {
            user: {
              id: share.userId || "anonymous",
              role: share.role as string,
            },
          };
        }
        throw new Error("Unauthorized");
      }
    },

    async onLoadDocument({ document, documentName }) {
      try {
        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, documentName),
        });

        if (doc?.ydocState) {
          const state = doc.ydocState as Buffer;
          Y.applyUpdate(document, new Uint8Array(state));
        } else if (doc?.content && typeof doc.content === "object" && (doc.content as any).content?.length) {
          // No ydocState but content exists (e.g. created via API/MCP)
          // Insert content into the Yjs XML fragment so the editor renders it
          const fragment = document.getXmlFragment("default");
          const jsonContent = doc.content as { type?: string; content?: any[] };
          if (jsonContent.content) {
            for (const node of jsonContent.content) {
              const el = new Y.XmlElement(node.type || "paragraph");
              if (node.content) {
                for (const child of node.content) {
                  if (child.type === "text" && child.text) {
                    el.insert(0, [new Y.XmlText(child.text)]);
                  }
                }
              }
              fragment.push([el]);
            }
          }
        }
      } catch (err) {
        console.error(`Failed to load document ${documentName}:`, err);
      }

      return document;
    },

    async onStoreDocument({ document, documentName }) {
      try {
        const state = Y.encodeStateAsUpdate(document);
        const content = document.getXmlFragment("default").toJSON();

        await db
          .update(documents)
          .set({
            ydocState: Buffer.from(state) as any,
            content: content || {},
            updatedAt: new Date(),
          })
          .where(eq(documents.id, documentName));

        // Auto-version every 5 minutes
        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, documentName),
          columns: { lastVersionAt: true, title: true, creatorId: true },
        });

        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
        if (!doc?.lastVersionAt || doc.lastVersionAt < fiveMinAgo) {
          const createdBy = doc!.creatorId;
          // Use atomic insert with subquery to prevent version numbering race
          await db.execute(sql`
            INSERT INTO document_versions (id, document_id, version_number, title, content, ydoc_state, created_by)
            SELECT gen_random_uuid(), ${documentName}, COALESCE(MAX(version_number), 0) + 1, ${doc?.title || "Untitled"}, ${JSON.stringify(content || {})}::jsonb, ${Buffer.from(state)}, ${createdBy}
            FROM document_versions WHERE document_id = ${documentName}
          `);

          await db
            .update(documents)
            .set({ lastVersionAt: new Date() })
            .where(eq(documents.id, documentName));
        }
      } catch (err) {
        console.error(`Failed to store document ${documentName}:`, err);
      }
    },
  });

  // Handle WebSocket upgrade for /collab path
  fastify.get("/collab", { websocket: true }, (socket, request) => {
    server.handleConnection(socket, request.raw);
  });

  fastify.decorate("hocuspocus", server);

  fastify.addHook("onClose", async () => {
    await server.destroy();
  });
}

declare module "fastify" {
  interface FastifyInstance {
    hocuspocus: ReturnType<typeof Server.configure>;
  }
}

export default fp(hocuspocusPlugin, {
  name: "hocuspocus",
  dependencies: ["auth"],
});
