# v1: data

The storage side of board v1: the schema, the invariants and who enforces them,
the transaction of each operation, contention and failure cases, and the
questions left open. It answers the "data" questions of
`docs/design/drafts/v1/brief.md`; the owner's decisions there are taken as
fixed, and this revision follows the lead's "Resolutions after review" in the
same file (numbers in brackets, such as [R17], point to them).

## What was tried

In a throwaway package outside the repository, `sqlite3: any` resolved to
`package:sqlite3` 3.7.0, which builds and loads its own SQLite (3.53.4) through
a build hook, with no system library involved. Checked against it:

- `PRAGMA journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON`: work.
- `sqlite_compileoption_used('ENABLE_FTS5')` is 1; an external-content FTS5
  table kept by triggers, `bm25()`, prefix queries and `integrity-check`
  work. JSON functions (`json_valid`, `json_array_length`) are built in.
- `STRICT` tables, `WITHOUT ROWID`, `UPDATE … RETURNING`: work.
- Two connections on one file: the second `BEGIN IMMEDIATE` waits for the
  busy timeout and then fails with `SqliteException` code 5 (`SQLITE_BUSY`).
- `sqlite3.open(path, mode: OpenMode.readOnly)`: a write fails with code 8
  (`SQLITE_READONLY`).
- FTS5 `MATCH` with raw text: `lease`, `leas*`, `cafe` (for "Café"),
  `title:fix`, `"APP-12"` work; `APP-12` fails ("no such column: 12"),
  `claim-release` fails, `foo"` fails ("unterminated string"). The query
  syntax is the owner's question (open question 1).
- The schema below, run as written: it creates; the FTS5 triggers index an
  inserted task; the option-index checks and the append-only triggers refuse
  what they should; the two-step milestone renumbering passes the position
  checks; the in-place reset (drop everything, create anew, under one
  `BEGIN IMMEDIATE` with `defer_foreign_keys`) works while a second
  connection has the file open, and that connection then reads the new
  `instance`.

Whether `dart compile exe` carries the bundled SQLite (with FTS5) into the
executable is the build question, which is the owner's [R1]; this draft needs
FTS5 and the JSON functions from whichever build is chosen.

Everything below uses only what SQLite and `package:sqlite3` give directly:
no hand-written parser, no custom functions, no extension loading.

## Conventions

- **Time** is `TEXT` in UTC, ISO 8601 with milliseconds and `Z`
  (`2026-10-12T09:30:00.000Z`), always that width, so text comparison is time
  comparison [R17]. The value always comes from the injected clock in Dart
  (`:now`), never from SQLite's own time functions. A write samples `:now`
  **after** `BEGIN IMMEDIATE` returns, so the order of `at` across processes
  follows the order of commits and of event ids, and a lease is measured from
  when the write actually happened, not from before a wait on the lock.
- **Durations** (claim, extend) are whole minutes, 1–1440 [R17].
- **Enums** are `TEXT` with a `CHECK (… IN (…))`. **Tables are `STRICT`.**
- **The file is marked as a board**: `PRAGMA application_id = 0x424F5244`
  ("BORD") [R15], and `PRAGMA user_version` is the schema version. Both live
  in the database header and are written inside the transaction that creates
  the schema, so a half-made file carries neither.
- **Per connection**, on open: `PRAGMA foreign_keys = ON`,
  `PRAGMA busy_timeout = <runtime's value>`, `PRAGMA synchronous = FULL`.
  `journal_mode = WAL` is set once at `board init` and persists in the file.
  `FULL` rather than WAL's usual `NORMAL`: an agent told "claimed" must find
  the claim after a power cut, and at a board's write rate the extra fsync
  costs nothing that matters.

## Schema

