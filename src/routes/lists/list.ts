import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, and, asc, notInArray, sql, inArray, isNull, gte, lte, exists } from "drizzle-orm";
import { authenticateRequest } from "../../plugins/auth.js";
import { runAutomations } from "../../lib/automations.js";
import { broadcastToWorkspace } from "../../plugins/sse.js";
import { syncJunctionForListChange } from "../../lib/sprint-list.js";

const { lists, spaces, tasks, taskActivities, workspaceMembers, taskAssignees, taskLabels } = schema;

// ── Server-side list querying (sort / filter / group / paginate) ─────────────
// Shared by GET /lists/:id/tasks/paged and GET /lists/:id/task-groups so the
// rows and the group counts can never disagree about what matches.

const CLOSED_STATUSES = ["done", "closed", "complete"];

// Priority is a text column, so alphabetical ordering would give
// high < low < medium < urgent. Rank it explicitly instead.
const priorityRank = sql<number>`CASE ${tasks.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3
  ELSE 4 END`;

type SortBy = "order" | "dueDate" | "priority" | "name" | "createdAt" | "updatedAt";
type GroupBy = "status" | "priority" | "assignee" | "dueDate" | "label";

const SORT_EXPR: Record<SortBy, ReturnType<typeof sql>> = {
  order: sql`${tasks.order}`,
  dueDate: sql`${tasks.dueDate}`,
  priority: priorityRank,
  name: sql`LOWER(${tasks.title})`,
  createdAt: sql`${tasks.createdAt}`,
  updatedAt: sql`${tasks.updatedAt}`,
};

function parseCsv(v?: string): string[] {
  return (v || "").split(",").map(s => s.trim()).filter(Boolean);
}

/** Build the WHERE conditions shared by the rows query and the counts query. */
function buildTaskFilters(listId: string, q: Record<string, string | undefined>) {
  const conds = [eq(tasks.listId, listId)];

  if (q.includeClosed !== "true") conds.push(notInArray(tasks.status, CLOSED_STATUSES));
  // Root-level rows only; subtasks are loaded on demand under their parent.
  if (q.rootsOnly === "true") conds.push(isNull(tasks.parentTaskId));
  if (q.parentId) conds.push(eq(tasks.parentTaskId, q.parentId));

  const statuses = parseCsv(q.status);
  if (statuses.length) conds.push(inArray(tasks.status, statuses));

  const priorities = parseCsv(q.priority);
  if (priorities.length) conds.push(inArray(tasks.priority, priorities));

  if (q.dueFrom) conds.push(gte(tasks.dueDate, new Date(q.dueFrom)));
  if (q.dueTo) conds.push(lte(tasks.dueDate, new Date(q.dueTo)));

  // Many-to-many filters via EXISTS — avoids the row multiplication a join
  // would cause when a task has several assignees/labels.
  const assigneeIds = parseCsv(q.assigneeIds);
  if (assigneeIds.length) {
    conds.push(
      exists(
        db.select({ x: sql`1` }).from(taskAssignees).where(
          and(eq(taskAssignees.taskId, tasks.id), inArray(taskAssignees.userId, assigneeIds))
        )
      )
    );
  }
  const labelIds = parseCsv(q.labels);
  if (labelIds.length) {
    conds.push(
      exists(
        db.select({ x: sql`1` }).from(taskLabels).where(
          and(eq(taskLabels.taskId, tasks.id), inArray(taskLabels.labelId, labelIds))
        )
      )
    );
  }

  return and(...conds);
}

async function checkListAccess(listId: string, userId: string) {
  const list = await db.query.lists.findFirst({ where: eq(lists.id, listId), with: { space: true } });
  if (!list) return null;
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, list.space.workspaceId), eq(workspaceMembers.userId, userId)),
  });
  return membership ? { list, space: list.space, membership } : null;
}

const updateListSchema = z.object({ name: z.string().min(1).max(255).optional() });

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.record(z.string(), z.unknown()).optional(),
  status: z.string().max(50).optional(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
  dueDate: z.string().datetime().optional(),
  timeEstimate: z.number().min(0).optional(),
  order: z.number().optional(),
  parentTaskId: z.string().uuid().optional(),
});

function toDescriptionDoc(desc: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!desc) return {};
  if (typeof desc === "object") return desc;
  if (desc.trim() === "") return {};
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: desc }] }] };
}

const bulkCreateTaskSchema = z.object({
  tasks: z.array(z.object({
    title: z.string().min(1).max(500),
    description: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    status: z.string().max(50).optional(),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
    dueDate: z.string().datetime().optional(),
    timeEstimate: z.number().min(0).optional(),
    order: z.number().optional(),
    parentTaskId: z.string().uuid().optional(),
  })),
});

