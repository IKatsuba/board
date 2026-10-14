# board: design

A task board for teams of coding agents: one SQLite file per machine, holding
every project's tasks, read and written by agents through the `board`
command in their shell. This is the design of the first version (v1),
detailed enough to write the code from. The decisions behind it, with the
options weighed and the packages tried, are in `docs/decisions.md`; the
drafts it was merged from are in `docs/design/drafts/v1/`,
`docs/design/drafts/v1-projects/`, `docs/design/drafts/bun/` (the move from
Dart to Bun, TypeScript and Prisma 7) and `docs/design/drafts/cli/` (the
MCP server dropped; agents on the CLI). Questions only the owner can answer
are at the end.

## Why

Driving chord's development through a general-purpose board for one day (50
agent runs, about 15 tasks) showed what agents need from a board and what goes
wrong without it:

- **The state must outlive any one context.** The session that drives the
  work forgets after a compaction; the board does not.
- **Handing work on must be a call, not a parse.** A name typed in a comment
  re-handed a task by accident.
- **A dead run must not hold a task forever.** A task stayed "in progress"
  after its run was stopped, and had to be picked up again by hand.
- **Questions for the owner and their answers are data.** About ten decisions
  were taken that day by a delegate and had to be listed afterwards for the
  owner to check.
- **Small findings must not get lost.** Reviewers filed a dozen minor tasks;
  each must land in the milestone it was found in, and agents search the board
  before filing.
- **Runs share a checkout and leave processes behind.** One run's stash landed
  in another's working tree; three orphaned agents ran for 17 hours. board
  records where a run works; processes are chord's business.

What the board does not do: run anything. The session in front of the person
(chord's `main`) already gets every lead's report as a turn of its own and can
start the next team run. board is memory and rules; the driver is `main`.
Stopping work is `main` not starting runs and chord stopping them, which is
why there is no pause.

## The model

```
project     key, name, directory                      — one per repository
milestone   project, name, delivers, position         — an ordered chain per project
task        key (<project key>-<n>), title, body, status, priority,
            parent, milestone, created_at, created_by
waits       task → task it waits for (same project)
claim       task, holder, since, until, directory?, branch?   — a lease
question    Q<n> (one sequence per machine), task, text,
            options[{label, detail?}], recommended, asked_by, status,
            choice, answer, answered_by, answered_as (owner | delegate),
            validated_by
event       id, at, actor, kind, project, task, milestone, data (JSON)
                                                      — append-only
```

- **One board per machine, many projects.** `~/.board/board.db` holds every
  project. A project has a key chosen by a person (`BRD`), a name, and the
  directory that selects it. Tasks, milestones, claims, questions and events
  belong to a project; parents, waits and milestones never cross projects.
- **Events are the history.** Every write appends its events in the same
  transaction that changes the rows, so a task's story is a query,
  `board show KEY --since ID` returns only what changed since an agent last looked, and
  `board watch` streams the log.
- **Status says where a task is, not who has it.** Stored: `backlog`, `ready`,
  `active`, `done`, `cancelled`. Shown: those, plus `blocked`, which is derived
  from an open question. Who works on a task is its claim.
- **A task is ready** when its status is `ready` (or `active` with an expired
  claim), it has no open question, and everything it waits for is `done` or
  `cancelled`.
- **A claim is a lease the claimer sizes.** `board claim` takes a duration in
  minutes, chosen by the team from its own estimate; there is no default. The
  holder releases early when done and extends explicitly when it needs more
  time; other writes do not renew it. A claim past its end reads as gone at
  once, and the next write logs `claim_expired`. Two runs cannot hold one task.
  A claim may carry the directory and branch the run works in; board shows
  them and checks nothing about them.
- **A question blocks its task** until it is answered or withdrawn. An answer
  records who gave it: the owner, or a delegate the owner trusted with
  decisions, which stays on the to-validate list until validated. The owner's
  answer over an unvalidated delegate answer replaces it, and the log keeps
  both.
- **Milestones are an ordered chain per project**, with nothing above them (a
  feature is a parent task). A task belongs to at most one milestone,
  independently of its parent. A milestone is done when it has tasks and all
  are closed; it cannot be closed by hand. The earliest open one is
  *current*, later open ones are *planned*. A finding filed with a parent and
  no milestone takes its parent's milestone; a task added to, moved into or
  reopened in a done milestone reopens it.
- **No duplicate detection.** `board add` adds. Agents look first: `board ls
  --contains` filters by a plain substring of title and body.

`--actor`, on every write, is a string the caller gives and board trusts:
board checks no roles, and every agent can run every command. Roles live in the team's
instructions. `board` is a reserved actor, used for what board does itself.

## Projects

### Adding one

`board project add KEY [--name NAME] [--dir DIR]` adds a project. A person
chooses `KEY`; it is never derived from a directory or a name. It is 1–10
characters, a letter then letters or digits, stored in upper case and unique
case-insensitively. It is the prefix of every task key of the project and can
never change, because task keys live in agents' contexts and in event text.
`--dir` defaults to the working directory and is stored as a real path
(`realpath(3)`: symlinks, `/tmp` → `/private/tmp` and the on-disk letter case
of an APFS volume all collapse to one spelling). It must exist, must not be
`/`, and must be unique. `--name` is a label, defaulting to the directory's
last component.

**One repository is one project, and its directory is the repository's
root.** `project add` and `project edit --dir` ask git about the directory
with the same rule as resolution (step 4 below). If the directory is inside a
git checkout, it must be that checkout's main root. A subdirectory or a linked
worktree is refused with `invalid_argument`, naming the root to use instead.
A directory whose git layout gives no root (a bare repository's worktree, a
separate git dir, a submodule) is refused as not supported, with
`invalid_argument`. A directory outside git is accepted as it is. When git
cannot answer (it is not installed, it is the Command Line Tools stub, it
fails or times out), the directory is refused with `invalid_argument` and
git's reason in the details: board cannot check the one-repository rule, and
nothing is registered on a guess (owner, slice 1). There are no subprojects: a package inside
a repository is not registered on its own. Two repositories, one cloned inside
the other's tree, are still two roots; the deepest one wins, as below.

`board project edit KEY [--name] [--dir]` changes the label or the directory
(the repository moved). `board project rm KEY` removes a project with **no
tasks** (a key typed wrong at `add`), with its milestones and events. A
project with tasks cannot be removed in v1: its keys may still be held by
agents, and a re-added key would hand `BRD-1` to a different task. Because
nothing that ever named a task is removed, no task key is ever reused.

### Which project a call is about

The same rule for every command:

1. **A task key or a question id names it.** `BRD-12` is in `BRD`; `Q7`'s
   project is its task's. A command that takes a key or a question id takes
   no `-p`.
2. Otherwise **`-p KEY`** (`--project`), when given. There is no pin and no
   environment variable for the project (decision 24).
3. Otherwise the **working directory** of the process: the project whose
   directory is the cwd or contains it (a prefix ending at a `/`, so
   `/p/apple` is not under `/p/app`), the deepest when projects nest.
4. Otherwise **git**: `git -C <cwd> rev-parse --git-common-dir`. When the
   common directory is named `.git`, its parent is the main checkout's root,
   matched as in step 3. That covers the repository, its subdirectories, its
   linked worktrees, and standing inside `.git`. Any other common directory
   (a bare repository, a separate git dir, a submodule) gives no root, and the
   error says so. Nothing is guessed about other layouts. **Bare repositories
   are not supported**: a worktree of a bare repository answers `no_project`
   unless `-p` is given.
5. Otherwise **`no_project`**, which says what was looked at and how to add
   the project:

   ```
   No project here. Looked at the working directory /work/app/server: no project's directory contains it. Looked at its git repository: the main repository is /work/app, and no project's directory contains it. Projects on this machine: BRD /work/board.
   Pass `-p KEY` with one of the keys above, or ask the owner to choose a key and run `board project add KEY --dir /work/app`.
   ```

   The key is a placeholder on purpose: the key is the person's choice, so an
   agent is told to ask, not to pick one. `details` carry `cwd`, the git
   outcome (`found`, `not_a_repo`, `missing`, `failed`), `git_root` and the
   projects.

`-p` is optional, never required, and every answer says which project it
was about. `board ls` and `board questions` also take `--all`, the only
machine-wide request; a status, a next task or a milestone chain is always one
project's. A `-p` that contradicts a key or parent given in the same call is
`invalid_argument`.

**Run time.** Each command is its own process and resolves from its own
working directory, as a real path (`process.cwd()`, never `PWD`). An
agent's shell runs where the agent works: a team run in a git worktree has
the worktree as its cwd, which is the case step 4 is for. Resolution happens
**inside the transaction**, against the `project` rows read there, so a
project added, edited or removed is seen by the next command.

git is a separate process and no transaction may await, so: the operation runs
with the cwd only. If resolution reaches step 4 without a git answer, it
throws before any change and the transaction rolls back. board then asks git
outside any transaction and runs the operation once more, in a new
transaction, with the answer. git costs about 25 ms a call when it runs
(measured); `-p` skips it. git runs with a 3 s timeout and is killed past it
(`Bun.spawn` and `SIGKILL`). A missing git, a failing git, or the macOS
command-line-tools stub is reported in the error, not worked around. git is
the owner's instruction and an external program, not a package.

### No server to configure

Agents run `board` from their shell; nothing goes in `.mcp.json`, and no
board process outlives its command. `BOARD_DIR` in the environment names
another board directory, for tests or a second board. An old `.mcp.json`
line starting `board mcp` now fails to start (there is no such command):
remove it.

## Storage

### File and connections

- **One file per machine**: `$BOARD_DIR/board.db`, with `BOARD_DIR`
  defaulting to `~/.board`. `BOARD_DIR` must be absolute: a relative one
  would resolve against each process's cwd, and every session would open a
  different file without a word (`"~/x"` in a JSON config is not expanded by
  anyone). An empty value counts as unset, for `BOARD_DIR` and for `HOME`
  alike. Only `src/main.ts` reads the
  environment; the rest of `src/` takes it as a parameter.
- **Only `board project add` creates the file.** It creates the directory
  and the file, sets WAL, and then creates the schema in the same transaction
  as the project. WAL is set before that transaction because SQLite refuses
  to change `journal_mode` inside one. A switch refused `SQLITE_BUSY` (it
  does not wait out the busy timeout) means another first `project add` holds
  the file: this one goes on to its transaction, whose lock statement does
  wait ("`board project add`" below has the full order). Under the
  lock, before writing anything, it checks that the file is in WAL; a fresh
  file still not in WAL (the other creator died before committing) is
  refused `busy` and nothing is written, so the refused switch alone never
  stands for the other creator having succeeded. The "is it already a board"
  check is repeated under the same lock, so two first `project add`s on a
  fresh machine create one schema and both rows. Every other command and
  opens without creating: a missing file is `no_board`, naming the path, whether
  `BOARD_DIR` set it, and `board project add`. A read that created would turn
  a mistyped `BOARD_DIR` into a second, empty board. Every command opens
  afresh, so a board created after an agent started is there on its next
  command.
- The directory and the file get default modes under the umask; the home
  directory on macOS already shuts other users out.
- SQLite through Prisma 7.10.0 (`@prisma/client`, generator
  `prisma-client`, runtime `bun`) and the driver adapter
  `prisma-adapter-bun-sqlite` 0.8.0 over `bun:sqlite`, which on macOS is
  the system's `/usr/lib/libsqlite3.dylib` (3.51.0 on the machine tried; the
  version is the user's macOS's, and the binary requires macOS 13). Nothing
  of SQLite is bundled. The file is marked as a board by
  `PRAGMA application_id = 0x424F5244` ("BORD"); `PRAGMA user_version` is the
  schema version, checked at open and in every transaction. There are no
  migrations before the first release, and **no reset command**: a file of
  another version is `schema_mismatch`, and starting over is the person's
  offline act: stop the agents, move `board.db`, `board.db-wal` and
  `board.db-shm` aside, and run `board project add` again. Nothing in board
  ever replaces the file's contents under running processes. A file removed
  by hand while agents work makes every later command `no_board`; a write in
  flight at that moment is lost, which is why the procedure stops the agents
  first.