```sql
PRAGMA application_id = 0x424F5244;
PRAGMA user_version = 1;

-- One row: the board itself, its pause, and the instance that tells a
-- process the board was reset under it.
CREATE TABLE board (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  prefix      TEXT NOT NULL
              CHECK (length(prefix) BETWEEN 1 AND 10
                     AND prefix GLOB '[A-Z]*'
                     AND prefix NOT GLOB '*[^A-Z0-9]*'),
  instance    TEXT NOT NULL CHECK (length(instance) = 32),
  created_at  TEXT NOT NULL,
  paused_by   TEXT,
  paused_at   TEXT,
  paused_why  TEXT,
  CHECK ((paused_by IS NULL) = (paused_at IS NULL)),
  CHECK (paused_at IS NOT NULL OR paused_why IS NULL)
) STRICT;

-- The ordered chain. Its status is derived, not stored: see "Milestones".
CREATE TABLE milestone (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL COLLATE NOCASE UNIQUE
              CHECK (length(name) BETWEEN 1 AND 40
                     AND name GLOB '[A-Za-z0-9]*'
                     AND name NOT GLOB '*[^A-Za-z0-9._-]*'
                     AND lower(name) <> 'none'),
  delivers    TEXT NOT NULL,
  position    INTEGER NOT NULL UNIQUE CHECK (position <> 0),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
) STRICT;

-- `id` is the n of the key `<prefix>-<n>`; the key itself is never stored.
-- `blocked` is not a stored status: it is derived from open questions.
-- Priority 0..3 is urgent, high, normal, low.
CREATE TABLE task (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'ready'
                CHECK (status IN ('backlog', 'ready', 'active', 'done', 'cancelled')),
  priority      INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  parent_id     INTEGER REFERENCES task (id),
  milestone_id  INTEGER REFERENCES milestone (id),
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL CHECK (length(created_by) > 0),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE INDEX task_by_status    ON task (status, priority, id);
CREATE INDEX task_by_parent    ON task (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX task_by_milestone ON task (milestone_id, status) WHERE milestone_id IS NOT NULL;

-- task_id waits for on_id.
CREATE TABLE waits (
  task_id  INTEGER NOT NULL REFERENCES task (id),
  on_id    INTEGER NOT NULL REFERENCES task (id),
  PRIMARY KEY (task_id, on_id),
  CHECK (task_id <> on_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX waits_by_on ON waits (on_id);

-- At most one claim per task: the primary key is the "two runs cannot hold
-- one task" rule. Past claims live in the event log.
CREATE TABLE claim (
  task_id    INTEGER PRIMARY KEY REFERENCES task (id),
  holder     TEXT NOT NULL CHECK (length(holder) > 0),
  since      TEXT NOT NULL,
  until      TEXT NOT NULL,
  directory  TEXT,
  branch     TEXT,
  CHECK (until > since)
) STRICT;

CREATE INDEX claim_by_until ON claim (until);

-- `id` is the n of `Q<n>`, one sequence per board.
-- `options` is a JSON array of {label, detail?} objects; `recommended` and
-- `choice` are 1-based into it, as in every interface.
CREATE TABLE question (
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
) STRICT;

CREATE INDEX question_by_task ON question (task_id, status);
CREATE INDEX question_to_validate ON question (answered_at)
  WHERE answered_as = 'delegate' AND validated_at IS NULL;

-- Append-only history. `milestone_id` has no foreign key: an empty
-- milestone can be deleted, and its events must outlive it.
CREATE TABLE event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL CHECK (length(actor) > 0),
  kind          TEXT NOT NULL CHECK (kind IN (
                  'board_created', 'board_paused', 'board_resumed',
                  'task_added', 'task_edited', 'task_status', 'task_moved',
                  'waits_changed',
                  'claimed', 'claim_extended', 'claim_released', 'claim_expired',
                  'comment', 'handover',
                  'question_asked', 'question_answered', 'question_validated',
                  'question_withdrawn',
                  'milestone_added', 'milestone_edited', 'milestone_deleted',
                  'milestone_done', 'milestone_reopened')),
  task_id       INTEGER REFERENCES task (id),
  milestone_id  INTEGER,
  data          TEXT NOT NULL DEFAULT '{}'
                CHECK (json_valid(data) AND json_type(data) = 'object')
) STRICT;

CREATE INDEX event_by_task      ON event (task_id, id) WHERE task_id IS NOT NULL;
CREATE INDEX event_by_milestone ON event (milestone_id, id) WHERE milestone_id IS NOT NULL;
CREATE INDEX event_by_kind      ON event (kind, id);

CREATE TRIGGER event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TRIGGER event_no_delete BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

-- Full-text search over title and body. External content: the text is
-- stored once, in `task`; the index follows it through triggers, so it is
-- updated inside whatever transaction changes the task and no Dart path can
-- forget it.
CREATE VIRTUAL TABLE task_fts USING fts5 (
  title, body,
  content = 'task', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER task_fts_insert AFTER INSERT ON task BEGIN
  INSERT INTO task_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER task_fts_update AFTER UPDATE OF title, body ON task BEGIN
  INSERT INTO task_fts (task_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO task_fts (rowid, title, body) VALUES (new.id, new.title, new.body);
END;
-- Tasks are never deleted; this trigger exists so that stays harmless if a
-- later version changes that.
CREATE TRIGGER task_fts_delete AFTER DELETE ON task BEGIN
  INSERT INTO task_fts (task_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;
```

Notes on the choices:

- **Triggers, not Dart writes, keep FTS5 in step.** This is the pattern SQLite's
  own FTS5 documentation gives for external-content tables. A Dart-side write
  would have to be repeated in every path that touches title or body; a
  trigger runs in the same transaction by construction. Search ranks with
  `bm25(task_fts, 4.0, 1.0)` (title weighted over body).
- **The event log's append-only rule is a trigger**, the one invariant cheap
  enough to state in SQL and expensive enough to get wrong. A reset drops the
  table; `DROP TABLE` fires no row trigger.
