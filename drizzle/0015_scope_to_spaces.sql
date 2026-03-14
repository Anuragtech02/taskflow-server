BEGIN;

-- Step 0: Create a "General" space for any workspace that has no spaces
-- (prevents orphaned sprints/docs during backfill)
INSERT INTO spaces (id, workspace_id, name, icon, "order", created_at)
SELECT gen_random_uuid(), w.id, 'General', 'folder', 0, NOW()
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.workspace_id = w.id);

-- Step 1: Add spaceId to sprints (nullable initially)
ALTER TABLE sprints ADD COLUMN space_id UUID REFERENCES spaces(id) ON DELETE CASCADE;
CREATE INDEX sprints_space_idx ON sprints(space_id);

-- Step 2: Backfill sprints — infer space from majority of tasks
UPDATE sprints s SET space_id = (
  SELECT sp.id FROM sprint_tasks st
  JOIN tasks t ON st.task_id = t.id
  JOIN lists l ON t.list_id = l.id
  JOIN spaces sp ON l.space_id = sp.id
  WHERE st.sprint_id = s.id
  GROUP BY sp.id ORDER BY COUNT(*) DESC LIMIT 1
) WHERE EXISTS (SELECT 1 FROM sprint_tasks WHERE sprint_id = s.id);

-- Step 3: Sprints with no tasks — assign to first space in workspace
UPDATE sprints s SET space_id = (
  SELECT sp.id FROM spaces sp WHERE sp.workspace_id = s.workspace_id
  ORDER BY sp."order" ASC, sp.created_at ASC LIMIT 1
) WHERE s.space_id IS NULL;

-- Step 4: Backfill documents with null spaceId
UPDATE documents d SET space_id = (
  SELECT sp.id FROM spaces sp WHERE sp.workspace_id = d.workspace_id
  ORDER BY sp."order" ASC, sp.created_at ASC LIMIT 1
) WHERE d.space_id IS NULL;

-- Step 5: Make NOT NULL (safe — all rows backfilled above)
ALTER TABLE sprints ALTER COLUMN space_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN space_id SET NOT NULL;

COMMIT;