- One connection per process: one `PrismaClient`, and the adapter connects
  once. Every command opens one and closes it (closing the last connection
  checkpoints the WAL: 0.65–0.82 ms after a one-row write, measured). On every open: the adapter sets `foreign_keys = ON` and
  `busy_timeout = 5000`; board sets `synchronous = FULL` right after
  `$connect()` (an agent told "claimed" must still hold the claim after a
  power loss; Apple's SQLite starts a WAL connection at `NORMAL`).
  `journal_mode = WAL` is set once, by `project add`, and persists. The
  adapter's `wal` option is not used: it would switch any file to WAL on
  open, before board has checked that the file is a board, and throw on the
  refused switch `project add` goes past.
- **The adapter creates a missing file**, and has no option against it. So
  every command but `project add` checks, before it builds the client, that
  `board.db` exists and holds a schema (`sqlite_master` is not empty): a
  missing file, or the empty one a failed first `project add` leaves, is
  `no_board`. The only race is with the offline move, which stops the agents
  first.
- `board watch` and `board sql` do not go through Prisma (the adapter cannot
  open read-only and exposes no statement): they open `bun:sqlite` directly
  with `{ readonly: true }`, which refuses a missing file with
  `SQLITE_CANTOPEN` and creates nothing. One SQLite library is in every
  process, so quarry's POSIX-lock hazard (two library copies on one file)
  does not arise.

#### `board project add`

Before the transaction, each step a statement of its own, with no snapshot
carried:

1. `mkdir -p $BOARD_DIR`; open the client (the adapter creates an empty
   `board.db` if none exists); `PRAGMA synchronous = FULL`.
2. `PRAGMA application_id`: a value other than `0` and `0x424F5244` is
   `not_a_board`, nothing written (the early answer for somebody else's
   file; repeated under the lock).
3. `PRAGMA journal_mode = WAL`. Answered `wal`: go on. Refused
   `SQLITE_BUSY` (at once, no wait): another first `project add` holds the
   file; go on as well, because the next step waits.

The transaction, one Prisma `$transaction` as every write is (below):

4. **Lock statement:** `PRAGMA application_id = 1112494660` (`0x424F5244`).
   It is a write in both branches: on a fresh file it is the header the
   schema needs; on an existing board it rewrites the same value and still
   takes the lock (measured). Past the busy timeout: `busy`, nothing
   written. A fresh file has no `project` table, which is why this is not
   the ordinary lock statement.
5. `now` from the injected clock, after the lock.
6. `PRAGMA journal_mode` must read `wal`; otherwise `busy` and nothing
   written (a fresh file whose creator died before committing), so the
   refused switch of step 3 never stands for the other creator's success.
7. Under the lock, `SELECT count(*) FROM sqlite_master`:
   - **0 objects, the fresh branch:** run Appendix A's statements one per
     call (`src/store/ddl.ts`, including `PRAGMA user_version`), append
     `board_created`, insert the project, append `project_added`, commit. A
     refusal here (a bad key, a directory not canonical) rolls everything
     back: there is no sweep to keep on a file with no board, and the file
     stays empty, in WAL.
   - **Objects present, the existing branch:** the ordinary write from its
     step 3: `user_version` (`schema_mismatch`; tables with neither the
     version nor a `project` table are `not_a_board`; either rolls back,
     undoing step 4's rewrite), the machine-wide sweep, `SAVEPOINT op`,
     validate (`project_exists` keeps the sweep), insert the project and
     `project_added`, commit.

Measured with Prisma and the adapter as they are: 2 and 5 first creators
started at the same millisecond on an empty `BOARD_DIR`, 10 trials each,
gave every time one schema (28 objects), every project, **one
`board_created`** and one `project_added` per creator. A creator killed
while holding a fresh file not yet in WAL left the waiter answering `busy`
with nothing written; a rerun created the board. A refused `project add` on
an existing board with a lapsed claim kept its sweep.
- The board on a network file system is not supported: WAL needs shared
  memory between processes on one host.

### Schema

The full DDL is Appendix A. In short:

- Every table is `STRICT`; enums are `TEXT` with `CHECK`. Times are `TEXT`,
  UTC ISO 8601 with milliseconds and `Z` (`2026-10-12T09:30:00.000Z`), fixed
  width so that text order is time order, in storage and in every interface.
- `project.key` is `COLLATE NOCASE UNIQUE` and upper case by `CHECK`;
  `directory` is absolute, canonical by `CHECK` as far as a `CHECK` can tell,
  and unique.
- **Task numbers are per project**: `task.number` is the `n` of `BRD-n`,
  `UNIQUE (project_id, number)`, assigned as `max + 1` inside the `board add`
  transaction, under the write lock. `task.id` is internal and never shown.
- **Relations stay inside a project by composite foreign keys** onto
  `UNIQUE (project_id, id)` of `task` and `milestone`: a parent, a wait, a
  milestone and a task's events cannot point into another project by any
  path. The store checks first, and a key of another project in `parent`,
  `waits`, `waits_add` or `waits_remove` is `invalid_argument` naming the
  field; the foreign key is the backstop.
- `question.id` is the `n` of `Q<n>`, one sequence per machine, so
  `board answer Q7` works from anywhere.
- Milestone names and positions are unique per project.
- `claim` has the task as its primary key: one claim per task, enforced by
  SQLite as well as by the rules.
- `event` is append-only by trigger: never updated, and never deleted while
  its project exists (only the removal of an empty project deletes its
  events). `event.project_id` is null exactly on `board_created` and
  `project_removed`. Its `data` is a JSON object whose references are public
  identifiers (keys, `Q<n>`, milestone names, priority words), so a line of
  the log reads without joins.
- Priority is stored 0–3 and shown as `urgent`, `high`, `normal`, `low`.
- Not stored, derived on read with the caller's `now`: `blocked`; whether a
  claim is live; a milestone's status; a task's `updated_at` (the `at` of its
  latest event).

**Appendix A is the one source of the schema.** `src/store/ddl.ts` exports
it as an explicit array of its 22 complete statements (each `CREATE TRIGGER
… END` whole), run one per call: through Prisma and `bun:sqlite` a string
of several statements silently runs only the first, and nothing splits text
at run time. `prisma/schema.prisma` is derived from it (`gen`, under
"Build and distribution": the array → `build/schema.db` → `prisma db pull`
→ `prisma generate --sql`), committed, and only types the client; it is never
pushed or migrated, and there is no `_prisma_migrations` table. Prisma's
schema language cannot say `STRICT`, `CHECK`, `COLLATE NOCASE`, triggers or
`WITHOUT ROWID`, which is why it is not the source; composite foreign keys,
`UNIQUE`s and partial indexes (`previewFeatures = ["partialIndexes"]`) come
through. Relation fields renamed by hand in `schema.prisma` survive a later
pull. `check` fails when `gen` changes the committed file. Prisma 7.10.0's
pull writes `question_to_validate`'s predicate wrongly (the index's `WHERE`
starts on its own line, and the pulled `raw(…)` carries the DDL's head);
`validate` and `generate` pass and the client is right, so the pulled file is
committed as it is and the bug is reported upstream. Only `migrate diff`,
which board never runs, would turn it into bad SQL.

**Queries** are a mix, by what each one is: Prisma's model API for row and
nested CRUD (`task.create` with its `event` rows, `claim.delete`,
`findUnique` by key or number) and milestone status (`task.groupBy`, since
TypedSQL types a parameterised per-group count as `null`; decision 26);
TypedSQL (`prisma/sql/*.sql`,
`$queryRawTyped`) for the sweep (`DELETE … RETURNING`; Prisma has no
`deleteManyAndReturn` for SQLite), `max(number) + 1`, readiness and
`board next`'s order and the substring filter;
`$executeRawUnsafe` only for board's own fixed text (the lock statement,
pragmas, DDL), never with user text.

Cross-row rules (status ⇔ claim, readiness, cycles in `waits` and `parent`,
milestone flips) live in TypeScript over the store, not in SQL triggers, because
they produce errors the commands must explain, and a trigger's message is a
string to parse back.

### Every operation

A write is one Prisma interactive `$transaction` (`timeout: 10_000`,
`maxWait: 30_000`), whose first statement takes the write lock:

1. The adapter begins it deferred (no Prisma SQLite adapter can begin
   `IMMEDIATE`); its first statement is `UPDATE project SET id = id WHERE
   0`. A deferred transaction that holds no snapshot yet waits for the write
   lock through the busy handler, as `BEGIN IMMEDIATE` does, even when the
   statement matches no row (measured, and pinned by a store test: after it,
   a second connection's `BEGIN IMMEDIATE` gets `SQLITE_BUSY`). Past the busy
   timeout, `busy`, nothing written. No statement precedes it. (`project
   add`'s lock statement is `PRAGMA application_id`, above.)
2. Take `now` from the injected clock: after the lock, so a lease is measured
   from when the write happened, and `at` follows commit order.
3. Check `user_version` (`schema_mismatch`).
4. Resolve the project inside the transaction, from a key read by `UNIQUE`
   lookup, or from the cwd or git as above. A process never carries a
   `project.id` from one call to the next. If git is needed and not at hand,
   roll back and retry once with its answer.
5. Sweep expired claims, machine-wide (below).
6. `SAVEPOINT op`: a nested `tx.$transaction`.
7. Validate. On a refusal, the nested callback throws and Prisma rolls back
   to the savepoint: the operation changes nothing,
   and the sweep stays.
8. Otherwise apply the change and append its events, including any
   `milestone_done` / `milestone_reopened` flip it caused.
9. `RELEASE op`, `COMMIT`.

A write's answer lists in `events` every id it appended, including
`claim_expired` lines its sweep wrote for any project. An update whose every
part changes nothing answers `changed: []` and appends no event of its own.

No write reads before its lock statement: in WAL, a deferred transaction
that has read and then writes fails `SQLITE_BUSY_SNAPSHOT` (or `SQLITE_BUSY`)
without consulting the busy handler; measured through Prisma, 989 of 1,000
read-first writes under ten writers failed that way, and 1,000 of 1,000
lock-first writes committed. The sweep is not the lock statement, because it
needs `now`, which would then be sampled before a wait of up to 5 s. A read
is one deferred `$transaction` with steps 2–4, so a multi-query read sees one
snapshot; a `"*"` read skips step 4.

**`Store` alone holds the client.** It owns the one `PrismaClient` and
exposes only `read(fn)` and `write(fn)`, each a `$transaction`, which the
adapter's mutex runs one at a time per process; nothing else in `src/`
imports the client, and `rules/` gets a transaction, never the client. A
plain client call made while a transaction is open would run inside it on
the one connection and vanish with its rollback (measured: answered
"created", then gone). So a command's two attempts (the retry with git's
answer) and two `Board` calls in one test never interleave inside a
transaction. No store callback
does I/O or awaits a timer (git runs before the transaction).

**Outcomes.** Contention ends in `busy`, nothing written, and in nothing
else: `P2010` or `P1008` whose `meta.driverAdapterError.cause.originalCode`
is `SQLITE_BUSY`, and `P2028` (Prisma's `maxWait` or `timeout`), kept as a
defensive case. Every other error is `internal` or `storage`. Every failure
ends in Prisma's `ROLLBACK` (or SQLite's own, on `SQLITE_FULL`), and the lock
is free after it and the client usable: measured for busy, a throw from the
callback, a unique violation, `SQLITE_FULL`, Prisma's own timeout, stdin
closed, and `SIGINT` / `SIGTERM` / `SIGHUP` / `SIGKILL` during a write.
`$disconnect()` is never relied on to release a lock.

**Prisma's timers do not bound a wait.** `busy_timeout` blocks in C with the
event loop stopped. A command makes one write, so n agents' writes behind a
lock held elsewhere wait their 5 s side by side, each in its own process, and
each answers `busy` after about 5 s. `timeout` stays the only bound on a
callback that would hang while holding the lock.

### Expiry, exactly once

Every write sweeps every project's expired claims, after resolving its
project:

```sql
DELETE FROM claim WHERE until <= :now RETURNING task_id, holder, since, until;
```

For each row it sets the task back to `ready` and appends `claim_expired` in
that task's project (actor `board`, `data.by` the actor whose write swept it,
read as "noticed by", and `data.until` when the lease actually ran out).
Writes are serialised by the lock, and the `DELETE` removes what it reports,
so however many processes notice an expiry, one event is written. The sweep
is machine-wide so that a quiet project's lapsed claims are logged while the
machine is busy. It commits even when the operation that ran it is refused,
which ties each event to the first write that saw the lapse.

**Reads do not write.** A read treats an expired claim as absent (`claim:
null`, status `ready`), so its answer is right without the write lock, and
`board watch` and `board sql` can stay read-only. On an idle machine,
`claim_expired` reaches the log at the next write; `board watch` warns before
the end with its derived `claim_expiring` line.

### Statuses and transitions

| From → to | By | Notes |
| --- | --- | --- |
| (new) → `ready` / `backlog` | `board add` | default `ready`: a milestone's findings are its work; `backlog` is main's choice |
| `backlog` ↔ `ready` | `board edit` | |
| `ready` → `active` | `board claim` only | the task must be ready; `not_ready` or `claim_held` otherwise |
| `active` → `ready` | `board release`, expiry, `board edit` | `board edit` sends work back and drops the claim unconditionally (`claim_released`, `sent_back`) |
| `active` → `backlog` | `board edit` | drops the claim the same way |
| open → `done` | `board edit` | refused while a question is open; drops a claim (`closed`) |
| open → `cancelled` | `board edit` | withdraws its open questions; drops a claim (`closed`) |
| `done` / `cancelled` → `backlog` / `ready` | `board edit` | reopening; reopens its milestone if done |
| anything → `active` / `blocked` by `board edit` | refused | `active` means claimed; `blocked` means a question is open |

`blocked` is implied: `board ask` does not touch the stored status, and
when the last open question is answered or withdrawn the task is what its
stored status and claim say. A claim held while waiting on the owner keeps
running down. `done` refuses an open question because closing would hide a
question the owner has not seen; cancelling withdraws them because they no
longer need an answer.

Waits are added and removed, never replaced, and only within a project. A
wait is satisfied when the task waited on is `done` or `cancelled`. A wait or
a parent that would close a loop is `cycle` (a recursive CTE before writing);
the same key in `waits_add` and `waits_remove`, or a task waiting on itself,
is `invalid_argument`. Adding an existing wait or removing a missing one
changes nothing.

### `board next`

The ready task to start next in one project, in this order:

1. ready tasks of the project's current milestone;
2. then ready tasks in no milestone (chores and small findings are not part of
   the plan for later milestones);
3. then ready tasks of later milestones, in chain order.

Within each group: priority, then oldest. An empty or exhausted current
milestone contributes nothing and the search falls through. An explicit
`milestone` restricts the search to it, with no fallback. The answer's `from`
says which rule picked the task (`current`, `unassigned`, `later`,
`milestone`), and when nothing is ready it says why (blocked, active, waiting
on other tasks). `board next` only reads: two callers may get the same task,
and the second `board claim` is refused `claim_held`.

### Claims

- `claim(task, holder, minutes, directory?, branch?)`: the task must be ready;
  an expired claim on it is swept in the same transaction, so retaking a
  lapsed task is one call. `since = now`, `until = now + minutes`. `holder`
  defaults to the actor: main claims for the lead it starts by passing the
  lead's name.
- `extend(task, holder, minutes)`: the claim must be live (an expired one is
  not revived: another run may already have been told the task is ready);
  `until = now + minutes`, a fresh estimate from where the run stands.
- `release(task, holder, note?)`: drops the claim; the task is `ready`.

Minutes are 1–1440. `holder` on extend and release is required and compared
with the live claim's: a compare-and-set against a stale view, not an
authorisation check. Anyone may call them, and main frees a dead run's task by
passing the holder it reads. The holder's other writes do not renew the
lease: a run stuck in a loop of comments must not hold its task forever.

### Questions

`board ask` takes 2–6 options `{label, detail?}` and a 1-based
`recommended`; both are required, because the design asks for a
recommendation every time. `board answer` takes `choice`, `text` or both,
and `as` (`owner` or `delegate`) with no default, so no one records an owner's
answer by leaving out an argument. Answering an answered question is
`already_answered`, except the owner's answer over a delegate's unvalidated
one: that replaces it (`answered_as` becomes `owner`, nothing to validate),
and `question_answered` carries `overrides` with the replaced answer.
`board validate` marks a delegate's answer checked; main uses it to record
the owner's approval given in the chat window, and `board validate` does the
same from a terminal. A question is `withdrawn` when its task is cancelled.

### Milestones

- **Order** is `position`, 1…n per project with no gaps. `board milestone add`
  places a new one `before` or `after` a named milestone, or last.
  `board milestone edit` renames, re-describes, and moves relative to another
  milestone. Any milestone may be moved; order only decides which open one is
  current.
- **Status** is derived: `done` (has tasks, all `done` or `cancelled`),
  `current` (the earliest open one), `planned` (later open ones). An empty
  milestone is open, never done. Progress shows done and cancelled separately,
  so a person sees when a milestone delivered less.
- **No closing by hand.** To finish a milestone with open tasks, main closes,
  cancels or moves them.
- **Findings stay in their milestone.** `board add` with a `parent` and no
  `milestone` takes the parent's; `milestone: "none"` says none on purpose.
  Adding, moving or reopening a task in a done milestone reopens it
  (`milestone_reopened`); if it is earlier than the current one, it becomes
  current again.
- **Names**: 1–40 characters, `^[A-Za-z0-9][A-Za-z0-9._-]*$`, unique per
  project case-insensitively, and never `none`, the word for "no milestone".
- **Deleting**: only a milestone with no tasks at all (`board milestone rm`,
  `board milestone rm`); later ones shift up.

`milestone_done` and `milestone_reopened` are appended by the write that
flipped the derived status, with that write's actor.

### The substring filter

`task_list.contains` and `board ls --contains` keep a task when its title or
body contains the text, as given; there is no index and no query syntax.
Anything richer goes through `board sql`.

```sql
WHERE (:p IS NULL OR t.project_id = :p)
  AND (t.title LIKE :pattern ESCAPE '\' OR t.body LIKE :pattern ESCAPE '\')
```

`:pattern` is `'%' + escape(text) + '%'`, where `escape` replaces `\` with
`\\` first, then `%` with `\%` and `_` with `\_` (escaping `\` last would
double the escapes just added). The text is bound, never spliced, so no
character of it is a wildcard: `50%`, `_`, `\`, `APP-12` and `claim-release`
are plain text. It is 1–200 characters (an empty pattern would match every
task, and SQLite refuses huge ones). Case folds for ASCII letters only:
`lease` finds `Lease`, but `é` does not find `É`, `cafe` does not find `Café`,
and NFD text does not find NFC text; `board ls --help` says so. Results
are newest first. A scan of 10,000 tasks with 2 KB bodies takes about 31 ms;
a leading `%` cannot use a B-tree index.

### Events

The one catalog. `project_id` is set on every event but `board_created` and
`project_removed`; `task_id` on every event about a task; `milestone_id` on
every event about a milestone. A change to a field is always `{from, to}`.

| Kind | `data` |
| --- | --- |
| `board_created` | `{}`; the machine's file made by the first `project add` |
| `project_added` | `{key, name, directory}` |
| `project_edited` | `{<field>: {from, to}}` for each of `name`, `directory` that changed |
| `project_removed` | `{key, name, directory}`; no project, since its row and events are gone |
| `task_added` | `{title, body, status, priority, parent, milestone, waits: [key]}` |
| `task_edited` | `{<field>: {from, to}}` for each of `title`, `body`, `priority`, `parent` that changed |
| `task_status` | `{from, to}` (stored statuses) |
| `task_moved` | `{from, to}` (milestone names or null) |
| `waits_changed` | `{added: [key], removed: [key]}` |
| `claimed` | `{holder, since, until, directory, branch}` |
| `claim_extended` | `{holder, until: {from, to}}` |
| `claim_released` | `{holder, reason, note}`; `reason` is `release`, `closed` or `sent_back`; `note` may be null |
| `claim_expired` | `{holder, since, until, by}`; actor `board` |
| `comment` | `{text}` |
| `handover` | `{to, text, changed, ran, unchecked}` |
| `question_asked` | `{question, text, options: [{label, detail}], recommended}` |
| `question_answered` | `{question, choice, text, as, overrides}`; `overrides` is the replaced answer or null |
| `question_validated` | `{question}` |
| `question_withdrawn` | `{question, why}` |
| `milestone_added` | `{name, delivers, position}` |
| `milestone_edited` | `{<field>: {from, to}}` for each of `name`, `delivers`, `position` that changed |
| `milestone_deleted` | `{name}` |
| `milestone_done` | `{name}` |
| `milestone_reopened` | `{name, by}`; `by` is the key of the task that reopened it |

This table is normative and held by the store's tests. A claim operation does
not also write `task_status`: "what started" is `claimed`. `blocked` has no
event of its own; `question_asked` and `question_answered` are it. A move
writes `milestone_edited` with `position` on the moved milestone; the shift
of the others follows from it. `claim_expiring` is not in the catalog:
`board watch` derives it and never writes it.

## The CLI

The CLI is the whole interface: agents work the board by running `board` in
their shell, and a person uses the same commands. There is no server, no
protocol and no long-lived process; each command is one short process with
one connection (see "Runtime"). The drafts behind this section are in
`docs/design/drafts/cli/`.

Built on `@cliffy/command` 1.3.1: one root `Command` with `throwErrors()`,
the groups `project` and `milestone` as `Command`s mounted on it, and one
`catch` at the entry point that prints a usage error (`ValidationError`) as
`board: usage: <message>` on stderr and exits 64; the help never goes to
stdout on a usage error. Lists (`--status`, `--kind`, `--waits`,
`--waits-add`, `--waits-remove`, `watch -p`, `--task`) are cliffy list types,
split on commas and checked per item by a type, repeatable with
`collect: true` and a `value` that flattens; `conflicts`, `required` and
`depends` are checked at parse; ranges and lengths are checked in `value`
(`inRange`, `lengthIn`), throwing cliffy's `ValidationError`.

### Four rules the surface follows

1. **Free text is never a positional argument.** cliffy 1.3.1 hands an
   unknown flag to a positional argument that is still unfilled (deliberate,
   in `@jsr/cliffy__flags`): with `add <title:string>`, `board add --tex x`
   (a typo of `--text`) would make `--tex` the title. A typed positional (a
   task key, a question id, a milestone name, an integer) refuses a `--…`
   token through its type, so positionals are identifiers only, and every
   title, body and text is a flag. `board sql QUERY` is the one free-text
   positional, and stays (it is read-only).
2. **A flag is named after its field, in kebab case**: `waits_add` is
   `--waits-add`, and a refusal's `details.field` is the flag as typed
   ("Errors" below).
3. **One command per input shape.** Where an operation had a `kind` or an
   `if/then/else`, the CLI has two commands, so cliffy's own `required` says
   what each needs (`comment` and `handover`).
4. **cliffy checks the shape, `Board` checks the rules.** No parsing of
   ours: what does not fit a command is cliffy's usage error (exit 64); what
   fits and breaks a rule is board's refusal (exit 1).

### Conventions

- **One shape per thing.** Project, task, task summary, claim, question,
  milestone and event each have one JSON schema (Appendix B), used by every
  command that prints them under `--json`.
- **Public identifiers are strings**: `BRD-12`, `Q7`, project keys, milestone
  names. Keys and question ids are accepted in any case and printed in upper
  case. No command takes or prints a row id.
- **Answers name their project** at the top level (`status --json`'s
  `project`, `ls --json`'s `project`, …); `Event` carries `project`. A task
  key's prefix is its project's key, so task, claim and question shapes need
  no field of their own.
- **Status** in every answer and every filter is the effective status
  (`blocked` derived, an expired claim read as no claim).
- **Every write answers with `events`**, every id it appended, so an agent
  can pass the last one as `--since` next time.
- **Handing work on is `board handover`** with `--to`. A handover is an
  event and nothing more: it moves no claim, changes no status, and nothing
  in any comment's text is read as an instruction. Closing a task is `board
  edit --status done`: a lead reports, `main` decides. Projects are added,
  edited and removed by the person: adding one is the choice of a key, and
  `board skill` tells agents never to run `project` writes.

### Commands

Flat verbs for tasks and questions, groups for projects and milestones. No
existing command is renamed; the task and question writes join `ls`, `show`,
`next`, `status`, `questions`, `answer` and `validate` at the top level.

```
board project add KEY --actor NAME [--name NAME] [--dir DIR] [--json]
board project ls [--json]
board project edit KEY --actor NAME [--name NAME] [--dir DIR] [--json]
board project rm KEY --actor NAME [--json]

board status [-p KEY] [--json]
board ls [-p KEY | --all] [--status S,…] [--milestone NAME|none] [--parent KEY]
         [--ready] [--contains TEXT] [--limit N] [--offset N] [--json]
board show KEY [--since ID] [--json]
board next [-p KEY] [--milestone NAME] [--json]

board add --actor NAME --title TEXT [--body TEXT] [--priority P]
          [--status backlog|ready] [--parent KEY] [--milestone NAME|none]
          [--waits KEY,…] [-p KEY] [--json]
board edit KEY --actor NAME [--title TEXT] [--body TEXT | --no-body]
           [--priority P] [--status backlog|ready|done|cancelled]
           [--parent KEY | --no-parent] [--milestone NAME|none]
           [--waits-add KEY,…] [--waits-remove KEY,…] [--json]
board claim KEY --actor NAME --minutes N [--holder NAME]
            [--directory DIR] [--branch BRANCH] [--json]
board extend KEY --actor NAME --holder NAME --minutes N [--json]
board release KEY --actor NAME --holder NAME [--note TEXT] [--json]
board comment KEY --actor NAME --text TEXT [--json]
board handover KEY --actor NAME --to NAME --text TEXT --changed TEXT
               --ran TEXT --unchecked TEXT [--json]

board ask KEY --actor NAME --text TEXT --recommended N
          --option-1 LABEL [--detail-1 TEXT] --option-2 LABEL [--detail-2 TEXT]
          [--option-3 LABEL [--detail-3 TEXT]] … [--option-6 LABEL [--detail-6 TEXT]]
          [--json]
board questions [-p KEY | --all] [--state open|to_validate|answered|withdrawn|all]
                [--task KEY] [--json]
board answer QID [N] [--text TEXT] --as owner|delegate --actor NAME [--json]
board validate QID --actor NAME [--json]

board milestone [ls] [-p KEY] [--json]
board milestone add NAME --actor NAME --delivers TEXT [--before NAME | --after NAME]
                    [-p KEY] [--json]
board milestone edit NAME --actor NAME [--name NEW] [--delivers TEXT]
                     [--before NAME | --after NAME] [-p KEY] [--json]
board milestone rm NAME --actor NAME [-p KEY] [--json]

board watch [-f|--follow] [--since ID] [-p|--project KEY,…] [--kind K,…] [--task KEY,…]
            [--json] [--expiring-within MINUTES] [--exec CMD] [--exec-timeout SECONDS]
board sql QUERY [-p KEY] [--json]
board skill
board upgrade [--version VERSION] [-f] [-v] | -l
board help [COMMAND]
board COMMAND [SUBCOMMAND] --help
```

| Operation | Command | Kind |
| --- | --- | --- |
| a project's state | `board status` | read |
| list tasks | `board ls` | read |
| one task and its events | `board show` | read |
| the next task | `board next` | read |
| list questions | `board questions` | read |
| add a task | `board add` | write |
| change a task | `board edit` | write |
| the lease | `board claim` / `extend` / `release` | write |
| a note | `board comment` | write |
| a handover | `board handover` | write |
| ask the owner | `board ask` | write |
| answer, validate | `board answer` / `validate` | write |
| the chain | `board milestone add` / `edit` / `rm` | write |
| projects (the person's) | `board project add` / `edit` / `rm` | write |

- **Short flags** are only those that exist: `-p` (project), `-f` (watch
  `--follow`), and upgrade's `-f`, `-v`, `-l`. An agent writes the long form,
  and a log of `board claim BRD-14 --minutes 90 --actor @lead` reads without
  a legend.
- **`-p` is declared per command**, offered only where a project applies
  (`status`, `ls`, `next`, `add`, `questions`, `milestone …`, `sql`,
  `watch`). Commands that take a task key or a question id take no `-p`: the
  key names the project, so `show`, `edit`, `claim`, `answer` and the rest
  work from any directory. `--all` (on `ls` and `questions`) spans every
  project and conflicts with `-p`.
- `board help [COMMAND]` is cliffy's `HelpCommand`, mounted `.global()`; it
  reaches one level, so a subcommand's help is `board project help add` or
  `board project add --help`. A bare `board` or `board project` prints its
  help and exits 0. The help is coloured only when stdout is a terminal
  (`help({colors: process.stdout.isTTY === true})`).
- Tables are `@cliffy/table`'s, without borders. It counts terminal cells,
  so wide characters align, and a newline in a cell continues in its column.

### Inputs

Every operation's input is a flag or a positional, checked at parse. The
lengths and ranges are those Appendix B's input schemas had; each is now a
cliffy `Type` or a `value` hook (code points, as `lengthIn` counts them):

| Command | Flag | Check |
| --- | --- | --- |
| every write | `--actor NAME` | required; 1–64 |
| `add`, `edit` | `--title` | 1–200 (required on `add`); whitespace only is the rules' `invalid_argument` |
| `add`, `edit` | `--body` | 0–20,000; absent on `add` is `""`; `--no-body` on `edit` empties it |
| `add`, `edit` | `--priority` | `urgent`, `high`, `normal`, `low` |
| `add` / `edit` | `--status` | `backlog`, `ready` / also `done`, `cancelled` |
| `add`, `edit` | `--parent KEY`; `--no-parent` on `edit` | key type; `--no-parent` clears it (cliffy's negatable option; both together is "can only occur once") |
| `add`, `edit`, `ls` | `--milestone NAME\|none` | milestone type; `none`, any case, is no milestone |
| `add` / `edit` | `--waits` / `--waits-add`, `--waits-remove` | key lists, at most 50 each; duplicates folded by the rules |
| `edit` | — | no field flag given is a usage error naming them all (`minProperties` before) |
| `claim`, `extend` | `--minutes N` | required; integer 1–1440; a flag, not a second positional, because the lease's size is chosen on purpose (decision 4) |
| `claim` | `--holder` | optional, defaults to the actor |
| `extend`, `release` | `--holder` | required: the holder the caller saw |
| `claim` | `--directory`, `--branch` | 1–1,024, 1–255; stored as given; no default from the cwd or git (main claims for a lead from main's own checkout) |
| `release` | `--note` | 1–500 |
| `comment` | `--text` | required; 1–10,000 |
| `handover` | `--to`, `--text`, `--changed`, `--ran`, `--unchecked` | all required; `--to` 1–64, `--text` 1–10,000, the other three 1–4,000 |
| `ask` | `--text` | required; 1–2,000 |
| `ask` | `--option-1` … `--option-6`, `--detail-1` … `--detail-6` | 1 and 2 required; `--option-N` depends on `--option-(N−1)`; `--detail-N` on `--option-N`; labels 1–80, details 1–500 |
| `ask` | `--recommended N` | required; 1–6; past the given options is `invalid_argument` |
| `answer` | `N`, `--text` | `N` 1–6, `--text` 1–2,000; at least one (an action check, 64) |
| `answer` | `--as owner\|delegate` | required, no default (decision 14) |
| `milestone add`, `edit` | `--delivers` | 1–500, required on `add`; `--before` conflicts with `--after`; `edit` needs something to change |
| `ls` | `--contains` | 1–200; empty means no filter (decision 27) |
| `ls`, `show` | `--limit`, `--offset`, `--since` | 1–200, ≥ 0, ≥ 0 |

Question options are **numbered flags** because every other shape failed a
probe: cliffy's two-argument option (`--option <label> [detail]`) mixed
shapes, refused a detail starting with `-` and crashed on an empty one;
repeated `--option` and `--detail` paired by order cannot say "no detail";
a delimiter inside one argument or JSON in a flag would be a parser of ours.
Numbered flags put every check in cliffy, and `--option-2 Unbounded
--detail-2 'No cap'` cannot be paired wrong.

`kind` of a comment is the command: `comment` has `--text` only, so a note
with `--to` is "Unknown option"; `handover` marks its five flags `required`.
Both call `board.taskComment` with `kind` set.

### The actor

**`--actor NAME` is required on every write**, with no environment variable
and no default (owner, decision 1). A missing `--actor` is cliffy's
`required: true`: `board: usage: Missing required option "--actor".`, exit
64, nothing opened. The name is trusted and recorded as given; `board` is
reserved and refused by the rules (`invalid_argument`, `field: actor`).
`project add`, `edit` and `rm` take it like every write, so `project_added`
records whoever ran it. The person writes as `owner` by typing `--actor
owner` (or keeps a shell alias). `--as` on `board answer` is required too:
the actor is who typed the answer, `--as` is whose decision it is.

No variable, because every agent of a chord inherits chord's one
environment (team files and settings cannot set a per-agent variable), so a
`BOARD_ACTOR` in the person's profile would make every agent that forgets the
flag write as the owner; and an agent's shell keeps no export between calls.
`BOARD_ACTOR` and `BOARD_PROJECT` stay the names `watch --exec` sets for the
event's actor and project; board reads neither.

### Long text

**Every text is a flag value; board reads no stdin and no files** (owner).
One line without a `'` goes in single quotes; anything else in a quoted
heredoc inside a command substitution, where nothing is expanded:

```sh
board comment BRD-14 --actor @lead --text "$(cat <<'EOF'
Anything goes here: 'quotes', "quotes", $HOME, `ticks`, \backslashes.
EOF
)"
```

- The shell is the library: cliffy takes the value as is (a value with
  newlines, one starting with `-`, `--text=-x` all arrive unchanged). Agents
  already write `git commit -m "$(cat <<'EOF' …)"`.
- **Sizes hold.** macOS's `ARG_MAX` is 1 MiB for the arguments and the
  environment together, with no per-argument limit; the largest input, a
  handover, is at most 88 KB (4 bytes a code point). A 1,000,000-byte
  argument reached cliffy whole through the binary (measured).
- **No command can hang on input**: stdin is never read, so a TTY, a pty,
  `/dev/null` or a closed stdin change nothing.
- An empty value (`--text ''`) is dropped by cliffy (decision 27): a
  required flag is then missing (64); `--body ''` on `edit` changes nothing,
  which is why `--no-body` exists.
- **Two limits the CLI adds**, stated in `board skill`: **no NUL** in any
  text (an argument cannot hold one, though JSON could), and **no trailing
  newline** through `"$(…)"`, which strips every one.

Turned down: `--body-file` / `--text-file` with `-` for stdin (a second path
per field, stdin's lifecycle, a TTY check; `Bun.stdin.text()` and
`get-stdin` 10.0.0 tried); a whole input object as JSON on stdin (Ajv in the
binary, a second contract beside the flags); curl's `@file` (a text starting
with `@` would be read as a path).

