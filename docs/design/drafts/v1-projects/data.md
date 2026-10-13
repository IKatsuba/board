# v1-projects: data

The storage side of the v1 rework: one database per machine, projects, no
FTS5, no pause. It answers the "data" questions of
`docs/design/drafts/v1-projects/brief.md`, whose owner's decisions are taken
as fixed. It describes what changes relative to the merged v1 design
(`docs/design.md`, "Storage" and Appendix A) and gives the complete revised
DDL, which replaces Appendix A as a whole. This revision follows the lead's
"Resolutions after review" in the brief (R0, C1, C4, C5, C8, C9, C11).

## What was tried

In a throwaway package outside the repository, `sqlite3: ^3.7.0` resolved to
`package:sqlite3` 3.7.0 with its bundled SQLite 3.53.4, run with
`dart run` on Dart 3.13.5. The DDL at the end of this draft was loaded from a
file as written and exercised:

- It creates in one `BEGIN IMMEDIATE` with the header pragmas;
  `foreign_key_check` and `integrity_check` are clean afterwards.
- `project`: a lowercase key, a key starting with a digit, an 11-character
  key, `brd` beside `BRD` (NOCASE `UNIQUE`), a duplicate directory, `/`, a
  relative path, a trailing `/`, `//`, `..` are all refused; a key lookup is
  case-insensitive.
- The resolution query below: `/Users/x/app/src` → `APP`,
  `/Users/x/app/packages/sub/lib` → `SUB` (nested, deepest wins),
  `/Users/x/apple` and `/Users/x/ap` → none, `/Users/x/App` → none (bytes,
  not case-folded).
- Task numbers per project through `INSERT … SELECT coalesce(max(number), 0)
  + 1 … RETURNING`: `BRD-1, BRD-2, BRD-3` beside `APP-1`; the `max` is a
  covering-index search. A duplicate `(project, number)` is refused.
- The composite foreign keys refuse a parent, a wait, a milestone or an event
  in another project, and a wait row whose `project_id` disagrees with its
  tasks; the same within one project passes.
- Milestones: `M1` at position 1 in two projects passes; `m1` again in the
  same project, or a second position 1, is refused. The two-step position
  rewrite works scoped to one project.
