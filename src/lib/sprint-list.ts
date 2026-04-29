/**
 * Helpers that keep the 1:1 sprint <-> list mapping in sync.
 *
 * Under Model B, every sprint owns exactly one list (kind='sprint'). The
 * sprint_tasks junction table is preserved as the historical record but
 * `tasks.list_id` is the source of truth for "which sprint is this task
 * currently in?".
 */
import { db, schema } from "../db/index.js";
import { eq, and, asc, sql, inArray } from "drizzle-orm";

const { lists, sprints, tasks, sprintTasks, spaces } = schema;

const BACKLOG_NAMES = ["backlog", "backlogs"];

/**
 * Find the list that owns this sprint. Returns null if the sprint has no
 * list (transitional state — every active sprint should have one after
 * the migration).
 */
export async function getListForSprint(sprintId: string) {
  const [list] = await db.select().from(lists).where(eq(lists.sprintId, sprintId)).limit(1);
  return list ?? null;
}

/**
 * Ensure a sprint has its 1:1 list, creating one if missing. Idempotent.
 * Returns the list. Pass an optional folderId/order for placement.
 */
export async function ensureSprintList(sprintId: string, opts?: { folderId?: string | null }) {
  const existing = await getListForSprint(sprintId);
  if (existing) return existing;

  const [sprint] = await db.select().from(sprints).where(eq(sprints.id, sprintId)).limit(1);
  if (!sprint) throw new Error(`Sprint ${sprintId} not found`);

  // Append after the highest-order list in the same space.
  const maxOrderRows = await db
    .select({ m: sql<number>`COALESCE(MAX("order"), 0)::int` })
    .from(lists)
    .where(eq(lists.spaceId, sprint.spaceId));
  const order = (maxOrderRows[0]?.m ?? 0) + 1;

  const [created] = await db
    .insert(lists)
    .values({
      spaceId: sprint.spaceId,
      folderId: opts?.folderId ?? null,
      name: sprint.name,
      kind: "sprint",
      sprintId: sprint.id,
      order,
      archivedAt: sprint.status === "completed" ? sprint.endDate : null,
    })
    .returning();
  return created;
}

/**
 * Find or create a Backlog list in the given space. Used as the destination
 * when a task is unassigned from a sprint or when stragglers need a home.
 */
export async function getOrCreateBacklogList(spaceId: string) {
  const [existing] = await db
    .select()
    .from(lists)
    .where(
      and(
        eq(lists.spaceId, spaceId),
        inArray(sql<string>`LOWER(${lists.name})`, BACKLOG_NAMES),
        sql`${lists.archivedAt} IS NULL`,
      ),
    )
    .orderBy(asc(lists.createdAt), asc(lists.id))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(lists)
    .values({
      spaceId,
      name: "Backlog",
      kind: "backlog",
      order: 0,
    })
    .returning();
  return created;
}

/**
 * Atomically: ensure the sprint has its list, then insert the sprint_tasks
 * junction row (idempotent), then move the task's list_id to the sprint's
 * list. Returns the resulting list.
 */
export async function assignTaskToSprintAndList(taskId: string, sprintId: string) {
  const list = await ensureSprintList(sprintId);
  await db.transaction(async (tx) => {
    // Remove any prior sprint-task rows for this task (single-sprint policy
    // mirrors the existing PUT /tasks/:id/sprint behavior).
    await tx.delete(sprintTasks).where(eq(sprintTasks.taskId, taskId));
    await tx.insert(sprintTasks).values({ sprintId, taskId });
    await tx.update(tasks).set({ listId: list.id }).where(eq(tasks.id, taskId));
  });
  return list;
}

/**
 * Pull a task out of every sprint. If the task currently lives in a
 * sprint-kind list, also move it to the space's Backlog list (creating one
 * if needed) so it doesn't sit in a now-archived sprint list. If the task
 * is in a general/backlog/non-sprint list, only the sprint_tasks junction
 * is cleared — the task stays where it is.
 */
export async function unassignTaskFromSprints(taskId: string) {
  const [task] = await db
    .select({
      id: tasks.id,
      listId: tasks.listId,
      spaceId: spaces.id,
      listKind: lists.kind,
    })
    .from(tasks)
    .innerJoin(lists, eq(lists.id, tasks.listId))
    .innerJoin(spaces, eq(spaces.id, lists.spaceId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task) return null;

  if (task.listKind !== "sprint") {
    // Task isn't in a sprint list — just clear the junction row(s).
    await db.delete(sprintTasks).where(eq(sprintTasks.taskId, taskId));
    return null;
  }

  const backlog = await getOrCreateBacklogList(task.spaceId);
  await db.transaction(async (tx) => {
    await tx.delete(sprintTasks).where(eq(sprintTasks.taskId, taskId));
    await tx.update(tasks).set({ listId: backlog.id }).where(eq(tasks.id, taskId));
  });
  return backlog;
}

/**
 * Bulk move tasks to the Backlog list (used by sprint-completion rollover).
 */
export async function moveTasksToBacklog(spaceId: string, taskIds: string[]) {
  if (taskIds.length === 0) return null;
  const backlog = await getOrCreateBacklogList(spaceId);
  await db.transaction(async (tx) => {
    await tx.delete(sprintTasks).where(inArray(sprintTasks.taskId, taskIds));
    await tx.update(tasks).set({ listId: backlog.id }).where(inArray(tasks.id, taskIds));
  });
  return backlog;
}

/**
 * Mark a sprint's list as archived (completion timestamp). Idempotent —
 * passing the same end date doesn't re-trigger anything.
 */
export async function archiveSprintList(sprintId: string, archivedAt: Date) {
  await db
    .update(lists)
    .set({ archivedAt })
    .where(and(eq(lists.sprintId, sprintId), sql`${lists.archivedAt} IS NULL`));
}

/**
 * Clear the archive timestamp on a sprint's list. Used when a sprint flips
 * back from 'completed' to 'active' or 'planned'.
 */
export async function unarchiveSprintList(sprintId: string) {
  await db.update(lists).set({ archivedAt: null }).where(eq(lists.sprintId, sprintId));
}