### Output

- **stdout carries the answer; stderr carries notes and errors.** A write's
  one line is its answer and goes to stdout (`added BRD-17 …`, `Q7 asked
  …`); counts and hints (`12 tasks in BRD; next page: --offset 50`) go to
  stderr.
- **`--json` on a board operation** (`status`, `ls`, `show`, `next`,
  `questions`, every task, question, milestone and project write, `project
  ls`) prints **one JSON object** on stdout, on one line, and nothing else
  on stdout. Its shape is Appendix B's output schema for that command.
  `answer`, `validate`, `milestone add/edit/rm` and `project rm` gain
  `--json` (the removed `Project` for `project rm`).
- **The exceptions, as built:** `milestone [ls] --json` prints a
  `Milestone[]` array; `sql --json` an array of row objects; `watch --json`
  one object per line, as a stream; `skill`, `help` and `upgrade` take no
  `--json`.
- **Human form**: one line for a write (the text line of Appendix B); a
  borderless table for a list (`ls`, `questions`, `milestone ls`, `project
  ls`, `sql`); `status` and `show` as below; `next` a one-row table and the
  reason on stderr. Control characters are shown, not sent (decision 28), in
  human output only.
- **Paging.** `ls --limit N --offset N`: `--json` has `total` and
  `next_offset`; the note ends `; next page: --offset 50`. `show KEY --since
  ID`: at most 200 events, oldest first; `--json` has `cursor` and `more`.
  `board watch --task KEY --json [--since ID]` prints a task's whole log
  without paging.

```
$ board project add BRD --actor owner --dir ~/src/board
BRD  board  /Users/me/src/board
keys BRD-1, BRD-2, …; agents started under /Users/me/src/board use it

$ board project ls
   KEY  NAME   OPEN  CLOSED  CURRENT MILESTONE  DIRECTORY
*  BRD  board  4     11      v1 (2 of 5)        /Users/me/src/board
   APP  app    12    40      -                  /Users/me/src/app

$ board status
project           BRD  board  /Users/me/src/board
milestone 2 of 5  v1  The tools and the CLI.  3 tasks left (5 done, 1 cancelled of 9)
tasks             2 ready, 1 active, 1 blocked, 4 backlog, 11 done, 1 cancelled
questions         1 open, 2 to validate

claims
KEY     HOLDER  UNTIL                     LEFT    DIRECTORY             BRANCH
BRD-12  @lead   2026-10-12T16:00:00.000Z  in 47m  /Users/me/src/brd-wt  feat/claims

$ board claim BRD-14 --actor main --holder @lead --minutes 90 --directory /work/brd-wt --branch feat/watch
BRD-14 claimed by @lead until 2026-10-12T15:33:00.000Z (90 min)
```

`project ls` marks with `*` the project the working directory resolves to.
`project add` refuses a `--dir` that is inside a git checkout but is not its
main root, and names the root. Its `--json` prints the `Project`; `project ls --json`
prints `{projects: [{project, open, closed, current}], here}`.

### Errors

