-- The loop a new parent closed: from the parent, follow parents up until the
-- task is reached. `path` is the ids walked, comma-separated; a path never
-- revisits a task, so the walk ends.
-- @param {Int} $1:parentId
-- @param {Int} $2:taskId
WITH RECURSIVE up(id, path) AS (
  SELECT $1, CAST($1 AS TEXT)
  UNION ALL
  SELECT t.parent_id, CAST(up.path || ',' || t.parent_id AS TEXT)
  FROM task t
  JOIN up ON t.id = up.id
  WHERE t.parent_id IS NOT NULL
    AND instr(',' || up.path || ',', ',' || t.parent_id || ',') = 0
)
SELECT path FROM up WHERE id = $2 LIMIT 1