- **`instance`** is 32 hex characters from `lower(hex(randomblob(16)))`, set
  by init and by every reset [R2].
- **No `updated_at` column** [R18]: a task's `updated_at` is the `at` of its
  latest event, one indexed lookup (`event_by_task`, highest id). Every change
  to a task writes an event, so the two cannot disagree.
- **No `ON DELETE` actions.** Tasks, questions and events are never deleted;
  claims are deleted by the store; a milestone is deleted only when no task
  refers to it, which the foreign key from `task` enforces.
- **Priority** is stored 0–3; the words agents see (`urgent`, `high`,
  `normal`, `low`) are interfaces' and map onto it in that order. Events
  carry the word.
- **Option shape** (`{label, detail?}`, label non-empty) is checked by the
  store and by the tool's input schema: a `CHECK` cannot iterate a JSON array
  without a subquery, which SQLite does not allow there.

## Invariants and who enforces them

| Invariant | Enforced by |
| --- | --- |
| One board row; prefix shape; milestone name shape | `CHECK` |
| One claim per task | `claim` primary key |
| A task key or question id is never reused | `AUTOINCREMENT` |
| Events are never changed or removed | triggers |
| Types, enums, question answer fields together | `STRICT`, `CHECK` |
| References exist | foreign keys (`foreign_keys = ON` on every connection) |
| FTS5 matches `task` | triggers |
| The process works on the board it opened | the store, first thing in every transaction (below) |
| `status = 'active'` ⇔ a claim row exists | the store, in the same transaction; a test asserts it after every operation |
| Claims are only taken on a ready task | the store |
| No cycle in `waits`; no cycle in `parent` | the store: a recursive CTE before writing |
| A task with an open question is `blocked` | derived on read |
| A milestone is done when all its tasks are closed | derived on read; events written by the store |
| A `done` task has no open question | the store |
| Nothing changes while paused | the store, in every write transaction |

The rules live in pure Dart over the store and are tested against
`sqlite3.openInMemory()`, as CLAUDE.md asks. The cross-row rules could be
SQLite triggers too; they stay in Dart because they produce errors the tools
must explain (`claim_held`, `not_ready`, `cycle`), and a `RAISE(ABORT)`
message is a string to parse back, which is the wrong way round.

### Derived state

Computed on read with the caller's `:now`, never stored:

- **Effective status** of a task: `done`/`cancelled` as stored; else `blocked`
  if it has an open question; else `ready` if stored `active` and its claim's
  `until <= :now` (expired, not yet swept); else the stored status. Every
  filter on status (`task_list`, `board ls`, counts) uses this effective
  status, the same value reads return [R19].
- **Claim**: a claim row with `until > :now`. An expired row still in the
  table is read as no claim at all: `claim: null`, status `ready` [R18].
- **Milestone status** [R6]: `done` when it has at least one task and every
  task is `done` or `cancelled`; otherwise open. The earliest open milestone
  by `position` is `current`; later open ones are `planned`. Earlier open
  ones cannot exist: the current one is the earliest by definition.
- **`updated_at`** of a task: the `at` of its latest event.

## Every operation checks the board it is on

A process (one `board mcp`, one CLI command, one watcher) reads `instance`
and `user_version` when it opens the file and keeps them [R2]. Every
operation, read or write, does this first inside its transaction:

1. read `PRAGMA user_version`; if it is not this build's, refuse with
   `schema_mismatch` (another build made or reset the file);
2. read the board row; if `instance` is not the cached one, refuse with
   `board_reset`, and then re-attach: cache the new `instance`, drop any
   per-board cache (prepared statements re-prepare by themselves after a
   schema change). The call that noticed is refused; the next call works on
   the new board.

Reading both inside the transaction makes the check and the work see one
snapshot: a reset that commits between them is impossible, because a write
holds the lock and a read sees one consistent version. The board row is read
anyway (pause, prefix), so the check costs one `PRAGMA` per call. *Runtime:
`board watch` exits non-zero on `board_reset` [R2].*

## Statuses and transitions

Stored: `backlog`, `ready`, `active`, `done`, `cancelled`. Shown to agents
additionally: `blocked` (derived). `task_update` cannot set `active` or
`blocked`; filters by `blocked` are accepted and mean "has an open question".

| From → to | How | Notes |
| --- | --- | --- |
| (new) → `ready` / `backlog` | `task_add` | default `ready` [R19]: a milestone's findings are its work; `backlog` is for main to choose |
| `backlog` ↔ `ready` | `task_update` | |
| `ready` → `active` | `task_claim` only | refused `not_ready` unless the task is ready (below) |
| `active` → `ready` | `task_release`, expiry, or `task_update status=ready` | the last is main sending work back: the claim is deleted unconditionally (`claim_released`, `reason: sent_back`) [R3] |
| `active` → `backlog` | `task_update` | deletes the claim the same way |
| any open → `done` | `task_update` | refused `invalid_transition` while the task has an open question; deletes a claim (`reason: closed`) |
| any open → `cancelled` | `task_update` | withdraws its open questions (`question_withdrawn`) and deletes a claim (`reason: closed`) |
| `done` / `cancelled` → `backlog` / `ready` | `task_update` | reopening; reopens its milestone if that was done |
| → `active` by `task_update` | refused | `invalid_transition`: `active` means "claimed" |