| Exit | What | stdout | stderr |
| --- | --- | --- | --- |
| 0 | done | the answer | notes |
| 1 | refused by board: one of the 17 codes, or `registry` | nothing | `board: <code>: <message> <next>`, or under `--json` the error object |
| 64 | usage: the command line does not fit the command (cliffy's `ValidationError`, or an action's shape check) | nothing | `board: usage: <cliffy's message>` |
| 130 / 143 | ended by `SIGINT` / `SIGTERM` (any command; the shim re-raises its child's signal) | — | — |
| 141 | stdout closed by its reader ("Runtime") | — | nothing from board but notes already written |

```
$ board claim BRD-14 --actor @dev --minutes 60
board: claim_held: BRD-14 is held by @lead until 2026-10-12T15:33:00.000Z. Wait for it, or `board extend` it if the claim is yours.
$ board claim BRD-14 --actor @dev
board: usage: Missing required option "--minutes".
```

- **One exit code for every refusal**, the code in a fixed place in the
  line (`board: <code>:`) and in the JSON. An exit code per class (sysexits)
  was turned down: most codes have no slot, and an agent would learn a
  table that lives only in the docs.
- **Under `--json`** a refusal is Appendix B's error object on stderr, one
  line; stdout is empty.
- **What a refusal promises.** The change asked for was not made. A write
  refused after its lock still commits the machine-wide expiry sweep
  (decision 5), so `claim_expired` lines of other claims may have been
  logged. `internal` promises less: the failure may come after the commit
  (writing the answer, closing), so it says read before retrying.
- **Usage errors are never JSON**, even with `--json`: cliffy fails before
  the options are known, and finding `--json` in the raw argv would be
  parsing of ours. They come before the board is opened: nothing was read or
  written. No `usage` code is added to the error enum. cliffy names the flag
  for missing, unknown, conflicting, depending and repeated options and for
  type and `value` failures. They take the place of the MCP SDK's `Input
  validation error` (decision 13).
- **The exceptions, as built:** `board sql` prints SQLite's own message
  with exit 1 when a query fails, and refuses a write with exit 64 *after*
  opening the board read-only (decision 16; `VACUUM INTO` leaves its empty
  file). `board upgrade` keeps cliffy's exits (decision 36); `registry` is
  its one code. A write ended by 130 / 143 may or may not have committed.
- **`details.field` is the flag as typed**: a flag's long name without
  dashes (`waits-add`, `holder`, `dir`), a positional's synopsis name in
  upper case (`KEY`, `N`). It differs from the old input name in four
  places: `waits_add` / `waits_remove` → `waits-add` / `waits-remove`;
  `directory` → `dir` for `project add/edit` (`claim`'s stays `directory`,
  its flag being `--directory`); `key` → `KEY` for `project_exists`;
  `choice` → `N` for `answer`. Messages quote the same spelling with dashes.
  `Board`'s TypeScript inputs and event `data` keep their snake-case names.
- **`next` names commands**: every `next` that named a tool names the
  command (`board extend`, `board show KEY`, `board edit KEY --status ready`,
  `board edit KEY --milestone none`, `board questions --state to_validate`,
  `Pass -p KEY`, `Pass --actor with your own name`), and `board sql`'s write
  refusal names `board edit`, `board claim`, `board answer`. A test fails on
  any `next` containing `task_`, `question_`, `milestone_` or
  `board_status`.

### `board skill`

`board skill` prints the agent's guide on stdout and exits 0. It takes no
argument and no `--json`, stores nothing, and opens no board, so it works
before `board project add` and with a `BOARD_DIR` that does not exist. A
person puts its output into a team's instructions, or tells the team to run
it first. No role argument: every role needs the model and the errors, and
a lead sometimes acts as main.

It has two parts, as `../quarry/src/guide.ts` splits its own:

1. **Prose, typed** (`src/skill.ts`): the model, the flows for main, a lead
   and a member, quoting, the notifier, recovery, and what to do per error
   code.
2. **The command index, generated** from the cliffy tree (`getCommands()`
   walked from `buildCli`'s root): one line per leaf command with the
   description its `Command` carries, so a description corrected in
   `src/cli/` is corrected here. `help`, `upgrade` and `skill` are left out.

Tests keep it in step:

- **Every command line in the prose parses**: each fenced block runs under
  `/bin/sh -c` with `board` defined as a shell function that prints its
  argv NUL-separated, and each call's words are parsed against a tree whose
  actions are no-ops; a line that fails parse fails the test (command
  names, flags, required flags and types at once). The shell splits, as it
  does for an agent: `shell-quote` 1.8.4 and `string-argv` 0.3.2 were tried
  and neither fits the prose's comments, `2>&1`, backslash continuations
  and heredocs.
- **Every error code has a row** in the prose's table: the enum of
  `src/schemas.ts` against the table's first column.
- **The flows run**: each flow's lines, in order, through `runCli` against a
  fresh temp board, keys and ids taken from the previous answers' `--json`,
  each expected to exit as the text says. If substituting proves heavier
  than the flows, the scenario tests and the prose share their command lines
  through one constant instead.

The text, with the index as the generator prints it:

````markdown
# Working on a board

board is the task board your team shares. It is one SQLite file on this
machine with every project's tasks in it, and you read and write it by running
`board` in your shell. It is memory and rules, not an engine: nothing runs
because of the board. `main`, the session in front of the person, decides
what happens next; leads and members do the work and write down what they did.

## The model in a paragraph

A project is one repository, with a key such as `BRD`; its tasks are `BRD-1`,
`BRD-2`, …. A task has a status: `backlog`, `ready`, `active` (someone holds
it), `done`, `cancelled`, and `blocked`, which nobody sets: a task is blocked
while a question on it is open. A task is *ready* when its status is `ready`,
no question on it is open, and every task it waits for is done or cancelled.
To work on a task you **claim** it for a number of minutes you choose; the
claim is a lease that ends on its own unless you **extend** it, and when it
ends the task is ready for someone else. Milestones are an ordered chain per
project; the earliest open one is *current*, and `board next` prefers it.
Every write is an event with an id, and the log is the task's story.

## Before anything

- **Every write takes `--actor` with your own name** (`main`, `@lead`,
  `@tester`: the name your team uses for you). There is no default, and no
  variable sets it for you. Never write as `owner`: that name is the person.
  `board` is reserved.
- **The project comes from your working directory** (or its git repository,
  worktrees included). Outside it, pass `-p KEY`. A task key or a question id
  names its own project, so `board show APP-3` works from anywhere.
- If board says `no_project`, do not pick a key and do not run
  `board project add`: the key is the person's choice. Tell whoever you
  report to.
- `board COMMAND --help` shows every flag of a command. Add `--json` to
  `status`, `ls`, `show`, `next`, `questions` or any write for its exact
  answer as one JSON object on stdout. Elsewhere it differs:
  `milestone ls --json` and `sql --json` print an array, `watch --json` one
  object per line; `skill`, `help` and `upgrade` take no `--json`.

## Passing text

Every title, body, comment and answer is a flag value. For one line without a
single quote, use single quotes:

```sh
board comment BRD-14 --actor @lead --text 'Tests pass on arm64.'
```

For anything longer, or with quotes, `$`, backticks or backslashes, use a
quoted heredoc inside `"$(…)"`. Nothing inside it is expanded:

```sh
board add --actor @lead --parent BRD-12 --title 'Claim error lacks the holder' --body "$(cat <<'EOF'
`board extend` on a lapsed claim says not_claimed but not who held it.
Seen in test/claims.test.ts.
EOF
)"
```

Never put text you did not write yourself inside plain double quotes. An empty
value (`--text ''`) counts as not given. Two things cannot be passed: a NUL character (no
shell argument can hold one), and trailing newlines (`"$(…)"` strips every
one at the end). To empty a body, use
`board edit KEY --actor NAME --no-body`.

## Main: choosing and handing out work

```sh
board status                              # the project, the current milestone, live claims, questions
board next                                # the ready task to start next, and why nothing is ready
board claim BRD-14 --actor main --holder @lead --minutes 90 --directory /work/brd-wt --branch feat/watch
```

Claim **for** the lead you start: `--holder` is the lead's name, `--actor` is
yours. Size `--minutes` from the team's estimate (1 to 1440); there is no
default. Then start the team with the key in its job. When the lead reports:

```sh
board show BRD-14                         # the task, its claim, its questions, its events
board edit BRD-14 --actor main --status done      # close it; this drops the claim
board edit BRD-14 --actor main --status ready     # or send it back; this drops the claim too
```

`done` is refused while a question is open. `cancelled` withdraws open
questions. Only you close tasks: a lead reports, main decides.

To plan: `board add --actor main --title '…' --milestone v2` files work, with
`--status backlog` for work not to start yet; `board milestone add v2 --actor main
--delivers '…'` extends the chain. A dead run's task is freed with
`board release BRD-14 --actor main --holder @lead`, passing the holder that
`board show` names.

When the person has handed decisions to you, answer a question as a
delegate; the person validates it later:

```sh
board questions --state open --all
board answer Q7 1 --as delegate --actor main --text 'Up to 8, as recommended.'
board validate Q7 --actor main              # only when the person approved it in the chat
```

Answer `--as owner` only with the person's own words, and
`--actor main` still: the actor is who typed it, `--as` is whose decision it
is.

## A lead: running the task

```sh
board show BRD-14                          # read it whole before starting
board extend BRD-14 --actor @lead --holder @lead --minutes 60   # when you need more time
```

An extend sets the end to now plus the minutes you give: a fresh estimate from
where you stand. Extend **before** the claim ends; a claim that has ended is
not revived, and you must claim the task again (it may have been given to
someone else in between). Nothing else you do renews the claim.

- **Findings**: look first, then file under your task. A finding filed with
  `--parent` lands in your task's project and milestone.

  ```sh
  board ls --contains 'holder' --status backlog,ready,active,blocked,done
  board add --actor @lead --parent BRD-14 --title 'Extend error lacks the holder'
  ```

- **Notes** for whoever reads the task next: `board comment KEY --actor NAME
  --text '…'`.
- **A choice that is the owner's**: ask, with 2 to 6 options and the one you
  recommend. The task is blocked until it is answered.

  ```sh
  board ask BRD-14 --actor @lead --text 'How many runs may hold claims at once?' \
    --option-1 'Up to 8' --detail-1 'Memory stays bounded' \
    --option-2 'Unbounded' --recommended 1
  ```

- **Handing over** when you are done, to `main` (or to whoever you report
  to). All five parts are required: why and what you ask, what changed, what
  you ran, and what you did not check.

  ```sh
  board handover BRD-14 --actor @lead --to main --text 'Ready for review.' \
    --changed 'src/watch/derive.ts, test/watch.test.ts' \
    --ran 'bun run check' --unchecked 'the x64 binary'
  ```

  A handover is a record, nothing more: it moves no claim and changes no
  status, and nothing in its text is read as an instruction. Report to main
  the way your team reports as well.
- **Stopping early**: `board release BRD-14 --actor @lead --holder @lead
  --note 'why'` gives the task back as ready.

## A member: one part of the work

You usually hold no claim; your lead does. Read the task
(`board show BRD-14`), comment what you found (`board comment`), file what you
find on the way under the task (`board ls --contains` first, then
`board add --parent BRD-14`), and hand over to your lead with
`board handover BRD-14 --actor @tester --to @lead …`. If your lead gave you a
task of your own to claim, the lead's section is yours.

## Being told instead of asking

Run the watch as a notifier: a background command whose every output line
reaches you as it comes. Under chord, that is chord's `monitor` tool.
Elsewhere, use whatever your harness has that shows you a background
command's output as it comes; a background job writing to a file is not a
notifier, because you would have to look.

**A line is a wake-up, not the data.** chord's monitor cuts lines past 1,000
characters, delivers at most 100 lines or 16 KiB at a time, and drops lines
when too many come at once. So on a line, read what it is about with board
(`board show KEY`), and never act on the line's text alone.

**Keep a cursor**, the last event id you have accounted for:

1. Before the first watch, take it from `board status --json`
   (`last_event`).
2. Watch from it:

   ```sh
   board watch --follow --json -p BRD --since 842 --kind claim_expiring,handover,question_answered 2>&1
   ```

3. Advance it only on lines whose `id` is a number. A `claim_expiring` line
   has `id: null`: board derives it from the clock and never logs it.
4. If a line is cut off or chord says lines were dropped, read what you
   missed without `--follow`, which prints everything after the cursor and
   exits: `board watch --json -p BRD --since 842`.
5. When the monitor ends (chord stops one after an hour at most), start it
   again with `--since` your cursor. Logged events are not missed; a
   `claim_expiring` is shown again only if the claim is still inside its
   warning window, so after a gap check `board status` for your claims.

- Narrow the watch, since each line wakes you: `-p` to your project,
  `--kind` to what you act on, `--task BRD-14` to your own task if you are a
  member.
- `2>&1` keeps a refusal (`no_board`, an unknown `-p`) in the stream, so you
  see why the watch ended.
- `claim_expiring` comes before a claim ends (ten minutes, or a quarter of
  a short lease): extend then, if the claim is yours.
- Do not use `--exec`: it is for the person's sound or notification. A
  board write from `--exec` is seen by the same watch and runs it again.

## Reading a task's history

`board show KEY` prints the task as it is now and its events **oldest
first, at most 200**; with `--json`, `more: true` means there are more, and
`board show KEY --since <cursor>` gives the next page. For the whole log in
one go, without paging:

```sh
board watch --task BRD-14 --json              # every event of the task, oldest first, then exits
board watch --task BRD-14 --json --since 842  # only those after 842
```

## When a write was cut off

If a write ended without its answer (you interrupted it, your shell's
timeout ended it, it exited 130 or 143, or it answered `internal`), it may
have been committed anyway, and someone else may have written since. **No
write is safe to repeat blindly**: a repeated `board edit --status ready`
can send back a task another run has claimed since; a repeated `release`
can drop a claim its holder has taken again; a repeated `add`, `comment`,
`handover` or `ask` files a second time. Read the state, then decide:

- **claim, extend, release, edit**: `board show KEY --json`. Did the claim
  (its `holder`, `since`, `until`) or the fields become what you asked? Then
  it happened. If they are something else, someone else acted: work from
  what is there now, not from your old command.
- **comment, handover, ask**: `board watch --task KEY --json --since <the
  last id you saw before>` lists what was logged on the task since; look for
  your own `comment`, `handover` or `question_asked`.
- **add**: search every status and every page, since `ls` shows only open
  tasks by default:

  ```sh
  board ls --json --contains '<words of the title>' --status backlog,ready,active,blocked,done,cancelled
  ```

  and while `next_offset` is not null, again with `--offset <next_offset>`.
  Add `--parent KEY` if you filed it under a parent.

Repeat only what is not there.

## When board refuses

A refusal exits 1 and prints `board: CODE: what is wrong. What to do.` on
stderr (with `--json`, `{"error": {"code", "message", "next", "details"}}`).
Act on the code, and read `next`. The change you asked for was not made
(a refused write may still have logged other claims' expiry, which is not
yours to undo).

A command line that does not fit the command exits 64 with
`board: usage: …`; board did not open the board: fix the flags
(`board COMMAND --help`) and run it again.

Two commands answer differently. `board sql` prints SQLite's own message
with exit 1 when a query fails, and refuses a write with exit 64. `board
upgrade` uses its own messages and exit codes.

| Code | What to do |
| --- | --- |
| `not_found` | The key, question, milestone or project does not exist. Check it; `board ls --contains`, `board questions`, `board milestone ls` find things. |
| `claim_held` | The task has a live claim (`details.claim` says whose and until when). Compare `details.claim.holder` with the `--holder` you meant, not with your `--actor` (main claims for a lead). The same: the claim is already there (a claim run twice, or one cut off and retried); `board extend` it if more time is needed, do not claim again. Another: do not take it. On extend or release: re-read with `board show KEY` and pass the holder it names, if acting on that claim is still right. |
| `not_claimed` | No live claim: it ended or was released. `board claim` it again if it is still yours to do. |
| `not_ready` | The task is not ready: `details.reason` is `status`, `question` or `waits`. `board show` lists what blocks it. |
| `invalid_transition` | That status, question or milestone change is not allowed from here; `details.allowed` lists what is. |
| `already_answered` | The question has an answer. Only the owner's answer replaces a delegate's unvalidated one. |
| `cycle` | That wait or parent would close a loop; `details.path` is the loop. |
| `invalid_argument` | A value the rules refuse; `details.field` names the flag you typed (`waits-add` is `--waits-add`; an upper-case name such as `KEY` or `N` is a positional argument). Change it. |
| `no_project` | Your directory is in no project. Pass `-p KEY` with a listed key, or tell whoever you report to; never add a project yourself. |
| `project_exists` | That project key or directory is taken. This is the person's command; report it. |
| `busy` | Another write held the board for 5 s. Your change was not made; run the same command again. |
| `storage` | Disk full or an I/O error. Your change was not made; report it. |
| `no_board` | There is no board file yet, or `BOARD_DIR` is wrong. Report it; the person creates the board with `board project add`. |
| `damaged` | The board file is damaged. Stop and report it; do not try to repair it. |
| `not_a_board` | The file is not a board. Stop and report it. |
| `schema_mismatch` | The board was made by another build of board (an upgrade can do this): every command answers this until the person moves the file aside. Stop and report it; never move the file yourself. |
| `internal` | A bug in board. It may have failed after your change was made: read before you retry ("When a write was cut off"), and report it with the command you ran. |
| `registry` | Only `board upgrade`: the npm registry could not be read. Not yours to fix. |

## Commands

  board status               One project's state: milestones, claims, questions.
  board ls                   List tasks, newest first, by status, milestone, parent, readiness or text.
  board show                 One task whole, and its events.
  board next                 The task to start next in a project, and why nothing is ready.
  board add                  Add a task, or a finding under a parent.
  board edit                 Change a task: title, body, priority, status, parent, milestone, waits.
  board claim                Claim a ready task for a number of minutes.
  board extend               Set a live claim's end to now plus minutes.
  board release              Drop a live claim; the task is ready again.
  board comment              A note on a task.
  board handover             Hand work on: to, why, what changed, what ran, what is unchecked.
  board ask                  Ask the owner a question with 2 to 6 options and a recommendation.
  board questions            List questions by state.
  board answer               Answer a question, as the owner or as a delegate.
  board validate             Mark a delegate's answer as approved by the owner.
  board milestone ls         The milestone chain, in order.
  board milestone add        Add a milestone.
  board milestone edit       Rename, re-describe or move a milestone.
  board milestone rm         Delete a milestone with no tasks.
  board project ls           Every project on this machine.
  board project add          Add a project (the person's command).
  board project edit         Change a project's name or directory (the person's command).
  board project rm           Remove a project with no tasks (the person's command).
  board watch                Print the event log; --follow to keep printing.
  board sql                  Run one read-only SQL statement against the board.

`board help COMMAND` or `board COMMAND --help` says one command in full.
````

### `board watch`

Modelled on `quarry watch`. It prints the machine's event log, one line per
event, oldest first.

- **Filters.** `-p, --project`, `--kind` and `--task`, each repeatable and
  comma-separated; they intersect. `--kind` takes the catalog plus
  `claim_expiring`, so a misspelt kind is a usage error that lists the kinds.
  Each `-p` key becomes its project's id once, at attach; an unknown key is
  `not_found` before attaching.
- **Where it starts.** Without `--follow`, from the beginning: `board watch
  --task BRD-4` is that task's whole log. With `--follow`, from now.
  `--since ID` starts after ID in either mode; ids are machine-wide.
- **The human line**, tab-separated: time, `#id` (`-` on a derived line),
  project (`-` when none), task, actor, kind, a summary written from `data`.

  ```
  2026-10-12T14:03:00.000Z  #436  BRD  BRD-14  main   claimed          @lead for 90 min, until 2026-10-12T15:33:00.000Z, feat/watch
  2026-10-12T14:05:00.000Z  #437  APP  -       owner  milestone_added  v2 at 3 of 3
  2026-10-12T15:23:00.000Z  -     BRD  BRD-14  board  claim_expiring   @lead's claim ends at 2026-10-12T15:33:00.000Z (in 10m)
  ```

- **`--json`**: one object per line, flushed per line, with one flat shape for
  logged and derived lines: `{id, derived, at, actor, kind, project, task,
  milestone, data}`. A derived line has `id: null`, `derived: true` and actor
  `board`, so a consumer that tracks the last id it saw never advances onto
  it. There is no heartbeat.
- **`claim_expiring`**, the one derived kind, `data: {holder, until,
  minutes_left}`, for the watched projects' claims. It is shown only under
  `--follow`, once per lease per watcher, when `until − threshold <= now <
  until`, and on attach for claims already inside their window. The
  threshold is `min(10 minutes, a quarter of the lease)` by default: a fixed
  10 minutes would fire at once on a short lease, and a share alone would warn
  half an hour ahead of a long one. `--expiring-within MINUTES` fixes it. An
  extend sets a new deadline, which can warn again. The line is never written
  to the log, and each watcher derives its own, as quarry's `no_daemon` is
  noticed.
- **A narrowed project removed.** `project_removed` has no project, so a
  narrowed watcher matches it on `data.key`: it prints the line and stops
  watching that key, and exits 0 when no `-p` key is left. A project added
  again under the key is a new project and needs a new `watch`. An
  unnarrowed watch prints the line and goes on.
- **`--exec CMD`** needs `--follow`. For every line, in stream order, one at a
  time, `CMD` runs through `sh -c` with the line's JSON on stdin and
  `BOARD_EVENT_ID` (empty on a derived line), `BOARD_EVENT_KIND`,
  `BOARD_EVENT_AT`, `BOARD_PROJECT`, `BOARD_TASK`, `BOARD_ACTOR`,
  `BOARD_SUMMARY` in the environment (empty where there is nothing). Its
  output goes to the watcher's stderr, never into the stream. Nothing is
  dropped: while a command runs the watcher does not read, and the events wait
  in the database. Past `--exec-timeout SECONDS` (default 30; the one duration
  in seconds, because a notifier is measured in seconds) the child gets
  `SIGTERM`, then `SIGKILL` 2 s later. A failing command is one line on
  stderr, and the stream goes on. The cursor advances either way. A
  `claim_expiring` whose whole window falls inside one running command is
  missed: the derived line is best effort, the logged lines are not.
- A missing board is `no_board`, exit 1; `--follow` does not wait for the file
  to appear.

**How it notices changes without a daemon.** One read-only connection polls
`PRAGMA data_version` every 500 ms (about 6 µs a poll). It changes when
another connection commits, in any project, and it works on a read-only
connection. The order is exact, because a commit can land between any two
steps:

- *On attach:* read `data_version` and keep it; set the cursor (`--since`, or
  `max(event.id)`); read the live claims; print the attach `claim_expiring`
  lines.
- *Every tick:* read `data_version`. If it changed, keep the new value
  **before** draining `SELECT … FROM event WHERE id > :cursor AND (project_id
  IN (:ids) OR kind = 'project_removed') ORDER BY id LIMIT 500` (without the
  project condition when not narrowed) until a short page, printing the rows
  that pass the filters and moving the cursor past every row read, printed or
  not. Then re-read the live claims. Finally, on every tick, derive
  `claim_expiring` against `now`.

Keeping `data_version` before the drain means a commit that lands during the
drain is read on the next tick rather than lost. Moving the cursor over
filtered-out rows keeps a narrowed watcher from re-reading another project's
burst. No read transaction is held between polls, so WAL checkpoints are never
starved. File watching was tried and rejected: it reports `-wal` churn, not
commits, and the watcher needs a timer anyway for `claim_expiring`.

### `board sql`

Modelled on `quarry sql`, without its statement scanner. `board sql QUERY
[-p KEY] [--json]` runs one statement against the stored schema (keys are not
stored, `blocked` is not a status, an expired claim is a row until a write
sweeps it) and prints a table (`NULL` for null, blobs as hex, the row count on
stderr) or a JSON array of row objects. Without `-p` it sees every project,
and it never resolves a project from the cwd.

```
board sql -p BRD "SELECT number, title FROM task WHERE status = 'ready'"
board sql "SELECT p.key || '-' || t.number AS key, t.title FROM task t JOIN project p ON p.id = t.project_id WHERE t.status = 'ready' ORDER BY t.id DESC"
```

**The boundary is SQLite's own judgement**, with no parser of ours. The
query runs on a throwaway `bun:sqlite` connection opened `{ readonly: true }`.
After the `-p` views (below) are created, board sets `PRAGMA query_only = 1`,
then prepares the user's text; a statement with parameters (`paramsCount >
0`) is a usage error. Each guard closes a hole the other leaves: the read-only
open alone lets `VACUUM INTO` write a full copy of the board to a new file,
and `query_only` is what refuses it. `bun:sqlite` exposes neither
`sqlite3_stmt_readonly` nor the prepared statement's tail (nor does
`node:sqlite` under Bun), so, measured over 21 statements, every write tried
is refused, with **three losses** (owner, decision 16), each written into
`board help sql`:

1. **A write is refused when it runs, not before.** SQLite still judges, and
   nothing is written to the board; board learns of it from the error. An
   `SQLITE_READONLY` is the refusal below, exit 64. Anything else is
   SQLite's own message, exit 1: a write on a `-p` view ("cannot modify
   task because it is a view"), `ATTACH` of a new file (`SQLITE_CANTOPEN`),
   `PRAGMA journal_mode = DELETE` (`SQLITE_BUSY`).
2. **`VACUUM INTO '<path>'` leaves an empty file at `<path>`** before it is
   refused: a write outside the board, to a path the person typed, not
   undone.
3. **Only the first statement runs.** `board sql "SELECT 1; DELETE FROM
   task"` runs the `SELECT` and silently does not run the rest. Nothing after
   the first statement runs, so this is safe, but it is not refused.

What passes besides reads is harmless: `EXPLAIN`, a read of a pragma,
`ATTACH` of an existing file or `:memory:` (itself read-only), and `PRAGMA
query_only = 0`, which, being the one statement, leaves the throwaway
connection unused.

**`-p KEY` narrows by temporary views.** Before the query runs, board resolves
the key to its project's id from its own read of the row and creates, on its
throwaway read-only connection (the `temp` schema is the connection's own
memory), one `TEMP VIEW` per project table under the table's own name, from a
fixed list:

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

Unqualified names resolve to `temp` before `main`, so the query sees one
project, and its text is not rewritten. The id is board's own integer, written
as a literal because views take no parameters; nothing the user typed reaches
the DDL. The views keep their tables' columns, so a query works the same with
or without `-p`, and SQLite flattens them onto the project indexes. A store
test checks that every table with a `project_id` or `task_id` has a view, so a
table added later cannot leak every project. **It narrows; it does not wall
off**, and `board help sql` says so: `main.<table>` and `sqlite_master` still
see every project.

A statement refused `SQLITE_READONLY` exits 64 with nothing written:

```
board: `board sql` reads; it does not write. A change goes through the command that owns it (board edit, board claim, board answer, board project edit, …), so the board and its log move together. For what no command reaches, sqlite3 against ~/.board/board.db is the last resort, and nothing checks what it does.
```

A query that fails as SQL prints SQLite's own message, exit 1. `bun:sqlite`
exposes neither an authorizer nor a progress handler, so a long query is
stopped with Ctrl-C; a read does not block writers in WAL.

## Runtime

- **Processes.** Every command is one short process with one connection: any
  number of agents' commands, any number of watchers, all on the machine's
  one file, with no daemon and no server. Writers of every project serialise
  on SQLite's write lock; readers never wait, because of WAL. Event order is
  `event.id`, assigned under the lock, never `at`.
- **Cost per call** (Apple M3 Pro, the arm64 binary, a temp board of 300
  tasks, 40 runs per case, medians; `docs/design/drafts/cli/runtime.md`):
  `board --version` 32 ms; a read (`ls --json`, `status --json`) 73 ms; a
  write 78 ms (an add then a claim in one process, 84 ms). The npm shim adds
  25 ms; a cwd that needs git adds 25 ms. Of a read, about 38 ms is Bun
  starting and the imports, 21 ms `Store.open`, 16 ms Prisma's first query
  (its WASM compiler plans it), 1 ms the close. The first run of a newly
  installed binary takes about 1.4 s once (macOS's first look at a new
  77 MB file). Removing the MCP SDK saved 17–18 ms a call. Against an
  agent's turn of seconds this does not matter, and nothing is done about it
  (decision 51).
- **Busy timeout: 5 s.** A board write takes well under a millisecond.
  Measured through Prisma and the adapter, 10 processes × 100 write-first
  transactions on one file: 1,000 of 1,000 committed in 1.35 s, no failure.
  Waiting longer would only hide a holder that does not let go (someone in
  the `sqlite3` shell with an open transaction). Past it, the agent gets
  `busy`, nothing written, safe to retry. An agent's shell timeout (Claude
  Code's default is 2 minutes) is far above it.
