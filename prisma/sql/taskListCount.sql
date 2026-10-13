-- task_list's filter, in one place with its paging and its count, so no id
-- list is carried through JavaScript. Statuses are effective: blocked is an
-- open question, and an expired claim reads as no claim. The substring
-- filter is "The substring filter" of docs/design.md. Parameters are
-- numbered in the order they first appear, since SQLite numbers $N
-- parameters by first appearance when they are bound from an array.
-- @param {String} $1:now
-- @param {Int} $2:projectId?
-- @param {Int} $3:parentId?
-- @param {Int} $4:milestoneId?
-- @param {Int} $5:noMilestone
-- @param {String} $6:pattern?
-- @param {String} $7:statuses
-- @param {Int} $8:ready?
WITH effective AS (
  SELECT t.id,
         CASE
           WHEN t.status IN ('done', 'cancelled') THEN t.status
           WHEN EXISTS (SELECT 1 FROM question q
                        WHERE q.task_id = t.id AND q.status = 'open') THEN 'blocked'
           WHEN t.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM claim c
                                WHERE c.task_id = t.id AND c.until > $1) THEN 'ready'
           ELSE t.status
         END AS status
  FROM task t
  WHERE ($2 IS NULL OR t.project_id = $2)
    AND ($3 IS NULL OR t.parent_id = $3)
    AND ($4 IS NULL OR t.milestone_id = $4)
    AND ($5 = 0 OR t.milestone_id IS NULL)
    AND ($6 IS NULL OR t.title LIKE $6 ESCAPE '\' OR t.body LIKE $6 ESCAPE '\')
),
matched AS (
  SELECT e.id
  FROM effective e
  WHERE e.status IN (SELECT value FROM json_each($7))
    AND ($8 IS NULL OR $8 = (e.status = 'ready'
         AND NOT EXISTS (SELECT 1 FROM waits w JOIN task o ON o.id = w.on_id
                         WHERE w.task_id = e.id AND o.status NOT IN ('done', 'cancelled'))))
)
SELECT count(*) AS total FROM matched
