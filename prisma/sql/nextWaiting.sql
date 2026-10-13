-- Why the open tasks in task_next's scope are not ready, each counted once
-- under the first reason that applies: an open question, a live claim, waits
-- on open tasks. A backlog task with none of these counts nowhere.
-- Parameters are numbered in the order they first appear.
-- @param {String} $1:now
-- @param {Int} $2:projectId
-- @param {Int} $3:milestoneId?
WITH open AS (
  SELECT t.id, t.status,
         EXISTS (SELECT 1 FROM question q
                 WHERE q.task_id = t.id AND q.status = 'open') AS asked,
         EXISTS (SELECT 1 FROM claim c
                 WHERE c.task_id = t.id AND c.until > $1) AS held,
         EXISTS (SELECT 1 FROM waits w JOIN task o ON o.id = w.on_id
                 WHERE w.task_id = t.id AND o.status NOT IN ('done', 'cancelled')) AS waiting
  FROM task t
  WHERE t.project_id = $2
    AND ($3 IS NULL OR t.milestone_id = $3)
    AND t.status IN ('backlog', 'ready', 'active')
)
SELECT count(*) FILTER (WHERE asked) AS blocked,
       count(*) FILTER (WHERE NOT asked AND held) AS active,
       count(*) FILTER (WHERE NOT asked AND NOT held AND waiting) AS waits_open
FROM open
