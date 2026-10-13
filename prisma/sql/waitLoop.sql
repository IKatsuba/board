-- What the task waited on reaches by waits, each edge once: (id, prev) says
-- prev waits for id. UNION keeps each pair once, so the walk is bounded by
-- the edges, not by the routes through them. The waits are a DAG (a loop is
-- refused before it is written), so following prev back from any reached
-- task ends at the start.
-- @param {Int} $1:onId
WITH RECURSIVE reach(id, prev) AS (
  SELECT $1, NULL
  UNION
  SELECT w.on_id, w.task_id
  FROM waits w
  JOIN reach ON w.task_id = reach.id
)
SELECT id, prev FROM reach
