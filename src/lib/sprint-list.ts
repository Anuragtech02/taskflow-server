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
 *
 * Folder placement (3-way distinction on `opts.folderId`):
 *   - omitted (undefined) → inherit from the most-recent sprint list in the
 *     same space; if there is none, fall back to space root (NULL)
 *   - explicit `null` → space root
 *   - explicit string → that folder (caller's responsibility to validate)
 *
 * Returns the list.
 */
export async function ensureSprintList(sprintId: string, opts?: { folderId?: string | null }) {
  const existing = await getListForSprint(sprintId);
  if (existing) return existing;

  const [sprint] = await db.select().from(sprints).where(eq(sprints.id, sprintId)).limit(1);
  if (!sprint) throw new Error(`Sprint ${sprintId} not found`);

  // Resolve folder placement. The 3-way distinction matters: undefined means
  // "inherit"; null means "explicitly at space root"; a UUID is a chosen folder.
  let folderId: string | null;
  if (opts && Object.prototype.hasOwnProperty.call(opts, "folderId")) {
    folderId = opts.folderId ?? null;
  } else {
    const [prev] = await db
      .select({ folderId: lists.folderId })
      .from(lists)
      .where(and(eq(lists.spaceId, sprint.spaceId), eq(lists.kind, "sprint")))
      .orderBy(sql`${lists.createdAt} DESC`)
      .limit(1);
    folderId = prev?.folderId ?? null;
  }

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
      folderId,
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
 * Keep the sprint_tasks junction in sync when a task's list_id changes.
 * Call this AFTER a task's list_id has been updated (whether the change
 * came from a drag-drop, a "move to list" action, a new-task insert, etc.).
 *
 * Rules:
 *   - target is a sprint-kind list → replace any existing junction row with
 *     one pointing at the target's sprint (single-sprint policy)
 *   - target is a non-sprint list → drop any existing junction rows for the
 *     task (it's no longer in any sprint)
 *
 * Idempotent: re-calling with the same target is a no-op.
 */
export async function syncJunctionForListChange(taskId: string, newListId: string) {
  const [list] = await db
    .select({ id: lists.id, kind: lists.kind, sprintId: lists.sprintId })
    .from(lists)
    .where(eq(lists.id, newListId))
    .limit(1);
  if (!list) return;

  if (list.kind === "sprint" && list.sprintId) {
    const targetSprintId = list.sprintId;
    await db.transaction(async (tx) => {
      // Replace any prior sprint membership.
      await tx.delete(sprintTasks).where(eq(sprintTasks.taskId, taskId));
      await tx.insert(sprintTasks).values({ sprintId: targetSprintId, taskId });
    });
  } else {
    await db.delete(sprintTasks).where(eq(sprintTasks.taskId, taskId));
  }
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

/** Statuses that count as finished when a sprint is completed. */
const DONE_STATUSES = ["done", "closed", "complete"];

export type IncompleteDestination = { kind: "backlog" } | { kind: "rollover"; targetSprintId: string };

/**
 * Complete a sprint in one transaction: every incomplete task in it moves to
 * the destination, then the sprint is marked completed and its list archived.
 * Done tasks stay as the sprint's frozen record.
 *
 * This replaces the client looping over one request per task (plus a final
 * PATCH): a 450-task sprint took minutes and could stop half way. Here it is
 * a handful of set-based statements, and all-or-nothing.
 *
 * Per-task semantics match assignTaskToSprintAndList / unassignTaskFromSprints:
 *  - rollover: the task leaves every sprint, joins the target sprint and moves
 *    to the target sprint's list.
 *  - backlog: the task leaves every sprint; if it sits in a sprint-kind list
 *    it moves to its space's Backlog list, otherwise it stays where it is.
 *
 * Returns null if the sprint doesn't exist or is already completed (so a
 * double submit can't process it twice).
 */
export async function completeSprintMovingIncomplete(sprintId: string, dest: IncompleteDestination) {
  // List creation is idempotent and uses its own connection, so do it up front.
  const targetList = dest.kind === "rollover" ? await ensureSprintList(dest.targetSprintId) : null;

  return db.transaction(async (tx) => {
    // Lock the sprint row: two "Complete" clicks can't both get past this.
    const [sprint] = await tx.select().from(sprints).where(eq(sprints.id, sprintId)).for("update");
    if (!sprint || sprint.status === "completed") return null;

    const incomplete = await tx
      .select({ id: tasks.id, listKind: lists.kind, spaceId: lists.spaceId })
      .from(sprintTasks)
      .innerJoin(tasks, eq(tasks.id, sprintTasks.taskId))
      .innerJoin(lists, eq(lists.id, tasks.listId))
      .where(
        and(
          eq(sprintTasks.sprintId, sprintId),
          sql`(${tasks.status} IS NULL OR ${tasks.status} NOT IN (${sql.join(DONE_STATUSES.map((d) => sql`${d}`), sql`, `)}))`,
        ),
      );

    // Chunked so a very large sprint can't exceed the bind-parameter limit.
    const CHUNK = 1000;
    const chunks = <T>(arr: T[]) => Array.from({ length: Math.ceil(arr.length / CHUNK) }, (_, i) => arr.slice(i * CHUNK, (i + 1) * CHUNK));
    const ids = incomplete.map((t) => t.id);

    for (const part of chunks(ids)) {
      await tx.delete(sprintTasks).where(inArray(sprintTasks.taskId, part));
    }

    if (dest.kind === "rollover" && targetList) {
      for (const part of chunks(ids)) {
        await tx.insert(sprintTasks).values(part.map((taskId) => ({ sprintId: dest.targetSprintId, taskId }))).onConflictDoNothing();
        await tx.update(tasks).set({ listId: targetList.id }).where(inArray(tasks.id, part));
      }
    } else {
      const bySpace = new Map<string, string[]>();
      for (const t of incomplete) {
        if (t.listKind !== "sprint") continue; // not in a sprint list: only the membership is cleared
        bySpace.set(t.spaceId, [...(bySpace.get(t.spaceId) ?? []), t.id]);
      }
      for (const [spaceId, spaceTaskIds] of bySpace) {
        const backlog = await getOrCreateBacklogList(spaceId);
        for (const part of chunks(spaceTaskIds)) {
          await tx.update(tasks).set({ listId: backlog.id }).where(inArray(tasks.id, part));
        }
      }
    }

    const [updated] = await tx.update(sprints).set({ status: "completed" }).where(eq(sprints.id, sprintId)).returning();
    await tx
      .update(lists)
      .set({ archivedAt: updated.endDate })
      .where(and(eq(lists.sprintId, sprintId), sql`${lists.archivedAt} IS NULL`));

    return { sprint: updated, moved: ids.length, destinationListId: targetList?.id ?? null };
  });
}
