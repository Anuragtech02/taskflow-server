UPDATE tasks SET archived_at = NULL WHERE archived_at IS NOT NULL;
