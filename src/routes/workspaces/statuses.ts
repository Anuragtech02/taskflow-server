import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc, sql, inArray } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";

const { statuses, workspaceMembers, tasks, lists, spaces } = schema;

const MAX_STATUSES_PER_WORKSPACE = 50;

const createStatusSchema = z.object({
  name: z.string().min(1).max(255),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#6366f1"),
  order: z.number().int().optional(),
});

const updateStatusSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  order: z.number().int().optional(),
  isDefault: z.boolean().optional(),
});

const reorderSchema = z.object({
  statusIds: z.array(z.string().uuid()).min(1).max(MAX_STATUSES_PER_WORKSPACE),
});

async function checkMembership(workspaceId: string, userId: string) {
  return db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
  });
}

// Normalize a display name into the slug stored in tasks.status (matches the
// pre-0016 convention so existing task rows keep their references).
function normalizeStatusName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

// Lets transactions short-circuit with a specific HTTP response.
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export default async function workspaceStatusRoutes(fastify: FastifyInstance) {
  // GET /workspaces/:id/statuses
  fastify.get("/workspaces/:id/statuses", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const workspaceStatuses = await db
        .select()
        .from(statuses)
        .where(eq(statuses.workspaceId, workspaceId))
        .orderBy(asc(statuses.order));
      return { statuses: workspaceStatuses };
    } catch (error) {
      console.error("Error fetching statuses:", error);
      return reply.status(500).send({ error: "Failed to fetch statuses" });
    }
  });

  // POST /workspaces/:id/statuses
  fastify.post("/workspaces/:id/statuses", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const parsed = createStatusSchema.safeParse(body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
      const { name, color, order } = parsed.data;

      const dup = await db
        .select()
        .from(statuses)
        .where(and(eq(statuses.workspaceId, workspaceId), sql`LOWER(${statuses.name}) = LOWER(${name})`))
        .limit(1);
      if (dup.length > 0) return reply.status(400).send({ error: "Status name must be unique within this workspace" });

      // Enforce the per-workspace cap so a single user can't pollute the workspace with thousands of statuses.
      const [{ count: existingCount }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(statuses)
        .where(eq(statuses.workspaceId, workspaceId));
      if (Number(existingCount) >= MAX_STATUSES_PER_WORKSPACE) {
        return reply.status(400).send({ error: `Workspace has reached the limit of ${MAX_STATUSES_PER_WORKSPACE} statuses` });
      }

      let newOrder = order;
      if (newOrder === undefined || newOrder === null) {
        const max = await db
          .select({ order: statuses.order })
          .from(statuses)
          .where(eq(statuses.workspaceId, workspaceId))
          .orderBy(sql`${statuses.order} DESC`)
          .limit(1);
        newOrder = max.length > 0 ? (max[0].order ?? 0) + 1 : 0;
      }

      const [newStatus] = await db
        .insert(statuses)
        .values({ workspaceId, name, color, order: newOrder, isDefault: false })
        .returning();
      return reply.status(201).send({ status: newStatus });
    } catch (error) {
      console.error("Error creating status:", error);
      return reply.status(500).send({ error: "Failed to create status" });
    }
  });

  // PATCH /workspaces/:id/statuses/:statusId
  fastify.patch("/workspaces/:id/statuses/:statusId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId, statusId } = request.params as { id: string; statusId: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const parsed = updateStatusSchema.safeParse(body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
      const { name, color, order, isDefault } = parsed.data;

      // Run the entire read-modify-write in one transaction with row-level lock,
      // so concurrent PATCHs against the same row can't race.
      let updated;
      try {
        await db.transaction(async (tx) => {
          // SELECT ... FOR UPDATE — locks the status row for the duration of the tx.
          const lockedRows = await tx.execute<{
            id: string; workspace_id: string; name: string; color: string | null; order: number | null; is_default: boolean | null;
          }>(sql`
            SELECT id, workspace_id, name, color, "order", is_default
            FROM ${statuses}
            WHERE id = ${statusId} AND workspace_id = ${workspaceId}
            FOR UPDATE
          `);
          const existing = (lockedRows as unknown as Array<{ id: string; workspace_id: string; name: string; color: string | null; order: number | null; is_default: boolean | null }>)[0];
          if (!existing) {
            throw new HttpError(404, "Status not found");
          }

          // Case-insensitive duplicate check (the unique index will also catch it on commit;
          // this gives a friendlier error message than a raw 23505).
          if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
            const dup = await tx
              .select()
              .from(statuses)
              .where(and(eq(statuses.workspaceId, workspaceId), sql`LOWER(${statuses.name}) = LOWER(${name})`))
              .limit(1);
            if (dup.length > 0) {
              throw new HttpError(400, "Status name must be unique within this workspace");
            }
          }

          // If the slug changes, rewrite tasks.status across this workspace's tasks.
          if (name) {
            const oldSlug = normalizeStatusName(existing.name);
            const newSlug = normalizeStatusName(name);
            if (oldSlug !== newSlug) {
              const workspaceListIds = await tx
                .select({ id: lists.id })
                .from(lists)
                .innerJoin(spaces, eq(spaces.id, lists.spaceId))
                .where(eq(spaces.workspaceId, workspaceId));
              const ids = workspaceListIds.map((l) => l.id);
              if (ids.length > 0) {
                await tx
                  .update(tasks)
                  .set({ status: newSlug })
                  .where(and(inArray(tasks.listId, ids), eq(tasks.status, oldSlug)));
              }
            }
          }

          // If isDefault is being set true, clear the flag on every other status in this workspace.
          // Keeps the "at most one default per workspace" invariant.
          if (isDefault === true) {
            await tx
              .update(statuses)
              .set({ isDefault: false })
              .where(and(eq(statuses.workspaceId, workspaceId), sql`${statuses.id} <> ${statusId}`));
          }

          const [u] = await tx
            .update(statuses)
            .set({
              ...(name && { name }),
              ...(color && { color }),
              ...(order !== undefined && { order }),
              ...(isDefault !== undefined && { isDefault }),
            })
            .where(eq(statuses.id, statusId))
            .returning();
          updated = u;
        });
      } catch (e) {
        if (e instanceof HttpError) return reply.status(e.status).send({ error: e.message });
        // Unique-violation from the index — translate to 400.
        if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "23505") {
          return reply.status(400).send({ error: "Status name must be unique within this workspace" });
        }
        throw e;
      }
      return { status: updated };
    } catch (error) {
      console.error("Error updating status:", error);
      return reply.status(500).send({ error: "Failed to update status" });
    }
  });

  // DELETE /workspaces/:id/statuses/:statusId
  fastify.delete("/workspaces/:id/statuses/:statusId", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId, statusId } = request.params as { id: string; statusId: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });
      if (!["owner", "admin"].includes(membership.role)) return reply.status(403).send({ error: "Only owners and admins can delete statuses" });

      const existing = await db
        .select()
        .from(statuses)
        .where(and(eq(statuses.id, statusId), eq(statuses.workspaceId, workspaceId)))
        .limit(1);
      if (existing.length === 0) return reply.status(404).send({ error: "Status not found" });

      const remaining = await db
        .select()
        .from(statuses)
        .where(and(eq(statuses.workspaceId, workspaceId), sql`${statuses.id} <> ${statusId}`))
        .orderBy(asc(statuses.order));
      const oldSlug = normalizeStatusName(existing[0].name);

      // Refuse to delete the last status if any task still references it —
      // would leave tasks pointing at a slug with no surviving row.
      if (remaining.length === 0) {
        const workspaceListIds = await db
          .select({ id: lists.id })
          .from(lists)
          .innerJoin(spaces, eq(spaces.id, lists.spaceId))
          .where(eq(spaces.workspaceId, workspaceId));
        const ids = workspaceListIds.map((l) => l.id);
        if (ids.length > 0) {
          const [{ count: tasksUsing }] = await db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(tasks)
            .where(and(inArray(tasks.listId, ids), eq(tasks.status, oldSlug)));
          if (Number(tasksUsing) > 0) {
            return reply.status(400).send({
              error: "Cannot delete the last status while tasks still reference it. Create another status first or reassign those tasks.",
            });
          }
        }
      }

      const fallbackSlug = remaining.length > 0 ? normalizeStatusName(remaining[0].name) : null;

      await db.transaction(async (tx) => {
        if (fallbackSlug) {
          const workspaceListIds = await tx
            .select({ id: lists.id })
            .from(lists)
            .innerJoin(spaces, eq(spaces.id, lists.spaceId))
            .where(eq(spaces.workspaceId, workspaceId));
          const ids = workspaceListIds.map((l) => l.id);
          if (ids.length > 0) {
            await tx
              .update(tasks)
              .set({ status: fallbackSlug })
              .where(and(inArray(tasks.listId, ids), eq(tasks.status, oldSlug)));
          }
        }
        await tx.delete(statuses).where(eq(statuses.id, statusId));
      });
      return { success: true };
    } catch (error) {
      console.error("Error deleting status:", error);
      return reply.status(500).send({ error: "Failed to delete status" });
    }
  });

  // PUT /workspaces/:id/statuses/reorder
  fastify.put("/workspaces/:id/statuses/reorder", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });

    const { id: workspaceId } = request.params as { id: string };
    try {
      const membership = await checkMembership(workspaceId, authResult.userId);
      if (!membership) return reply.status(403).send({ error: "Access denied" });

      const body = request.body as Record<string, unknown>;
      const parsed = reorderSchema.safeParse(body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message });
      const { statusIds } = parsed.data;

      // Validate every submitted ID belongs to this workspace before touching any row.
      const found = await db
        .select({ id: statuses.id })
        .from(statuses)
        .where(and(eq(statuses.workspaceId, workspaceId), inArray(statuses.id, statusIds)));
      if (found.length !== statusIds.length) {
        return reply.status(400).send({ error: "One or more status IDs do not belong to this workspace" });
      }

      await db.transaction(async (tx) => {
        for (let i = 0; i < statusIds.length; i++) {
          await tx
            .update(statuses)
            .set({ order: i })
            .where(and(eq(statuses.id, statusIds[i]), eq(statuses.workspaceId, workspaceId)));
        }
      });

      const updated = await db
        .select()
        .from(statuses)
        .where(eq(statuses.workspaceId, workspaceId))
        .orderBy(asc(statuses.order));
      return { statuses: updated };
    } catch (error) {
      console.error("Error reordering statuses:", error);
      return reply.status(500).send({ error: "Failed to reorder statuses" });
    }
  });
}
