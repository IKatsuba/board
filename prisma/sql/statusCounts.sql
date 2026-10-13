-- One project's tasks counted by effective status: blocked is an open
-- question, and an expired claim reads as no claim. Parameters are numbered
-- in the order they first appear.
-- @param {String} $1:now
-- @param {Int} $2:projectId
WITH effective AS (
  SELECT CASE
           WHEN t.status IN ('done', 'cancelled') THEN t.status
           WHEN EXISTS (SELECT 1 FROM question q
                        WHERE q.task_id = t.id AND q.status = 'open') THEN 'blocked'
           WHEN t.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM claim c
                                WHERE c.task_id = t.id AND c.until > $1) THEN 'ready'
           ELSE t.status
         END AS status
  FROM task t
  WHERE t.project_id = $2
)
SELECT count(*) FILTER (WHERE status = 'backlog') AS backlog,
       count(*) FILTER (WHERE status = 'ready') AS ready,
       count(*) FILTER (WHERE status = 'active') AS active,
       count(*) FILTER (WHERE status = 'blocked') AS blocked,
       count(*) FILTER (WHERE status = 'done') AS done,
       count(*) FILTER (WHERE status = 'cancelled') AS cancelled
FROM effective
