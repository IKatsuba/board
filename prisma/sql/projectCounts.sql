SELECT p.id,
       coalesce(sum(t.status IN ('backlog', 'ready', 'active')), 0) AS open,
       coalesce(sum(t.status IN ('done', 'cancelled')), 0) AS closed
FROM project p
LEFT JOIN task t ON t.project_id = p.id
GROUP BY p.id
