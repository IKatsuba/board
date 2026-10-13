-- task_next's pick: the first ready task of the current milestone, then of
-- no milestone, then of later milestones in chain order; within each,
-- priority then oldest. An explicit milestone restricts the search to it.
-- Parameters are numbered in the order they first appear, since SQLite
-- numbers $N parameters by first appearance when bound from an array.
-- @param {Int} $1:projectId
-- @param {Int} $2:milestoneId?
-- @param {String} $3:now
-- @param {Int} $4:currentId?
SELECT t.id, t.milestone_id
FROM task t
LEFT JOIN milestone m ON m.id = t.milestone_id
WHERE t.project_id = $1
  AND ($2 IS NULL OR t.milestone_id = $2)
  AND (t.status = 'ready'
       OR (t.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM claim c WHERE c.task_id = t.id AND c.until > $3)))
  AND NOT EXISTS (SELECT 1 FROM question q WHERE q.task_id = t.id AND q.status = 'open')
  AND NOT EXISTS (SELECT 1 FROM waits w JOIN task o ON o.id = w.on_id
                  WHERE w.task_id = t.id AND o.status NOT IN ('done', 'cancelled'))
ORDER BY CASE
           WHEN t.milestone_id = $4 THEN 0
           WHEN t.milestone_id IS NULL THEN 1
           ELSE 2
         END,
         m.position, t.priority, t.id
LIMIT 1