- **The wait freezes the process.** It is SQLite's busy handler, in C on the
  only thread: for up to 5 s the process runs no JavaScript (no timers, no
  stdin, no signal handlers; measured, no 100 ms tick between 203 ms and
  5,254 ms). That is acceptable because a process can never wait on a lock
  it holds itself: one connection, one transaction at a time. Per process:
  - **A command** installs no `SIGINT` handler: Ctrl-C during the wait ends
    it at once (measured on the binary: 3 ms for `SIGINT`, 6 ms for
    `SIGTERM`) with nothing written, and it held no lock. A JavaScript
    handler would run only after the wait, by which time the write had
    committed, and exit 130 would lie about it. A non-interactive shell's
    `&` starts a job with `SIGINT` ignored, so a backgrounded board is
    stopped with `SIGTERM` (POSIX, not board's).
  - **`board watch` and `board sql`** read on a read-only connection and never
    wait behind a writer in WAL. Measured with a watcher whose own
    `busy_timeout` was 5 s, so a wait would show: a writer holding the lock
    3 s with 1,000 uncommitted rows, a writer frozen with `SIGSTOP` while
    holding it, a writer killed mid-write, and WAL recovery after `-shm` was
    removed with a writer opening at the same moment: the worst gap between
    500 ms ticks was 506 ms, the worst poll 4.9 ms, no error. A reader meets
    the busy handler only during WAL recovery, bounded by the WAL's size
    (milliseconds; SQLite checkpoints at 1,000 pages), never by another
    process's lock. `claim_expiring` and `--exec` timeouts run on the
    watcher's own loop and clock, which no other process can stop.
- **An unknown outcome.** A command killed after its commit and before its
  answer (Ctrl-C at the wrong moment, a shell timeout, `internal` while
  printing) leaves a write its agent did not see. Only reads are safe to
  repeat blindly. `add`, `comment`, `handover` and `ask` would file twice;
  `claim`, `extend`, `release` and `edit` can undo a later write by another
  run (a `release` repeated after the same holder claimed again, an `edit
  --status ready` repeated after another run's claim). The agent re-reads
  (`show --json`, `watch --task KEY --json --since ID`, `ls --contains` over
  every status for an add) and then decides; `board skill` teaches it.
- **A closed stdout ends board quietly with 141.** Bun ignores `SIGPIPE`, so
  a write to a closed pipe is an `EPIPE` error: `board watch --json | head
  -1` printed a 17-line Bun stack and exited 1 (measured on v1). Agents cut
  output with `head` as a matter of course. `src/main.ts` treats `EPIPE` on
  stdout as the end: no message, exit 141 (128 + `SIGPIPE`, what a shell
  shows for `yes | head`). A few lines on `process.stdout`'s `error` event and
  on a throw from `write`, in board's own entry point; no package is involved
  (decision 52). A write whose answer could not be printed has still
  committed: the unknown outcome above.
- **The shim forwards signals.** The npm shim (`npm/board/bin/board.js`)
  used `spawnSync`, which blocks Node's event loop and cannot forward a
  signal: `SIGTERM` to the shim's pid alone left a `watch --follow`
  running, reparented to `launchd` (measured). It spawns with
  `child_process.spawn` (`stdio: "inherit"`), forwards `SIGINT`, `SIGTERM`
  and `SIGHUP` to the child, and on the child's exit re-raises its signal or
  exits with its status (decision 53). A signal to the whole process group
  (Ctrl-C in a terminal, chord's `stop_monitor`) already reached both.
- **The environment.** Only `src/main.ts` reads it: `BOARD_DIR` and `HOME`.
  board reads no `BOARD_ACTOR` and no `BOARD_PROJECT` (decision 1, decision
  24); cliffy's `.env()` is not used, since it reads `process.env` itself.
- **Time.** One injected `Clock` returning a UTC `Date` truncated to
  milliseconds and formatted with `toISOString()` (milliseconds and `Z`, fixed
  width). Nothing in `src/` reads the clock but `SystemClock`, and SQL never
  calls `now` (a review rule). It is the wall clock, because leases are
  deadlines between processes; a clock jump moves expiry with it, which is
  accepted on one machine.
- **Failures.**

  | Situation | Outcome |
  | --- | --- |
  | A process killed inside a write | SQLite rolls it back; the lock is free at once; rows and events never disagree. A claim it committed earlier stays until its lease runs out: the lease is what handles a dead run. |
  | A command killed after its commit, before its answer | the write stands and its agent did not see it; reads are safe to repeat, writes are re-read first ("An unknown outcome") |
  | Lock held past 5 s | `busy`, exit 1, nothing changed; each waiting agent's command answers after its own 5 s |
  | Ctrl-C or `SIGTERM` during the busy wait | the process dies at once, 130 / 143, nothing written, no lock held |
  | No board file / bad `BOARD_DIR` | `no_board` with the path and the way out; the next command opens afresh, so a board created later is simply there |
  | cwd in no project, git finds none | `no_project` with the cwd, git's outcome and the `project add` line |
  | git missing, slow or failing | resolution goes on without it; the reason is in the error; 3 s at worst; the next command that needs git asks again |
  | The shell's cwd deleted | Bun refuses before `main.ts` runs, with its own one line, exit 1 |
  | A project's directory moved | it matches nothing until `board project edit --dir` |
  | Damaged file | `damaged` with SQLite's message and the offline recovery; no repair attempted |
  | Not a board / another schema | `not_a_board` / `schema_mismatch`, with the offline recovery |
  | An upgrade to a build with another `user_version` | every command that runs the new binary answers `schema_mismatch` at once, until the person moves the file aside and runs `project add`. A `PATH` that resolves another install (decision 43) keeps running the old binary until the file is moved, then answers `schema_mismatch` |
  | A command during an upgrade's install | the binary or the platform package is briefly missing: 127, or the shim's "no platform package", exit 1; the next command runs the new version |
  | Board file removed by hand while agents work | every later command is `no_board`; a write in flight at that moment is lost; the documented procedure stops the agents first |
  | Disk full, I/O error | `storage`, rolled back, exit 1 |
  | A bug in board inside a write | rolled back, `internal`, exit 1 |
  | stdout closed by its reader | silent, exit 141 |
  | The shim signalled alone | it forwards the signal; no child is left |
  | A binary signed without its entitlement, or with another | without `allow-jit`, board calls that reach Prisma answer `internal` (`SharedArrayBuffer is not defined`), with the Developer ID and ad hoc alike (decision 25); the release reads the signed entitlements back and stops on any difference from `tool/macos/board.entitlements` |

### Module layout

```
src/main.ts                 the entry point: the CLI; the only reader of the
                            environment, the cwd and the process's streams;
                            EPIPE on stdout → exit 141
src/env.ts                  BOARD_DIR / HOME → the board path, or a
                            configuration error
src/clock.ts                Clock, SystemClock
src/errors.ts               BoardError: one discriminated union, one case
                            per code
src/place/                  Place {cwd, git()}; GitRunner, ProcessGitRunner
                            (Bun.spawn, 3 s, SIGKILL); the root rule
src/store/                  open (pragmas, identity; never creates), create
                            (project add only), read/write: the only holders
                            of the PrismaClient
src/store/ddl.ts            Appendix A as an array of statements: the one
                            schema source
src/store/generated/        `prisma generate --sql`'s output; not in git
src/rules/                  projects, tasks, claims, questions, milestones,
                            readiness, events: pure TypeScript over a
                            transaction
src/board.ts                Board = Store + Clock; one method per operation;
                            the constructor takes a Store (no lazy open)
src/schemas.ts              Appendix B's output schemas as `as const`
                            objects; types through json-schema-to-ts
src/skill.ts                the agent guide's prose, pure
src/cli/                    one file per command or group (project,
                            milestone, the task writes, the question
                            commands, skill, watch, sql, upgrade); owns exit
                            codes
src/watch/                  derive (pure), loop, exec
src/upgrade/                detect, argv (pure), providers, spawn: `board
                            upgrade` (see "`board upgrade`")
src/sql/readonly.ts         the read-only gate and the project views
prisma/schema.prisma        pulled from build/schema.db, committed
prisma/sql/                 TypedSQL queries
prisma.config.ts            the datasource: file:./build/schema.db
tool/schema-db.ts           builds build/schema.db from ddl.ts
test/                       *.test.ts; test/helpers/ for spawned processes
npm/                        the three package.json templates and bin/board.js
tool/release.sh             the release, on the owner's Mac (--dry-run)
tool/macos/board.entitlements  com.apple.security.cs.allow-jit
package.json, bun.lock, .npmrc, tsconfig.json, biome.json
```

`rules/` and `board.ts` know nothing of cliffy or stdout; the CLI is the one
adapter, turning arguments into a `Board` call and a result or `BoardError`
into output. `projectAt` and the root rule are pure; `GitRunner` is the one
seam to the outside world, injected so no test needs a particular git.
`store/` is the only module that imports the generated client, and it hands
`rules/` a transaction, never the client. `@modelcontextprotocol/server` and
`@modelcontextprotocol/client` are gone from `package.json`; `ajv` is a
direct dev dependency, for the output-schema tests only, never bundled.
`Place`'s shared pending git stays (correct, tested), though one command
never has two callers.

### Tests

No test reaches a real agent. `bun test` (Bun's own runner), started as
`bun run test` so that the generation pipeline runs first; `bun test` alone
on a fresh checkout fails at the first import of `src/store/generated/`,
which says what is missing.

- **Rules**, against a fresh in-memory database per test (the adapter takes
  `:memory:`; `src/store/ddl.ts` is run on it, the same array the binary
  runs) with a `FakeClock`: every operation's success and every refusal;
  that a write and its events commit together or not at all, and that a
  refused write still commits its sweep; readiness and `board next` order;
  milestone flips; lease expiry by moving the clock (invisible to reads at
  once, one `claim_expired` at the next write, in the claim's project);
  per-project task numbers; cross-project relations refused; the `LIKE`
  escaping of `%`, `_` and `\`, and ASCII-only case folding pinned with a
  non-ASCII case; two `Board` calls started together, one refused, the
  other's write kept.
- **Projects**: `projectAt` table-driven (equal path, a path below,
  `/p/app-two` not under `/p/app`, nested in either order → deepest, no
  match); the root rule as a pure function of git's output (`.git`,
  `../../.git`, an absolute worktree path, `.` inside `.git`, a bare
  directory, a separate git dir, a submodule); a `Place` with a fake
  `GitRunner` (git not called when the cwd matches; one git for two
  concurrent calls; asked again after a failure; the timeout with the child
  killed); `ProcessGitRunner` against real git in temp directories, skipped
  without git; real paths through a symlink, `/tmp` and a mis-cased spelling;
  a `project add` by a second connection seen by the next call; the
  roll-back-and-retry when git is needed, with a project removed between
  calls.
- **Store**, against a temp file (WAL needs one), the second party a
  **process** spawned with `Bun.spawn([process.execPath,
  "test/helpers/holder.ts", …])`, not a `Worker` (a worker shares the
  process, and the lock tests are about processes): two connections racing
  for one claim, two sweeps of one expiry, numbers under two writers in one
  project, a write in one project sweeping another's claim; two and five
  first `project add`s; the busy timeout with a holder, and the client
  usable after `busy`; the lock statement takes the lock (a second
  connection's `BEGIN IMMEDIATE` gets `SQLITE_BUSY`); every failure path
  frees the lock (a throw, a constraint, disk full through
  `max_page_count`, Prisma's timeout); `SIGINT` during a CLI's wait leaves
  nothing written (spawned from Bun: a shell's `&` sets `SIGINT` ignored);
  damaged, foreign and missing files (no file left behind by any command
  but `project add`); `now` taken after the lock; removal of an empty
  project under `defer_foreign_keys`; a view for every project table.
- **Env**: unset → `~/.board/board.db`; empty → unset; relative and `~/…`
  refused; no `HOME`.
- **CLI**, in process: `runCli(argv, deps)` over the root built by the same
  `buildCli` the entry point uses, with `.noExit()`, injected sinks, `env`,
  `cwd`, a `FakeClock` and a fake or real `GitRunner`. They replace the MCP
  client tests:
  - the command tree: every command of "Commands" is mounted with its flags
    (walked from `buildCli`);
  - per command, one success: the human line and `--json` agree, and
    `--json` is one object that Appendix B's schema for the command accepts,
    checked with Ajv 8.20.0 directly (`ajv/dist/2020`, `strict: false`); every
    command with `--json` has a schema and no schema is without a command;
  - per command, its refusals: exit 1, `board: <code>: …` on stderr, stdout
    empty, the error object under `--json` accepted by the error schema; one
    refusal of each code;
  - usage errors: exit 64, `board: usage: …`, never JSON, nothing opened (no
    `board.db` created on a missing board) and no event appended; one case
    per row of "Inputs", lengths at the maximum and one past it in code
    points (an astral character counts one);
  - a rule that throws answers `internal`, the write rolled back;
  - a cwd in no project answers `no_project` with `details`, then works
    after `project add`; `-p` overriding the cwd; `-p` contradicting a key is
    `invalid_argument`; one command on a missing board answers `no_board`,
    and after `project add` the next works;
  - the flows (add, claim, extend, handover, send back, lapse by moving the
    clock, reclaim, close; the chain built and walked; a question blocked,
    answered as a delegate, overridden, validated) as sequences of `runCli`
    calls on one temp board; `board skill`'s flows are taken from them;
  - a 20,000-code-point body of astral characters (80,000 bytes) passed as
    one argument and read back equal by `show --json`;
  - `next` strings name no tool (`task_`, `question_`, `milestone_`,
    `board_status`).
- **Concurrency through the CLI is across processes, never in process.** Two
  `runCli` calls in one process open two connections on one thread; the busy
  handler blocks the thread in C, so the waiting one stops the holder from
  committing and the test measures a `busy` of its own making. Concurrent
  cases spawn `bun src/main.ts …` as processes: two claims of one task
  started together, exactly one exits 0 and the other exits 1 with
  `claim_held`, repeated 20 times; concurrent edits likewise.
- **`board skill`**: every `board …` line of the prose parses against the
  tree with no-op actions; every error code has a row; the index is
  generated; the flows run ("`board skill`").
- **Watch**: `derive` as a pure function (thresholds, once per lease,
  re-armed by an extend, the attach line); the loop driven tick by tick with
  an injected clock and sleep (a commit between `data_version` and the drain
  is printed on the next tick; 1,200 events of another project are not
  printed and cost one indexed query per tick (decision 31); `-p` exits on
  its project's removal; the missed window under `--exec`, pinned); `exec`
  with real `sh -c` one-liners through `Bun.spawn`; against a temp file, a
  watcher keeps its 500 ms ticks while a spawned holder keeps the write
  lock.
- **sql**: every statement of the read-only matrix in
  `docs/design/drafts/bun/data.md` §5 is a case; with `-p`, unqualified names
  see one project, `main.<t>` all, and the gate still holds.
- **The npm shim**: a write and a read with `--json` through it, a
  refusal's exit 1 and a usage error's 64 kept; the shim signalled alone
  leaves no child.
- **The built binary**: one smoke test, skipped unless `BOARD_BIN` names a
  built `board`, run through a symlink **and** as a copy in another
  directory. With a temp `BOARD_DIR` and a temp repository with a linked
  worktree:
  1. `board project add T --actor smoke --dir <repo>`, exit 0;
  2. from `<worktree>/sub`, no `-p`, through `sh -c` so the heredoc is the
     shell's: `board add --actor smoke --title 'Smoke 100% done' --body
     "$(cat <<'EOF' … EOF)"` with quotes, `$` and a backtick in the body; it
     must resolve through git; `--json` gives `T-1`;
  3. `board ls --contains '100%' --json` finds `T-1`; `board show T-1
     --json` gives the body back byte for byte;
  4. `board claim T-1 --actor smoke --minutes 5`, then the same again: exit
     1, `claim_held`; a missing flag: exit 64, nothing written;
  5. five processes claim one fresh task at once: one 0, four `claim_held`;
  6. `board watch --json | head -c 1`: exit 141, empty stderr;
  7. `board skill` exits 0 with a `BOARD_DIR` that does not exist;
  8. `board sql` reads the task back and prints `sqlite_version()`, so a run
     records which SQLite it ran on; `board upgrade --help` exits 0.

  CI runs it on the unsigned arm64 binary; the release runs it on both
  signed ones (x64 under `arch -x86_64`). No MCP client is anywhere in
  `test/`.

## Build and distribution

v1 targets **macOS only**, arm64 and x64, macOS 13 or newer (Bun's floor).

- **Generation**, one ordered pipeline from a clean checkout, the same for
  tests, CI and the release. Committed: `src/store/ddl.ts`,
  `prisma/schema.prisma`, `prisma/sql/*.sql`, `prisma.config.ts`. Generated,
  not committed: `build/schema.db` and `src/store/generated/`. The scripts in
  `package.json`:

  ```json
  {
    "scripts": {
      "schema:db": "bun tool/schema-db.ts",
      "schema:pull": "prisma db pull",
      "gen": "bun run schema:db && bun run schema:pull && prisma generate --sql",
      "check": "bun run gen && git diff --exit-code prisma/schema.prisma && tsc --noEmit && biome ci . && bun test",
      "test": "bun run gen && bun test",
      "build:arm64": "bun run gen && bun build --compile --target=bun-darwin-arm64 src/main.ts --outfile build/darwin-arm64/board",
      "build:x64": "bun run gen && bun build --compile --target=bun-darwin-x64 src/main.ts --outfile build/darwin-x64/board"
    }
  }
  ```

  `schema:db` rebuilds `build/schema.db` by running `DDL` on `bun:sqlite`;
  `schema:pull` rewrites `prisma/schema.prisma` from it; `prisma generate
  --sql` writes the client and the TypedSQL functions in one run, reading the
  queries' types from the same file. From nothing, `gen` takes about 2.6 s,
  and a second pull is byte-identical, so the `git diff` check is stable.
  `PRISMA_HIDE_UPDATE_MESSAGE=1` keeps Prisma's banner out of the release
  log. `.npmrc` maps `@jsr` to `https://npm.jsr.io`, where cliffy comes from.
  Checks: `tsc --noEmit` (TypeScript 7), and Biome for format and lint in one
  tool (Bun has neither).
- **Build**: `bun build --compile --target=bun-darwin-arm64` and
  `--target=bun-darwin-x64`, both on the arm64 Mac in under a second each
  (the first x64 build fetches Bun's x64 runtime once). One Mach-O per
  architecture, about 76 MB and 84 MB (a 33 MB npm tarball), holding Bun's
  runtime, the bundle and Prisma's WASM query compiler (embedded as base64,
  only the SQLite flavour). SQLite is the system's, loaded at run time, so
  nothing sits beside the binary: it runs through a symlink and as a copy
  alone. `--minify` and `--sourcemap` were not tried and are left out until
  they are.
- **x64**: Bun cross-compiles; Rosetta is needed only to run the x64
  self-test. The x64 runtime arrives signed by Oven with hardened runtime;
  the release's `--force` replaces that signature. There is no universal
  binary, since npm picks the package per architecture.
- **npm only**, as esbuild does it: the main package `@chorded/board`, with
  a `bin/board.js` shim (the command is `board`) and exact-version
  `optionalDependencies` on `@chorded/board-darwin-arm64` and
  `@chorded/board-darwin-x64` (`os: ["darwin"]`, `cpu: ["arm64"]` /
  `["x64"]`, `files: ["bin"]`), each holding `bin/board` alone, signed. The
  shim stays a Node script (npm runs `bin` with the user's Node; the user
  need not have Bun): it resolves the platform package, `spawn`s its binary
  with inherited stdio, forwards `SIGINT`, `SIGTERM` and `SIGHUP` to it
  ("Runtime"), and exits with the child's status, re-raising its signal so a
  command interrupted keeps 130 / 143. No install script. npm keeps the file byte-identical, mode
  `0755`, and sets no quarantine; `codesign --verify --strict` passes on the
  installed copy (tried with `npm pack` and `npm i`, npm 11.6.2). The
  repository's own `package.json` is `private: true` and holds the version,
  the dependencies (pinned by `bun.lock`) and the scripts; the three
  published `package.json`s are templates under `npm/`.
- **Signing**: Developer ID, hardened runtime, secure timestamp, one file
  per architecture, one call:

  ```sh
  codesign --force --sign "$identity" --options runtime --timestamp \
    --entitlements tool/macos/board.entitlements \
    --identifier dev.katsuba.board "$B/board"
  codesign --verify --strict --verbose=2 "$B/board"
  codesign -d --entitlements - --xml "$B/board" > "$B/entitlements.plist"
  [ "$(plutil -convert json -o - "$B/entitlements.plist")" = \
    "$(plutil -convert json -o - tool/macos/board.entitlements)" ] ||
    die "entitlements of $B/board differ from tool/macos/board.entitlements"
  ```

  Bun's payload is a Mach-O segment (`__BUN`), not bytes appended to the
  image, so the signature covers it and `--verify --strict` passes. The
  binary carries one entitlement, `com.apple.security.cs.allow-jit`, and
  needs it. Under hardened runtime a Bun binary is never killed for lack of
  an entitlement, but without one JavaScriptCore runs with its JIT off and
  `SharedArrayBuffer` is undefined: re-measured with the Developer ID,
  `--version` and `project add` work and `board ls` answers `internal`
  (`SharedArrayBuffer is not defined`) (decision 25). `allow-jit` restores
  it and is narrower than `allow-unsigned-executable-memory`, which also
  works.
  `disable-library-validation` is not needed: the only library loaded from
  outside the binary is the system's `libsqlite3`, a platform library. Since
  a binary without its entitlement passes every functional test, the release
  reads the entitlements back and compares them, as above. Tried on the
  owner's Mac with the real Developer ID, for arm64, and for x64 under
  Rosetta. Development builds keep Bun's own signature and run as they are.
- **Notarisation**: one zip (`ditto -c -k --norsrc --noextattr --keepParent`)
  holding both signed binaries, submitted with `xcrun notarytool submit …
  --keychain-profile roost-notary --wait`. That is the team-wide App Store
  Connect API key the owner keeps in the login keychain. Apple's log is
  fetched and kept beside the build whatever the verdict, and the release
  stops unless the verdict is `Accepted`. A bare Mach-O cannot be stapled, so
  Gatekeeper looks the ticket up online on the first run of a quarantined
  copy; an npm install sets no quarantine, so it is not assessed at all. After
  acceptance, both binaries must pass `codesign --verify --strict
  --test-requirement="=notarized"`; the check retries briefly while the
  ticket propagates. `spctl -a -t exec` is not used: it rejects any bare
  Mach-O as "does not seem to be an app", notarised or not (first release). What
  is published is exactly what was notarised: no rebuild, no `strip`, no
  rewritten file.
- **The release runs on the owner's Mac, not in CI**, as the sibling
  repository chorded's `Scripts/release.sh` does. `tool/release.sh` publishes;
  `tool/release.sh --dry-run` does everything up to `npm publish` and stops,
  sending nothing anywhere but Apple. In order, each step checked before the
  next:
  1. Refuse a dirty tree, untracked files included: a published build that
     no commit describes cannot be rebuilt.
  2. Read the version from `package.json`. Refuse it if `@chorded/board` has
     it on npm already. If only platform packages have it (a run stopped
     between publishes), publish what is missing from the packages already
     in `build/release/`, without building again, waiting as in step 11
     before `@chorded/board`.
  3. Check that `npm whoami` answers (the owner's own login) before anything
     is built.
  4. Find the Developer ID Application identity for team `YQ8ZD2KZ3T` in the
     login keychain by team, so a renewed certificate is picked up. Refuse
     none or several, listing what `security find-identity` said.
  5. `bun install --frozen-lockfile`, then `bun run check`.
  6. `bun run build:arm64` and `bun run build:x64`; check both with `file`.
  7. Sign, verify and compare the entitlements of both, then run each one's
     self-test: `board project add` and `board ls` under a temporary
     `BOARD_DIR`; x64 runs through `arch -x86_64`.
  8. Notarise the one zip and check the `=notarized` requirement.
  9. Assemble the three packages in `build/release/npm/` from the signed
     binaries and the shim. `npm pack` them, install the tarballs in a
     scratch project, and verify and self-test the installed copies.
  10. `--dry-run` stops here and prints where the packages are.
  11. Publish `@chorded/board-darwin-arm64` and `@chorded/board-darwin-x64`,
      then wait until `npm view @chorded/board-darwin-<arch>@<version>
      version` answers for both: npm can hold an accepted package in
      validation, and a main package published in that window installs with
      no binary. The wait is up to 60 attempts per package, 15 seconds
      apart, one package after the other, each miss saying on stderr which
      package it waits for. A timeout dies before the main
      package, saying to rerun once `npm view` answers; the rerun resumes
      (step 2). Then publish `@chorded/board` (whose exact-version
      `optionalDependencies` must resolve). Never unpublish (decision 57).

  Every check dies with what it read. The last line printed is the published
  version, and it is printed only when everything above it held.
- **CI runs tests and checks only**: `bun install --frozen-lockfile`, `bun
  run check`, and the smoke test on `bun run build:arm64`'s unsigned binary.
  CI has no signing step and no secrets.
- **Known risk: x64 is verified only under Rosetta.** No Intel Mac is
  available. The x64 binary has been built, signed and run under Rosetta,
  with and without the entitlement. A native Intel Mac may treat it
  differently. This is recorded, not a release gate.
- **Known risk: the system SQLite.** The SQLite is the user's macOS's, not
  one board ships. Appendix A needs `STRICT` (3.37), `RETURNING` (3.35) and
  built-in JSON (3.38); only 3.51.0 (macOS 26) was tried. The smoke test
  prints `sqlite_version()`.

The probes and commands behind this section are in
`docs/design/drafts/bun/runtime.md`.

## `board upgrade`

`board upgrade` installs another version of board through the package
manager that installed this one, so the manager's own records stay right and
nothing but the manager touches the installed files. It is cliffy's
`UpgradeCommand` (`@cliffy/command/upgrade` 1.3.1) over four providers from
`@cliffy/upgrade` 1.3.1, one per manager. It never opens the board. The
drafts behind this section, with every probe and every cliffy line cited, are
in `docs/design/drafts/upgrade/`; the owner settled the three questions they
left open (decisions 41 to 43).

```
board upgrade [--version VERSION] [-f|--force] [-v|--verbose]
board upgrade -l|--list-versions
```

### The command

- `new UpgradeCommand({ provider, standalone: false, spinner: false })`,
  mounted as `.command("upgrade", …)` on the root. `standalone: false` is
  what sends cliffy to the provider's `upgrade()` hook. Without it,
  `isStandalone()` (`Bun.isStandaloneExecutable`, true for board) takes the
  binary-swap path, which `NpmProvider` refuses. cliffy's script path would
  spawn `process.execPath install …`, which in a compiled binary is board
  itself. Neither is reached.
- Options are cliffy's: `-l`, `--version` (default `latest`), `-f` (skips the version comparison), `-v`.
  `-o/--output` does not appear, since no provider supports binary upgrades.
  `--no-spinner` is hidden, and so is `-r/--registry`: only one provider is
  mounted (below), and cliffy hides the option below two. The root's `-V, --version` is not global, so it
  does not collide with `upgrade --version`. `board help upgrade` and
  `board upgrade help` both work (`help` passes `noGlobals()`).
- `board skill` does not teach it: upgrading is a person's act.
- `package.json` gains `"@cliffy/upgrade": "npm:@jsr/cliffy__upgrade@1.3.1"`.
  `NpmProvider` is imported from `@cliffy/upgrade/provider/npm`; the
  re-export under `@cliffy/command/upgrade/provider/npm` is deprecated.

### The providers

`src/upgrade/providers.ts`: an abstract `NpmManagerProvider extends
NpmProvider`, constructed with `{ package: "@chorded/board" }`, and one
subclass per manager that narrows `name` to `npm`, `bun`, `pnpm` or `yarn`.
They override only public methods of cliffy's `Provider`:

- `resolveVersion(name, version)`: `latest` becomes
  `(await this.getVersions(name)).latest`, and any other version passes
  through. cliffy's `NpmProvider` delegates `latest` to the manager as `@*`,
  and `bun add -g pkg@*` leaves an installed version alone, exits 0 and
  records `"*"`. board would then report an upgrade that did not happen.
  With an exact version every manager moves, and the messages name the
  version. Narrowing `delegateLatestResolution` to `false` instead does not
  compile: `NpmProvider` types it as the literal `true` (decision 33).
- `getVersions(name)`: `NpmProvider`'s listing, unchanged, with a failure
  rethrown as board's refusal `registry` (below).
- `hasRequiredPermissions()`: answers `false`, with a comment saying why:
  its only caller in 1.3.1 is cliffy's version check, which then never
  fetches, so help and `--version` never touch the network (decision 41).
- `upgrade(options)`: refuses when no supported installation was identified,
  then runs
  `installArgv(this.name, options.to)` through `runManager`.

The four: npm, bun, pnpm, yarn (classic). yarn berry has no global install. Volta installs in npm's layout and
intercepts `npm install -g`, so it needs no provider of its own. `deno
install -g`, `npx` and `bunx` get none either: npx and bunx are caches, and
nobody has asked for Deno.

`installArgv(manager, version)`, pure, `version` always exact:

| Manager | argv |
| --- | --- |
| npm | `npm install --global @chorded/board@VERSION` |
| bun | `bun add --global @chorded/board@VERSION` |
| pnpm | `pnpm add --global @chorded/board@VERSION` |
| yarn | `yarn global add @chorded/board@VERSION` |

The manager is the name looked up on `PATH`, never `process.execPath`. No
`--force` and no `--silent`. bun and yarn record the exact version in their
global `package.json`, which pins it there; `board upgrade` is the way to
move it, and it always names the next exact version.

### Which manager installed this board

`detectManager(realPath)`, pure, in `src/upgrade/detect.ts`, over the real
path of the running binary. In a compiled Bun binary `process.execPath` is
already symlink-resolved; `main.ts` takes it once, `realpath`s it anyway, and
passes it in through `Deps.upgrade`. The first row that matches wins:

| # | Pattern in the real path | Answer |
| --- | --- | --- |
| 1 | `/_npx/<dir>/node_modules/@chorded/board-darwin-` | none (npx) |
| 2 | `/bunx-<dir>/node_modules/@chorded/board-darwin-` | none (bunx) |
| 3 | `/install/global/node_modules/@chorded/board-darwin-` | bun (`$BUN_INSTALL`, default `~/.bun`) |
| 4 | `/global/<dir>/[<dir>/]node_modules/.pnpm/@chorded+board-darwin-` | pnpm (`global/5/…` before pnpm 11, `global/v11/<hash>-<n>/…` from 11) |
| 5 | `/yarn/global/node_modules/@chorded/board-darwin-` | yarn classic (default global folder) |
| 6 | `/lib/node_modules/@chorded/board/node_modules/@chorded/board-darwin-` | npm, any prefix (nvm, Homebrew, fnm, Volta) |
| 7 | anything else | none: no supported global installation identified |

Every manager row needs `@chorded/board-darwin-`, so a Bun or Node that
happens to sit under a global `node_modules` never matches. Row 7 is not a
claim about how board got there. It covers a copied binary, a development
build, `bun src/main.ts`, and a local install. It also covers some installs a
manager made in a layout v1 does not recognise: yarn with a custom
`global-folder`, pnpm with a custom `global-dir`, bun with `globalDir` set,
npm's linked install strategy, and `deno install -g`.

**No supported installation identified: refuse**, exit 1:

```
Failed to upgrade board from version 0.1.0 to 0.2.0.
board cannot identify a supported global installation from this executable path: ~/src/board/build/darwin-arm64/board. If a package manager installed it, upgrade with that manager: npm install --global @chorded/board@0.2.0, bun add --global @chorded/board@0.2.0, pnpm add --global @chorded/board@0.2.0, or yarn global add @chorded/board@0.2.0. Not recognised: yarn with a custom --global-folder, npm link, and copies outside a manager's global directory.
```

A guess would install a second board somewhere else and leave the one that
ran untouched. `-l` still works.

**Only the detected provider is mounted.** `board upgrade` updates the
install it runs from (decision 42). The command gets one provider, the
detected manager's; when nothing is detected it gets npm's, whose hook
refuses as above (cliffy needs at least one). Installing board with another
manager is a plain install with that manager, not an upgrade.

**The manager is the one on `PATH` now** (decision 43). A path names a
manager's kind, not the install that the manager on `PATH` writes to. board
uses the environment it runs in and runs whatever manager of the detected
kind `PATH` finds, with no check of its global root and no prefix derived
from the path. When `PATH` does not match the install (two nvm Nodes, a
custom npm `prefix` in one shell, pnpm 10 against 12, another
`BUN_INSTALL`), the upgrade goes to *that* manager's install and the
running board stays as it is. The README says so beside the install line.

### Running the manager

`runManager(argv, env)` in `src/upgrade/spawn.ts`:

- `Bun.spawn`, all three stdio **inherited**, the environment passed through
  unchanged (`npm_config_*`, `.npmrc`, `BUN_INSTALL`, `PNPM_HOME`, proxies).
  The person sees the manager's progress and can answer its prompts (an OTP,
  corepack). Piping, as cliffy's own Bun runtime does, would hide that and
  turn a prompt into a hang. Hence `spinner: false`: cliffy's spinner
  redraws stdout every 75 ms and would interleave with the manager's output.
- **No timeout.** An install downloads a 33 MB tarball over whatever network
  the person has, and the person has Ctrl-C. A kill in the middle can leave a
  broken install: npm, interrupted, moves `bin/board` and the package aside
  while it rolls back.
- **No signal handler.** Ctrl-C reaches the shim, board and the manager
  together, as it would reach the manager typed by hand. The shim and board
  end by `SIGINT` (130). Probed: bun, yarn and pnpm 12 stop and keep the old
  version. npm goes on rolling back for some seconds after the prompt
  returns, then the old version is intact. pnpm 10 leaves board uninstalled,
  which is pnpm's own behaviour; the fix is to run the install again. This is
  accepted and documented in the README with the reinstall line per manager
  (decision 38).
- A missing manager makes `Bun.spawn` throw `ENOENT`. The hook turns that
  into "pnpm is not on PATH. Install pnpm, or upgrade board with the manager
  that installed it (detected: npm)." A non-zero exit or a signal is
  rejected with a message naming the argv and the status or signal.

**Replacing the running binary is safe.** npm 11.6.2, bun 1.4.3, pnpm 10.33.0
and 12.11.2, and yarn 1.22.22 never write the installed binary in place.
npm and bun rename the old package aside and delete it, and yarn unlinks it.
pnpm 10 installs into a new versioned directory and keeps the old one. pnpm
12 installs into a new `global/v11/<hash>-<n>` and deletes the old one. The
running `board upgrade`, the waiting shim and every running `board watch
--follow` keep the old inode and run on. The new file passes `codesign --verify --strict`.
For contrast, a running hardened-runtime binary overwritten in place is
killed (`SIGKILL`) at its next page-in. So nothing in board may ever write a
binary in place, and nothing may read back from `process.execPath` after the
install: depending on the manager, that path is the new file, the old one, or
gone. Every later command runs whatever `board` `PATH` finds; a running
`watch --follow` keeps the old version until it is restarted.
A post-install check is left out for the same reason, since the new binary's
path is the manager's business.

### Output and exit codes

cliffy's own lines go through its logger: `log` only under `-v`, `info` to
stdout, `warn` and `error` to stderr. The manager's output sits between them,
on the inherited streams.

```
$ board upgrade
… the manager's output …
From now on, each board command runs the board your PATH finds, which is 0.2.0 if PATH leads to the install just upgraded. A running board watch --follow keeps 0.1.0 until it is restarted.
Successfully upgraded board from version 0.1.0 to 0.2.0! (https://npmjs.org/package/@chorded/board/v/0.2.0)
```

The line about later commands is the provider's, printed by its hook right
after the manager exits 0. cliffy prints its success line only after the
hook returns, so the provider's line comes first (decision 39).
Under `-v`, cliffy prints the current and target versions first and the hook
prints `$ <argv>`. A failure prints cliffy's `Failed to upgrade board from
version 0.1.0 to 0.2.0.` after the manager's output, then the hook's line,
e.g. `npm install --global @chorded/board@0.2.0 exited with status 243.`.

| Case | Code |
| --- | --- |
| upgraded; already current (cliffy's warning, no manager run); `-l` | 0 |
| `--version` without a value, unknown option (parse) | 64 |
| unknown version, registry unreachable, manager missing, failed or signalled, no supported installation | 1 |
| `-l` with the registry unreachable | 1, through `runCli` |
| Ctrl-C during the install | 130 |

Two of these exits are cliffy's `process.exit`: `exit(1)` after a failure,
and `exit(0)` after `-l`. They pass the root's `.noExit()`. The codes still
match board's convention, so this is accepted (decision 36). An unknown
`--version` is found after parse, so it exits 1, not 64. Accepted too.

**`registry`.** A new refusal code for the CLI only, like
`project_exists`: "board could not read the versions of @chorded/board from
registry.npmjs.org: <reason>", `next` "check the network and try again;
nothing was changed", `details` `{reason}`. The `getVersions` override throws
it as a `BoardError`. Inside the upgrade action, cliffy logs its message and
exits 1. `-l`'s action runs outside that catch: its failure leaves `parse`,
and `runCli` gains a branch that prints a `BoardError` the way the commands'
`refusing` does (`board: <message> <next>`, exit 1), instead of the internal
error with a stack (decision 35).

**Colour.** cliffy colours through `@std/fmt/colors`, which under Bun is on
even when piped and with `NO_COLOR`. The entry point calls
`setColorEnabled(deps.colors)`, the documented switch, on the one
`@jsr/std__fmt` copy cliffy imports. `@jsr/std__fmt` becomes a dependency
under its own name at cliffy's version, so Bun keeps one copy (decision 40).

### The registry

Versions come from `NpmProvider.getVersions`: one `fetch` of
`https://registry.npmjs.org/@chorded/board` (the package name comes from the
constructor, not the command name). The main package's list is the right one
to read. It is published last, with the version `tool/npm-assemble.ts`
stamps into all three packages, so every listed version has both platform
packages. The current version is `pkg.version`, which equals what the manager
recorded.

| Invocation | Fetches |
| --- | --- |
| `board upgrade` (latest) | twice: `isOutdated`, then `resolveVersion` |
| `board upgrade --version V` | once (`isOutdated`) |
| `board upgrade -f` (latest) | once (`resolveVersion`) |
| `board upgrade -f --version V` | never |
| `board upgrade -l` | once |
| `--help`, `-h`, `board help`, `board --version` | never (decision 41) |

No separate network check before spawning: `isOutdated` already says
"already latest" and "version not found" before the manager runs, and `-f`
skips it. Offline fails fast: no DNS in about 80 ms, a refused connection at
once. A network that accepts and never answers waits for Bun's own `fetch`
limit, measured at 360 s. That is not bounded: the person has Ctrl-C, and
bounding it would mean racing a timer around cliffy's listing (decision 37).
The registry is npmjs.org only. The URL is a private field of `NpmProvider`,
so a person whose manager installs from a mirror lists from npmjs.org and
installs from the mirror. That is accepted for v1, since board is published
only on npmjs.org.

**The version check.** Once a command named `upgrade` is mounted, cliffy's
`checkVersion` runs on the root's long `--version`, on every command's
`-h`/`--help`, and in `HelpCommand`. Each run fetches the registry with no
bound, and a failed fetch is not caught. Probed: while `@chorded/board` is
unpublished, `board --help`, `board ls --help`, `board help` and `board
--version` all throw. Offline after publishing is the same. CLI tests that
ask for help would reach the registry. The fetch is skipped only when
`hasRequiredPermissions()` answers `false`. Its sole callers in 1.3.1 are
`checkVersion` and `UpgradeCommand.hasRequiredPermissions`, which only
`checkVersion` calls. board's providers answer `false`, with a comment
saying that it switches the check off, not that a permission is missing; the
"new version available" hint is gone (decision 41).

### The board file

`board upgrade` takes no `Deps` that open the store. It needs no
`BOARD_DIR`, writes no event, and works where no board exists. It also works
on a board that the running binary refuses with `schema_mismatch`, so `board
upgrade --version <previous>` is a way back from a mismatch. Old and new
binaries on one file: with the same `user_version` they share it under WAL as
any two processes do, with two rule sets for a while (accepted before the
first release). With a different one, the new binary refuses with
`schema_mismatch` on first use; an old binary still found through another
`PATH` (decision 43) goes on until the file is moved aside. Nothing
is rewritten. Two `board upgrade`s at once are two managers' installs at
once; board adds no lock.

### Module layout and tests

```
src/upgrade/detect.ts     detectManager(realPath): the marker table, pure
src/upgrade/argv.ts       installArgv(manager, version), pure
src/upgrade/providers.ts  NpmManagerProvider and the four; managerProviders(env)
src/upgrade/spawn.ts      runManager(argv, env): Bun.spawn, stdio inherited
src/cli/upgrade.ts        upgradeCommand(deps): the UpgradeCommand, providers ordered
src/main.ts               Deps.upgrade = { execPath, providers: managerProviders(process.env) }
```

`src/upgrade/` knows nothing of the board or the store. Only
`providers.ts` imports `@cliffy/upgrade`, and only `src/cli/upgrade.ts`
imports `@cliffy/command/upgrade`. `Deps.upgrade` is a seam like
`Deps.runner`: production code has no branch for tests.

Tests never reach the registry, a real manager or a global install:

- `test/upgrade-detect.test.ts`: `detectManager` over a table of real paths
  per layout (npm under several prefixes, bun, pnpm 10 and 12, yarn), plus
  row 7's cases (`build/`, a copy, a local install, the `bun` executable,
  npx, bunx). `installArgv` per manager, with a pin that no row produces
  `@*` or `@latest`.
- `test/upgrade-spawn.test.ts`: the providers' `upgrade()` in process,
  against fake `npm`/`bun`/`pnpm`/`yarn` scripts in a temporary directory
  that is the spawn's whole `PATH`. The scripts record their argv and
  environment and exit with a status the test sets. Covered: success, exit 3,
  killed by `SIGTERM`, missing manager.
- `test/upgrade-cli.test.ts`: the command in a **subprocess**, since
  cliffy's `exit` would end `bun test`. It runs through
  `test/helpers/upgrade-cli.ts`, which builds `Deps` as `main.ts` does, but
  with `execPath`, the environment and, for registry cases, test providers
  taken from its arguments. The test providers are subclasses of the
  production ones that override only `getVersions`, so no global is stubbed.
  Cases: the provider mounted per layout, `-r` absent from the help, success, manager failure, missing
  manager, already latest, version not found, `-l`, `-l` offline (the
  `registry` refusal), and `-f --version V` with no versions at all (no
  registry needed). Ctrl-C is a detached helper sent `SIGINT` while a fake
  manager sleeps. `bun src/main.ts upgrade` itself runs once: nothing
  detected, the refusal, nothing spawned. Help and `--version` with
  `upgrade` mounted make no fetch.
- The binary smoke test gains `board upgrade --help`, exit 0, which proves
  the imports survive `--compile`. It never upgrades, and there is no online
  test.

## How it runs with chord

Agents call `board` from their shell; nothing goes in `.mcp.json`, and board
needs no change to chord. A team learns the board from `board skill`: its
output goes into the team's instructions and `main`'s, or the instructions
say to run it first, and each role is told the name it writes as (`main`,
`@lead`, `@tester`). chord already tells each agent its name at the top of
its instructions ("You are <name>, a member of team <team>").

1. The person adds the project once: `board project add BRD --actor owner`
   in its directory.
2. The person, or `main` on its own, picks the next task: `board next`, which
   prefers the project's current milestone. The project comes from the
   shell's directory.
3. `main` claims it for the team (`board claim BRD-14 --actor main --holder
   @lead --minutes 90`, the minutes from the team's estimate, plus
   `--directory` and `--branch` when the run has its own) and starts a team
   on it with chord's `run_team`, the task's key in the job.
4. The lead reads the task (`board show`), runs its members, comments
   (`board comment`), adds findings under the task (`board add --parent`;
   they land in its project and milestone), extends the claim when it needs
   more time, and asks (`board ask`) when a choice is the owner's. Every
   write carries `--actor` with its own name. A run in a git worktree
   resolves to the project through git.
5. The lead hands over (`board handover --to main`) and reports to `main`
   through chord's `send_message`; `main` closes the task or sends it back
   (`board edit --status done` or `ready`; either drops the claim) and takes
   the next.
6. A question: `main` asks the person in the window, or, when the person has
   handed decisions over, answers `--as delegate`; the answer waits on
   `board questions --state to_validate` until validated or overridden.
7. An agent that wants to be told rather than ask runs `board watch --follow
   --json -p BRD --since <cursor> --kind claim_expiring,handover,question_answered 2>&1`
   under chord's `monitor` tool, which delivers each stdout line into the
   session as a message and stops the watcher's process group with
   `stop_monitor`. A monitor line is a wake-up, not data: chord cuts lines
   past 1,000 characters, sends at most 100 lines or 16 KiB a batch, and
   drops lines on a flood (more than 1,000 lines or 256 KiB in 10 s). The
   agent reads the task with board, keeps a cursor (from `board status
   --json`'s `last_event`, advanced only on logged ids), catches up with a
   `watch` without `--follow` after a cut or dropped line, and restarts the
   monitor with `--since` its cursor when it ends (an hour at most).
   `--exec` stays the person's notifier, for a sound or a notification; a
   board write from it would be seen by the same watch and run again.

Nothing here needs chord's code: the flow is in `board skill`, the team
file's instructions and `main`'s.

## Not in scope

- A daemon or a runner. Work moves when `main` moves it.
- A pause. It only refused board writes while the agents kept working;
  stopping work is `main` not starting runs and chord stopping them. It may
  come back later.
- Full-text search. A substring filter, and `board sql` for the rest.
- A UI for people beyond the CLI; task writes from the CLI (a person files
  work by asking `main`).
- Sync between machines, accounts or auth.
- Removing a project that has tasks; a reset command.
- Knowing chord's roles: board stores the names it is given and checks none.
- Tracking processes; checking the directory or branch a claim names.
- Detecting duplicate tasks.
- A server of any kind (MCP, a socket, a daemon) in front of the board.
- Reading text from stdin or files; a JSON input object.
- An environment variable for the actor or the project.
- Linux and Windows.
- Homebrew and release tarballs (later, at most).
- Self-update without a package manager (a binary swap, release assets),
  and an upgrade provider for Deno, npx, bunx or yarn berry.
- Subprojects: a directory inside a repository registered as its own project.
- Bare repositories and their worktrees, unless `project` is given.
- Migrations or reading older formats before the first release.

## Open questions for the owner

None.

## Appendix A: schema

The DDL as tried through Prisma 7.10.0 and `prisma-adapter-bun-sqlite` 0.8.0
on Bun 1.4.3 (system SQLite 3.51.0); every statement ran unchanged. The same
statements, one per element and in this order, are `src/store/ddl.ts`.

```sql
PRAGMA application_id = 0x424F5244;
PRAGMA user_version = 1;

-- A project: the key its tasks carry and the directory that selects it.
-- `directory` is absolute and a real path, never `/`.
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

## Appendix B: output schemas

The CLI's JSON contract: what `--json` prints, per command, in JSON Schema
2020-12. Normative: the tests validate every `--json` output and every
refusal against these schemas with Ajv (`ajv/dist/2020`, `strict: false`);
nothing validates at run time (decision 13). There are no input schemas: a
command's input is its flags, checked by cliffy ("Inputs"). Each schema
carries the `$defs` it refers to, so `$ref: "#/$defs/…"` resolves inside it. Every object has
`additionalProperties: false`, and every property is listed in `required`: an
output field that may be absent is `null`, never missing.

```json
{
  "$defs": {
    "Time": { "type": "string",
      "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" },
    "ProjectKey": { "type": "string", "pattern": "^[A-Z][A-Z0-9]{0,9}$" },
    "Key": { "type": "string", "pattern": "^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$" },
    "QuestionId": { "type": "string", "pattern": "^Q[1-9][0-9]*$" },
    "MilestoneName": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$" },
    "Status": { "enum": ["backlog", "ready", "active", "blocked", "done", "cancelled"] },
    "Priority": { "enum": ["urgent", "high", "normal", "low"] },
    "EventId": { "type": "integer", "minimum": 1 },
    "Events": { "type": "array", "items": { "$ref": "#/$defs/EventId" } },

    "Project": {
      "type": "object", "additionalProperties": false,
      "required": ["key", "name", "directory", "created_at"],
      "properties": {
        "key": { "$ref": "#/$defs/ProjectKey" },
        "name": { "type": "string" },
        "directory": { "type": "string" },
        "created_at": { "$ref": "#/$defs/Time" } } },

    "TaskRef": {
      "type": "object", "additionalProperties": false,
      "required": ["key", "title", "status"],
      "properties": {
        "key": { "$ref": "#/$defs/Key" },
        "title": { "type": "string" },
        "status": { "$ref": "#/$defs/Status" } } },

    "TaskSummary": {
      "type": "object", "additionalProperties": false,
      "required": ["key", "title", "status", "priority", "milestone", "parent",
                   "holder", "ready", "created_at", "updated_at"],
      "properties": {
        "key": { "$ref": "#/$defs/Key" },
        "title": { "type": "string" },
        "status": { "$ref": "#/$defs/Status" },
        "priority": { "$ref": "#/$defs/Priority" },
        "milestone": { "type": ["string", "null"] },
        "parent": { "oneOf": [{ "$ref": "#/$defs/Key" }, { "type": "null" }] },
        "holder": { "type": ["string", "null"] },
        "ready": { "type": "boolean" },
        "created_at": { "$ref": "#/$defs/Time" },
        "updated_at": { "$ref": "#/$defs/Time" } } },

    "Task": {
      "type": "object", "additionalProperties": false,
      "required": ["key", "title", "status", "priority", "milestone", "parent",
                   "holder", "ready", "created_at", "updated_at",
                   "body", "created_by", "waits", "waited_by", "children",
                   "claim", "questions"],
      "properties": {
        "key": { "$ref": "#/$defs/Key" },
        "title": { "type": "string" },
        "status": { "$ref": "#/$defs/Status" },
        "priority": { "$ref": "#/$defs/Priority" },
        "milestone": { "type": ["string", "null"] },
        "parent": { "oneOf": [{ "$ref": "#/$defs/Key" }, { "type": "null" }] },
        "holder": { "type": ["string", "null"] },
        "ready": { "type": "boolean" },
        "created_at": { "$ref": "#/$defs/Time" },
        "updated_at": { "$ref": "#/$defs/Time" },
        "body": { "type": "string" },
        "created_by": { "type": "string" },
        "waits": { "type": "array", "items": { "$ref": "#/$defs/TaskRef" } },
        "waited_by": { "type": "array", "items": { "$ref": "#/$defs/TaskRef" } },
        "children": { "type": "array", "items": { "$ref": "#/$defs/TaskRef" } },
        "claim": { "oneOf": [{ "$ref": "#/$defs/Claim" }, { "type": "null" }] },
        "questions": { "type": "array", "items": { "$ref": "#/$defs/Question" } } } },

    "Claim": {
      "type": "object", "additionalProperties": false,
      "required": ["key", "title", "holder", "since", "until", "minutes_left",
                   "directory", "branch"],
      "properties": {
        "key": { "$ref": "#/$defs/Key" },
        "title": { "type": "string" },
        "holder": { "type": "string" },
        "since": { "$ref": "#/$defs/Time" },
        "until": { "$ref": "#/$defs/Time" },
        "minutes_left": { "type": "integer", "minimum": 0, "maximum": 1440 },
        "directory": { "type": ["string", "null"] },
        "branch": { "type": ["string", "null"] } } },

    "Option": {
      "type": "object", "additionalProperties": false,
      "required": ["label", "detail"],
      "properties": {
        "label": { "type": "string" },
        "detail": { "type": ["string", "null"] } } },

    "Answer": {
      "type": "object", "additionalProperties": false,
      "required": ["choice", "text", "by", "as", "at"],
      "properties": {
        "choice": { "type": ["integer", "null"], "minimum": 1 },
        "text": { "type": ["string", "null"] },
        "by": { "type": "string" },
        "as": { "enum": ["owner", "delegate"] },
        "at": { "$ref": "#/$defs/Time" } } },

    "Question": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "key", "text", "options", "recommended", "asked_by",
                   "asked_at", "status", "answer", "validated"],
      "properties": {
        "id": { "$ref": "#/$defs/QuestionId" },
        "key": { "$ref": "#/$defs/Key" },
        "text": { "type": "string" },
        "options": { "type": "array", "minItems": 2, "maxItems": 6,
                     "items": { "$ref": "#/$defs/Option" } },
        "recommended": { "type": "integer", "minimum": 1, "maximum": 6 },
        "asked_by": { "type": "string" },
        "asked_at": { "$ref": "#/$defs/Time" },
        "status": { "enum": ["open", "answered", "withdrawn"] },
        "answer": { "oneOf": [{ "$ref": "#/$defs/Answer" }, { "type": "null" }] },
        "validated": { "oneOf": [
          { "type": "object", "additionalProperties": false, "required": ["by", "at"],
            "properties": { "by": { "type": "string" }, "at": { "$ref": "#/$defs/Time" } } },
          { "type": "null" }] } } },

    "Milestone": {
      "type": "object", "additionalProperties": false,
      "required": ["name", "position", "delivers", "status", "tasks"],
      "properties": {
        "name": { "$ref": "#/$defs/MilestoneName" },
        "position": { "type": "integer", "minimum": 1 },
        "delivers": { "type": "string" },
        "status": { "enum": ["done", "current", "planned"] },
        "tasks": {
          "type": "object", "additionalProperties": false,
          "required": ["total", "done", "cancelled", "left"],
          "properties": {
            "total": { "type": "integer", "minimum": 0 },
            "done": { "type": "integer", "minimum": 0 },
            "cancelled": { "type": "integer", "minimum": 0 },
            "left": { "type": "integer", "minimum": 0 } } } } },

    "Place": {
      "type": "object", "additionalProperties": false,
      "required": ["name", "position", "of", "left"],
      "properties": {
        "name": { "$ref": "#/$defs/MilestoneName" },
        "position": { "type": "integer", "minimum": 1 },
        "of": { "type": "integer", "minimum": 1 },
        "left": { "type": "integer", "minimum": 0 } } },

    "Event": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "at", "actor", "kind", "project", "task", "milestone", "data"],
      "properties": {
        "id": { "$ref": "#/$defs/EventId" },
        "at": { "$ref": "#/$defs/Time" },
        "actor": { "type": "string" },
        "kind": { "$ref": "#/$defs/Kind" },
        "project": { "oneOf": [{ "$ref": "#/$defs/ProjectKey" }, { "type": "null" }] },
        "task": { "oneOf": [{ "$ref": "#/$defs/Key" }, { "type": "null" }] },
        "milestone": { "type": ["string", "null"] },
        "data": { "type": "object" } } },

    "Kind": { "enum": [
      "board_created", "project_added", "project_edited", "project_removed",
      "task_added", "task_edited", "task_status", "task_moved", "waits_changed",
      "claimed", "claim_extended", "claim_released", "claim_expired",
      "comment", "handover",
      "question_asked", "question_answered", "question_validated", "question_withdrawn",
      "milestone_added", "milestone_edited",
      "milestone_deleted", "milestone_done", "milestone_reopened"] }
  }
}
```

Notes:

- `TaskSummary` is what lists return; `Task` is the summary's fields plus the
  rest, written out in full because `additionalProperties: false` does not
  compose with `allOf`.
- A task key's prefix is its project's key, so tasks, claims and questions
  carry their project in `key`; answers scoped to a project say it at the top
  level.
- `Project.directory` is the stored, resolved path.
- `Claim.minutes_left` is whole minutes rounded up, so a live claim never
  shows 0 unless it has under a minute; a claim is only ever shown live.
- `Option.detail` and `Answer.text` are `null` when not given. An answer has
  `choice`, `text` or both.
- `Question.validated` is non-null only on an answer given `as: delegate`. An
  owner's override leaves it null.
- `Milestone.tasks.left` is `total − done − cancelled`. `Place` is "milestone
  2 of 5, 3 left".
- `Events`, on every write, is every id the write appended, ascending, the
  sweep's `claim_expired` lines of any project included.
- `Event.project` is null only on `board_created` and `project_removed`.
- `Event.data` is `{ "type": "object" }` on the wire; its shape per kind is
  the normative table under "Events", held by the store's tests.
- `none`, any case, means no milestone wherever `--milestone` is taken;
  the store refuses it as a name.

### Project shapes

`board project add`, `edit` and `rm` print a `Project` under `--json`
(`rm` the removed one). `board project ls --json` prints:

```json
{ "type": "object", "additionalProperties": false,
  "required": ["projects", "here"],
  "properties": {
    "projects": { "type": "array", "items": {
      "type": "object", "additionalProperties": false,
      "required": ["project", "open", "closed", "current"],
      "properties": {
        "project": { "$ref": "#/$defs/Project" },
        "open": { "type": "integer", "minimum": 0 },
        "closed": { "type": "integer", "minimum": 0 },
        "current": { "oneOf": [{ "$ref": "#/$defs/Place" }, { "type": "null" }] } } } },
    "here": { "oneOf": [{ "$ref": "#/$defs/ProjectKey" }, { "type": "null" }] } } }
```

### Errors

Every refusal board makes, from every command, has this shape; under
`--json` it is printed on stderr, on one line:

```json
{
  "type": "object", "additionalProperties": false, "required": ["error"],
  "properties": {
    "error": {
      "type": "object", "additionalProperties": false,
      "required": ["code", "message", "next", "details"],
      "properties": {
        "code": { "enum": [
          "not_found", "claim_held", "not_claimed", "not_ready",
          "invalid_transition", "already_answered", "cycle", "invalid_argument",
          "busy", "storage", "no_board", "no_project", "project_exists", "damaged",
          "not_a_board", "schema_mismatch", "internal", "registry"] },
        "message": { "type": "string" },
        "next": { "type": "string" },
        "details": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "what": { "enum": ["project", "task", "question", "milestone"] },
            "id": { "type": "string" },
            "field": { "type": "string" },
            "reason": { "type": "string" },
            "from": { "type": "string" },
            "to": { "type": "string" },
            "allowed": { "type": "array", "items": { "type": "string" } },
            "path": { "type": "array", "items": { "type": "string" } },
            "claim": { "$ref": "#/$defs/Claim" },
            "task": { "$ref": "#/$defs/TaskSummary" },
            "question": { "$ref": "#/$defs/Question" },
            "project": { "$ref": "#/$defs/Project" },
            "projects": { "type": "array", "items": { "$ref": "#/$defs/Project" } },
            "cwd": { "type": "string" },
            "git": { "enum": ["found", "not_a_repo", "missing", "failed"] },
            "git_root": { "type": ["string", "null"] },
            "file": { "type": "string" },
            "sqlite": { "type": "string" } } } } } }
}
```

Without `--json`, stderr has `board: <code>: <message> <next>`; the exit is
1 either way. `message` says what is wrong and names the thing; `next` says
what to do, naming commands. `details` carries only the fields listed for the
code below, and is `{}` when there are none. `details.field` is the flag as
typed ("Errors" under "The CLI"). A refusal does not make the change asked
for and appends no event of its own; a write refused after its lock still
commits the machine-wide sweep (decision 5).

| Code | When | `next` says | `details` |
| --- | --- | --- | --- |
| `not_found` | a project, key, question or milestone does not exist (a key whose prefix is no project is `what: project`) | check it; `board ls --contains` / `board questions` / `board milestone ls` to find it; for a project, the keys there are | `what`, `id` |
| `claim_held` | `board claim` with a live claim (any holder); `board extend` / `board release` whose `holder` is not the live claim's | for a claim: wait or `board extend` if it is yours; for extend/release: re-read the claim with `board show KEY` and pass its holder as `--holder` | `claim` |
| `not_claimed` | `board extend` / `board release` with no live claim (none, or expired) | `board claim` to take it | — |
| `not_ready` | `board claim` on a task that is not ready | the reason, and what would make it ready | `task`, `reason` (`status`, `question`, `waits`) |
| `invalid_transition` | a status, question, milestone or project change the rules do not allow (closing with an open question, validating an owner's answer, deleting a milestone that has tasks, removing a project that has tasks, asking on a closed task, answering a withdrawn question) | what is allowed from here | `from`, `to`, `allowed`, `reason` |
| `already_answered` | answering a question that is answered and not overridable | `board questions`; the owner may override a delegate's unvalidated answer | `question` |
| `cycle` | a wait or a parent that would close a loop | the loop | `path` (keys) |
| `invalid_argument` | a value the schema allows and the rules do not: a key of another project in `--parent` / `--waits` / `--waits-add` / `--waits-remove`; `-p` contradicting `--parent` or `--task`; a milestone name with `--all`; the same key in `--waits-add` and `--waits-remove`; `N` or `--recommended` past the options; a move relative to itself; a milestone name taken or `none`; the actor `board` | what to change; the actor `board`: pass `--actor` with your own name | `field` |
| `busy` | the write lock was not obtained within the busy timeout | retry; nothing was changed | — |
| `storage` | disk full, I/O error, read-only file | SQLite's message; nothing was changed | `sqlite` |
| `no_board` | the board file is missing (only `board project add` creates it), or `BOARD_DIR` is relative, or neither `BOARD_DIR` nor `HOME` is set | for `missing`: `board project add KEY` in a project's directory creates it; otherwise fix the environment (see "`no_board`") | `file`, `reason` (`missing`, `board_dir_relative`, `no_home`) |
| `no_project` | no key and no `-p` given, and the working directory resolves to no project, directly or through git | pass `-p KEY` with a key listed, or ask the owner to choose a key and run `board project add KEY --dir DIR` | `cwd`, `git`, `git_root`, `projects`, `reason` (git's message when `failed`) |
| `project_exists` | `board project add` / `edit` with a key or a directory another project has | choose another key; or move the other project first | `field` (`KEY`, `dir`), `project` |
| `damaged` | the file is not a database or is malformed | stop the agents, move `~/.board/board.db` and its `-wal` / `-shm` aside, then `board project add` | `sqlite` |
| `not_a_board` | a SQLite file that is not a board (`application_id`) | move it aside, then `board project add` | — |
| `schema_mismatch` | a board from another build (`user_version`) | there are no migrations before the first release: move the file aside, after the owner agrees, then `board project add` | `from`, `to` (versions) |
| `internal` | an exception in board's own code; a failure before the commit was rolled back, one after it (printing, closing) was not | report it; read before retrying | `reason` |
| `registry` | only `board upgrade` could not read the versions of `@chorded/board` from registry.npmjs.org (offline, not found, non-2xx) | check the network and try again; nothing was changed | `reason` |

Arguments that do not fit a command are not refusals: cliffy refuses them
before board opens anything, as `board: usage: <message>` on stderr, exit
64, never JSON (decision 13).

The schemas are `as const` TypeScript objects in one module, used two ways:
turned into types by `json-schema-to-ts`, and used by the tests to validate
the CLI's `--json` output and its refusals.

### The commands

One output schema per command with `--json`, under the command's name
(`outputs.<command>` in `src/schemas.ts`). The inputs are in "Inputs"
under "The CLI".

Every command can also answer `busy`, `storage`, `no_board`, `damaged`,
`not_a_board`, `schema_mismatch` and `internal`; every command that resolves
a project as in "Which project a call is about" can answer `no_project`,
and `not_found` with `what: project`. These are not repeated per command.
The schemas below omit `"type": "object", "additionalProperties": false` and
the `$defs`, which every one has. "Text" is the human line.

#### `board status`

```json
{ "required": ["project", "counts", "milestones", "current", "claims", "questions", "last_event"],
  "properties": {
    "project": { "$ref": "#/$defs/Project" },
    "counts": { "type": "object", "additionalProperties": false,
      "required": ["backlog", "ready", "active", "blocked", "done", "cancelled"],
      "properties": {
        "backlog": { "type": "integer", "minimum": 0 }, "ready": { "type": "integer", "minimum": 0 },
        "active": { "type": "integer", "minimum": 0 }, "blocked": { "type": "integer", "minimum": 0 },
        "done": { "type": "integer", "minimum": 0 }, "cancelled": { "type": "integer", "minimum": 0 } } },
    "milestones": { "type": "array", "items": { "$ref": "#/$defs/Milestone" } },
    "current": { "oneOf": [{ "$ref": "#/$defs/Place" }, { "type": "null" }] },
    "claims": { "type": "array", "items": { "$ref": "#/$defs/Claim" } },
    "questions": { "type": "object", "additionalProperties": false,
      "required": ["open", "to_validate"],
      "properties": { "open": { "type": "integer", "minimum": 0 },
                      "to_validate": { "type": "integer", "minimum": 0 } } },
    "last_event": { "type": "integer", "minimum": 0 } } }
```

- One project's state. `counts` are by effective status. `milestones` is the
  project's chain in order. `current` is null when no milestone is current
  (none, or all done).
- `claims` are the project's live ones, soonest to end first, with
  `directory` and `branch` as given; nothing is checked about them (owner
  decision 3).
- `last_event` is the project's newest event id, for `board show --since` and
  `board watch --since`; 0 when it has none.

Text: `BRD: milestone 2 of 5 (v1), 3 tasks left; 2 ready, 1 active, 1 blocked; 1 claim; 1 open question, 2 to validate`.

#### `board ls`

```json
{ "required": ["project", "tasks", "total", "next_offset"],
  "properties": {
    "project": { "oneOf": [{ "$ref": "#/$defs/ProjectKey" }, { "const": "*" }] },
    "tasks": { "type": "array", "items": { "$ref": "#/$defs/TaskSummary" } },
    "total": { "type": "integer", "minimum": 0 },
    "next_offset": { "type": ["integer", "null"], "minimum": 0 } } }
```

- `-p` omitted: `--parent`'s project if given, else the resolved one.
  `--all`: every project, answered as `project: "*"`; then `--milestone` may
  only be `none`.
- `--status` defaults to the open ones: `backlog`, `ready`, `active`,
  `blocked`. Filters are by effective status, so `--status blocked` is "has an
  open question" and `--status ready` includes tasks whose claim expired.
  `--ready` keeps only tasks ready by the rule (status `ready`, no open
  question, nothing it waits for open), intersected with `--status`.
- `--milestone none` is tasks in no milestone; the store refuses `none` as a
  name, so the two never meet.
- `--contains` keeps tasks whose title or body contains the string as given:
  no character is special, and only ASCII letters are matched regardless of
  case.
- Newest first, by `task.id`, which also orders across projects under
  `--all`. `--limit` defaults to 50, `--offset` to 0; `next_offset` is null
  on the last page; `total` counts every match.

Text: `3 tasks in BRD` / `3 tasks in BRD containing "lease"` / `50 of 120 tasks in every project; next page: --offset 50`.

#### `board show`

```json
{ "required": ["task", "events", "cursor", "more"],
  "properties": {
    "task": { "$ref": "#/$defs/Task" },
    "events": { "type": "array", "maxItems": 200, "items": { "$ref": "#/$defs/Event" } },
    "cursor": { "type": "integer", "minimum": 0 },
    "more": { "type": "boolean" } } }
```

`events` are the task's events with `id > --since` (default 0), oldest first,
at most 200. `cursor` is the id of the last event in the page, or `--since`
when the page is empty; `more` says run again with `--since <cursor>`;
`board watch --task KEY --json` prints the whole log without paging. The task's
fields are always whole, so the current state never needs a replay. The key
names the project; the working directory plays no part. Refusals:
`not_found`.

Text: `BRD-12 active, held by @lead until 2026-10-12T16:00:00.000Z; 2 events since 420`.

#### `board next`

```json
{ "required": ["project", "task", "from", "milestone", "waiting"],
  "properties": {
    "project": { "$ref": "#/$defs/ProjectKey" },
    "task": { "oneOf": [{ "$ref": "#/$defs/TaskSummary" }, { "type": "null" }] },
    "from": { "enum": ["current", "unassigned", "later", "milestone", null] },
    "milestone": { "oneOf": [{ "$ref": "#/$defs/Place" }, { "type": "null" }] },
    "waiting": { "type": "object", "additionalProperties": false,
      "required": ["blocked", "active", "waits_open"],
      "properties": { "blocked": { "type": "integer", "minimum": 0 },
                      "active": { "type": "integer", "minimum": 0 },
                      "waits_open": { "type": "integer", "minimum": 0 } } } } }
```

Within one project: ready tasks of the current milestone, then ready tasks in
no milestone, then ready tasks of later milestones in chain order; within
each, priority then oldest. An empty or exhausted current milestone falls
through. `from` says which rule picked the task: `current`, `unassigned`,
`later`, or `milestone` when `--milestone` was given, which
restricts the search to it with no fallback; `null` when `task` is null.
`milestone` is the current milestone's place, or the explicit one's; null
when there is none. `waiting` counts the open tasks in the searched scope
that are not ready, by reason.

`board next` only reads: it claims nothing, two callers may get the same task,
and the second `board claim` gets `claim_held`. Refusals: `not_found` for an
explicit milestone.

Text: `next in BRD: BRD-14 "Watch tool" (current milestone v1)`; `next in BRD: BRD-20 "Bump deps" (no milestone; v1 has nothing ready)`; `nothing ready in BRD: 1 blocked on a question, 1 active, 2 waiting on other tasks`.

#### `board add`

```json
{ "required": ["task", "events"],
  "properties": { "task": { "$ref": "#/$defs/Task" }, "events": { "$ref": "#/$defs/Events" } } }
```

- Project: `-p`, else `--parent`'s, else the resolved one. `-p` and a
  `--parent` of another project is `invalid_argument`; so is a `--waits` key of
  another project.
- Defaults: `--body` `""`, `--priority` `normal`, `--status` `ready`. No duplicate
  detection.
- `--milestone` omitted: the parent's milestone if `--parent` is given, else
  none. `"none"` puts it in no milestone explicitly. A name is the project's
  milestone.
- A done milestone takes the task and reopens: `milestone_reopened` is among
  the `events`.
- Refusals: `not_found` (parent, a wait, the milestone); `invalid_argument`
  (a title that is only whitespace, which the parse does not refuse; another
  project's key). A new task cannot close a loop, so there is no `cycle` here.

Events: `task_added`, and `milestone_reopened` when it applies.
Text: `added BRD-17 "Claim error lacks the holder" (v1, under BRD-12, ready)`.

#### `board edit`

```json
{ "required": ["task", "changed", "events"],
  "properties": {
    "task": { "$ref": "#/$defs/Task" },
    "changed": { "type": "array", "uniqueItems": true, "items": { "enum": [
      "title", "body", "priority", "status", "parent", "milestone", "waits"] } },
    "events": { "$ref": "#/$defs/Events" } } }
```

- The key names the project; `--parent`, `--waits-add` and `--milestone` are looked
  up in it, and a key of another project is `invalid_argument`. A task does
  not move between projects.
- `--status` cannot be `active` (only `board claim` makes a task active) or
  `blocked` (implied by an open question). The transitions are those of
  "Statuses and transitions": `backlog` ↔ `ready`; an open task to `done`
  (refused with an open question) or `cancelled` (withdraws its open
  questions); a closed task back to `backlog` or `ready` (reopens its
  milestone if done). Anything else is `invalid_transition` with `allowed`.
- An active task set to `ready`, `backlog`, `done` or `cancelled` loses its
  claim in the same transaction, whoever holds it: `claim_released` with
  reason `sent_back` or `closed`.
- Waits are added and removed, never replaced, so two writers do not lose
  each other's edits. The same key in both lists, or the task's own key, is
  `invalid_argument`; a wait or parent that closes a loop is `cycle`.
- An update that changes nothing changes no row of its own: `changed: []`,
  and `events` holds only what the sweep appended, often nothing.
- Moving into a done milestone, or reopening a task of one, reopens it.

Events, in this order, those that apply: `task_edited`, `task_moved`,
`waits_changed`, `task_status`, `claim_released`, `question_withdrawn`,
`milestone_done`, `milestone_reopened`.
Text: `BRD-17: status backlog → ready, milestone v1 → v2` / `BRD-17: nothing to change`.

#### `board claim`

```json
{ "required": ["claim", "task", "events"],
  "properties": { "claim": { "$ref": "#/$defs/Claim" },
                  "task": { "$ref": "#/$defs/TaskSummary" },
                  "events": { "$ref": "#/$defs/Events" } } }
```

- `--minutes` has no default (owner decision 4). `--holder` defaults to `--actor`:
  main claims a task for the lead it starts by passing `holder: "@lead"`.
- The task must be ready; an expired claim on it is swept in the same
  transaction, so retaking a lapsed task is one call. The task becomes
  `active`.
- `directory` is informational: it is not compared with the
  project's directory.
- Refusals: `not_found`; `claim_held` when a live claim exists, by anyone,
  the same holder included (`next`: `board extend` if it is yours);
  `not_ready` with `reason` `status`, `question` or `waits`.

Events: `claimed` (plus any `claim_expired` the sweep writes).
Text: `BRD-14 claimed by @lead until 2026-10-12T15:33:00.000Z (90 min)`.

#### `board extend`

```json
{ "required": ["claim", "events"],
  "properties": { "claim": { "$ref": "#/$defs/Claim" }, "events": { "$ref": "#/$defs/Events" } } }
```

`until` becomes now plus `--minutes`, not the old end plus them: the
claimer re-estimates from where it stands. `--holder` is required and compared
with the live claim's: it is not a role check, it stops a caller acting on a
stale view. Anyone may call it. Refusals: `not_found`; `not_claimed` (no live
claim, or expired: it is claimed again, not extended); `claim_held` when
`--holder` differs, with the current claim. Events: `claim_extended`.
Text: `BRD-14 held by @lead until 2026-10-12T16:40:00.000Z (60 min from now)`.

#### `board release`

```json
{ "required": ["task", "released", "events"],
  "properties": { "task": { "$ref": "#/$defs/TaskSummary" },
                  "released": { "$ref": "#/$defs/Claim" },
                  "events": { "$ref": "#/$defs/Events" } } }
```

The task goes back to `ready`. `released` is the claim as it stood. `--note`
goes into `claim_released.data.note`. Refusals as `board extend`. To close and
release at once, `board edit --status done`. Events: `claim_released` with
reason `release`.
Text: `BRD-14 released by main (held by @lead since 2026-10-12T14:03:00.000Z)`.

#### `board comment` and `board handover`

```json
{ "required": ["event", "events"],
  "properties": { "event": { "$ref": "#/$defs/Event" }, "events": { "$ref": "#/$defs/Events" } } }
```

A handover's `text` is why and what is asked; `changed`, `ran` and
`unchecked` are what changed, what was run and what is not checked. A
handover is an event and nothing more: it moves no claim and changes no
status, and nothing in `text` is read. Comments on closed tasks are allowed.
Refusals: `not_found`. Events: `comment` or `handover`.
Text: `note on BRD-14` / `handover on BRD-14 from @lead to main`.

#### `board ask`

```json
{ "required": ["question", "task", "events"],
  "properties": { "question": { "$ref": "#/$defs/Question" },
                  "task": { "$ref": "#/$defs/TaskSummary" },
                  "events": { "$ref": "#/$defs/Events" } } }
```

`--recommended` is 1-based into the options; past the last given is `invalid_argument`.
The task becomes `blocked` until its last open question is answered or
withdrawn. Ids are `Q<n>`, one sequence per machine. Refusals:
`not_found`; `invalid_transition` on a closed task. Events: `question_asked`.
Text: `Q7 asked on BRD-14; BRD-14 is blocked until it is answered`.

#### `board answer`

```json
{ "required": ["question", "task", "events"],
  "properties": { "question": { "$ref": "#/$defs/Question" },
                  "task": { "$ref": "#/$defs/TaskSummary" },
                  "events": { "$ref": "#/$defs/Events" } } }
```

- `--as` has no default, so nobody records an owner's answer by leaving out
  a flag. `N` past the options is `invalid_argument`.
- **The owner's override**: `as: owner` on a question answered
  `as: delegate` and not yet validated replaces the answer. The question then
  reads `answer.as: "owner"`, `validated: null`, and leaves the to-validate
  list; the `question_answered` event carries `overrides` with the previous
  answer.
- Otherwise an answered question is `already_answered` (an owner's answer, a
  validated delegate answer, or a delegate answering again); a withdrawn one
  is `invalid_transition`.

Events: `question_answered`. Text: `Q7 answered by main as delegate: up to 8 at once; BRD-14 unblocked; waits for the owner to validate` / `Q7: the owner's answer replaces the delegate's`.

#### `board validate`

```json
{ "required": ["question", "events"],
  "properties": { "question": { "$ref": "#/$defs/Question" }, "events": { "$ref": "#/$defs/Events" } } }
```

Marks a delegate's answer checked. For main to record the owner's approval
said in the chat window; `board validate` is the same from the terminal.
Refusals: `invalid_transition` for an open, withdrawn, owner-answered or
already validated question. Events: `question_validated`. Text: `Q7 validated`.

#### `board questions`

```json
{ "required": ["project", "questions"],
  "properties": {
    "project": { "oneOf": [{ "$ref": "#/$defs/ProjectKey" }, { "const": "*" }] },
    "questions": { "type": "array", "items": { "$ref": "#/$defs/Question" } } } }
```

`-p` omitted: `--task`'s project if given, else the resolved one; `--all`
for every project, so the owner sees everything to validate at once. `state`
defaults to `open`; `to_validate` is answered `as: delegate` and not
validated. Oldest asked first. Refusals: `not_found` for `--task`;
`invalid_argument` for a `-p` other than `--task`'s.
Text: `2 questions to validate in BRD` / `5 questions to validate in every project`.

#### `board milestone add`

```json
{ "required": ["project", "milestone", "chain", "events"],
  "properties": { "project": { "$ref": "#/$defs/ProjectKey" },
                  "milestone": { "$ref": "#/$defs/Milestone" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Goes last in the project's chain unless `--before` or `--after` names one of
its milestones. `NAME` is unique in the project, case-insensitively;
`none` (any case) and a taken name are `invalid_argument`. A new milestone is
empty, so if it lands before the current one it becomes current, and
`board next` falls through it. Refusals: `not_found` for `--before` / `--after`.
Events: `milestone_added`. Text: `BRD: milestone v2 added at 3 of 5`.

#### `board milestone edit`

```json
{ "required": ["project", "milestone", "chain", "changed", "events"],
  "properties": { "project": { "$ref": "#/$defs/ProjectKey" },
                  "milestone": { "$ref": "#/$defs/Milestone" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "changed": { "type": "array", "uniqueItems": true,
                               "items": { "enum": ["name", "delivers", "position"] } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Rename, re-describe, and move relative to another milestone of the same
project. Something to change (`--name`, `--delivers`, `--before` or `--after`)
is required by a check in the action, a usage error. There is no
status field: a milestone is done when all its tasks are closed and reopens
when a task comes in. A move relative to itself, a taken name or `none` is
`invalid_argument`; `not_found` for the milestone or the anchor. No change:
`changed: []`, with `events` holding only sweep ids. Events: `milestone_edited` with `{field: {from,
to}}`, with `position` when moved. Text: `BRD: milestone v2 → v1.1, moved before v3`.

#### `board milestone rm`

```json
{ "required": ["project", "deleted", "chain", "events"],
  "properties": { "project": { "$ref": "#/$defs/ProjectKey" },
                  "deleted": { "$ref": "#/$defs/MilestoneName" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Only an empty milestone; one with tasks, cancelled ones included, is
`invalid_transition` with `reason: "has_tasks"` and `next`: move its tasks
out with `board edit KEY --milestone none` first. Later milestones of the project
shift up. Events: `milestone_deleted`. Text: `BRD: milestone v2 deleted; 4 left`.
