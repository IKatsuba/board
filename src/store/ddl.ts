// Appendix A of docs/design.md, the one source of the schema: one complete
// statement per element, in order. Through Prisma and bun:sqlite a string of
// several statements silently runs only its first, so nothing here is split
// at run time.
export const DDL: readonly string[] = [
	`PRAGMA application_id = 0x424F5244`,
	`PRAGMA user_version = 1`,
	// A project: the key its tasks carry and the directory that selects it.
	// `directory` is absolute and a real path, never `/`.
	`CREATE TABLE project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL COLLATE NOCASE UNIQUE
              CHECK (length(key) BETWEEN 1 AND 10
                     AND key GLOB '[A-Z]*'
                     AND key NOT GLOB '*[^A-Z0-9]*'),
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  directory   TEXT NOT NULL UNIQUE
              CHECK (directory GLOB '/?*'
                     AND directory NOT GLOB '*/'
                     AND directory NOT GLOB '*//*'
                     AND directory NOT GLOB '*/./*' AND directory NOT GLOB '*/.'
                     AND directory NOT GLOB '*/../*' AND directory NOT GLOB '*/..'),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL CHECK (length(created_by) > 0)
) STRICT`,
	// The ordered chain of one project. Its status is derived, not stored.
	`CREATE TABLE milestone (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES project (id),
  name        TEXT NOT NULL COLLATE NOCASE
              CHECK (length(name) BETWEEN 1 AND 40
                     AND name GLOB '[A-Za-z0-9]*'
                     AND name NOT GLOB '*[^A-Za-z0-9._-]*'
                     AND lower(name) <> 'none'),
  delivers    TEXT NOT NULL,
  position    INTEGER NOT NULL CHECK (position <> 0),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  UNIQUE (project_id, name),
  UNIQUE (project_id, position),
  UNIQUE (project_id, id)
) STRICT`,
	// `number` is the n of the key `<project.key>-<n>`, one sequence per
	// project; `id` is internal and never shown. `blocked` is derived from open
	// questions. Priority 0..3 is urgent, high, normal, low.
	`CREATE TABLE task (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES project (id),
  number        INTEGER NOT NULL CHECK (number > 0),
  title         TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'ready'
                CHECK (status IN ('backlog', 'ready', 'active', 'done', 'cancelled')),
  priority      INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  parent_id     INTEGER,
  milestone_id  INTEGER,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL CHECK (length(created_by) > 0),
  UNIQUE (project_id, number),
  UNIQUE (project_id, id),
  -- A parent and a milestone are in the task's own project.
  FOREIGN KEY (project_id, parent_id) REFERENCES task (project_id, id),
  FOREIGN KEY (project_id, milestone_id) REFERENCES milestone (project_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT`,
	`CREATE INDEX task_by_status    ON task (project_id, status, priority, number)`,
	`CREATE INDEX task_by_parent    ON task (parent_id) WHERE parent_id IS NOT NULL`,
	`CREATE INDEX task_by_milestone ON task (milestone_id, status) WHERE milestone_id IS NOT NULL`,
	// task_id waits for on_id, both in project_id.
	`CREATE TABLE waits (
  project_id  INTEGER NOT NULL,
  task_id     INTEGER NOT NULL,
  on_id       INTEGER NOT NULL,
  PRIMARY KEY (task_id, on_id),
  FOREIGN KEY (project_id, task_id) REFERENCES task (project_id, id),
  FOREIGN KEY (project_id, on_id) REFERENCES task (project_id, id),
  CHECK (task_id <> on_id)
) STRICT, WITHOUT ROWID`,
	`CREATE INDEX waits_by_on ON waits (on_id)`,
	// At most one claim per task: the primary key is the "two runs cannot hold
	// one task" rule. Past claims live in the event log.
	`CREATE TABLE claim (
  task_id    INTEGER PRIMARY KEY REFERENCES task (id),
  holder     TEXT NOT NULL CHECK (length(holder) > 0),
  since      TEXT NOT NULL,
  until      TEXT NOT NULL,
  directory  TEXT,
  branch     TEXT,
  CHECK (until > since)
) STRICT`,
	`CREATE INDEX claim_by_until ON claim (until)`,
	// `id` is the n of `Q<n>`, one sequence per machine.
	// `options` is a JSON array of {label, detail?} objects; `recommended` and
	// `choice` are 1-based into it, as in every interface.
	`CREATE TABLE question (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES task (id),
  text         TEXT NOT NULL CHECK (length(trim(text)) > 0),
  options      TEXT NOT NULL
               CHECK (json_valid(options) AND json_type(options) = 'array'
                      AND json_array_length(options) BETWEEN 2 AND 6),
  recommended  INTEGER NOT NULL
               CHECK (recommended BETWEEN 1 AND json_array_length(options)),
  asked_by     TEXT NOT NULL,
  asked_at     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'answered', 'withdrawn')),
  choice       INTEGER
               CHECK (choice IS NULL OR choice BETWEEN 1 AND json_array_length(options)),
  answer       TEXT,
  answered_by  TEXT,
  answered_at  TEXT,
  answered_as  TEXT CHECK (answered_as IN ('owner', 'delegate')),
  validated_by TEXT,
  validated_at TEXT,
  CHECK ((status = 'answered') = (answered_at IS NOT NULL)),
  CHECK ((answered_at IS NULL) = (answered_by IS NULL)),
  CHECK ((answered_at IS NULL) = (answered_as IS NULL)),
  CHECK (status = 'answered' OR (choice IS NULL AND answer IS NULL)),
  CHECK (status <> 'answered' OR choice IS NOT NULL OR answer IS NOT NULL),
  CHECK ((validated_by IS NULL) = (validated_at IS NULL)),
  CHECK (validated_at IS NULL OR answered_as = 'delegate')
) STRICT`,
	`CREATE INDEX question_by_task ON question (task_id, status)`,
	`CREATE INDEX question_to_validate ON question (answered_at)
  WHERE answered_as = 'delegate' AND validated_at IS NULL`,
	// Append-only history. `project_id` is null only for the two events about
	// the machine's board as a whole. `milestone_id` has no foreign key: an
	// empty milestone can be deleted, and its events must outlive it.
	`CREATE TABLE event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL CHECK (length(actor) > 0),
  kind          TEXT NOT NULL CHECK (kind IN (
                  'board_created',
                  'project_added', 'project_edited', 'project_removed',
                  'task_added', 'task_edited', 'task_status', 'task_moved',
                  'waits_changed',
                  'claimed', 'claim_extended', 'claim_released', 'claim_expired',
                  'comment', 'handover',
                  'question_asked', 'question_answered', 'question_validated',
                  'question_withdrawn',
                  'milestone_added', 'milestone_edited', 'milestone_deleted',
                  'milestone_done', 'milestone_reopened')),
  project_id    INTEGER REFERENCES project (id),
  task_id       INTEGER,
  milestone_id  INTEGER,
  data          TEXT NOT NULL DEFAULT '{}'
                CHECK (json_valid(data) AND json_type(data) = 'object'),
  -- An event about a task is in that task's project.
  FOREIGN KEY (project_id, task_id) REFERENCES task (project_id, id),
  CHECK ((project_id IS NULL) = (kind IN ('board_created', 'project_removed')))
) STRICT`,
	`CREATE INDEX event_by_project   ON event (project_id, id) WHERE project_id IS NOT NULL`,
	`CREATE INDEX event_by_task      ON event (task_id, id) WHERE task_id IS NOT NULL`,
	`CREATE INDEX event_by_milestone ON event (milestone_id, id) WHERE milestone_id IS NOT NULL`,
	`CREATE INDEX event_by_kind      ON event (kind, id)`,
	// Events are never changed, and never removed while their project exists:
	// removing an empty project removes its events after the project row.
	`CREATE TRIGGER event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END`,
	`CREATE TRIGGER event_no_delete BEFORE DELETE ON event
WHEN old.project_id IS NULL
  OR EXISTS (SELECT 1 FROM project WHERE id = old.project_id)
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END`,
];
