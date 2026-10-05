import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

type Executor = Pick<typeof db, "execute">;

/**
 * Every descendant (children, grandchildren, … any depth) of the given tasks,
 * restricted to one workspace and excluding the roots themselves.
 *
 * UNION (not UNION ALL) de-duplicates as it recurses, so a corrupted
 * parent_task_id cycle terminates instead of looping forever.
 */
export async function descendantIds(exec: Executor, rootIds: string[], workspaceId: string): Promise<string[]> {
  if (rootIds.length === 0) return [];
  const roots = sql.join(rootIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await exec.execute<{ id: string }>(sql`
    WITH RECURSIVE sub AS (
      SELECT t.id FROM tasks t WHERE t.parent_task_id IN (${roots})
      UNION
      SELECT t.id FROM tasks t JOIN sub ON t.parent_task_id = sub.id
    )
    SELECT s.id FROM sub s
    JOIN tasks t ON t.id = s.id
    JOIN lists l ON l.id = t.list_id
    JOIN spaces sp ON sp.id = l.space_id
    WHERE sp.workspace_id = ${workspaceId}::uuid
      AND s.id NOT IN (${roots})
  `);
  return (rows as unknown as { id: string }[]).map((r) => r.id);
}