export default async function listRoutes(fastify: FastifyInstance) {
  // GET /lists/:id
  fastify.get("/lists/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkListAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      return { list: access.list };
    } catch (error) {
      console.error("Error fetching list:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PATCH /lists/:id
  fastify.patch("/lists/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkListAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      const body = request.body as Record<string, unknown>;
      const parsed = updateListSchema.safeParse(body);
      if (!parsed.success) return reply.status(400).send({ error: "Invalid data", details: parsed.error.flatten() });
      const [updated] = await db.update(lists).set(parsed.data).where(eq(lists.id, id)).returning();
      return { list: updated };
    } catch (error) {
      console.error("Error updating list:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /lists/:id
  fastify.delete("/lists/:id", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id } = request.params as { id: string };
    try {
      const access = await checkListAccess(id, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      if (!["owner", "admin"].includes(access.membership.role)) return reply.status(403).send({ error: "Only owners and admins can delete lists" });
      await db.delete(lists).where(eq(lists.id, id));
      return { success: true };
    } catch (error) {
      console.error("Error deleting list:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /lists/:id/tasks
  // Returns up to `limit` tasks (default 1000, max 5000). Order is deterministic
  // — `(order ASC, created_at ASC, id ASC)` — so any future cursor-paginated
  // client gets stable pages. `total` and `hasMore` let callers detect when
  // a list legitimately exceeds the cap (today's lists shouldn't, post-PR-3).
  fastify.get("/lists/:id/tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    const { limit: l, offset: o, includeClosed } = request.query as { limit?: string; offset?: string; includeClosed?: string };
    const limit = Math.min(Math.max(parseInt(l || "1000", 10) || 1000, 1), 5000);
    const offset = Math.max(parseInt(o || "0", 10) || 0, 0);
    const closedStatuses = ["done", "closed", "complete"];
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });

      const whereClause = includeClosed === "true"
        ? eq(tasks.listId, listId)
        : and(eq(tasks.listId, listId), notInArray(tasks.status, closedStatuses));

      const listTasks = await db.query.tasks.findMany({
        where: whereClause,
        // Deterministic tiebreakers so two tasks with identical `order` (the
        // common default of 0) don't shuffle between requests.
        orderBy: [asc(tasks.order), asc(tasks.createdAt), asc(tasks.id)],
        limit, offset,
        with: {
          assignees: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } },
          creator: { columns: { id: true, name: true, email: true, avatarUrl: true } },
        },
      });

      // Total count of tasks the WHERE clause matches — lets the client warn
      // when its rendered set is shorter than the actual list (limit hit).
      const [totalResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(whereClause);
      const total = totalResult?.count ?? 0;

      const [closedResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(and(eq(tasks.listId, listId), sql`${tasks.status} IN ('done', 'closed', 'complete')`));
      const closedCount = closedResult?.count ?? 0;

      return {
        tasks: listTasks,
        closedCount,
        total,
        hasMore: total > offset + listTasks.length,
      };
    } catch (error) {
      console.error("Error fetching tasks:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // Group key + how that group is ordered, for the grouped "ordered stream".
  //
  // These MUST mirror the semantics the list view used when it grouped
  // client-side, or the refactor would silently change what users see:
  //  - assignee/label put a task in exactly ONE group (its first assignee /
  //    first label), so we use a correlated subquery rather than a LEFT JOIN.
  //    A join would multiply rows and show a 3-assignee task three times.
  //  - dueDate buckets relatively (overdue/today/tomorrow/this_week/later)
  //    rather than by calendar date. "Today" depends on the viewer's timezone,
  //    so the client passes its local day boundaries in; we only compare.
  function groupSelectors(groupBy: GroupBy, q: Record<string, string | undefined>) {
    switch (groupBy) {
      case "status":
        return { key: sql<string>`COALESCE(${tasks.status}, 'todo')`, order: sql`${tasks.status}` };
      case "priority":
        return { key: sql<string>`COALESCE(${tasks.priority}, 'none')`, order: priorityRank };
      case "dueDate": {
        // Fall back to server-side UTC day boundaries if the client didn't send
        // its own — correct ordering either way, just possibly off by a
        // timezone for users far from UTC.
        const today = q.todayStart ? new Date(q.todayStart) : new Date(new Date().setUTCHours(0, 0, 0, 0));
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const dayAfter = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
        const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
        const bucket = sql<string>`CASE
          WHEN ${tasks.dueDate} IS NULL THEN 'no_due_date'
          WHEN ${tasks.dueDate} < ${today} THEN 'overdue'
          WHEN ${tasks.dueDate} < ${tomorrow} THEN 'today'
          WHEN ${tasks.dueDate} < ${dayAfter} THEN 'tomorrow'
          WHEN ${tasks.dueDate} < ${nextWeek} THEN 'this_week'
          ELSE 'later' END`;
        // Rank so groups render in chronological order, not alphabetical.
        const rank = sql`CASE
          WHEN ${tasks.dueDate} IS NULL THEN 5
          WHEN ${tasks.dueDate} < ${today} THEN 0
          WHEN ${tasks.dueDate} < ${tomorrow} THEN 1
          WHEN ${tasks.dueDate} < ${dayAfter} THEN 2
          WHEN ${tasks.dueDate} < ${nextWeek} THEN 3
          ELSE 4 END`;
        return { key: bucket, order: rank };
      }
      case "assignee": {
        // Deterministic "first" assignee — ordered so the same task always
        // lands in the same group across pages and requests.
        const first = sql<string>`COALESCE((
          SELECT ta.user_id::text FROM task_assignees ta
          WHERE ta.task_id = ${tasks.id} ORDER BY ta.user_id LIMIT 1
        ), 'unassigned')`;
        return { key: first, order: first };
      }
      case "label": {
        const first = sql<string>`COALESCE((
          SELECT tl.label_id::text FROM task_labels tl
          WHERE tl.task_id = ${tasks.id} ORDER BY tl.label_id LIMIT 1
        ), 'unlabeled')`;
        return { key: first, order: first };
      }
    }
  }

  function parseListQuery(q: Record<string, string | undefined>) {
    const sortBy: SortBy = (q.sortBy && q.sortBy in SORT_EXPR ? q.sortBy : "order") as SortBy;
    const groupBy: GroupBy | null = (["status", "priority", "assignee", "dueDate", "label"] as const)
      .includes(q.groupBy as GroupBy) ? (q.groupBy as GroupBy) : null;
    return {
      sortBy,
      groupBy,
      dir: q.sortOrder === "desc" ? sql`DESC` : sql`ASC`,
      limit: Math.min(Math.max(parseInt(q.limit || "100", 10) || 100, 1), 500),
      offset: Math.max(parseInt(q.offset || "0", 10) || 0, 0),
    };
  }

  // GET /lists/:id/tasks/paged
  // Server-side sort + filter + group + pagination over ROOT tasks. Returns one
  // ordered stream; when grouping, each row carries its groupKey so the client
  // just starts a new header whenever the key changes. Subtasks are fetched
  // separately via ?parentId=.
  fastify.get("/lists/:id/tasks/paged", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    const q = request.query as Record<string, string | undefined>;

    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });

      const { sortBy, groupBy, dir, limit, offset } = parseListQuery(q);
      const where = buildTaskFilters(listId, q);
      const g = groupBy ? groupSelectors(groupBy, q) : null;

      // Step 1: resolve the ordered window of (taskId, groupKey). Kept narrow so
      // the join-induced duplication for assignee/label grouping stays cheap.
      const sortSql = SORT_EXPR[sortBy];
      const orderBy = g
        ? sql`${g.order} ASC NULLS LAST, ${sortSql} ${dir} NULLS LAST, ${tasks.id} ASC`
        : sql`${sortSql} ${dir} NULLS LAST, ${tasks.id} ASC`;

      // No joins: every group key is a scalar expression over the task row, so
      // one task yields exactly one row and pagination stays honest.
      const selection = { id: tasks.id, groupKey: g ? g.key : sql<string>`''` };
      const windowRows = await db
        .select(selection)
        .from(tasks)
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);

      // Step 2: hydrate the full task records for just this window.
      const ids = [...new Set(windowRows.map(r => r.id))];
      const full = ids.length
        ? await db.query.tasks.findMany({
            where: inArray(tasks.id, ids),
            with: {
              assignees: { with: { user: { columns: { id: true, name: true, email: true, avatarUrl: true } } } },
              creator: { columns: { id: true, name: true, email: true, avatarUrl: true } },
            },
          })
        : [];
      const byId = new Map(full.map(t => [t.id, t]));
      // Re-apply the SQL ordering (findMany returns arbitrary order) and attach
      // groupKey, keeping the per-group duplicates the join produced.
      const orderedTasks = windowRows
        .map(r => {
          const t = byId.get(r.id);
          return t ? { ...t, groupKey: r.groupKey } : null;
        })
        .filter(Boolean);

      const [totalResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(where);
      const total = totalResult?.count ?? 0;

      return {
        tasks: orderedTasks,
        total,
        limit,
        offset,
        hasMore: offset + windowRows.length < total,
      };
    } catch (error) {
      console.error("Error fetching paged tasks:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /lists/:id/task-groups
  // Group buckets + TRUE totals for the current filters, so headers show the
  // real count even though only a window of rows is loaded. Uses exactly the
  // same filter builder as /tasks/paged so counts and rows always agree.
  fastify.get("/lists/:id/task-groups", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    const q = request.query as Record<string, string | undefined>;

    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });

      const { groupBy } = parseListQuery(q);
      if (!groupBy) return { groups: [] };

      const where = buildTaskFilters(listId, q);
      const g = groupSelectors(groupBy, q);

      const groups = await db
        .select({ key: g.key, count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(where)
        .groupBy(g.key)
        .orderBy(sql`MIN(${g.order}) ASC NULLS LAST`);

      return { groupBy, groups };
    } catch (error) {
      console.error("Error fetching task groups:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /lists/:id/tasks
  fastify.post("/lists/:id/tasks", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      const body = request.body as Record<string, unknown>;
      const validatedData = createTaskSchema.parse(body);
      const [task] = await db.insert(tasks).values({
        listId, title: validatedData.title, description: validatedData.description ?? {},
        status: validatedData.status ?? "todo", priority: validatedData.priority ?? "none",
        creatorId: authResult.userId, dueDate: validatedData.dueDate ? new Date(validatedData.dueDate) : null,
        timeEstimate: validatedData.timeEstimate, order: validatedData.order ?? 0, parentTaskId: validatedData.parentTaskId,
      }).returning();

      await db.insert(taskActivities).values({ taskId: task.id, userId: authResult.userId, action: "created" });
      // Model B: if this list represents a sprint, the new task is implicitly
      // in that sprint — write the sprint_tasks row so burndown / retro / etc.
      // pick it up.
      try { await syncJunctionForListChange(task.id, listId); } catch (err) { console.error("Error syncing sprint_tasks junction:", err); }
      try { await runAutomations("task_created", { taskId: task.id, workspaceId: access.space.workspaceId, userId: authResult.userId }); } catch (err) { console.error("Error running automations:", err); }
      broadcastToWorkspace(access.space.workspaceId, { type: "task_created", data: { task, listId, spaceId: access.space.id, userId: authResult.userId } });
      return reply.status(201).send({ task });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating task:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /lists/:id/tasks/bulk
  fastify.post("/lists/:id/tasks/bulk", async (request, reply) => {
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    const { id: listId } = request.params as { id: string };
    try {
      const access = await checkListAccess(listId, authResult.userId);
      if (!access) return reply.status(404).send({ error: "List not found" });
      const body = request.body as Record<string, unknown>;
      const { tasks: tasksToCreate } = bulkCreateTaskSchema.parse(body);

      const existingTasks = await db.query.tasks.findMany({
        where: eq(tasks.listId, listId), columns: { order: true }, orderBy: (t, { desc }) => [desc(t.order)], limit: 1,
      });
      const startOrder = existingTasks[0]?.order != null ? existingTasks[0].order + 1 : 0;

      const createdTasks = await Promise.all(tasksToCreate.map(async (taskData, index) => {
        const [task] = await db.insert(tasks).values({
          listId, title: taskData.title, description: toDescriptionDoc(taskData.description),
          status: taskData.status ?? "todo", priority: taskData.priority ?? "none",
          creatorId: authResult.userId, dueDate: taskData.dueDate ? new Date(taskData.dueDate) : null,
          timeEstimate: taskData.timeEstimate, order: taskData.order ?? startOrder + index, parentTaskId: taskData.parentTaskId,
        }).returning();
        await db.insert(taskActivities).values({ taskId: task.id, userId: authResult.userId, action: "created" });
        return task;
      }));

      // Model B: if this list represents a sprint, all bulk-created tasks
      // are implicitly in that sprint — write sprint_tasks rows for each.
      try {
        for (const task of createdTasks) {
          await syncJunctionForListChange(task.id, listId);
        }
      } catch (err) { console.error("Error syncing sprint_tasks junction (bulk):", err); }

      for (const task of createdTasks) {
        try { await runAutomations("task_created", { taskId: task.id, workspaceId: access.space.workspaceId, userId: authResult.userId }); } catch (err) { console.error("Error running automations:", err); }
        broadcastToWorkspace(access.space.workspaceId, { type: "task_created", data: { task, listId, spaceId: access.space.id, userId: authResult.userId } });
      }
      return reply.status(201).send({ tasks: createdTasks });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "Validation error", details: error.issues });
      console.error("Error creating bulk tasks:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

}
