-- @param {String} $1:now
DELETE FROM claim WHERE until <= $1 RETURNING task_id, holder, since, until
