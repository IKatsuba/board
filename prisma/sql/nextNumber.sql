-- @param {Int} $1:projectId
SELECT coalesce(max(number), 0) + 1 AS next FROM task WHERE project_id = $1
