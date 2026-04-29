/**
 * 0016 — Move statuses from list-scoped to workspace-scoped.
 *
 * Idempotent: safe to run multiple times. Each step checks current state
 * before mutating. Designed to be invoked from start.sh before
 * `drizzle-kit push` so a fresh container always reaches the desired state.
 *
 * Steps (each guarded so re-running is a no-op once applied):
 *   1. ADD COLUMN workspace_id (nullable) + supporting index
 *   2. Backfill workspace_id from lists.spaces.workspace_id
 *   3. Dedup: keep one row per (workspace_id, lower(name)) — tiebreaker is_default DESC, "order" ASC, id ASC
 *   4. SET NOT NULL on workspace_id
 *   5. DROP COLUMN list_id (and its FK + index)
 *   6. CREATE UNIQUE INDEX (workspace_id, lower(name))
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[0016] DATABASE_URL not set — skipping");
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

async function isNullable(table, column) {
  const r = await sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    LIMIT 1
  `;
  return r.length > 0 && r[0].is_nullable === "YES";
}

try {
  console.log("[0016] starting workspace-statuses migration");

  // Step 1: add workspace_id column (nullable initially) + index
  if (!(await columnExists("statuses", "workspace_id"))) {
    await sql.unsafe(`
      ALTER TABLE statuses
      ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE
    `);
    console.log("[0016] step 1: added statuses.workspace_id");
  } else {
    console.log("[0016] step 1: workspace_id already present — skipping");
  }
  if (!(await indexExists("statuses_workspace_idx"))) {
    await sql.unsafe(`CREATE INDEX statuses_workspace_idx ON statuses(workspace_id)`);
    console.log("[0016] step 1b: created statuses_workspace_idx");
  }

  // Step 2: backfill workspace_id from list -> space -> workspace
  // Then surface orphans (rows whose list_id was dangling or list lacks a space).
  if (await columnExists("statuses", "list_id")) {
    const updated = await sql.unsafe(`
      UPDATE statuses s
      SET workspace_id = sp.workspace_id
      FROM lists l
      JOIN spaces sp ON sp.id = l.space_id
      WHERE s.list_id = l.id
        AND (s.workspace_id IS NULL OR s.workspace_id <> sp.workspace_id)
      RETURNING 1
    `);
    console.log(`[0016] step 2: backfilled workspace_id on ${updated.length} statuses`);

    // Surface ANY rows still lacking a workspace_id BEFORE we run dedup, so
    // operators get a clear, actionable list rather than a crash-loop in step 4.
    const orphanRows = await sql`
      SELECT s.id, s.name, s.list_id
      FROM statuses s
      WHERE s.workspace_id IS NULL
    `;
    if (orphanRows.length > 0) {
      console.error(`[0016] step 2: ${orphanRows.length} status rows have no resolvable workspace.`);
      console.error("[0016] These rows likely reference a deleted list or a list whose space was orphaned.");
      console.error("[0016] Inspect and clean up before re-running. Affected rows:");
      for (const r of orphanRows) {
        console.error(`  • status id=${r.id} name="${r.name}" list_id=${r.list_id ?? "NULL"}`);
      }
      throw new Error(`Cannot proceed: ${orphanRows.length} statuses have no resolvable workspace_id`);
    }
  } else {
    console.log("[0016] step 2: list_id already gone — skipping backfill");
  }

  // Step 3: dedup by (workspace_id, lower(name))
  // Keep one row per group. Tiebreaker: is_default DESC, "order" ASC, id ASC.
  // We do NOT delete rows that have NULL workspace_id (defensive — should never happen post-step-2).
  const before = await sql`SELECT COUNT(*)::int AS n FROM statuses WHERE workspace_id IS NOT NULL`;
  const dropped = await sql.unsafe(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY workspace_id, LOWER(name)
               ORDER BY is_default DESC NULLS LAST, "order" ASC NULLS LAST, id ASC
             ) AS rn
      FROM statuses
      WHERE workspace_id IS NOT NULL
    )
    DELETE FROM statuses WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING 1
  `);
  const after = await sql`SELECT COUNT(*)::int AS n FROM statuses WHERE workspace_id IS NOT NULL`;
  console.log(`[0016] step 3: dedup removed ${dropped.length} rows (${before[0].n} → ${after[0].n})`);

  // Step 3b: preserve is_default invariant per workspace.
  // After dedup, ensure every workspace that had any default-flagged status pre-migration
  // still has at least one default-flagged status. The dedup tiebreaker prefers is_default DESC,
  // so a default-flagged row would already win against non-default duplicates — but a workspace
  // with mixed defaults (different lists each had their own default) might end up with multiple
  // surviving rows where only one carried the flag. Normalize: at most one default per workspace.
  const multiDefaults = await sql`
    SELECT workspace_id, COUNT(*)::int AS n
    FROM statuses
    WHERE is_default = true
    GROUP BY workspace_id
    HAVING COUNT(*) > 1
  `;
  for (const md of multiDefaults) {
    // Keep the lowest-order default; clear the flag on the rest.
    await sql.unsafe(`
      UPDATE statuses SET is_default = false
      WHERE workspace_id = '${md.workspace_id}'
        AND is_default = true
        AND id NOT IN (
          SELECT id FROM statuses
          WHERE workspace_id = '${md.workspace_id}' AND is_default = true
          ORDER BY "order" ASC NULLS LAST, id ASC
          LIMIT 1
        )
    `);
    console.log(`[0016] step 3b: workspace ${md.workspace_id} had ${md.n} defaults — collapsed to 1`);
  }

  // Step 4: SET NOT NULL on workspace_id (only if we have full coverage)
  const orphans = await sql`SELECT COUNT(*)::int AS n FROM statuses WHERE workspace_id IS NULL`;
  if (orphans[0].n > 0) {
    // Should be impossible after the step-2 abort branch — surface clearly if it isn't.
    throw new Error(`step 4 invariant broken: ${orphans[0].n} statuses still have NULL workspace_id`);
  }
  if (await isNullable("statuses", "workspace_id")) {
    await sql.unsafe(`ALTER TABLE statuses ALTER COLUMN workspace_id SET NOT NULL`);
    console.log("[0016] step 4: workspace_id is now NOT NULL");
  } else {
    console.log("[0016] step 4: workspace_id already NOT NULL — skipping");
  }

  // Step 5: drop list_id column (and its FK + index)
  if (await columnExists("statuses", "list_id")) {
    // Drop FK constraints referencing list_id (name is auto-generated in older Drizzle).
    const fks = await sql`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.statuses'::regclass
        AND contype = 'f'
        AND pg_get_constraintdef(oid) ILIKE '%list_id%'
    `;
    for (const fk of fks) {
      await sql.unsafe(`ALTER TABLE statuses DROP CONSTRAINT IF EXISTS "${fk.conname}"`);
      console.log(`[0016] step 5a: dropped FK ${fk.conname}`);
    }
    if (await indexExists("statuses_list_idx")) {
      await sql.unsafe(`DROP INDEX IF EXISTS statuses_list_idx`);
      console.log("[0016] step 5b: dropped statuses_list_idx");
    }
    await sql.unsafe(`ALTER TABLE statuses DROP COLUMN list_id`);
    console.log("[0016] step 5c: dropped statuses.list_id");
  } else {
    console.log("[0016] step 5: list_id already gone — skipping");
  }

  // Step 6: unique index on (workspace_id, lower(name))
  if (!(await indexExists("statuses_workspace_name_unique"))) {
    await sql.unsafe(`
      CREATE UNIQUE INDEX statuses_workspace_name_unique
      ON statuses (workspace_id, LOWER(name))
    `);
    console.log("[0016] step 6: created statuses_workspace_name_unique");
  } else {
    console.log("[0016] step 6: unique index already present — skipping");
  }

  console.log("[0016] complete");
} catch (err) {
  console.error("[0016] FAILED:", err);
  process.exit(1);
} finally {
  await sql.end();
}