- The `LIKE` filter with Dart-side escaping and `ESCAPE '\'`: `50%`, `%`,
  `_`, `e_c`, `\`, `back\s` each find exactly the task containing them
  literally, while an unescaped `%_%` matches every task. Case: `CAFé` finds
  `Café`; `CAFÉ` does not find `Café`, `école` does not find `ÉCOLE`; `cafe`
  does not find `Café`; NFD `Café` does not find NFC `Café`.
  `sqlite_compileoption_used('ENABLE_ICU')` is 0.
- Timing: the filter over 10,000 tasks with 2 KB bodies, in one project, took
  about 31 ms (a scan through the `(project_id, id)` index); over 20,000
  tasks of all projects, 37 ms.
- The append-only triggers: updating any event, deleting an event of an
  existing project, deleting `board_created` are refused. Removing a project
  with no tasks (project row, then its events, then its milestones, under
  `defer_foreign_keys`, then `project_removed`) commits; without deferring it
  is refused at once; with tasks it is refused at `COMMIT`. A re-added key
  gets a new `project.id` (`AUTOINCREMENT`).
- The machine-wide sweep (`DELETE FROM claim … RETURNING`) frees claims of two
  projects in one write and logs each `claim_expired` in its task's project.
- The per-project `task_next` query below runs and falls through an empty
  current milestone to `unassigned`.
- The sweep committed under a refused operation: sweep, `SAVEPOINT op`, the
  operation's update and event, `ROLLBACK TO op`, `RELEASE op`, `COMMIT`.
  Afterwards the claims are gone and both `claim_expired` events are in the
  log; the operation's row and event are not.
- The views of `board sql --project` (section 8), created as `TEMP VIEW`s on
  a connection opened with `OpenMode.readOnly`: they create; unqualified
  names read the views (2 of 3 tasks, the one project row, its events, its
  questions through `task`); `main.task` and `sqlite_master` still see
  everything; every statement tried is `isReadOnly`; a write through a view
  is refused ("cannot modify task because it is a view"), one to `main` is
  `SQLITE_READONLY`.

Everything uses only what SQLite and `package:sqlite3` give directly: no
parser, no custom function, no extension. The one piece of Dart over input is
the `LIKE` escaping, which the owner left to us (below).

## What holds from v1

One line each; the v1 text stands for these.

- Conventions: time format and the injected clock sampled after the lock;
  minutes 1–1440; `STRICT`; enums as `CHECK`; per-connection pragmas; WAL;
  `synchronous = FULL`.
- The file marks: `application_id = 0x424F5244`, `user_version` (stays 1:
  nothing was ever built or released).
- The per-operation `user_version` check (`schema_mismatch`). The
  `instance` check, `board_reset`, the reset and the `board` table go (R0).
- Statuses and transitions, the derived `blocked`, `done` refusing an open
  question, `cancelled` withdrawing them.
- Claims: claim, extend, release, `holder` as a compare-and-set, no implicit
  renewal, reads never write.
- Questions: options, `as`, the owner's override of an unvalidated delegate
  answer, `withdrawn`.
- Milestones: derived status, no hand close, findings take the parent's
  milestone, reopening, relative moves with the two-step rewrite, deleting an
  empty one. All of it now within one project.
- Readiness. Waits: added and removed, cycle check by recursive CTE, a wait on
  a closed task already satisfied.
- No `updated_at` column; no `ON DELETE` actions.
- Contention cases of v1, except the pause race, which is gone.

## 1. The `project` table

```sql
CREATE TABLE project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (…v1 prefix rule…),
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  directory   TEXT NOT NULL UNIQUE CHECK (…absolute, no `/`, no `.`/`..`…),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
) STRICT;
```

(The full text is in Appendix A below.)

- **Key.** The v1 prefix rule carries over unchanged: 1–10 characters, `A–Z`
  then `A–Z0-9`, so a task key splits at its last `-`. Stored uppercase only
  (the `CHECK` refuses anything else); the column is `COLLATE NOCASE`, so
  `brd` cannot sit beside `BRD` and `brd-12` finds `BRD-12`, as v1 compared
  prefixes case-insensitively. The key is required at `project add` and never
  derived (owner decision 6). The store refuses a lowercase key as
  `invalid_argument` rather than uppercasing it; whether the CLI uppercases
  what a person types is interfaces' call.
- **The key never changes.** Event `data` stores task keys as text
  (`"BRD-12"`), and agents keep keys in their context; renaming the key would
  make both lie. `name` and `directory` may change (`project_edited`), if
  interfaces offers an edit.
- **Name.** Free text, 1–100 characters, for people. Required in the table;
  if `--name` is optional at the CLI, the store is given the key as the name
  (interfaces' call, flagged).
- **Directory.** Absolute, canonical, unique. The `CHECK` refuses what is
  certainly not canonical (relative, `/` itself, a trailing `/`, `//`, `.`,
  `..`); producing the canonical form (symlinks resolved, the case as on
  disk) is runtime's, and the store compares bytes. `/` is refused because a
  project there would contain every working directory on the machine and the
  "no project" error could never happen.
