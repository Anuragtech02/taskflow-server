import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { workspaces, workspaceMembers, spaces } = schema;

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
  subdomain: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/).optional(),
  logoUrl: z.string().optional(),
  plan: z.enum(["free", "pro", "enterprise"]).optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/).optional(),
  logoUrl: z.string().optional(),
});

export default async function workspaceRoutes(fastify: FastifyInstance) {
  // GET /workspaces
  fastify.get("/workspaces", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    try {
      const userWorkspaces = await db
        .select({
          id: workspaces.id, name: workspaces.name, slug: workspaces.slug,
          subdomain: workspaces.subdomain, logoUrl: workspaces.logoUrl,
          plan: workspaces.plan, status: workspaces.status,
          createdAt: workspaces.createdAt, role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(eq(workspaceMembers.userId, authResult.userId));

      return { workspaces: userWorkspaces };
    } catch (error) {
      console.error("Error fetching workspaces:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /workspaces
  fastify.post("/workspaces", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    try {
      const body = request.body as Record<string, unknown>;
      const validatedData = createWorkspaceSchema.parse(body);

      const existingWorkspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.slug, validatedData.slug),
      });
      if (existingWorkspace) return reply.status(409).send({ error: "Workspace slug already exists" });

      if (validatedData.subdomain) {
        const existingSubdomain = await db.query.workspaces.findFirst({
          where: eq(workspaces.subdomain, validatedData.subdomain.toLowerCase()),
        });
        if (existingSubdomain) return reply.status(409).send({ error: "Subdomain is not available" });
      }

      const [workspace] = await db.insert(workspaces).values({
        name: validatedData.name, slug: validatedData.slug,
        subdomain: validatedData.subdomain?.toLowerCase(),
        ownerId: authResult.userId, logoUrl: validatedData.logoUrl,
        plan: validatedData.plan || "free", status: "active",
      }).returning();

      await db.insert(workspaceMembers).values({
        workspaceId: workspace.id, userId: authResult.userId, role: "owner",
      });

      return reply.status(201).send({ workspace });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating workspace:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /workspaces/:id
  fastify.get("/workspaces/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
      if (!workspace) return reply.status(404).send({ error: "Workspace not found" });

      return { workspace, role: membership.role };
    } catch (error) {
      console.error("Error fetching workspace:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /workspaces/:id
  fastify.patch("/workspaces/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, authResult.userId)),
      });
      if (!membership || !["owner", "admin"].includes(membership.role)) {
        return reply.status(403).send({ error: "Access denied" });
      }

      const body = request.body as Record<string, unknown>;
      const validatedData = updateWorkspaceSchema.parse(body);
      const [workspace] = await db.update(workspaces).set(validatedData).where(eq(workspaces.id, id)).returning();
      return { workspace };
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error updating workspace:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /workspaces/:id
  fastify.delete("/workspaces/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id } = request.params as { id: string };
    try {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, authResult.userId), eq(workspaceMembers.role, "owner")),
      });
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      await db.delete(workspaces).where(eq(workspaces.id, id));
      return { success: true };
    } catch (error) {
      console.error("Error deleting workspace:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
