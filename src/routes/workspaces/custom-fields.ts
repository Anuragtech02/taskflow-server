import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc, sql } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { customFieldDefinitions, workspaceMembers } = schema;

const MAX_CFDS_PER_WORKSPACE = 50;

const VALID_TYPES = [
  "text", "textarea", "number", "date", "time", "datetime",
  "checkbox", "select", "multiSelect", "url", "email", "phone",
  "currency", "percentage", "user",
] as const;

const createSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(VALID_TYPES),
  options: z.record(z.string(), z.unknown()).optional(),
  order: z.number().int().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.enum(VALID_TYPES).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  order: z.number().int().optional(),
});

async function checkMembership(workspaceId: string, userId: string) {
  return db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export default async function workspaceCustomFieldRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/custom-fields
  fastify.get("/workspaces/:id/custom-fields", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const fields = await db
        .select()
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.workspaceId, workspaceId))
        .orderBy(asc(customFieldDefinitions.order));
      return { fields };
    } catch (error) {
      console.error("Error fetching custom fields:", error);
      return reply.status(500).send({ error: "Failed to fetch custom fields" });
    }
  });

  // POST /workspaces/:id/custom-fields
  fastify.post("/workspaces/:id/custom-fields", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
      const { name, type, options, order } = parsed.data;

      // Friendly dedup check (the unique index is the real safeguard).
      const dup = await db
        .select()
        .from(customFieldDefinitions)
        .where(and(
          eq(customFieldDefinitions.workspaceId, workspaceId),
          sql`LOWER(${customFieldDefinitions.name}) = LOWER(${name})`,
          eq(customFieldDefinitions.type, type),
        ))
        .limit(1);
      if (dup.length > 0) {
        return reply.status(400).send({ error: "A custom field with this name and type already exists in this workspace" });
      }

      const [{ count: existingCount }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.workspaceId, workspaceId));
      if (Number(existingCount) >= MAX_CFDS_PER_WORKSPACE) {
        return reply.status(400).send({ error: `Workspace has reached the limit of ${MAX_CFDS_PER_WORKSPACE} custom fields` });
      }

      let newOrder = order;
      if (newOrder === undefined || newOrder === null) {
        const max = await db
          .select({ order: customFieldDefinitions.order })
          .from(customFieldDefinitions)
          .where(eq(customFieldDefinitions.workspaceId, workspaceId))
          .orderBy(sql`${customFieldDefinitions.order} DESC`)
          .limit(1);
        newOrder = max.length > 0 ? (max[0].order ?? 0) + 1 : 0;
      }

      const [newField] = await db
        .insert(customFieldDefinitions)
        .values({ workspaceId, name, type, options: options || {}, order: newOrder })
        .returning();
      return reply.status(201).send({ field: newField });
    } catch (error) {
      console.error("Error creating custom field:", error);
      return reply.status(500).send({ error: "Failed to create custom field" });
    }
  });

  // PATCH /workspaces/:id/custom-fields/:fieldId
  fastify.patch("/workspaces/:id/custom-fields/:fieldId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId, fieldId } = request.params as { id: string; fieldId: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
      const { name, type, options, order } = parsed.data;

      let updated;
      try {
        await db.transaction(async (tx) => {
          // Lock the row so concurrent PATCHs don't race.
          const lockedRows = await tx.execute<{ id: string; workspace_id: string; name: string; type: string }>(sql`
            SELECT id, workspace_id, name, type
            FROM ${customFieldDefinitions}
            WHERE id = ${fieldId} AND workspace_id = ${workspaceId}
            FOR UPDATE
          `);
          const existing = (lockedRows as unknown as Array<{ id: string; workspace_id: string; name: string; type: string }>)[0];
          if (!existing) throw new HttpError(404, "Custom field not found");

          // Renaming or retyping: check uniqueness friendly-side.
          const newName = name ?? existing.name;
          const newType = type ?? existing.type;
          if (
            newName.toLowerCase() !== existing.name.toLowerCase() ||
            newType !== existing.type
          ) {
            const dup = await tx
              .select()
              .from(customFieldDefinitions)
              .where(and(
                eq(customFieldDefinitions.workspaceId, workspaceId),
                sql`LOWER(${customFieldDefinitions.name}) = LOWER(${newName})`,
                eq(customFieldDefinitions.type, newType),
                sql`${customFieldDefinitions.id} <> ${fieldId}`,
              ))
              .limit(1);
            if (dup.length > 0) {
              throw new HttpError(400, "A custom field with this name and type already exists in this workspace");
            }
          }

          const [u] = await tx
            .update(customFieldDefinitions)
            .set({
              ...(name !== undefined && { name }),
              ...(type !== undefined && { type }),
              ...(options !== undefined && { options }),
              ...(order !== undefined && { order }),
            })
            .where(eq(customFieldDefinitions.id, fieldId))
            .returning();
          updated = u;
        });
      } catch (e) {
        if (e instanceof HttpError) return reply.status(e.status).send({ error: e.message });
        if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "23505") {
          return reply.status(400).send({ error: "A custom field with this name and type already exists in this workspace" });
        }
        throw e;
      }
      return { field: updated };
    } catch (error) {
      console.error("Error updating custom field:", error);
      return reply.status(500).send({ error: "Failed to update custom field" });
    }
  });

  // DELETE /workspaces/:id/custom-fields/:fieldId
  // Note: tasks.customFields jsonb stores values keyed by field ID. Deleting
  // here leaves orphan keys in tasks. Frontend gracefully ignores them; an
  // optional cleanup pass could strip them, but it's not required for correctness.
  fastify.delete("/workspaces/:id/custom-fields/:fieldId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId, fieldId } = request.params as { id: string; fieldId: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      if (!["owner", "admin"].includes(membership.role)) {
        return reply.status(403).send({ error: "Only owners and admins can delete custom fields" });
      }

      const [deleted] = await db
        .delete(customFieldDefinitions)
        .where(and(eq(customFieldDefinitions.id, fieldId), eq(customFieldDefinitions.workspaceId, workspaceId)))
        .returning();
      if (!deleted) return reply.status(404).send({ error: "Custom field not found" });
      return { success: true };
    } catch (error) {
      console.error("Error deleting custom field:", error);
      return reply.status(500).send({ error: "Failed to delete custom field" });
    }
  });
}