**Blocked is implied.** `question_ask` on an open task makes it `blocked`
without touching `task.status`; when its last open question is answered or
withdrawn, the task is whatever its stored status says (an active task whose
claim is still live is active again, otherwise ready). No "status before
blocked" column is needed. A claim held while waiting on the owner keeps
running down; the holder extends it or lets it expire. `question_ask` on a
closed task is `invalid_transition`.

**`done` refuses open questions** because closing would hide a question the
owner has not seen. Cancelling withdraws them because a cancelled task's
questions no longer need an answer.

**Waits** [R19]. `waits` on `task_add`, and `waits_add` / `waits_remove` on
`task_update`, take keys:

- a key in both `waits_add` and `waits_remove` of one call is
  `invalid_argument`; so is a task waiting on itself;
- an unknown key is `not_found`; a wait that would close a cycle is `cycle`
  (checked with a recursive CTE over `waits` before inserting);
- adding a wait that exists, or removing one that does not, changes nothing;
  an update whose every part changes nothing writes nothing and appends no
  event;
- waiting on a closed task is allowed and is already satisfied: a wait is
  satisfied when the task waited on is `done` or `cancelled`.

The same cycle check applies to `parent`.

## Keys and identities

**Task key** `<prefix>-<n>`, `n` = `task.id`, assigned by `AUTOINCREMENT`
inside the `BEGIN IMMEDIATE` of `task_add`. Writers are serialised by the
write lock, so two processes cannot get the same `n`, and `AUTOINCREMENT`
keeps a number from being reused even if a row were ever removed. No counter
column, no read-then-write. Lookup parses the key at its last `-`, compares
the prefix case-insensitively with `board.prefix`, and reads by `id`; a wrong
prefix is `not_found`.

**Question id** `Q<n>`, `n` = `question.id`, one sequence per board [R4],
assigned the same way. `board answer Q7` needs no task key.

**Milestone identity is the name** [R20]: 1–40 characters,
`^[A-Za-z0-9][A-Za-z0-9._-]*$`, unique case-insensitively, never `none` in any
case (the word tools use for "no milestone"). The `CHECK` above is that
pattern in `GLOB` form. Events and `task.milestone_id` use the internal `id`,
so a rename moves nothing.

## Milestones

- **Order** is `position`, unique, 1…n with no gaps. `milestone_add` places
  the new one `before` or `after` a named milestone, or last when neither is
  given [R20].
- **Moving** is relative: `before: NAME` or `after: NAME` on the milestone's
  update [R20]. The store computes the new order in Dart and rewrites the
  positions in the same transaction. Positions are unique and SQLite checks
  `UNIQUE` row by row inside an `UPDATE`, so the rewrite first negates all
  positions and then sets the new ones: two plain statements (which is why
  `position` is checked `<> 0`, not `> 0`). Moving a milestone relative to
  itself is `invalid_argument`; an unknown name is `not_found`. Any
  milestone may be moved, done or not: order only decides which open one is
  current.
- **Status** is derived: `done`, `current`, `planned` [R6].
- **Cancelled tasks count as closed.** A milestone whose tasks are all
  cancelled is done; progress shows done and cancelled separately ("4 done,
  1 cancelled") so a person sees it delivered less.
- **No closing by hand.** A milestone is done exactly when all its tasks are
  closed; to finish one with open tasks, main closes, cancels or moves them.
- **A done milestone takes new and moved tasks and reopens** [R6]. Adding a
  task to it, moving one into it, or reopening one of its tasks makes it open
  again (`milestone_reopened`); if it is earlier than the current one, it
  becomes current. There is no refusal for a done milestone.
- **A finding takes its parent's milestone** [R6]: `task_add` with a `parent`
  and no `milestone` puts the task into the parent's milestone (none if the
  parent has none). `milestone: none` says no milestone explicitly. This is a
  store rule, so the CLI and the tool cannot differ on it.
- **An empty milestone** is open, never done (it has delivered nothing), so if
  it is the earliest it is current. `task_next` falls through it (below).
- **Deleting** [R20]: `milestone_delete` (`board milestone rm`) removes a
  milestone with no tasks at all, open or closed, and renumbers the positions
  after it. One with tasks is `invalid_transition`; the foreign key from
  `task` is the backstop.

`milestone_done` and `milestone_reopened` are written by the store in the same
transaction as the task write that flipped the derived status: the write
computes the status of the milestones it touches (the task's old and new
milestone) before and after, and appends one event for each flip. Their actor
is the actor of that write.

