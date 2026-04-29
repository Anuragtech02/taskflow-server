/**
 * 0018 — Model B: each sprint becomes a list (1:1).
 *
 * Idempotent: safe to run multiple times. Hooked into start.sh so a fresh
 * container always reaches the desired state.
 *
 * High level:
 *   - Every sprint in the system gets exactly one list (kind='sprint',
 *     sprint_id set, archived_at = sprint.endDate when status='completed',
 *     active sprints have archived_at = NULL).
 *   - For each (sprintId, taskId) in sprint_tasks, the task's list_id is
 *     updated to point at that sprint's list.
 *   - sprint_tasks junction is preserved as historical record. Future writes
 *     keep both sides in sync.
 *   - Tasks currently in a list named "Sprint" but with NO sprint_tasks row
 *     get moved to the existing 'Backlog' list in that space (or a new one
 *     if none exists).
 *   - The original "Sprint" list, if reused for the active sprint, is
 *     renamed to that sprint's name.
 *   - Audit table 'migration_audit_modelb' records (task_id,
 *     original_list_id, new_list_id, ran_at) for one-shot rollback.
 *
 * Steps (each guarded so re-running is a no-op once applied):
 *   1. Schema: ensure lists.kind / lists.sprint_id / lists.archived_at
 *      columns exist with sane defaults; create supporting indexes.
 *   2. Audit table: ensure migration_audit_modelb exists.
 *   3. Per space, per sprint:
 *      3a. If a list already has sprint_id pointing at this sprint -> keep.
 *      3b. Else, prefer reusing a list literally named "Sprint" in this
 *          space (only the FIRST encountered active sprint claims it; it
 *          is renamed to the sprint's name).
 *      3c. Else, create a fresh list with the sprint's name.
 *   4. For each (sprintId, taskId) in sprint_tasks, update the task's
 *      list_id to the sprint's list. Audit the change.
 *   5. For tasks remaining in any "Sprint"-named list with no sprint_tasks
 *      row, move them to the Backlog list of that space (creating one if
 *      missing). Audit the change.
 *   6. Set archived_at on sprint-list rows whose sprint is completed.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[0018] DATABASE_URL not set — skipping");
  process.exit(0);
}

const sql = postgres(url, { max: 1, idle_timeout: 5 });

async function columnExists(table, column) {
  const r = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    LIMIT 1
  `;
  return r.length > 0;
}

async function indexExists(name) {
  const r = await sql`
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name} LIMIT 1
  `;
  return r.length > 0;
}

async function tableExists(name) {
  const r = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${name}
    LIMIT 1
  `;
  return r.length > 0;
}

const SPRINT_LIST_NAMES = ["sprint", "sprints", "current sprint"];
const BACKLOG_LIST_NAMES = ["backlog", "backlogs"];

try {
  console.log("[0018] starting sprint-as-list migration");

  // Step 1: schema
  if (!(await columnExists("lists", "kind"))) {
    await sql.unsafe(`ALTER TABLE lists ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'general'`);
    console.log("[0018] step 1: added lists.kind");
  } else {
    console.log("[0018] step 1: lists.kind already present — skipping");
  }
  if (!(await columnExists("lists", "sprint_id"))) {
    await sql.unsafe(`ALTER TABLE lists ADD COLUMN sprint_id UUID`);
    console.log("[0018] step 1: added lists.sprint_id");
  } else {
    console.log("[0018] step 1: lists.sprint_id already present — skipping");
  }
  if (!(await columnExists("lists", "archived_at"))) {
    await sql.unsafe(`ALTER TABLE lists ADD COLUMN archived_at TIMESTAMP`);
    console.log("[0018] step 1: added lists.archived_at");
  } else {
    console.log("[0018] step 1: lists.archived_at already present — skipping");
  }
  if (!(await indexExists("lists_archived_idx"))) {
    await sql.unsafe(`CREATE INDEX lists_archived_idx ON lists(archived_at)`);
    console.log("[0018] step 1b: created lists_archived_idx");
  }
  if (!(await indexExists("lists_sprint_unique"))) {
    await sql.unsafe(`CREATE UNIQUE INDEX lists_sprint_unique ON lists(sprint_id) WHERE sprint_id IS NOT NULL`);
    console.log("[0018] step 1c: created lists_sprint_unique");
  }

  // Step 2: audit table for rollback. Unique on (task_id, reason) so re-runs
  // can't accumulate duplicate rows for the same logical move.
  if (!(await tableExists("migration_audit_modelb"))) {
    await sql.unsafe(`
      CREATE TABLE migration_audit_modelb (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL,
        original_list_id UUID NOT NULL,
        new_list_id UUID NOT NULL,
        reason VARCHAR(50) NOT NULL,
        ran_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await sql.unsafe(`CREATE INDEX migration_audit_modelb_task_idx ON migration_audit_modelb(task_id)`);
    await sql.unsafe(`CREATE UNIQUE INDEX migration_audit_modelb_task_reason_unique ON migration_audit_modelb(task_id, reason)`);
    console.log("[0018] step 2: created migration_audit_modelb");
  } else {
    // Earlier runs may not have the unique index — add it idempotently.
    if (!(await indexExists("migration_audit_modelb_task_reason_unique"))) {
      await sql.unsafe(`CREATE UNIQUE INDEX migration_audit_modelb_task_reason_unique ON migration_audit_modelb(task_id, reason)`);
      console.log("[0018] step 2: added unique index on (task_id, reason)");
    } else {
      console.log("[0018] step 2: migration_audit_modelb already exists — skipping");
    }
  }

  // Step 3: ensure each sprint has a list
  const sprints = await sql`
    SELECT id, space_id, name, status, end_date
    FROM sprints
    ORDER BY space_id, start_date NULLS LAST
  `;

  let listsCreated = 0;
  let listsReused = 0;
  let listsAlreadyLinked = 0;

  for (const sp of sprints) {
    // 3a: already linked?
    const linked = await sql`
      SELECT id, name FROM lists WHERE sprint_id = ${sp.id} LIMIT 1
    `;
    if (linked.length > 0) {
      listsAlreadyLinked++;
      continue;
    }

    // 3b: only the FIRST active sprint per space gets to claim a "Sprint"-named list.
    // Take the lock by atomically updating the list to set sprint_id, only if no
    // other sprint has claimed it yet (sprint_id IS NULL) and it's a name match.
    let claimedRow = null;
    if (sp.status === "active") {
      const claimResult = await sql`
        UPDATE lists
        SET sprint_id = ${sp.id},
            kind = 'sprint',
            name = ${sp.name}
        WHERE space_id = ${sp.space_id}
          AND LOWER(name) IN ${sql(SPRINT_LIST_NAMES)}
          AND sprint_id IS NULL
          AND id IN (
            SELECT id FROM lists
            WHERE space_id = ${sp.space_id}
              AND LOWER(name) IN ${sql(SPRINT_LIST_NAMES)}
              AND sprint_id IS NULL
            ORDER BY created_at ASC, id ASC
            LIMIT 1
          )
        RETURNING id
      `;
      claimedRow = claimResult[0] ?? null;
    }

    if (claimedRow) {
      listsReused++;
      console.log(`[0018] step 3: reused sprint-named list as "${sp.name}" (sprint=${sp.id})`);
      continue;
    }

    // 3c: figure out the folder to put the new list in. If any other list in
    // this space has a folder, prefer the same folder as the existing "Sprint"
    // list (or any sprint-named list); otherwise use NULL.
    const folderRow = await sql`
      SELECT folder_id FROM lists
      WHERE space_id = ${sp.space_id}
        AND LOWER(name) IN ${sql(SPRINT_LIST_NAMES)}
        AND folder_id IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1
    `;
    const folderId = folderRow[0]?.folder_id ?? null;

    // Determine "order" — append after the highest existing order in the space.
    const maxOrder = await sql`
      SELECT COALESCE(MAX("order"), 0)::int AS m FROM lists WHERE space_id = ${sp.space_id}
    `;
    const newOrder = (maxOrder[0]?.m ?? 0) + 1;

    await sql`
      INSERT INTO lists (id, space_id, folder_id, name, kind, sprint_id, "order", archived_at)
      VALUES (
        gen_random_uuid(),
        ${sp.space_id},
        ${folderId},
        ${sp.name},
        'sprint',
        ${sp.id},
        ${newOrder},
        ${sp.status === "completed" ? sp.end_date : null}
      )
    `;
    listsCreated++;
    console.log(`[0018] step 3: created list "${sp.name}" in space ${sp.space_id} (sprint=${sp.id}, status=${sp.status})`);
  }
  console.log(`[0018] step 3 summary: ${listsCreated} created, ${listsReused} reused, ${listsAlreadyLinked} already linked`);

  // Step 4: move task.list_id for every (sprintId, taskId) in sprint_tasks
  // Audit each move that actually changes list_id.
  const sprintTaskPairs = await sql`
    SELECT st.sprint_id, st.task_id, t.list_id AS current_list_id, l.id AS new_list_id
    FROM sprint_tasks st
    JOIN tasks t ON t.id = st.task_id
    JOIN lists l ON l.sprint_id = st.sprint_id
    WHERE t.list_id IS DISTINCT FROM l.id
  `;
  console.log(`[0018] step 4: ${sprintTaskPairs.length} task list_id changes pending`);

  for (const pair of sprintTaskPairs) {
    await sql.begin(async (tx) => {
      // ON CONFLICT DO NOTHING via the unique (task_id, reason) index — a
      // partial re-run won't accumulate duplicate audit rows.
      await tx`
        INSERT INTO migration_audit_modelb (task_id, original_list_id, new_list_id, reason)
        VALUES (${pair.task_id}, ${pair.current_list_id}, ${pair.new_list_id}, 'sprint_assignment')
        ON CONFLICT (task_id, reason) DO NOTHING
      `;
      await tx`
        UPDATE tasks SET list_id = ${pair.new_list_id} WHERE id = ${pair.task_id}
      `;
    });
  }
  console.log(`[0018] step 4: ${sprintTaskPairs.length} tasks moved to their sprint list`);

  // Step 5: stragglers — tasks living in a sprint-context list (named "Sprint"
  // OR with kind='sprint') that don't have a corresponding sprint_tasks row
  // pointing at the list's sprint. After step 3 claimed/renamed the original
  // "Sprint" list as the active sprint's list, those untracked tasks need to
  // be evicted to the Backlog.
  const stragglerSpaces = await sql`
    SELECT DISTINCT l.space_id
    FROM tasks t
    JOIN lists l ON l.id = t.list_id
    LEFT JOIN sprint_tasks st ON st.task_id = t.id
                              AND (l.sprint_id IS NULL OR st.sprint_id = l.sprint_id)
    WHERE (LOWER(l.name) IN ${sql(SPRINT_LIST_NAMES)} OR l.kind = 'sprint')
      AND st.task_id IS NULL
  `;

  let totalStragglersMoved = 0;
  for (const row of stragglerSpaces) {
    // Find or create a Backlog list in this space
    const existingBacklog = await sql`
      SELECT id FROM lists
      WHERE space_id = ${row.space_id}
        AND LOWER(name) IN ${sql(BACKLOG_LIST_NAMES)}
        AND archived_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `;
    let backlogId = existingBacklog[0]?.id;
    if (!backlogId) {
      const [created] = await sql`
        INSERT INTO lists (id, space_id, name, kind, "order", archived_at)
        VALUES (gen_random_uuid(), ${row.space_id}, 'Backlog', 'backlog', 0, NULL)
        RETURNING id
      `;
      backlogId = created.id;
      console.log(`[0018] step 5: created new "Backlog" list in space ${row.space_id} (${backlogId})`);
    } else {
      console.log(`[0018] step 5: using existing Backlog ${backlogId} in space ${row.space_id}`);
    }

    // Move tasks (in batches) and audit each move. Same predicate as the
    // outer space discovery — tasks in a sprint-context list (by name or by
    // kind='sprint') with no corresponding sprint_tasks row.
    const stragglers = await sql`
      SELECT t.id AS task_id, t.list_id AS current_list_id
      FROM tasks t
      JOIN lists l ON l.id = t.list_id
      LEFT JOIN sprint_tasks st ON st.task_id = t.id
                                AND (l.sprint_id IS NULL OR st.sprint_id = l.sprint_id)
      WHERE l.space_id = ${row.space_id}
        AND (LOWER(l.name) IN ${sql(SPRINT_LIST_NAMES)} OR l.kind = 'sprint')
        AND st.task_id IS NULL
    `;
    for (const t of stragglers) {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO migration_audit_modelb (task_id, original_list_id, new_list_id, reason)
          VALUES (${t.task_id}, ${t.current_list_id}, ${backlogId}, 'straggler_to_backlog')
          ON CONFLICT (task_id, reason) DO NOTHING
        `;
        await tx`UPDATE tasks SET list_id = ${backlogId} WHERE id = ${t.task_id}`;
      });
      totalStragglersMoved++;
    }
  }
  console.log(`[0018] step 5: ${totalStragglersMoved} stragglers moved to Backlog`);

  // Step 6: archive lists whose sprint is completed (only if not already set)
  const archived = await sql`
    UPDATE lists l
    SET archived_at = s.end_date
    FROM sprints s
    WHERE l.sprint_id = s.id
      AND s.status = 'completed'
      AND l.archived_at IS NULL
    RETURNING l.id
  `;
  console.log(`[0018] step 6: archived ${archived.length} sprint lists for completed sprints`);

  // Step 6b: ensure sprint-linked lists carry kind='sprint' (idempotent backfill)
  await sql`UPDATE lists SET kind = 'sprint' WHERE sprint_id IS NOT NULL AND kind <> 'sprint'`;

  console.log("[0018] complete");
} catch (err) {
  console.error("[0018] FAILED:", err);
  process.exit(1);
} finally {
  await sql.end();
}
