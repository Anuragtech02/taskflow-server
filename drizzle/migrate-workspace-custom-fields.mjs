/**
 * 0017 — Move custom_field_definitions from list-scoped to workspace-scoped.
 *
 * Idempotent: safe to run multiple times. Each step checks state before
 * mutating. Hooked into start.sh so a fresh container always reaches the
 * desired state.
 *
 * Important invariant: `tasks.customFields` jsonb stores values keyed by the
 * definition's UUID `id`, not by name. Therefore the migration MUST preserve
 * row IDs (no INSERT/replace) and rewrite task jsonb keys when dedup deletes
 * a duplicate definition row.
 *
 * Steps:
 *   1. ADD COLUMN workspace_id (nullable) + supporting index
 *   2. Backfill workspace_id from lists.spaces.workspace_id; surface orphans
 *   3. Dedup: keep one row per (workspace_id, lower(name), type).
 *      For each duplicate group, rewrite tasks.custom_fields jsonb to point
 *      at the canonical id, then delete the loser rows.
 *   4. SET NOT NULL on workspace_id
 *   5. DROP COLUMN list_id (and its FK + index)
 *   6. CREATE UNIQUE INDEX (workspace_id, lower(name), type)
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[0017] DATABASE_URL not set — skipping");
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
  console.log("[0017] starting workspace-custom-fields migration");

  // Step 1: add workspace_id + index
  if (!(await columnExists("custom_field_definitions", "workspace_id"))) {
    await sql.unsafe(`
      ALTER TABLE custom_field_definitions
      ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE
    `);
    console.log("[0017] step 1: added custom_field_definitions.workspace_id");
  } else {
    console.log("[0017] step 1: workspace_id already present — skipping");
  }
  if (!(await indexExists("cfd_workspace_idx"))) {
    await sql.unsafe(`CREATE INDEX cfd_workspace_idx ON custom_field_definitions(workspace_id)`);
    console.log("[0017] step 1b: created cfd_workspace_idx");
  }

  // Step 2: backfill workspace_id, surface orphans before mutating further
  if (await columnExists("custom_field_definitions", "list_id")) {
    const updated = await sql.unsafe(`
      UPDATE custom_field_definitions c
      SET workspace_id = sp.workspace_id
      FROM lists l
      JOIN spaces sp ON sp.id = l.space_id
      WHERE c.list_id = l.id
        AND (c.workspace_id IS NULL OR c.workspace_id <> sp.workspace_id)
      RETURNING 1
    `);
    console.log(`[0017] step 2: backfilled workspace_id on ${updated.length} CFDs`);

    const orphanRows = await sql`
      SELECT c.id, c.name, c.type, c.list_id
      FROM custom_field_definitions c
      WHERE c.workspace_id IS NULL
    `;
    if (orphanRows.length > 0) {
      console.error(`[0017] step 2: ${orphanRows.length} CFDs have no resolvable workspace.`);
      console.error("[0017] These rows likely reference a deleted list or a list whose space was orphaned.");
      console.error("[0017] Inspect and clean up before re-running. Affected rows:");
      for (const r of orphanRows) {
        console.error(`  • cfd id=${r.id} name="${r.name}" type=${r.type} list_id=${r.list_id ?? "NULL"}`);
      }
      throw new Error(`Cannot proceed: ${orphanRows.length} CFDs have no resolvable workspace_id`);
    }
  } else {
    console.log("[0017] step 2: list_id already gone — skipping backfill");
  }

  // Step 3: dedup. Keep canonical row per (workspace_id, lower(name), type);
  // rewrite tasks.custom_fields jsonb keys to point at canonical id; then drop losers.
  // Tiebreaker: lowest "order", then lowest id.
  //
  // Each group's rewrite+delete is wrapped in a tx so a crash mid-group can't
  // leave tasks pointing at a row we already deleted.
  const dupGroups = await sql`
    SELECT workspace_id, LOWER(name) AS lname, type, COUNT(*)::int AS n
    FROM custom_field_definitions
    WHERE workspace_id IS NOT NULL
    GROUP BY workspace_id, LOWER(name), type
    HAVING COUNT(*) > 1
  `;
  let totalDropped = 0;
  for (const g of dupGroups) {
    const ranked = await sql`
      SELECT id, "order"
      FROM custom_field_definitions
      WHERE workspace_id = ${g.workspace_id} AND LOWER(name) = ${g.lname} AND type = ${g.type}
      ORDER BY "order" ASC NULLS LAST, id ASC
    `;
    const canonical = ranked[0].id;
    const losers = ranked.slice(1).map((r) => r.id);
    if (losers.length === 0) continue;

    const droppedHere = await sql.begin(async (tx) => {
      // Rewrite jsonb keys on tasks: move loser-id values onto canonical-id.
      // Operand order matters: `jsonb_build_object(canonical, ...) || (cf - loser)`
      // means "canonical from new object, but if a key already exists in the
      // existing field minus loser, that wins" — i.e. canonical's existing
      // value is preserved when present, and loser's value fills in only when
      // canonical is absent. We also gate on `NOT (custom_fields ? canonical)`
      // for clarity / belt-and-suspenders.
      for (const loserId of losers) {
        await tx`
          UPDATE tasks
          SET custom_fields =
            jsonb_build_object(${canonical}::text, custom_fields -> ${loserId})
            || (custom_fields - ${loserId})
          WHERE custom_fields ? ${loserId}
            AND NOT (custom_fields ? ${canonical})
        `;
        // For tasks that already have canonical AND loser, just strip the loser key
        // (canonical's existing value wins).
        await tx`
          UPDATE tasks
          SET custom_fields = custom_fields - ${loserId}
          WHERE custom_fields ? ${loserId}
            AND (custom_fields ? ${canonical})
        `;
      }
      const del = await tx`DELETE FROM custom_field_definitions WHERE id IN ${tx(losers)} RETURNING 1`;
      return del.length;
    });
    totalDropped += droppedHere;
    console.log(`[0017] step 3: workspace ${g.workspace_id} "${g.lname}" (${g.type}): kept ${canonical}, dropped ${droppedHere}`);
  }
  console.log(`[0017] step 3: dedup removed ${totalDropped} rows total`);

  // Step 4: SET NOT NULL on workspace_id (must have full coverage)
  const orphans = await sql`SELECT COUNT(*)::int AS n FROM custom_field_definitions WHERE workspace_id IS NULL`;
  if (orphans[0].n > 0) {
    throw new Error(`step 4 invariant broken: ${orphans[0].n} CFDs still have NULL workspace_id`);
  }
  if (await isNullable("custom_field_definitions", "workspace_id")) {
    await sql.unsafe(`ALTER TABLE custom_field_definitions ALTER COLUMN workspace_id SET NOT NULL`);
    console.log("[0017] step 4: workspace_id is now NOT NULL");
  } else {
    console.log("[0017] step 4: workspace_id already NOT NULL — skipping");
  }

  // Step 5: drop list_id column + its FK + index
  if (await columnExists("custom_field_definitions", "list_id")) {
    const fks = await sql`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.custom_field_definitions'::regclass
        AND contype = 'f'
        AND pg_get_constraintdef(oid) ILIKE '%list_id%'
    `;
    for (const fk of fks) {
      await sql.unsafe(`ALTER TABLE custom_field_definitions DROP CONSTRAINT IF EXISTS "${fk.conname}"`);
      console.log(`[0017] step 5a: dropped FK ${fk.conname}`);
    }
    if (await indexExists("cfd_list_idx")) {
      await sql.unsafe(`DROP INDEX IF EXISTS cfd_list_idx`);
      console.log("[0017] step 5b: dropped cfd_list_idx");
    }
    await sql.unsafe(`ALTER TABLE custom_field_definitions DROP COLUMN list_id`);
    console.log("[0017] step 5c: dropped custom_field_definitions.list_id");
  } else {
    console.log("[0017] step 5: list_id already gone — skipping");
  }

  // Step 6: unique index on (workspace_id, lower(name), type)
  if (!(await indexExists("cfd_workspace_name_type_unique"))) {
    await sql.unsafe(`
      CREATE UNIQUE INDEX cfd_workspace_name_type_unique
      ON custom_field_definitions (workspace_id, LOWER(name), type)
    `);
    console.log("[0017] step 6: created cfd_workspace_name_type_unique");
  } else {
    console.log("[0017] step 6: unique index already present — skipping");
  }

  console.log("[0017] complete");
} catch (err) {
  console.error("[0017] FAILED:", err);
  process.exit(1);
} finally {
  await sql.end();
}