## Readiness and `task_next`

A task is ready when, at `:now`:

1. its stored status is `ready`, or `active` with an expired claim;
2. it has no open question;
3. every task it waits for is `done` or `cancelled`.

`task_next` order [R7]: the current milestone's ready tasks; then ready tasks
in no milestone; then ready tasks of later milestones in chain order. Within
each, priority (urgent first), then oldest (`id`). An empty or exhausted
current milestone simply contributes nothing, so the query falls through.
With an explicit `milestone` (a name, or `none`), only that milestone's
ready tasks are considered, with no fallback.

The answer's `from` names the rule that picked the task: `current`,
`unassigned`, `later`, or `milestone` when a milestone was given; null when
nothing is ready.

```sql
WITH open_milestone AS (
  SELECT m.id, m.position
  FROM milestone m
  WHERE NOT EXISTS (SELECT 1 FROM task t WHERE t.milestone_id = m.id)
     OR EXISTS (SELECT 1 FROM task t
                WHERE t.milestone_id = m.id
                  AND t.status NOT IN ('done', 'cancelled'))
),
current_milestone AS (
  SELECT id FROM open_milestone ORDER BY position LIMIT 1
),
ready AS (
  SELECT t.*
  FROM task t
  LEFT JOIN claim c ON c.task_id = t.id
  WHERE (t.status = 'ready' OR (t.status = 'active' AND c.until <= :now))
    AND NOT EXISTS (SELECT 1 FROM question q
                    WHERE q.task_id = t.id AND q.status = 'open')
    AND NOT EXISTS (SELECT 1 FROM waits w JOIN task d ON d.id = w.on_id
                    WHERE w.task_id = t.id
                      AND d.status NOT IN ('done', 'cancelled'))
)
SELECT r.*,
  CASE
    WHEN :explicit THEN 'milestone'
    WHEN r.milestone_id = (SELECT id FROM current_milestone) THEN 'current'
    WHEN r.milestone_id IS NULL THEN 'unassigned'
    ELSE 'later'
  END AS picked_from
FROM ready r
LEFT JOIN milestone m ON m.id = r.milestone_id
WHERE NOT :explicit
   OR r.milestone_id IS :milestone_id   -- NULL for `none`
ORDER BY
  CASE
    WHEN r.milestone_id = (SELECT id FROM current_milestone) THEN 0
    WHEN r.milestone_id IS NULL THEN 1
    ELSE 2
  END,
  m.position, r.priority, r.id
LIMIT 1;
```

Tasks in a done milestone are never ready (they are all closed), so "later"
can only mean planned milestones. `task_next` is a read: two callers can get
the same task, and the second `task_claim` is refused with `claim_held`.
Parents are not special: a parent task with open children is ready unless it
waits for them; main expresses that with `waits`.

## Claims

Duration set at claim, explicit extend, early release, expiry frees the task
(owner decision 4). The store operations, all in minutes, 1–1440 [R17]:

- **`claim(task, holder, minutes, directory?, branch?)`**: the task must be
  ready (above), which includes "no live claim"; otherwise `not_ready`, or
  `claim_held` naming the current claim when that is the reason. An expired
  claim on it is swept first in the same transaction (below), so claiming a
  task whose lease ran out works in one call. Sets `since = :now`,
  `until = :now + minutes`, status `active`.
- **`extend(task, holder, minutes)`**: the claim must be live; otherwise
  `not_claimed` (an expired claim is swept and not revived, because by then
  another run may have been told the task is ready). Its holder must equal
  `holder`; otherwise `claim_held` naming the current claim [R3]. Sets
  `until = :now + minutes`: the new estimate counts from now, as the first one
  did.
- **`release(task, holder, note?)`**: the claim must exist (`not_claimed`
  otherwise) and its holder must equal `holder` (`claim_held` otherwise);
  deletes it, status `ready`. `note` goes into `claim_released` [R11].

Anyone may extend or release [R3]: board checks no roles, and `actor` is
trusted as given. `holder` is a compare-and-set, not an authorisation check:
it stops a caller acting on a stale view from extending or releasing a claim
that has changed hands since it looked. main freeing a dead run's task passes
the holder it sees in `task_read`. The event records both `actor` and
`holder`. There is no claim token: a holder that releases and claims again is
the same run. The implicit release by `task_update` (close, send back) takes
no holder and is unconditional [R3].

**The holder's other writes do not renew the claim.** The owner chose an
explicit extend; implicit renewal would also make the lease depend on matching
`actor` strings to `holder` strings that board never checks, and a run stuck
in a loop of comments would hold its task forever, which is the failure the
lease exists for.

### Expiry, exactly once

Every write transaction, after the board and pause checks, sweeps:

```sql
DELETE FROM claim WHERE until <= :now RETURNING task_id, holder, since, until;
```

