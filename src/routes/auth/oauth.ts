import { FastifyInstance } from "fastify";
import { timingSafeEqual, createHash } from "crypto";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";

const { users, workspaces, workspaceMembers, spaces } = schema;

function verifyInternalSecret(provided: string | undefined): boolean {
  if (!config.internalApiSecret || !provided) return false;

  // Hash both to normalize length, then compare in constant time
  const expectedHash = createHash("sha256").update(config.internalApiSecret).digest();
  const receivedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}

export default async function oauthRoutes(fastify: FastifyInstance) {
  fastify.post("/auth/oauth", async (request, reply) => {
    // Verify internal API secret (constant-time comparison)
    const secret = request.headers["x-internal-secret"] as string | undefined;
    if (!verifyInternalSecret(secret)) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    try {
      const body = request.body as Record<string, unknown>;
      const email = body?.email as string | undefined;
      const name = body?.name as string | undefined;
      const avatarUrl = body?.avatarUrl as string | undefined;

      if (!email) {
        return reply.status(400).send({ error: "Email is required" });
      }

      // Check if user already exists
      const existingUser = await db.query.users.findFirst({
        where: eq(users.email, email),
      });

      if (existingUser) {
        // Update avatar if provided and changed
        if (avatarUrl && avatarUrl !== existingUser.avatarUrl) {
          await db
            .update(users)
            .set({ avatarUrl })
            .where(eq(users.id, existingUser.id));
        }

        return reply.send({
          user: {
            id: existingUser.id,
            name: existingUser.name,
            email: existingUser.email,
            avatarUrl: avatarUrl || existingUser.avatarUrl,
          },
          isNewUser: false,
        });
      }

      // Create new user + workspace + default space
      const result = await db.transaction(async (tx) => {
        const displayName = name || email.split("@")[0];

        const [newUser] = await tx
          .insert(users)
          .values({
            name: displayName,
            email,
            avatarUrl: avatarUrl || null,
          })
          .returning();

        const slug = newUser.id.slice(0, 8);

        const [newWorkspace] = await tx
          .insert(workspaces)
          .values({
            name: `${displayName}'s Workspace`,
            slug,
            ownerId: newUser.id,
            plan: "free",
            status: "active",
          })
          .returning();

        await tx.insert(workspaceMembers).values({
          workspaceId: newWorkspace.id,
          userId: newUser.id,
          role: "owner",
        });

        await tx.insert(spaces).values({
          workspaceId: newWorkspace.id,
          name: "Inbox",
          description: "Your default task space",
          color: "#6366f1",
          icon: "inbox",
          order: 0,
        });

        return newUser;
      });

      return reply.status(201).send({
        user: {
          id: result.id,
          name: result.name,
          email: result.email,
          avatarUrl: result.avatarUrl,
        },
        isNewUser: true,
      });
    } catch (error) {
      console.error("OAuth user creation error:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
