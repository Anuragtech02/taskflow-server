/**
 * Dry-run migration analysis. Read-only — makes NO database writes.
 *
 * Reports the planned effect of three migrations against the connected database:
 *   1. statuses → workspace-scoped (dedup by lower(name))
 *   2. custom_field_definitions → workspace-scoped (dedup by (lower(name), type))
 *   3. Model B: each sprint gets its own list, tasks move from current list to sprint list
 *
 * Run with:
 *   DATABASE_URL=... npx tsx scripts/dry-run-migration.ts
 */

import { db, schema } from "../src/db/index.js";
import { sql, eq, inArray, isNotNull } from "drizzle-orm";

const { workspaces, spaces, lists, statuses, customFieldDefinitions, sprints, sprintTasks, tasks } = schema;

type RecordCount = { label: string; count: number };

function header(s: string) {
  console.log("\n" + "═".repeat(70));
  console.log(`  ${s}`);
  console.log("═".repeat(70));
}

function section(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 67 - s.length))}`);
}

function row(label: string, value: string | number) {
  console.log(`  ${label.padEnd(50)} ${String(value).padStart(15)}`);
}

async function snapshot(): Promise<RecordCount[]> {
  const out: RecordCount[] = [];
  out.push({ label: "workspaces",                count: (await db.select({ c: sql<number>`count(*)::int` }).from(workspaces))[0].c });
  out.push({ label: "spaces",                    count: (await db.select({ c: sql<number>`count(*)::int` }).from(spaces))[0].c });
  out.push({ label: "lists",                     count: (await db.select({ c: sql<number>`count(*)::int` }).from(lists))[0].c });
  out.push({ label: "sprints",                   count: (await db.select({ c: sql<number>`count(*)::int` }).from(sprints))[0].c });
  out.push({ label: "tasks",                     count: (await db.select({ c: sql<number>`count(*)::int` }).from(tasks))[0].c });
  out.push({ label: "tasks (with sprintTasks)",  count: (await db.select({ c: sql<number>`count(distinct task_id)::int` }).from(sprintTasks))[0].c });
  out.push({ label: "sprintTasks rows",          count: (await db.select({ c: sql<number>`count(*)::int` }).from(sprintTasks))[0].c });
  out.push({ label: "statuses (per-list)",       count: (await db.select({ c: sql<number>`count(*)::int` }).from(statuses))[0].c });
  out.push({ label: "custom_field_definitions",  count: (await db.select({ c: sql<number>`count(*)::int` }).from(customFieldDefinitions))[0].c });
  return out;
}

async function statusesAreWorkspaceScoped(): Promise<boolean> {
  const r = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='statuses' AND column_name='workspace_id'
    ) AS ok
  `);
  return ((r as unknown as { ok: boolean }[])[0]?.ok) === true;
}