and for each row returned sets `task.status = 'ready'` (it was `active`) and
appends `claim_expired`. Write transactions are serialised by `BEGIN
IMMEDIATE`, and the `DELETE` removes the row it reports, so however many
processes notice the expiry, exactly one transaction sees the row and writes
the event; the rest find nothing. The sweep covers every expired claim, not
only the task being written, using `claim_by_until`.

**Reads do not write.** A read runs in a deferred (read) transaction and
treats an expired claim as absent; it does not sweep. A read that may write
would need the write lock, so polling from several agents would contend with
real writes; a read upgraded to a write in WAL can fail with
`SQLITE_BUSY_SNAPSHOT` where a plain read cannot; and `board sql` and
`board watch` stay on read-only connections. The cost: `claim_expired` is
logged at the next write, not at the moment of expiry; its `at` is when it was
written, and its `data.until` is when the lease actually ran out.

`claim_expired` is not anyone's act: its `actor` is `board`, and `data.by`
names the actor of the write that swept it. `board` is therefore a reserved
actor name; the store refuses `actor = 'board'` on input
(`invalid_argument`).

## Questions

- `question_ask(task, text, options, recommended)`: the task must be open;
  2–6 options, each `{label, detail?}`; `recommended` 1-based. Appends
  `question_asked`; the task is now `blocked`.
- `question_answer(question, choice?, text?, as)`: at least one of `choice`
  and `text`. On an open question: records the answer. On an answered
  question: `already_answered`, except an owner's answer over a delegate's
  answer that is not yet validated [R5], which replaces it: `choice`,
  `answer`, `answered_by`, `answered_at` are overwritten, `answered_as =
  'owner'`, and the validation fields stay null (an owner's answer is never
  validated, by the `CHECK`). `question_answered` then carries `overrides`
  with the previous answer, so the delegate's decision stays in the history.
  On a withdrawn question: `invalid_transition`.
- `question_validate(question)`: only an answer `as delegate` and not yet
  validated; otherwise `invalid_transition`.
- `withdrawn` is a public status [R4]: a question is withdrawn when its task
  is cancelled.
- To validate: `answered_as = 'delegate' AND validated_at IS NULL`, served by
  the partial index.

## Pause