- **Uniqueness.** Key and directory are each unique. Two projects on one
  directory is `project_exists` (interfaces' code), naming which column
  collided.
- **Nested directories** are allowed (a package inside a monorepo, a project
  under another's tree). **The deepest directory that contains the path
  wins**: it is the most specific claim on that path, and it is the only rule
  that does not depend on the order projects were added in.

**Resolution** is one query over a canonical absolute path given by runtime:

```sql
SELECT id, key FROM project
WHERE :path = directory
   OR substr(:path, 1, length(directory) + 1) = directory || '/'
ORDER BY length(directory) DESC
LIMIT 1;
```

`directory || '/'` is what keeps `/Users/x/apple` out of `/Users/x/app`.
`substr` and `length` both count characters, so they agree on any text. No
index: a machine has tens of projects, and the query is a scan of them.
Runtime runs it with the working directory first and, when that finds
nothing, with the main repository's root from `git rev-parse
--git-common-dir`; the store does not run git and does not know which path
it was given.

## 2. How everything belongs to a project

- **`task.project_id`**, required. Every other table reaches a project
  through its task or carries the column itself (`milestone`, `waits`,
  `event`).
- **Task numbers are per project**: `BRD-1` and `APP-1` both exist. A key is
  read by people and agents as "the twelfth task of this project"; one
  machine-wide sequence would make `APP-4013` the first task of a new project.
  So the v1 rule "`task.id` is the `n` of the key" ends: `task.id` stays the
  internal row id (every foreign key uses it, and it is never shown), and
  `task.number` is the `n`, `UNIQUE (project_id, number)`.
- **How the number is assigned.** `INSERT … SELECT coalesce(max(number), 0)
  + 1 FROM task WHERE project_id = :p … RETURNING id, number`, inside the
  `task_add` transaction. Writers are serialised by `BEGIN IMMEDIATE`, so two
  processes cannot read the same `max`; the `UNIQUE` index is the backstop
  and also serves the `max` as a covering search. No counter column: a
  counter would be a second copy of a fact. `AUTOINCREMENT`'s other job in
  v1, never reusing a number, holds because tasks are never deleted and a
  project with tasks cannot be removed (section 3).
- **One project per relation.** A parent, a wait and a milestone are in the
  task's own project. This is enforced by SQLite through composite foreign
  keys onto `UNIQUE (project_id, id)` of `task` and `milestone`, not by Dart:
  a cross-project reference cannot be written by any path. The store still
  checks first: a key of another project in `parent`, `waits`, `waits_add`
  or `waits_remove` is `invalid_argument` naming the field (C11), so the
  foreign key is a backstop and not the error an agent sees. Why not allow
  cross-project waits: a wait on another project's task would make one
  project's `task_next` depend on another's state, and the event that frees
  it would be in another project's log. If the owner wants them later,
  dropping the composite keys on `waits` is the whole schema change.
- **`Q<n>` stays one sequence per machine.** `board answer Q7` keeps working
  from any directory without a project, which matters because the owner
  answers questions across projects, often not from inside the project's
  tree. A per-project sequence would need `BRD-Q7` or a `--project` on every
  answer. The cost is gaps: a project's questions are `Q3, Q8, Q9`. The
  question's project is its task's.
- **Milestone names are unique per project**, case-insensitively
  (`UNIQUE (project_id, name)` with the column's `NOCASE`), and so are
  positions: each project has its own chain 1…n. `none` stays reserved.
  `milestone.id` stays `AUTOINCREMENT` across the machine, because events of
  a deleted milestone keep its id.
- **The `board` table goes** (R0). `prefix` moves to `project.key`, the
  pause columns go (section 4), and `instance` goes with the reset. The
  file's creation is the `board_created` event.

## 3. No reset; removing a project

**Removing a project** is allowed only while it has **no tasks**
(`invalid_transition` otherwise, or a new code if interfaces prefers one).
The case it serves is a mistake at `project add`: a wrong key, which can
never be edited, or the wrong directory. A project without tasks has nothing
an agent can hold a key to: no tasks, so no claims, waits or questions. It
may have milestones and events (`project_added`, `project_edited`,
`milestone_*`); removal deletes them with it, in one transaction:

1. `PRAGMA defer_foreign_keys = ON` (resets itself at commit);
2. check that no task has `project_id = :p`, else refuse;
3. delete the `project` row, then its events (the trigger allows it only
   once the project row is gone), then its milestones;
4. append `project_removed {key, name, directory}` with `project_id` null;
5. `COMMIT`. Had a task been missed, the deferred foreign key from `task`
   refuses the commit.

The key and directory are then free; a re-added project gets a new
`project.id` (`AUTOINCREMENT`), so nothing that cached the old id can reach
the new one. **Removing a project with tasks is out of v1**: its keys may be
in agents' contexts and in other projects' event text, and a re-added key
would hand `BRD-1` to a different task. If the owner wants it later, it
needs a per-project identity checked by every operation, or a key that can
never be reused.

**There is no reset** (R0), machine-wide or per project. To start over, on
`schema_mismatch` or otherwise, the person stops the agents and moves
`board.db`, `board.db-wal` and `board.db-shm` aside, offline; the next
`project add` creates a new file. With no reset in place, nothing replaces a
file's contents under a running process, so the `instance` check and
`board_reset` go too; `schema_mismatch` on every operation stays.

## 4. The pause, removed

- **Schema:** `board.paused_by`, `paused_at`, `paused_why` and their two
  `CHECK`s; the event kinds `board_paused` and `board_resumed`.
- **Write sequence:** step 4 ("refuse `paused`, except `board_resume`") goes;
  the sweep follows the board and project checks directly.
- **Rules:** the invariant "nothing changes while paused" and the `paused`
  error; the `board_resume` exception; the v1 note that claims run down while
  paused; the open question about answers passing a pause.
- **Transitions:** none change; the pause never had a transition of its own,
  it only refused them.
- **Reason, for `docs/decisions.md`:** a pause only refused board writes
  while the agents kept working; stopping work is `main` not starting runs
  and chord stopping them. It may come back later.

## 5. The substring filter, without FTS5

Gone: `task_fts`, its three triggers, `bm25` ranking, the invariant "FTS5
matches `task`", the build's need for `ENABLE_FTS5`, and v1's open question
on query syntax. The JSON functions are still needed (`question`, `event`
`CHECK`s); the bundled SQLite has them.

**The filter**, with `:p` the scope the caller resolved (C5): a project id,
or null for `"*"`, the one machine-wide request:

```sql
WHERE (:p IS NULL OR t.project_id = :p)
  AND (t.title LIKE :pattern ESCAPE '\' OR t.body LIKE :pattern ESCAPE '\')
```

`:pattern` is built in Dart as `'%' + escape(text) + '%'`, where `escape`
replaces `\` with `\\` first, then `%` with `\%` and `_` with `\_`. The order
matters: escaping `\` last would double the escapes just added. The text is
bound, never spliced, and after escaping no character of the agent's text is
a wildcard. `\` is the escape character because it is the one people expect
and the escaping makes it literal too. Tried: `50%`, `_`, `\`, `back\s` each
find only the task containing them literally.

**Case and Unicode.** SQLite's `LIKE` folds case for ASCII letters only, and
the bundled build has no ICU. So:

- `lease` finds `Lease`, `LEASE`;
- `CAFé` finds `Café` (the ASCII letters fold, `é` matches itself), but `CAFÉ`
  does not find `Café`, nor `école` find `ÉCOLE`: non-ASCII letters match
  only in the same case;
- no diacritic folding: `cafe` does not find `Café` (FTS5's
  `remove_diacritics` did this; it goes with FTS5);
- no normalisation: text typed in NFD (`e` + U+0301) does not find the same
  text stored in NFC. Agents send NFC almost always; a person pasting from
  some macOS sources may not.

This is documented in the tool's description, and `board sql` is the way to
anything richer, as the owner decided. A Unicode-folding filter would need a
second, folded copy of title and body kept in step (a column written by Dart
with `toLowerCase()`), which is a second copy of a fact for a case the owner
did not ask for; not in v1.

**Limits for interfaces.** An empty `text` makes `%%`, which matches every
task: the input schema should require `minLength: 1`. SQLite refuses a
pattern over 50,000 bytes (`SQLITE_MAX_LIKE_PATTERN_LENGTH`) with "LIKE or
GLOB pattern too complex"; a `maxLength` of a few hundred characters in the
schema keeps that from ever reaching the agent as `internal`.

**No index helps.** A pattern with a leading `%` cannot use a B-tree index,
and SQLite's `LIKE` optimisation applies only to a fixed prefix. The filter is
a scan of the project's tasks (through the `(project_id, id)` index) or of
all tasks: 31 ms for 10,000 tasks with 2 KB bodies, far less for a real
board's shorter ones. It is a read, holds no write lock, and stops no writer.

*An equivalent noted, not chosen:* `instr(lower(title), lower(:text)) > 0`
has the same ASCII-only folding and needs no escaping at all, since `instr`
has no wildcards. The owner named `LIKE`, so the draft uses `LIKE`; the lead
may raise `instr` if escaping is unwelcome.

## 6. `task_next`, readiness, claims and expiry across projects

- **`task_next` is per project.** It takes the project (resolved by
  interfaces' rules) and every part of the v1 query filters on it: the open
  and current milestone come from that project's chain, ready tasks are that
  project's. The query is the v1 one with `m.project_id = :p` and
  `t.project_id = :p` added and `r.number` in place of `r.id` in the final
  order (equivalent within a project). A machine-wide `task_next` is
  meaningless: "current milestone" exists only per project.
- **Readiness** is unchanged; a task waits only on tasks of its own project
  (section 2), so readiness never crosses projects.
- **Claims** are unchanged. A claim is on a task, and the task names its
  project; `claim` has no project column.
- **The expiry sweep stays machine-wide**: every write, in any project, runs
  the v1 `DELETE FROM claim WHERE until <= :now RETURNING …` over all claims.
  Each `claim_expired` is appended with its own task's `project_id`;
  `data.by` names the actor of the write that swept it, who may be working in
  another project (the log's reader should take `by` as "noticed by", not as
  someone in this project). Why not per project: a per-project sweep would
  leave one quiet project's lapsed claims unlogged however busy the machine
  is, and the exactly-once argument is the same either way. The cost is a
  range search on `claim_by_until`, empty almost always.
- **The sweep commits always** (C9), even when the operation that ran it is
  refused. The operation runs inside a savepoint after the sweep:
  `SAVEPOINT op`; validate and apply; on a refusal `ROLLBACK TO op`; then
  `RELEASE op` and `COMMIT`. A refused write therefore can still append
  `claim_expired` events, of any project; the answer's `events` lists every
  id appended, those included, and "changes nothing" means `changed: []`,
  not "nothing committed". Committing the sweep keeps its events tied to the
  first write that saw the lapse, rather than to the first write that also
  succeeded.
- **A wait cannot cross projects** (section 2).

## 7. Events

- **New column `event.project_id`**, the project the event belongs to, with
  `event_by_project (project_id, id)` for `watch --project` and per-project
  reads. It is null only for `board_created` and `project_removed`, enforced
  by a `CHECK`. When `task_id` is set, a composite foreign key makes
  `project_id` the task's project, so no path can file a task's event under
  another project.
- **Removed kinds:** `board_paused`, `board_resumed`.
- **Changed kind:** `board_created` has `data {}` (no `prefix`, no `reset`)
  and `project_id` null: the machine's file being made, written by the
  `project add` that creates it (R0).
- **New kinds:**

| Kind | `project_id` | `data` |
| --- | --- | --- |
| `project_added` | the new project | `{key, name, directory}` |
| `project_edited` | the project | `{<field>: {from, to}}` for each of `name`, `directory` that changed |
| `project_removed` | null | `{key, name, directory}` |

`project_edited` exists only if interfaces offers an edit; otherwise it is
dropped from the `CHECK`. `project_removed` has a null `project_id` because
its project's row and events are gone; `watch --project K` matches it on
`data.key = K`, prints it and exits (C10). `Event.project` is nullable on
the wire for these two kinds (C4).

- **Append-only, refined.** Events are never updated. They are never deleted
  **while their project exists**: the delete trigger refuses unless the
  event's project row is already gone, which only the removal of an empty
  project does (section 3). `board_created` and `project_removed`, with no
  project, can never be deleted. Event ids stay `AUTOINCREMENT`, so a
  watcher's cursor never meets a reused id after a removal.
- Task references in `data` stay keys, now `<project key>-<number>`, built by
  the store with a join to `project`.
- The per-kind `data` table (v1's, with the changes above) is normative and
  checked by store tests (C8).

## 8. `board sql --project`: temporary views

Without `--project`, `board sql` reads the tables as they are, every project
included. With `--project K` (C1), board resolves `K` to its `project.id`
from its own read of the row, then creates on its read-only connection, before
running the person's statement, one `TEMP VIEW` per project table under the
table's own name. Unqualified names resolve to `temp` before `main`, so the
query sees one project. The id goes in as an integer literal (board's own
integer, never text from the command line); views cannot take parameters.

```sql
CREATE TEMP VIEW project   AS SELECT * FROM main.project   WHERE id = <id>;
CREATE TEMP VIEW task      AS SELECT * FROM main.task      WHERE project_id = <id>;
CREATE TEMP VIEW milestone AS SELECT * FROM main.milestone WHERE project_id = <id>;
CREATE TEMP VIEW waits     AS SELECT * FROM main.waits     WHERE project_id = <id>;
CREATE TEMP VIEW event     AS SELECT * FROM main.event     WHERE project_id = <id>;
CREATE TEMP VIEW claim     AS SELECT c.* FROM main.claim c
  JOIN main.task t ON t.id = c.task_id WHERE t.project_id = <id>;
CREATE TEMP VIEW question  AS SELECT q.* FROM main.question q
  JOIN main.task t ON t.id = q.task_id WHERE t.project_id = <id>;
```

- The list is fixed and is every table of Appendix A; a store test compares
  it with `sqlite_schema`, so a table added later without a view fails the
  test rather than leaking every project.
- Each view has its table's columns in its table's order (`c.*`, `q.*`), so a
  query written against the schema works the same with or without
  `--project`.
- `event` under `--project` excludes `board_created` and `project_removed`
  (no project).
- What the views do not narrow, as help says: `main.<table>`, and
  `sqlite_schema` / `sqlite_master`. The narrowing is a convenience, not a
  boundary.
- The views are in the connection's `temp` schema, which exists even on a
  read-only open, and they vanish with the connection. The person's statement
  still passes `isReadOnly` and `checkNoTail` (decision 16); a write through a
  view is refused by SQLite.

## Every operation, revised

A write:

1. `BEGIN IMMEDIATE` (`busy` past the timeout, nothing written).
2. Take `now` from the clock.
3. Check `user_version` (`schema_mismatch`).
4. For an operation in a project: read the project row by key
   (`no_project` / `not_found`, interfaces' code). The process never carries a
   `project.id` from one call to the next; the key is looked up inside each
   transaction (one `UNIQUE` lookup), so a project removed and re-added
   between calls is never written to by its old id. A task key resolves the
   same way: split at the last `-`, project by key, task by
   `(project_id, number)`.
5. Sweep expired claims, machine-wide.
6. `SAVEPOINT op`.
7. Validate; on a refusal `ROLLBACK TO op` (the sweep stays, C9).
8. Otherwise apply the change and its events, each with its `project_id`.
9. `RELEASE op`, `COMMIT`.

A read: one deferred transaction with steps 2–4. The scope comes from the
caller (C5): a resolved project, read by key in step 4, or `"*"`, the one
machine-wide request, which skips step 4. The store never resolves a scope
itself; when the caller needs git's answer it gets it outside the
transaction (C6). `board watch` and `board sql` without `--project` are
`"*"`.

**Creating the file** happens only in `project add` (R0, C3), in the same
transaction as the project: check the file is empty or a board, set
`journal_mode = WAL`, `BEGIN IMMEDIATE`, re-check under the lock (an empty
database, as an interrupted creation leaves it, is created; a board of this
version goes straight to the project), create the schema, set
`application_id` and `user_version`, append `board_created` (`data {}`), then
insert the project and append `project_added`, `COMMIT`. Two concurrent
first `project add`s are ordered by the lock: the second finds a board and
only adds its project. v1's `.board/.gitignore` and the upward search go
with the per-project file.

| Operation | Rows written | Events |
| --- | --- | --- |
| first `project add` | schema, header, `project` | `board_created`, `project_added` |
| `project add` | `project` | `project_added` |
| `project edit` (if any) | `project` | `project_edited` |
| `project rm` | `project`, its `event`s and `milestone`s deleted | `project_removed` |
| `task_add` | `task` (number by `max + 1`), `waits` | `task_added`; milestone flip |
| everything else | as v1, minus FTS (no triggers) | as v1 |
| any write | `claim`, `task.status` for each expired claim, any project | `claim_expired` in the task's project |

## Invariants, revised

| Invariant | Enforced by |
| --- | --- |
| Key, name, directory, milestone name shapes | `CHECK` |
| Key and directory unique; key case-insensitively | `UNIQUE` (key `NOCASE`) |
| Task number unique in its project | `UNIQUE (project_id, number)` |
| Parent, waits, milestone and a task's events in the task's project | composite foreign keys |
| Milestone name and position unique in its project | `UNIQUE (project_id, …)` |
| A task number is never reused | assigned `max + 1` under the lock; tasks never deleted; a project with tasks never removed |
| A question id, an event id, a project id is never reused | `AUTOINCREMENT` |
| Events never changed; never removed while their project exists | triggers |
| `project_id` null exactly on `board_created`, `project_removed` | `CHECK` |
| A project with tasks is not removed | the store; the deferred foreign key at `COMMIT` as backstop |
| The file is a board of this schema | the store, `user_version` in every transaction |
| A refused write still commits its sweep | the store, by a savepoint around the operation |
| Status ⇔ claim; claims only on ready tasks; no cycles; `done` has no open question | the store (as v1) |

Gone from v1's table: "FTS5 matches `task`", "nothing changes while
paused", "one `board` row", "the process works on the board it opened" (no
reset, no `instance`).

## Contention and failure, what changes

- **One write lock for every project on the machine.** Agents of all
  projects queue on one `BEGIN IMMEDIATE`. Writes stay a few milliseconds
  (v1's measurements), so a dozen concurrent agents across projects still
  wait milliseconds; whether 5 s stays right is runtime's question. A long
  `board sql` read pins the WAL for every project, not one: checkpoints wait
  for it, writers do not.
- **Two `task_add` in one project at once.** Serialised by the lock; each
  reads `max` after the other committed, so `BRD-7` and `BRD-8`. Two in
  different projects do not interact.
- **Two `project add` with one key or one directory.** The second gets
  `project_exists` (checked in the transaction; `UNIQUE` as backstop).
- **`project rm` racing a `task_add` in that project.** Serialised. If the
  add commits first, the removal finds a task and is refused. If the removal
  commits first, the add's step 4 finds no project.
- **A project's directory edited while servers run.** The data side reads
  the project by key per call; a server that resolved its project from its
  cwd at start keeps the key it resolved (runtime's caching question, flagged
  below).
- **Two first `project add`s on a missing file.** Ordered by the lock; the
  second finds the schema made and adds only its project.
- **A refused write sweeps.** Its `claim_expired` events commit (C9); a
  caller retrying a refused write appends no second event for the same claim.

## Open questions (the owner's)

1. **A worktree of a monorepo subproject.** The owner's rule matches the main
   repository's **root** when the cwd matches no project. A project whose
   directory is a subdirectory of the repository (`/repo/packages/app`) is
   then not found from a worktree (`/wt/packages/app` → common dir
   `/repo/.git` → root `/repo`): the root matches nothing, or the outer
   project if `/repo` is one. Options: (a) as decided, root only; a
   subproject is not found from a worktree; (b) append the cwd's path inside
   the worktree (`git rev-parse --show-prefix`) to the main root and resolve
   that path (`/repo/packages/app`), which the deepest-wins query then
   handles. data leans to (b): the same query, one more git call. It changes
   the owner's stated rule, so it is the owner's.

## Assumptions about the other drafts

- *Runtime:* gives the store a canonical absolute path (symlinks resolved,
  on-disk case on case-insensitive APFS), and runs git itself; runs the
  the git fallback outside the transaction (C6); creates the file only from
  `project add` (C3); caches project resolution or not (the store needs only
  a key per call); keeps 5 s or changes it.
- *Interfaces:* a store operation in a project receives the project **key**;
  error codes for "no project" and "project exists" (named here
  `no_project`, `project_exists`); `project rm` refused with tasks under some
  code; `invalid_argument` naming the field for a cross-project relation
  (C11); whether `project edit` exists (else drop `project_edited`); whether
  `--name` defaults to the key; `text` with `minLength: 1` and a `maxLength`;
  `"*"` as the one machine-wide scope, every other scope resolved by the
  caller (C5); the views of section 8 are created by `board sql --project`.

## Appendix A: schema

The DDL as tried against `package:sqlite3` 3.7.0 (SQLite 3.53.4). It
replaces v1's Appendix A as a whole.

```sql
PRAGMA application_id = 0x424F5244;
PRAGMA user_version = 1;

-- A project: the key its tasks carry and the directory that selects it.
-- `directory` is absolute and canonical (runtime's form), never `/`.
CREATE TABLE project (
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
) STRICT;

-- The ordered chain of one project. Its status is derived, not stored.
CREATE TABLE milestone (
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
) STRICT;

-- `number` is the n of the key `<project.key>-<n>`, one sequence per
-- project; `id` is internal and never shown. `blocked` is derived from open
-- questions. Priority 0..3 is urgent, high, normal, low.
CREATE TABLE task (
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
) STRICT;

CREATE INDEX task_by_status    ON task (project_id, status, priority, number);
CREATE INDEX task_by_parent    ON task (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX task_by_milestone ON task (milestone_id, status) WHERE milestone_id IS NOT NULL;

-- task_id waits for on_id, both in project_id.
CREATE TABLE waits (
  project_id  INTEGER NOT NULL,
  task_id     INTEGER NOT NULL,
  on_id       INTEGER NOT NULL,
  PRIMARY KEY (task_id, on_id),
  FOREIGN KEY (project_id, task_id) REFERENCES task (project_id, id),
  FOREIGN KEY (project_id, on_id) REFERENCES task (project_id, id),
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

-- `id` is the n of `Q<n>`, one sequence per machine.
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

-- Append-only history. `project_id` is null only for the two events about
-- the machine's board as a whole. `milestone_id` has no foreign key: an
-- empty milestone can be deleted, and its events must outlive it.
CREATE TABLE event (
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
) STRICT;

CREATE INDEX event_by_project   ON event (project_id, id) WHERE project_id IS NOT NULL;
CREATE INDEX event_by_task      ON event (task_id, id) WHERE task_id IS NOT NULL;
CREATE INDEX event_by_milestone ON event (milestone_id, id) WHERE milestone_id IS NOT NULL;
CREATE INDEX event_by_kind      ON event (kind, id);

-- Events are never changed, and never removed while their project exists:
-- removing an empty project removes its events after the project row.
CREATE TRIGGER event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TRIGGER event_no_delete BEFORE DELETE ON event
WHEN old.project_id IS NULL
  OR EXISTS (SELECT 1 FROM project WHERE id = old.project_id)
BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
```