async function statusesStillHaveListId(): Promise<boolean> {
  const r = await db.execute<{ ok: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='statuses' AND column_name='list_id'
    ) AS ok
  `);
  return ((r as unknown as { ok: boolean }[])[0]?.ok) === true;
}

async function analyzeStatuses() {
  header("MIGRATION 1: statuses → workspace-scoped");

  const hasListId = await statusesStillHaveListId();
  const hasWorkspaceId = await statusesAreWorkspaceScoped();

  if (!hasListId && hasWorkspaceId) {
    console.log("\n  ✓ Migration 1 already applied — statuses.list_id is gone, statuses.workspace_id is present.");
    console.log("    Skipping pre-migration analysis. Run a separate post-migration verification if needed.");
    return;
  }

  // Per workspace, distinct status names (case-insensitive). Pre-migration shape: joined via list -> space.
  const rows = await db.execute<{
    workspace_id: string; workspace_name: string; total_statuses: number; distinct_names: number;
  }>(sql`
    SELECT
      w.id   AS workspace_id,
      w.name AS workspace_name,
      COUNT(s.id)::int                          AS total_statuses,
      COUNT(DISTINCT LOWER(s.name))::int        AS distinct_names
    FROM ${workspaces} w
    JOIN ${spaces}    sp ON sp.workspace_id = w.id
    JOIN ${lists}     l  ON l.space_id      = sp.id
    LEFT JOIN ${statuses} s ON s.list_id    = l.id
    GROUP BY w.id, w.name
    ORDER BY w.name
  `);

  let totalBefore = 0;
  let totalAfter = 0;
  console.log(`\n  Per-workspace status counts (before → after dedup by lower(name)):\n`);
  console.log(`  ${"workspace".padEnd(40)} ${"before".padStart(10)} ${"after".padStart(10)} ${"removed".padStart(10)}`);
  for (const r of rows as unknown as { workspace_id: string; workspace_name: string; total_statuses: number; distinct_names: number }[]) {
    totalBefore += r.total_statuses;
    totalAfter += r.distinct_names;
    console.log(`  ${(r.workspace_name || "-").slice(0, 40).padEnd(40)} ${String(r.total_statuses).padStart(10)} ${String(r.distinct_names).padStart(10)} ${String(r.total_statuses - r.distinct_names).padStart(10)}`);
  }
  console.log("  " + "─".repeat(72));
  console.log(`  ${"TOTAL".padEnd(40)} ${String(totalBefore).padStart(10)} ${String(totalAfter).padStart(10)} ${String(totalBefore - totalAfter).padStart(10)}`);

  section("Status name conflicts (same lowercase name, different casing/color across lists)");
  const conflicts = await db.execute<{
    workspace_id: string; norm_name: string; variants: number; sample_names: string; sample_colors: string;
  }>(sql`
    SELECT
      sp.workspace_id,
      LOWER(s.name)        AS norm_name,
      COUNT(*)::int        AS variants,
      STRING_AGG(DISTINCT s.name, ', ')      AS sample_names,
      STRING_AGG(DISTINCT s.color, ', ')     AS sample_colors
    FROM ${statuses} s
    JOIN ${lists}    l  ON l.id = s.list_id
    JOIN ${spaces}   sp ON sp.id = l.space_id
    GROUP BY sp.workspace_id, LOWER(s.name)
    HAVING COUNT(*) > 1
    ORDER BY variants DESC
    LIMIT 30
  `);
  const conflictRows = conflicts as unknown as { workspace_id: string; norm_name: string; variants: number; sample_names: string; sample_colors: string }[];
  if (conflictRows.length === 0) {
    console.log("  (none — every status name is unique within its workspace already)");
  } else {
    for (const r of conflictRows) {
      console.log(`  • "${r.norm_name}"  ${r.variants}× across lists`);
      console.log(`      names seen:  ${r.sample_names}`);
      console.log(`      colors seen: ${r.sample_colors}`);
    }
  }

  section("Plan");
  console.log(`  - ALTER TABLE statuses ADD COLUMN workspace_id UUID;`);
  console.log(`  - Backfill: workspace_id ← lists.space.workspace_id`);
  console.log(`  - Dedup: keep one row per (workspace_id, LOWER(name)). Tiebreaker: is_default DESC, order ASC, id ASC.`);
  console.log(`  - tasks.status remains a varchar of the status NAME — no FK rewiring needed.`);
  console.log(`  - statuses.list_id stays nullable as a deprecation tombstone (drop in a follow-up).`);
}

async function analyzeCustomFields() {
  header("MIGRATION 2: custom_field_definitions → workspace-scoped");

  const rows = await db.execute<{
    workspace_id: string; workspace_name: string; total_cfds: number; distinct_signatures: number;
  }>(sql`
    SELECT
      w.id   AS workspace_id,
      w.name AS workspace_name,
      COUNT(c.id)::int                                                  AS total_cfds,
      COUNT(DISTINCT LOWER(c.name) || '|' || c.type)::int               AS distinct_signatures
    FROM ${workspaces} w
    JOIN ${spaces}    sp ON sp.workspace_id = w.id
    JOIN ${lists}     l  ON l.space_id      = sp.id
    LEFT JOIN ${customFieldDefinitions} c ON c.list_id = l.id
    GROUP BY w.id, w.name
    ORDER BY w.name
  `);

  let totalBefore = 0;
  let totalAfter = 0;
  console.log(`\n  Per-workspace custom-field counts (before → after dedup by (lower(name), type)):\n`);
  console.log(`  ${"workspace".padEnd(40)} ${"before".padStart(10)} ${"after".padStart(10)} ${"removed".padStart(10)}`);
  for (const r of rows as unknown as { workspace_id: string; workspace_name: string; total_cfds: number; distinct_signatures: number }[]) {
    totalBefore += r.total_cfds;
    totalAfter += r.distinct_signatures;
    console.log(`  ${(r.workspace_name || "-").slice(0, 40).padEnd(40)} ${String(r.total_cfds).padStart(10)} ${String(r.distinct_signatures).padStart(10)} ${String(r.total_cfds - r.distinct_signatures).padStart(10)}`);
  }
  console.log("  " + "─".repeat(72));
  console.log(`  ${"TOTAL".padEnd(40)} ${String(totalBefore).padStart(10)} ${String(totalAfter).padStart(10)} ${String(totalBefore - totalAfter).padStart(10)}`);

  section("CFD name+type conflicts");
  const conflicts = await db.execute<{
    workspace_id: string; key: string; variants: number; sample_options: string;
  }>(sql`
    SELECT
      sp.workspace_id,
      LOWER(c.name) || ' (' || c.type || ')' AS key,
      COUNT(*)::int                          AS variants,
      STRING_AGG(DISTINCT c.options::text, ' || ') AS sample_options
    FROM ${customFieldDefinitions} c
    JOIN ${lists}    l  ON l.id = c.list_id
    JOIN ${spaces}   sp ON sp.id = l.space_id
    GROUP BY sp.workspace_id, LOWER(c.name), c.type
    HAVING COUNT(*) > 1
    ORDER BY variants DESC
    LIMIT 30
  `);
  const conflictRows = conflicts as unknown as { workspace_id: string; key: string; variants: number; sample_options: string }[];
  if (conflictRows.length === 0) {
    console.log("  (none — every (name, type) is unique per workspace already)");
  } else {
    console.log(`  ⚠️  Same (name, type) defined across multiple lists — options may diverge:`);
    for (const r of conflictRows) {
      console.log(`  • ${r.key}  ${r.variants}×`);
      console.log(`      options seen: ${r.sample_options}`);
    }
    console.log(`\n  Resolution: keep one canonical row per (workspace_id, lower(name), type).`);
    console.log(`  ⚠️  task.customFields jsonb keys reference field NAMES, not IDs (verify before applying).`);
  }
}

async function analyzeSprintInventory() {
  header("SPRINT INVENTORY — proposed list names per sprint");

  const inv = await db.execute<{
    space_id: string; space_name: string;
    sprint_id: string; sprint_name: string; sprint_status: string;
    start_date: string; end_date: string; task_count: number;
  }>(sql`
    SELECT
      sp.id   AS space_id,
      sp.name AS space_name,
      s.id    AS sprint_id,
      s.name  AS sprint_name,
      s.status AS sprint_status,
      s.start_date::text AS start_date,
      s.end_date::text   AS end_date,
      (SELECT COUNT(*)::int FROM ${sprintTasks} st WHERE st.sprint_id = s.id) AS task_count
    FROM ${sprints} s
    JOIN ${spaces}  sp ON sp.id = s.space_id
    ORDER BY sp.name, s.start_date NULLS LAST, s.name
  `);
  const rows = inv as unknown as { space_id: string; space_name: string; sprint_id: string; sprint_name: string; sprint_status: string; start_date: string; end_date: string; task_count: number }[];

  let lastSpace = "";
  for (const r of rows) {
    if (r.space_name !== lastSpace) {
      console.log(`\n  Space: ${r.space_name}`);
      console.log(`  ${"sprint name".padEnd(30)} ${"status".padEnd(11)} ${"start".padEnd(12)} ${"end".padEnd(12)} ${"tasks".padStart(6)}`);
      lastSpace = r.space_name;
    }
    const start = (r.start_date || "").slice(0, 10);
    const end = (r.end_date || "").slice(0, 10);
    console.log(`  ${(r.sprint_name || "(unnamed)").slice(0, 30).padEnd(30)} ${(r.sprint_status || "").padEnd(11)} ${start.padEnd(12)} ${end.padEnd(12)} ${String(r.task_count).padStart(6)}`);
  }

  section("Naming collision check");

  // Detect sprint name collisions WITHIN a space (would create duplicate list names)
  const dupes = await db.execute<{ space_name: string; sprint_name: string; n: number }>(sql`
    SELECT sp.name AS space_name, s.name AS sprint_name, COUNT(*)::int AS n
    FROM ${sprints} s JOIN ${spaces} sp ON sp.id = s.space_id
    GROUP BY sp.name, s.name
    HAVING COUNT(*) > 1
  `);
  const dupeRows = dupes as unknown as { space_name: string; sprint_name: string; n: number }[];
  if (dupeRows.length === 0) {
    console.log("  ✓ No two sprints share a name within the same space.");
  } else {
    console.log("  ⚠️  Duplicate sprint names within a space (would clash as list names):");
    for (const d of dupeRows) console.log(`     • ${d.space_name}: "${d.sprint_name}" × ${d.n}`);
  }

  // Detect sprint name vs existing-list collisions
  const listClash = await db.execute<{ space_name: string; name: string; sprint_id: string }>(sql`
    SELECT sp.name AS space_name, l.name, s.id AS sprint_id
    FROM ${lists} l
    JOIN ${spaces}  sp ON sp.id = l.space_id
    JOIN ${sprints} s  ON s.space_id = sp.id AND LOWER(s.name) = LOWER(l.name)
  `);
  const clashRows = listClash as unknown as { space_name: string; name: string; sprint_id: string }[];
  if (clashRows.length === 0) {
    console.log("  ✓ No sprint name collides with an existing list name in the same space.");
  } else {
    console.log("  ⚠️  Sprint names that match existing list names (will reuse those lists):");
    for (const c of clashRows) console.log(`     • ${c.space_name}: "${c.name}"`);
  }

  // Empty completed sprints — kept for visibility (we now CREATE empty archived lists for them)
  const emptyCompleted = await db.execute<{ space_name: string; sprint_name: string }>(sql`
    SELECT sp.name AS space_name, s.name AS sprint_name
    FROM ${sprints} s
    JOIN ${spaces}  sp ON sp.id = s.space_id
    WHERE s.status = 'completed'
      AND (SELECT COUNT(*) FROM ${sprintTasks} st WHERE st.sprint_id = s.id) = 0
  `);
  const emptyRows = emptyCompleted as unknown as { space_name: string; sprint_name: string }[];
  if (emptyRows.length > 0) {
    console.log("\n  Empty completed sprints (will get archived empty lists, not skipped — preserves UI visibility):");
    for (const e of emptyRows) console.log(`     • ${e.space_name}: "${e.sprint_name}"`);
  }
}

async function analyzeModelB() {
  header("MIGRATION 3: Model B — sprint becomes a list");

  // Per space: how many sprints, how many tasks linked via sprintTasks
  const perSpace = await db.execute<{
    workspace_id: string;
    space_id: string;
    space_name: string;
    sprint_count: number;
    sprint_completed: number;
    sprint_active_planned: number;
    tasks_in_sprints: number;
  }>(sql`
    SELECT
      sp.workspace_id,
      sp.id   AS space_id,
      sp.name AS space_name,
      COUNT(DISTINCT s.id)::int                                                     AS sprint_count,
      COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'completed')::int               AS sprint_completed,
      COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('planned','active'))::int     AS sprint_active_planned,
      COUNT(DISTINCT st.task_id)::int                                               AS tasks_in_sprints
    FROM ${spaces} sp
    LEFT JOIN ${sprints}      s  ON s.space_id  = sp.id
    LEFT JOIN ${sprintTasks}  st ON st.sprint_id = s.id
    GROUP BY sp.workspace_id, sp.id, sp.name
    HAVING COUNT(DISTINCT s.id) > 0
    ORDER BY sp.workspace_id, sp.name
  `);

  console.log(`\n  Per-space sprint inventory:\n`);
  console.log(`  ${"space".padEnd(35)} ${"sprints".padStart(8)} ${"completed".padStart(10)} ${"active".padStart(8)} ${"tasks".padStart(8)}`);
  for (const r of perSpace as unknown as { workspace_id: string; space_id: string; space_name: string; sprint_count: number; sprint_completed: number; sprint_active_planned: number; tasks_in_sprints: number }[]) {
    console.log(`  ${(r.space_name || "-").slice(0, 35).padEnd(35)} ${String(r.sprint_count).padStart(8)} ${String(r.sprint_completed).padStart(10)} ${String(r.sprint_active_planned).padStart(8)} ${String(r.tasks_in_sprints).padStart(8)}`);
  }

  section("Lists currently named 'Sprint' (candidate to become the active sprint's list)");
  const namedSprintLists = await db.execute<{
    list_id: string; list_name: string; space_id: string; space_name: string; task_count: number;
  }>(sql`
    SELECT
      l.id    AS list_id,
      l.name  AS list_name,
      sp.id   AS space_id,
      sp.name AS space_name,
      (SELECT COUNT(*)::int FROM ${tasks} t WHERE t.list_id = l.id) AS task_count
    FROM ${lists} l
    JOIN ${spaces} sp ON sp.id = l.space_id
    WHERE LOWER(l.name) IN ('sprint', 'sprints', 'current sprint')
    ORDER BY sp.name
  `);
  const sprintLists = namedSprintLists as unknown as { list_id: string; list_name: string; space_id: string; space_name: string; task_count: number }[];
  if (sprintLists.length === 0) {
    console.log("  (none — every sprint will get a brand-new list)");
  } else {
    for (const r of sprintLists) {
      console.log(`  • "${r.list_name}" in space "${r.space_name}" — ${r.task_count} tasks`);
    }
  }

  section("Tasks that would change list_id during the migration");
  const movingTasks = await db.execute<{
    space_id: string;
    space_name: string;
    moving_to_sprint_list: number;
    staying_in_current_list: number;
  }>(sql`
    WITH sprint_task_pairs AS (
      SELECT DISTINCT st.task_id, t.list_id AS current_list_id, s.space_id
      FROM ${sprintTasks} st
      JOIN ${sprints} s ON s.id = st.sprint_id
      JOIN ${tasks}   t ON t.id = st.task_id
    )
    SELECT
      sp.id   AS space_id,
      sp.name AS space_name,
      COUNT(*)::int                            AS moving_to_sprint_list,
      0::int                                    AS staying_in_current_list
    FROM sprint_task_pairs stp
    JOIN ${spaces} sp ON sp.id = stp.space_id
    GROUP BY sp.id, sp.name
    ORDER BY sp.name
  `);
  const moves = movingTasks as unknown as { space_id: string; space_name: string; moving_to_sprint_list: number; staying_in_current_list: number }[];
  console.log(`  ${"space".padEnd(35)} ${"tasks moving".padStart(15)}`);
  let totalMoving = 0;
  for (const r of moves) {
    totalMoving += r.moving_to_sprint_list;
    console.log(`  ${(r.space_name || "-").slice(0, 35).padEnd(35)} ${String(r.moving_to_sprint_list).padStart(15)}`);
  }
  console.log(`  ${"TOTAL tasks whose list_id will change".padEnd(50)} ${String(totalMoving).padStart(15)}`);

  section("Subtask cross-list edge cases (subtask in sprint, parent in another list)");
  const orphanRisk = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM ${tasks} child
    JOIN ${tasks} parent ON parent.id = child.parent_task_id
    JOIN ${sprintTasks} st_child  ON st_child.task_id  = child.id
    LEFT JOIN ${sprintTasks} st_parent ON st_parent.task_id = parent.id
    WHERE st_parent.task_id IS NULL
  `);
  const orphanCount = (orphanRisk as unknown as { count: number }[])[0]?.count ?? 0;
  console.log(`  Subtasks in a sprint whose parent is NOT in any sprint: ${orphanCount}`);
  console.log(`  → After migration these become root-level tasks in the sprint list (visual only;`);
  console.log(`    parent_task_id stays intact, just renders flat because parent isn't in result set).`);

  section("Tasks currently in a list named 'Sprint' but with NO sprintTasks row");
  // For each affected space, also report whether a Backlog list already exists.
  const orphanInSprintList = await db.execute<{ space_id: string; space_name: string; count: number; existing_backlog_id: string | null; existing_backlog_name: string | null }>(sql`
    WITH straggler AS (
      SELECT sp.id AS space_id, sp.name AS space_name, COUNT(*)::int AS count
      FROM ${tasks} t
      JOIN ${lists}  l  ON l.id = t.list_id
      JOIN ${spaces} sp ON sp.id = l.space_id
      LEFT JOIN ${sprintTasks} st ON st.task_id = t.id
      WHERE LOWER(l.name) IN ('sprint', 'sprints', 'current sprint')
        AND st.task_id IS NULL
      GROUP BY sp.id, sp.name
    ),
    backlog AS (
      SELECT space_id, id, name,
             ROW_NUMBER() OVER (PARTITION BY space_id ORDER BY created_at, id) AS rn
      FROM ${lists}
      WHERE LOWER(name) IN ('backlog', 'backlogs')
    )
    SELECT s.space_id, s.space_name, s.count,
           b.id   AS existing_backlog_id,
           b.name AS existing_backlog_name
    FROM straggler s
    LEFT JOIN backlog b ON b.space_id = s.space_id AND b.rn = 1
  `);
  const orphans = orphanInSprintList as unknown as { space_id: string; space_name: string; count: number; existing_backlog_id: string | null; existing_backlog_name: string | null }[];
  if (orphans.length === 0) {
    console.log("  (none — every task in a 'Sprint' list is associated with at least one sprint)");
  } else {
    for (const o of orphans) {
      if (o.existing_backlog_id) {
        console.log(`  • ${o.space_name}: ${o.count} tasks → existing "${o.existing_backlog_name}" list (no new list created)`);
      } else {
        console.log(`  • ${o.space_name}: ${o.count} tasks → CREATE new "Backlog" list (none exists in this space)`);
      }
    }
  }

  section("Existing 'Sprint'-named lists — what happens to them after migration");
  const sprintListsFate = await db.execute<{ list_id: string; list_name: string; space_name: string; active_sprint_count: number }>(sql`
    SELECT l.id AS list_id, l.name AS list_name, sp.name AS space_name,
           (SELECT COUNT(*)::int
              FROM ${sprints} s
              WHERE s.space_id = sp.id AND s.status = 'active'
           ) AS active_sprint_count
    FROM ${lists} l
    JOIN ${spaces} sp ON sp.id = l.space_id
    WHERE LOWER(l.name) IN ('sprint', 'sprints', 'current sprint')
  `);
  const fateRows = sprintListsFate as unknown as { list_id: string; list_name: string; space_name: string; active_sprint_count: number }[];
  for (const r of fateRows) {
    if (r.active_sprint_count >= 1) {
      console.log(`  • "${r.list_name}" in "${r.space_name}" → REUSE as the active sprint's list (renamed to that sprint's name)`);
    } else {
      console.log(`  • "${r.list_name}" in "${r.space_name}" → no active sprint to attach to; will become an unattached general list`);
    }
  }

  section("Plan summary");
  console.log(`  - ALTER TABLE lists ADD COLUMN sprint_id UUID, archived_at TIMESTAMP, kind VARCHAR(20).`);
  console.log(`  - For EVERY sprint (including empty completed ones) create or reuse a list:`);
  console.log(`      • kind='sprint', sprint_id set, archived_at = sprint.endDate when status='completed'.`);
  console.log(`      • Active sprint reuses the existing "Sprint"-named list when present (renamed).`);
  console.log(`      • Empty completed sprints get archived empty lists — preserves UI visibility under Past Sprints.`);
  console.log(`  - For each (sprintId, taskId) in sprintTasks: tasks.list_id = (that sprint's list id).`);
  console.log(`  - sprintTasks junction stays as historical record. Writes update both junction and tasks.list_id atomically.`);
  console.log(`  - Stragglers in 'Sprint'-named lists with no sprintTasks → existing 'Backlog' list (per space) when present, else new 'Backlog'.`);
  console.log(`  - Past Sprints folder created per space; archived sprint lists nested there for sidebar tidiness.`);
  console.log(`  - Audit table 'migration_audit_modelb' records (task_id, original_list_id, new_list_id) for rollback.`);
}

async function main() {
  header("DRY-RUN MIGRATION REPORT — read-only, no writes");
  const start = Date.now();

  section("Current snapshot");
  const snap = await snapshot();
  for (const r of snap) row(r.label, r.count);

  await analyzeStatuses();
  await analyzeCustomFields();
  await analyzeSprintInventory();
  await analyzeModelB();

  console.log(`\n  Done in ${((Date.now() - start) / 1000).toFixed(2)}s. No writes performed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[dry-run] FAILED:", err);
  process.exit(1);
});