`board.paused_*` is the pause. Every write transaction refuses with `paused`
(by, at, why) when it is set, before the sweep, so a refused write changes
nothing, expiry included. Reading the pause inside the write lock means a
pause and a write racing each other are ordered: a write either committed
before the pause or is refused. `board_resume` is the one write allowed while
paused; `board_pause` while paused is refused as `paused` (the existing
pause's who and why are what the caller needs). Whether the owner's own
answers pass a pause is the owner's question (open question 2); the store
can let `question_answer` and `question_validate` through by a flag if the
answer is yes, and nothing else changes.

While paused, claims still run down and read as absent once expired; their
`claim_expired` events are written by the first write after resume.

## Transactions per operation

Every write is one `BEGIN IMMEDIATE … COMMIT` with this shape:

1. `BEGIN IMMEDIATE` (waits up to the busy timeout for the write lock;
   `busy` when it gives up, with nothing written).
2. Sample `:now` from the clock [R17].
3. Check `user_version` and `instance` (`schema_mismatch`, `board_reset`).
4. Refuse `paused` (except `board_resume`).
5. Sweep expired claims.
6. Validate against current rows; on any refusal, `ROLLBACK` and answer the
   error. The sweep is rolled back with it, so an error changes nothing; the
   next write sweeps again.
7. Apply the change, its events, and any `milestone_done` /
   `milestone_reopened`.
8. `COMMIT`.

A write never starts as a read and upgrades: every write opens with `BEGIN
IMMEDIATE`, even when it validates before writing. Every read runs in one
`BEGIN … COMMIT` read transaction with steps 2–3, so a multi-query read
(`task_read`, `board_status`, `task_list` with counts) sees one snapshot.

| Operation | Rows written in its transaction | Events |
| --- | --- | --- |
| `board init` / reset | schema, header, `board` | `board_created` |
| `board_pause` / `board_resume` | `board` | `board_paused` / `board_resumed` |
| `task_add` | `task`, `waits`, FTS (trigger) | `task_added`; milestone flip |
| `task_update` | `task`, `waits`, `claim` (delete on close or send back), `question` (withdraw on cancel) | each that applies, in this order: `task_edited`, `task_moved`, `waits_changed`, `task_status`, `claim_released`, `question_withdrawn`; milestone flips |
| `task_claim` | `claim`, `task.status` | `claimed` |
| extend | `claim.until` | `claim_extended` |
| `task_release` | `claim`, `task.status` | `claim_released` |
| `task_comment` | none | `comment` or `handover` |
| `question_ask` | `question` | `question_asked` |
| `question_answer` | `question` | `question_answered` |
| `question_validate` | `question` | `question_validated` |
| milestone add / update / delete | `milestone` (positions of others too) | `milestone_added` / `milestone_edited` / `milestone_deleted` |
| any write | `claim`, `task.status` for each expired claim | `claim_expired` |

An update that changes nothing writes nothing and appends no event [R19].

## Event kinds

This is the one catalog [R11]. `task_id` is set on every event about a task;
`milestone_id` on every event about a milestone (including `task_moved`, with
the new one, or the old one when moved out). `data` is a JSON object; task
references in it are keys (`"APP-12"`), questions are `Q<n>`, milestones are
names, priorities are words, statuses are stored statuses, times are the one
format, so a line reads without joins. A change to a field is always
`{from, to}`.

| Kind | `data` |
| --- | --- |
| `board_created` | `{prefix, reset}` (`reset`: true when made by `--force`) |
| `board_paused` | `{why}` (`why` may be null) |
| `board_resumed` | `{}` |
| `task_added` | `{title, body, status, priority, parent, milestone, waits: [key]}` |
| `task_edited` | `{<field>: {from, to}}` for each of `title`, `body`, `priority`, `parent` that changed |
| `task_status` | `{from, to}` |
| `task_moved` | `{from, to}` (milestone names or null) |
| `waits_changed` | `{added: [key], removed: [key]}` |
| `claimed` | `{holder, until, directory, branch}` (`since` is the event's `at`) |
| `claim_extended` | `{holder, until: {from, to}}` |
| `claim_released` | `{holder, reason, note?}`, reason `release`, `closed`, `sent_back` |
| `claim_expired` | `{holder, since, until, by}` |
| `comment` | `{text}` |
| `handover` | `{to, text, changed, ran, unchecked}` (field names as interfaces' schema) |
| `question_asked` | `{question, text, options, recommended}` |
| `question_answered` | `{question, choice, text, as, overrides?}`, `overrides` = `{choice, text, by, as, at}` of the replaced delegate answer |
| `question_validated` | `{question}` |
| `question_withdrawn` | `{question, why}` |
| `milestone_added` | `{name, delivers, position}` |
| `milestone_edited` | `{<field>: {from, to}}` for each of `name`, `delivers`, `position` that changed |
| `milestone_deleted` | `{name}` |
| `milestone_done` | `{name}` |
| `milestone_reopened` | `{name, by}` (`by`: the task key that reopened it) |

A move is `milestone_edited` with `position: {from, to}` on the moved
milestone; the shift of the others is implied by it and not logged per
milestone. This replaces the first draft's `milestone_reordered`, which only
fitted a full-order reorder [R20].

Status changes caused by a claim operation (`claimed`, `claim_released`,
`claim_expired`) do not also write `task_status`: one fact, one line, and the
claim kinds say the status change by their definition. `board watch --kind
task_status` therefore does not show claims; "what started" is `claimed`.
`blocked` has no event of its own; `question_asked` and `question_answered`
are it.

`claim_expiring` is not in the catalog: `board watch` derives it and never
writes it; its kind filter accepts it beside the stored kinds.

`task_added` carries the body and `task_edited` the old and new body, so the
history is whole; bodies are short markdown and the file stays small.

## Contention and failure

- **Two claims of one task.** Serialised by the write lock; the second sees the
  claim row and is refused `claim_held`. If the store had a bug, the primary
  key would still refuse the second row.
- **Two `task_next` callers.** Both may get the same task; one claim wins.
- **Expiry noticed by many processes.** Exactly one event (above).
- **Two `task_add` at once.** Different keys, by `AUTOINCREMENT` under the lock.
- **Pause racing a write.** Ordered by the lock.
- **A move racing another move or an add.** Serialised; each computes the
  new order from the positions it reads under the lock, so the result is the
  two moves applied in commit order, both logged.
- **Edit racing an edit** (title, body). Last writer wins, and both are in the
  log with their `from` and `to`.
- **Reset under running processes.** Every other process's next call is
  refused `board_reset` and re-attaches (above); none writes into the new
  board on a stale view.
- **Write lock not obtained within the busy timeout.** `busy`; nothing written.
- **Process killed mid-transaction.** SQLite rolls the transaction back on the
  next open; because every write including its events is one transaction, the
  log and the rows never disagree.
- **Long reads and checkpoints.** A read transaction pins the WAL; reads here
  are milliseconds, and `board watch --follow` holds none between polls.
- **Foreign keys off on some connection** would let a dangling reference in.
  Every connection is opened through one function that sets the pragmas; a
  test asserts `PRAGMA foreign_keys` is 1 after open.

## Finding the database, and `board init`

**Finding.** From the working directory upward, the first directory that
contains `.board/board.db` is the project, as git finds `.git`; the search
stops at the filesystem root. A `.board/` directory without `board.db` is not
a match (the search goes on). Nothing found: `no_board`, naming `board init`.
The store itself takes a path and never searches; whether a `--board` flag or
`BOARD_DB` can give that path is the owner's question [R24] (open question
3).

On open, before any operation: a file SQLite cannot read as a database is
`damaged`; a database whose `application_id` is not `0x424F5244` is
`not_a_board`; a board whose `user_version` is not this build's is
`schema_mismatch`.

**`board init [--prefix KEY]`** always targets the working directory, never
a board found above; a nested board is allowed [R14].

1. Create `./.board/` and `./.board/.gitignore` containing `*`, so the
   directory is never committed without touching the project's `.gitignore`.
2. Open `./.board/board.db` (SQLite creates it if absent). Before writing
   anything, read `application_id` and whether `sqlite_schema` has any
   object: a foreign database (objects, another `application_id`) is
   refused `not_a_board` here, before `journal_mode` would change its header.
   A file SQLite cannot read is `damaged`.
3. Set `journal_mode = WAL` (it cannot be set inside a transaction).
4. `BEGIN IMMEDIATE`, sample `:now`, and repeat the check of step 2 under the
   lock [R14]: an empty database (no objects, `application_id` 0, as an
   interrupted init leaves it) is initialised; a board is refused as already
   initialised unless `--force`; a foreign database is `not_a_board`.
5. Create the schema, set `application_id` and `user_version`, insert the
   board row with a new `instance`, append `board_created`, `COMMIT`.

**`--force`** resets in place, inside that same `BEGIN IMMEDIATE`, and only a
file that is a board (`application_id` matches), of this build or another:

1. `PRAGMA defer_foreign_keys = ON`, so dropping tables in any order is not
   refused mid-way (everything is empty by the commit).
2. Drop `task_fts` first (it takes its shadow tables with it), then every
   other table listed in `sqlite_schema` except SQLite's own `sqlite_%`
   (each takes its indexes and triggers, and its `sqlite_sequence` row, so
   keys and question ids start again at 1).
3. Create the schema, set the header values, insert the board row with a new
   `instance`, append `board_created` with `reset: true`; `COMMIT`.

No `VACUUM` after it [R15]: the freed pages are reused by the new board, and
`VACUUM` would need every other connection's cooperation for no gain.

`--force` never unlinks [R16]. Other `board mcp` processes may have the file
open; on POSIX, deleting it would leave them writing to an unlinked file and
losing every write without an error. A file that is not a readable board
(`damaged`, `not_a_board`) is refused even with `--force`, with a message to
move the file aside: recovery is offline, by the person.

The default prefix (whether `--prefix` is required) is the owner's question;
the `CHECK` takes 1–10 characters, `A–Z` then `A–Z0-9`, so a key splits
unambiguously at its last `-`.

## Open questions (the owner's)

1. **FTS5 query text.** Passing an agent's text straight to `MATCH` fails on
   ordinary input: a task key (`APP-12`), a hyphenated word, a stray quote.
   The package does exactly what SQLite does; making it accept such text
   means rewriting the input, which is not ours to decide. Options:
   (a) the `text` filter *is* an FTS5 query, documented in the tool's
   description; a syntax error comes back as `invalid_argument` with SQLite's
   message, and the agent fixes its own query;
   (b) the tool takes plain words and the store quotes each
   whitespace-separated word as an FTS5 string (`"APP-12"` works, as tried),
   losing `OR`, `NOT`, `*` and column filters;
   (c) both: plain words by default, a separate argument for raw FTS5;
   (d) the `trigram` tokenizer with substring search, which needs no syntax
   but finds substrings rather than words and makes the index about three
   times larger.
   data leans to (a): no input is rewritten, and an agent reads the error.
2. **Pause and answers.** Whether the owner's answers (`question_answer`,
   `question_validate`, from the CLI or through main) pass a pause. Drafted:
   refused like every write but `board_resume`. If yes, the store exempts
   those two operations and nothing else changes.
3. **Location override** [R24]. Whether `--board PATH` or `BOARD_DB` names
   the file instead of the upward search. The store takes a path either way,
   so the schema and the rules do not depend on the answer; only `init`'s
   "always the working directory" would need a sentence for it.

## Assumptions about the other drafts

- *Runtime:* the injected clock and the busy timeout value; `watch` holds no
  read transaction between polls and exits non-zero on `board_reset`; the
  chosen build carries FTS5 and the JSON functions.
- *Interfaces:* milestone name pattern and `none`; priority words mapped to
  0–3 in order; `Q<n>` ids; options `{label, detail?}`, 1-based; `task_add`
  defaults to `ready`; `task_update` cannot set `active` or `blocked`; extend
  and release carry `holder`; moves are `before` / `after`; `task_next`'s
  `milestone` argument and `from` values; the comment event kind is
  `comment`, not `note`; the `watch` kind filter includes `claim_expiring`;
  the error codes used here are from the catalog of [R12].
