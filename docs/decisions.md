# Decisions

One entry per decision: the context, the options weighed, the choice, its
consequences, and the packages tried under the project's one rule ("take a
library before writing one"). Entries marked *owner* were decided by the
owner; the rest by the architects' team, with the drafts in
`docs/design/drafts/v1/`, `docs/design/drafts/v1-projects/`,
`docs/design/drafts/bun/`, `docs/design/drafts/upgrade/` and
`docs/design/drafts/cli/` as the record. Library lines name what was tried on
the current stack (Bun, TypeScript, Prisma 7); a line about Dart's packages is
kept only where it is the reason a choice stands.
An entry overturned by a later decision is replaced, not kept beside it.
Questions still open are at the end of `docs/design.md`.

## 1. The actor is a required flag on every write, trusted (owner)

- **Context.** v1 took a required `actor` argument on every MCP write. With
  the MCP server gone (decision 45) every write is a command an agent runs
  from its shell, and the CLI used to write as `owner` because only the
  person ran it. Measured under chord: every agent session inherits chord's
  one environment, with no variable naming the agent; team files and
  settings have strict schemas with no `env` key, so a per-agent variable
  needs a change to chord; an agent's shell keeps no `export` from one call
  to the next (Claude Code). `watch --exec` already sets `BOARD_ACTOR` and
  `BOARD_PROJECT` to the event's actor and project.
- **Options.** (a) `--actor NAME` required on every write, no variable, no
  default. (b) `BOARD_ACTOR` only, set once per session. (c) Both, the flag
  winning, one of them required. (d) A missing actor means `owner`, as the
  CLI did.
- **Choice.** (a). A missing `--actor` is cliffy's `required: true`: a
  usage error, exit 64, nothing opened. `project add`, `edit` and `rm`
  take it too, and `OWNER` leaves `board.ts`.
- **Consequences.** board records names and checks none. `board` is
  reserved for board's own acts (`claim_expired`, derived watch lines) and
  refused as input (`invalid_argument`, `field: actor`). A variable in the
  person's profile would have reached every agent, and every agent that
  forgot the flag would have written as the owner; (b) is not settable by an
  agent at all. The person types `--actor owner` (or keeps an alias). Every
  name in the log was typed by whoever acted, in a command that shows in its
  transcript. `BOARD_ACTOR` / `BOARD_PROJECT` stay `watch --exec`'s names,
  read by nothing in board.
- **Libraries.** `@cliffy/command` 1.3.1 `.env()`, tried for (c): the flag
  wins and an empty variable reads as unset, but `required: true` on the
  variable demands it even when `--actor` is given, and cliffy reads
  `process.env` itself (against "only `src/main.ts` reads the environment").
  Not used.


## 2. One command set for every agent (owner)

- **Context.** `main` uses commands (`board next`, `board answer`) that
  members should not need.
- **Options.** Commands split by role; one set, with roles in team
  instructions and in `board skill`.
- **Choice.** One set. board checks no roles.
- **Consequences.** Anyone may release or extend another's claim; `--holder`
  on those commands is a compare-and-set against a stale view, not an
  authorisation (decision 4). `board validate` is a command, trusted like
  every actor. `board skill` tells agents never to run `project` writes.
- **Libraries.** None involved.


## 3. Checkouts are informational, processes are out (owner)

- **Context.** Runs share a checkout and leave processes behind.
- **Options.** Track process groups; record the branch or worktree; leave
  both to the team.
- **Choice.** Processes are chord's job. A claim carries optional `directory`
  and `branch`, which board stores, shows (`board show`, `board status`,
  `board status`) and never checks.
- **Consequences.** No field about a checkout appears in any refusal. A
  claim's directory is not compared with its project's.
- **Libraries.** None involved.

## 4. The claimer sizes the lease (owner; details by the team)

- **Context.** A dead run must not hold a task forever, and runs differ in
  length.
- **Options.** A fixed default (two hours) renewed by the holder's writes; a
  duration chosen at claim with explicit extend.
- **Choice.** `board claim` takes `--minutes` (1–1440) with no default;
  `board extend` sets `until = now + minutes`; `board release` ends it early.
  The holder's other writes do **not** renew it: implicit renewal would match
  `actor` strings to `holder` strings board never checks, and a run looping
  on comments would hold its task forever. `extend` and `release` require the
  `holder` the caller saw. No claim token: a holder that releases and
  reclaims is the same run. The implicit release by `board edit` (close,
  send back) is unconditional, because it is `main` deciding.
- **Consequences.** An expired claim is not revived by extend; it is claimed
  again. The upper bound of a day catches a unit mistake, and a longer run
  extends.
- **Libraries.** None involved.

## 5. Expiry is swept by every write, machine-wide; reads never write

- **Context.** A claim past its end must free the task, with one
  `claim_expired` event, while many processes may notice it at once, and one
  file now holds every project.
- **Options.** Reads sweep (they need the write lock); writes sweep their own
  project; writes sweep every project; the watcher derives an unlogged line at
  `until`. A refused write rolls its sweep back, or commits it.
- **Choice.** Every write, after resolving its project, runs `DELETE FROM
  claim WHERE until <= :now RETURNING …` over every project and logs one
  `claim_expired` per row, in the claim's own project, with `data.by` read as
  "noticed by". The operation then runs inside `SAVEPOINT op`; a refusal rolls
  back to it, so the sweep commits even when the operation is refused, and the
  answer's `events` lists every id appended. Reads treat an expired claim as
  absent.
- **Consequences.** Exactly one event per expiry, because writes are
  serialised and the `DELETE` removes what it reports. A quiet project's
  lapsed claims are logged while the machine is busy. Reads stay lock-free,
  and `board watch` and `board sql` can open read-only. On an idle machine the
  event is logged at the next write; `claim_expiring` warns beforehand.
- **Libraries.** Tried in Prisma 7.10.0 with `prisma-adapter-bun-sqlite`
  0.8.0 (system SQLite 3.51.0): `DELETE … RETURNING` through TypedSQL, two
  processes, a committed sweep under a refused operation through a nested
  `$transaction` savepoint. A transaction that reads before it writes fails
  `SQLITE_BUSY_SNAPSHOT` or `SQLITE_BUSY` without waiting (989 of 1,000 under
  ten writers), which is why a write's first statement takes the lock
  (decision 11).

## 6. No duplicate detection; a substring filter, no FTS5 (owner)

- **Context.** Reviewers filed findings and checked by hand for duplicates.
  The first design searched with FTS5, whose query syntax breaks on ordinary
  text such as `APP-12`.
- **Options.** `board add` answering with likely duplicates; FTS5 with raw,
  quoted or split query text; a trigram index; a plain substring filter.
- **Choice.** `board add` adds; no `force`. FTS5 is removed entirely. The
  owner kept at most a plain substring filter, and that is `board ls
  --contains`: `LIKE :pattern ESCAPE '\'` on title and body, the
  pattern built in TypeScript as `%` + the text with `\`, then `%`, then `_`
  escaped + `%`, and bound, never spliced. 1–200 characters. Anything richer
  goes through `board sql`.
- **Consequences.** No character of the agent's text is a wildcard, and the
  filter cannot fail as a query. Case folds for ASCII only (no ICU in the
  bundled SQLite): `é` does not find `É`, there is no diacritic folding, and
  NFD does not find NFC. No index helps a leading `%`: about 31 ms over 10,000
  tasks with 2 KB bodies. `instr(lower(…))` would need no escaping and was
  noted; `LIKE` is what the owner named.
- **Libraries.** FTS5 in the bundled SQLite was tried and then dropped by the
  owner. `LIKE … ESCAPE` tried on `50%`, `%`, `_`, `\`, and non-ASCII case.

## 7. Milestones: a derived status, no closing by hand (owner; details by the team)

- **Context.** The owner asked for an ordered chain of milestones, each
  indivisible, done when all its tasks are closed, with `board next` preferring
  the earliest open one. With projects, the chain is per project.
- **Options considered.** A stored status with a hand close; a derived one. A
  finding against a done milestone refused or reopening it. `board next` after
  the current milestone: unassigned tasks first, later milestones first, or
  never later ones. Reorder by full list or relative move.
- **Choice.** The status is derived (`done`, `current`, `planned`); an empty
  milestone is open; there is no hand close. A finding with a parent and no
  milestone takes the parent's; adding, moving or reopening a task in a done
  milestone reopens it (`milestone_reopened`). `board next`: current → no
  milestone → later milestones; an explicit milestone restricts with no
  fallback. Moves are relative (`before` / `after`) and log
  `milestone_edited` with `position`. An empty milestone can be deleted.
  Names and positions are unique per project, and `none` is reserved.
- **Consequences.** A milestone cannot be declared done against its tasks;
  progress shows done and cancelled separately. The stale-view check of a
  full-order reorder is not offered.
- **Libraries.** `@modelcontextprotocol/server` 2.3.1 (and `package:mcp_dart`
  2.4.2 before it), probed in process: a `oneOf [name pattern, const
  "none"]` input refused the literal `"none"`, because it matches both. That
  is JSON Schema's `oneOf`, not a package's quirk. The input was the name
  pattern alone, with `none` meaning "no milestone"; the store refuses
  `none` as a name. With the MCP server gone (decision 45) the same holds
  for `--milestone`: a milestone type whose pattern `none` matches.

## 8. `blocked` is derived; a new task is `ready`

- **Context.** The first sketch listed `blocked` as a status set by a
  question.
- **Options.** Store `blocked` plus "status before"; derive it from open
  questions. New tasks in `backlog` (main promotes) or `ready`.
- **Choice.** Derived. Every answer and filter uses the effective status. A
  new task defaults to `ready`: a milestone's findings are its work, and
  `backlog` is main's choice. `done` refuses an open question; `cancelled`
  withdraws them.
- **Consequences.** No second copy of a fact to keep in step. `board edit`
  cannot set `active` or `blocked`.
- **Libraries.** None involved.

## 9. No reset command

- **Context.** With no migrations before the first release, a board of
  another schema version must be started over. With one file per machine, an
  in-place reset would delete every project's tasks and history, and it is
  what forced a board identity check on every operation.
- **Options.** Unlink and recreate the file; reset in place with a
  `board.instance` checked by every operation (the first design); reset one
  project; no reset, with offline recovery.
- **Choice.** No reset. A file of another version is `schema_mismatch`. The
  person stops the agents, moves `board.db`, `board.db-wal` and `board.db-shm`
  aside, and runs `board project add` again. `board.instance`, the
  `board_reset` error and the `board` table go. The removed-file `stat` guard
  proposed by runtime is not adopted: the procedure stops the agents first.
- **Consequences.** Nothing in board replaces the file's contents under a
  running process. A file removed by hand while agents work makes every
  later command `no_board`; a write in flight at that moment is lost, and
  the procedure stops the agents first.
- **Libraries.** Tried in Dart's `package:sqlite3`, before it was dropped: an in-place
  reset with `defer_foreign_keys` and a second connection open.

## 10. The file is marked as a board

- **Context.** A board must be told from another SQLite file and from another
  build's board, with no migrations.
- **Choice.** `PRAGMA application_id = 0x424F5244` and `PRAGMA user_version`,
  both in the header, both written in the transaction that creates the
  schema; `user_version` is checked at open and in every transaction. Errors
  `not_a_board`, `schema_mismatch`. Nothing reads an older format, and no
  shape is kept loose for one.
- **Libraries.** SQLite's header pragmas, read and written through Prisma's
  raw API; nothing written of ours. The creating transaction of `project add`
  takes its lock with `PRAGMA application_id` (a fresh file has no `project`
  table for decision 11's lock statement).

## 11. Concurrency settings: a deferred BEGIN whose first statement takes the write lock (owner)

- **Context.** Every write must take the write lock before it reads, so that
  no write upgrades a stale snapshot (decision 5), and `now` must be sampled
  after the lock (decision 12). The owner chose Prisma 7. No Prisma SQLite
  adapter can begin `IMMEDIATE`: `prisma-adapter-bun-sqlite` 0.8.0 and
  `@prisma/adapter-better-sqlite3` 7.10.0 run a bare `BEGIN`,
  `@prisma/adapter-libsql` 7.10.0 runs `transaction("deferred")`, none has
  an option, and `$transaction` takes only `isolationLevel`.
- **Options.** (F) Prisma and the adapter as they are, with a fixed no-op
  write as the first statement of every write transaction. (A) A delegating
  driver adapter of ours (about 50 lines on `SqlDriverAdapterFactory`) whose
  `startTransaction` runs `BEGIN IMMEDIATE`. (B) Raw `BEGIN IMMEDIATE` /
  `COMMIT` around plain client calls. (C) Writes on `bun:sqlite` directly
  (`db.transaction(fn).immediate()`), Prisma off the core path. (D) Wait for
  an upstream option. (E) A deferred read-then-write with a retry on
  `BUSY_SNAPSHOT`.
- **Choice.** (F) (owner). Every write is one Prisma interactive
  `$transaction` (`timeout: 10_000`, `maxWait: 30_000`), begun deferred by
  the adapter; its first statement is `UPDATE project SET id = id WHERE 0`;
  then `now`; then the steps of "Every operation". WAL; busy timeout 5 s,
  past which the agent gets `busy`; `synchronous = FULL`, set by board on
  each open; SQLite's automatic checkpoints; one connection per process,
  held by `Store` alone. No adapter code and no retry loop of ours. `busy`
  covers `P2010` / `P1008` whose original code is `SQLITE_BUSY`, and
  `P2028` as a defensive case.
- **Turned down.** (A) worked (lock at `BEGIN`, `busy` after 5023 ms, a
  savepoint through a nested `$transaction`) but is code around a package
  that F does not need. (B): every nested model write failed with `cannot
  start a transaction within a transaction`, and Prisma serialised nothing
  in process. (C) leaves Prisma off the path it was chosen for. (D) has
  nothing to take today. (E) changes decisions 5 and 12 and adds a retry
  loop. quarry's route (a 25 ms busy timeout and a retry loop of its own, to
  keep the event loop free) is not taken either: the freeze is accepted
  (below).
- **Consequences.** The lock relies on SQLite starting a write transaction
  for a statement that writes no row; a store test pins it. The busy wait
  blocks the whole process for up to 5 s (no timers, stdin or signal
  handlers), which is acceptable because a process never waits on a lock it
  holds itself; `board watch` and `board sql` read and never wait behind a
  writer. Prisma's `maxWait` and `timeout` are JavaScript timers and cannot
  fire during the wait; a command makes one write, so agents' writes behind
  a lock held elsewhere wait their 5 s side by side, each in its own process
  (the queue of v1's long-lived server, the n-th write after about 5n s, went
  with it). A plain client call made while a
  transaction is open runs inside it, so nothing but `Store` touches the
  client. No command installs a `SIGINT` handler (re-measured on the
  binary: `SIGINT` ends a waiting command in 3 ms, `SIGTERM` in 6 ms). Tests
  of concurrency spawn processes: two connections in one thread block each
  other in the busy handler.
- **Libraries.** Prisma 7.10.0, `prisma-adapter-bun-sqlite` 0.8.0, Bun
  1.4.3. Measured with several processes on one WAL file: a read-first
  Prisma write fails `SQLITE_BUSY_SNAPSHOT` 2 ms after it writes, and 989 of
  1,000 failed under ten writers; the lock statement takes the lock even when
  it matches no row; a contender waits and gets the lock when the holder
  commits (2.66 s) or `SQLITE_BUSY` at 5029 ms; ten processes × 100 writes:
  1,000 committed in 1.35 s, none failed. A busy, a throw, a unique
  violation, `SQLITE_FULL`, Prisma's own timeout, stdin closed, and
  `SIGINT` / `SIGTERM` / `SIGHUP` / `SIGKILL` each left the lock free and
  the client usable. A queue of 12 writes behind a 90 s holder: each `busy`
  after its own 5 s, no `P2028`. The event loop: no 100 ms tick for the
  whole 5 s wait. A watcher beside a writer holding, frozen, killed or
  recovering: worst tick gap 506 ms.

## 12. Time: one format, one injected clock, sampled after the lock

- **Choice.** UTC ISO 8601 with milliseconds and `Z`, fixed width, in storage
  and in every interface. One `Clock`; SQL never reads the time. A write takes
  `now` after its lock statement returns (decision 11). Durations are minutes, except
  `--exec-timeout`, which is in seconds.
- **Options considered.** Whole seconds in interfaces and milliseconds in
  storage (two formats); `now` taken before the lock (a 5 s wait would let a
  sweep miss a lapsed claim).
- **Libraries.** JavaScript's `Date`, truncated to milliseconds, formatted
  with `toISOString()`.

## 13. One error shape; usage errors are cliffy's

- **Context.** An agent branches on a refusal's code. With the MCP server
  gone (decision 45), the MCP SDK no longer validates input against schemas
  before board runs; cliffy parses every command's flags.
- **Options.** (a) board's own refusals in one shape, and cliffy's
  `ValidationError` for a command line that does not fit, as it is; (b) the
  input schemas kept and run through Ajv at run time on the parsed input, so
  every error has board's shape; (c) a `usage` code added to the enum and a
  JSON usage error under `--json`.
- **Choice.** (a). `{error: {code, message, next, details}}` from a closed
  list of 17 codes (+ `registry`, `board upgrade`'s): `not_found`,
  `claim_held`, `not_claimed`, `not_ready`, `invalid_transition`,
  `already_answered`, `cycle`, `invalid_argument`, `no_project`,
  `project_exists`, `busy`, `storage`, `no_board`, `damaged`,
  `not_a_board`, `schema_mismatch`, `internal`. A refusal exits 1, with
  `board: <code>: <message> <next>` on stderr, or the object on stderr under
  `--json`. A command line that does not fit is cliffy's: `board: usage:
  <message>`, exit 64, never JSON, before the board is opened. Every check
  the SDK's Ajv made moves to the parse (a cliffy `Type`, `value`,
  `required`, `conflicts`, `depends`, or an action check for "at least one
  of"), or is made unexpressible by the command's shape, or stays in the
  rules; the lengths that existed only in Ajv (body, comment, labels, actor,
  …) move to `lengthIn` at parse. `details.field` names the flag as typed
  (`waits-add`, `dir`, `N`), and `next` names commands. `no_board`'s
  detail is `file`, since `path` is the array of a `cycle`.
- **Consequences.** One exit code for every refusal, the code in a fixed
  place: an agent reads a word, not a number table. (b) would cost 20–25 ms a
  call in the binary (Ajv measured there) and keep two sources of the same
  limits; (c) would need finding `--json` in the raw argv, parsing of ours.
  The values allowed by `details.field` changed in four places (`waits_add`
  / `waits_remove`, `directory` of `project add/edit`, `key` of
  `project_exists`, `choice`). `Output validation error` goes: no output
  is validated at run time (decision 48). `sql` and `upgrade` keep their
  own failures (decisions 16, 36).
- **Libraries.** `@cliffy/command` 1.3.1: `ValidationError` names the flag
  for missing, unknown, conflicting, depending and repeated options and for
  type and `value` failures (probed). `@modelcontextprotocol/server` 2.3.1,
  which v1 used, goes with the server. Ajv 8.20.0 tried at run time (decision
  48).


## 14. Questions have machine-wide ids; the owner can override a delegate

- **Choice.** `Q<n>`, one sequence per machine, so `board answer Q7` needs no
  task key and no project and works from any directory. Options are
  `{label, detail?}` objects, 2–6, with `recommended` and `choice` 1-based.
  `withdrawn` is a public status. `--as` is required on `board answer`, with
  no default (owner): the CLI's old default `owner` would record `main`'s
  answer as the owner's now that agents run it. The owner's answer over an
  unvalidated delegate answer replaces it, and `question_answered.overrides`
  keeps the old one.
- **Options considered.** Numbers per task (two tasks' "question 1" collide in
  the CLI); per project (`BRD-Q7`, or `--project` on every answer); zero-based
  indexes.
- **Consequences.** A project's questions have gaps (`Q3, Q8, Q9`).
- **Libraries.** None involved.

## 15. `board watch` polls `data_version`

- **Context.** `board watch --follow` must see new events and warn before a
  claim runs out, without a daemon, now across every project of the machine.
- **Options.** Polling `max(event.id)`; polling `PRAGMA data_version`; file
  file watching; quarry's sockets from
  writers.
- **Choice.** `PRAGMA data_version` every 500 ms on a read-only connection,
  kept **before** each drain. The cursor moves over filtered-out events.
  `-p` keys become project ids at attach; a narrowed watcher ends on its
  project's `project_removed`, matched on `data.key`. `claim_expiring` is
  derived at `min(10 min, a quarter of the lease)` (`--expiring-within`
  overrides), once per lease per watcher, never logged. Derived lines share
  the logged shape with `id: null, derived: true`. There is no heartbeat.
  `--exec` runs sequentially with nothing dropped and a 30 s timeout; a warning
  whose window falls inside a running command is missed, and that is
  documented and pinned by a test.
- **Consequences.** Latency of up to half a second. Every watcher wakes on any
  project's commit, at about 6 µs a poll.
- **Libraries.** File watching (Dart's `package:watcher` / `File.watch`)
  tried and rejected: it reports `-wal` churn rather than commits, behaves
  differently per OS, and a timer is needed anyway for `claim_expiring`. On
  Bun, `PRAGMA data_version` works on a `bun:sqlite` `{ readonly: true }`
  connection, and a watcher kept its 500 ms ticks beside a writer holding,
  frozen, killed or recovering (decision 11).

## 16. `board sql`: a read-only open plus `query_only`, with three losses accepted; views to narrow (owner)

- **Context.** The owner asked for any read-only query, the refusal of every
  write, a check of the SQLite package before porting quarry's statement
  splitter, and `--project` to narrow. Narrowing must not rewrite the user's
  query. The Dart design refused a write before it ran
  (`sqlite3_stmt_readonly`) and a second statement (`checkNoTail`);
  `bun:sqlite` exposes neither.
- **Options.** (a) A read-only open plus `PRAGMA query_only = 1`, the losses
  documented, and an upstream request to Bun. (b) A `bun:ffi` binding of ours
  to `sqlite3_prepare_v2`'s tail and `sqlite3_stmt_readonly` on the system
  library. (c) No `board sql` until Bun exposes both. Earlier, for Dart:
  porting quarry's splitter, `?mode=ro`. To narrow: rewrite the query
  (refused), drop `--project`, or temporary views.
- **Choice.** (a) (owner). `bun:sqlite` `{ readonly: true }` on a throwaway
  connection, the `-p` views, then `PRAGMA query_only = 1`, then the user's
  statement; parameters are a usage error. No parser of ours. With `-p KEY`,
  board creates one `TEMP VIEW` per project table, under the table's name,
  from a fixed list (`claim` and `question` through a join on `task`), with
  the project id as an integer literal of board's own. The request to Bun
  for `Statement.readonly` and a tail check is the owner's to file.
- **Turned down.** (b) is code of ours around the package, with C pointers
  in the binary. (c) drops a command the owner asked for over losses that
  write nothing to the board.
- **Consequences.** Three losses, written into `board help sql` and the
  design: a write is refused when it runs, not before (`SQLITE_READONLY` is
  exit 64; other refusals are SQLite's message, exit 1); `VACUUM INTO`
  leaves an empty file at the path it names; a second statement silently
  does not run. A bare `ATTACH` of an existing file passes and is itself
  read-only. There is no time limit: `bun:sqlite` exposes no progress
  handler or authorizer. `-p` narrows and does not wall off:
  `main.<table>` and `sqlite_master` still see every project, and the help
  says so. A store test keeps the view list equal to the project tables.
- **Libraries.** `bun:sqlite` (Bun 1.4.3, system SQLite 3.51.0), a matrix of
  21 statements: with the read-only open and `query_only`, every write
  tried is refused and the board file is unchanged (`user_version`, rows,
  mtime); `VACUUM INTO` without `query_only` writes a full copy.
  `Statement` exposes `columnNames`, `columnTypes`, `declaredTypes`,
  `paramsCount` and nothing about read-only or the tail; `prepare` runs the
  first statement of several and drops the rest. `node:sqlite` under Bun:
  the same. Prisma's adapter cannot open read-only. Temporary views work on
  the read-only connection, shadow `main` for unqualified names, and refuse
  writes. Before the move, `package:sqlite3` 3.7.0 refused every write of 14
  statements with its three guards.

## 17. Projects are added by a person, with a key it chooses (owner)

- **Context.** `board init` made one board per directory with a prefix. With
  one board per machine, a project must be registered, and its key is the
  prefix of every task key.
- **Options.** A key derived from the directory or name (as quarry does); a
  key the person types. `board init` kept as an alias, or replaced.
- **Choice.** `board project add KEY [--name] [--dir]`, the key required and
  never derived, 1–10 characters, stored upper case, unique
  case-insensitively, never changed afterwards. `project ls`, `project edit`
  (name and directory), and `project rm` for a project with no tasks.
  `board init` is gone, with no alias. Only `project add` creates the board
  file, in the same transaction as the project; the check is repeated under
  the lock, so two first `project add`s create one schema. WAL is set just
  before that transaction, since SQLite cannot switch it inside one; a
  switch refused `SQLITE_BUSY` goes on to wait for the lock, and the file is
  checked to be in WAL under the lock before anything is written (owner,
  slice 1: setting WAL after the commit was rejected because it leaves a
  committed board briefly outside WAL).
- **Consequences.** Removing a project with tasks is out of v1, so no task key
  is ever reused. Projects are added by the person; `board skill` tells
  agents never to run `project` writes.
  Every other command on a missing file answers `no_board`, so a mistyped
  `BOARD_DIR` never creates a second, empty board.
- **Libraries.** `@cliffy/command` 1.3.1: the `project` command group as the
  `milestone` one is, each a `Command` mounted on the root.

## 18. The CLI is `@cliffy/command`; tables through `@cliffy/table` (owner: cliffy)

- **Context.** Commands, nested commands, repeatable comma-separated
  options with allowed values, conflicts, exit 64 on usage errors, `board
  help [COMMAND]`; aligned tables for `ls`, `status`, `project ls`, `sql`.
- **Options.** `@cliffy/command`, `commander`, `yargs`, `citty`, `cac`,
  `node:util` `parseArgs`; for tables `@cliffy/table` or `cli-table3`.
- **Choice.** cliffy (owner). One root `Command` with `throwErrors()` and one
  `catch` that maps a `ValidationError` to `board: <message>` on stderr and
  exit 64; groups as mounted `Command`s; list types split on commas,
  `collect: true` with a `value` that flattens, `EnumType` for allowed
  values; `conflicts`, `required` and `depends` checked at parse; `-p`
  declared per command; `HelpCommand` mounted `.global()`; help coloured only
  on a terminal. Tables are `@cliffy/table`, borderless.
- **Consequences.** No parsing of ours. `board help` reaches one level, so a
  subcommand's help is `board GROUP help SUB` or `--help`. A bare group
  prints its help and exits 0. Tables count terminal cells, so wide
  characters align and a newline in a cell continues in its column.
  `--json` stays the exact form. `board sql` takes its query as one quoted
  argument. Since agents work through the CLI (decision 45), cliffy is also
  where input is checked: the shape of one value in a `Type` or `value`
  hook, flags together in `conflicts` / `depends` / `required` or an action
  check, all exit 64 (decision 13). cliffy hands an unknown flag to an
  unfilled positional, so free text is never positional (decision 46); its
  `.env()` is not used (decision 1). cliffy comes from JSR, so `.npmrc` maps `@jsr` to
  `npm.jsr.io`; users get it inside the binary.
- **Libraries.** `@cliffy/command` and `@cliffy/table` 1.3.1 under Bun 1.4.3,
  from source, in a `bun build --compile` binary (as a copy and through a
  symlink) and under `bun test` with `.noExit()`; no shim (its runtime layer
  uses `process` when `Deno` is absent; the Deno-only helpers serve
  `@cliffy/command/upgrade`, not imported). Compared: `commander` 15.0.0
  (fits, with a comma-split `argParser` and a `--exec` check of ours),
  `yargs` 18.2.0 (no `help` command, aliases added to every option),
  `citty` 0.2.2 (no repeatable options, unknown options accepted), `cac`
  7.1.0 (no nested commands), `parseArgs` (no commands); `cli-table3` 0.6.5
  (the same output, one more dependency).

## 19. Built with `bun build --compile` over `prisma-adapter-bun-sqlite` (owner: Bun and Prisma 7)

- **Context.** The owner moved board from Dart to Bun, TypeScript and Prisma
  7 over SQLite, deleting the Dart implementation. The binary must be one
  signed file per platform that a user runs with nothing installed.
- **Options.** Adapters: `prisma-adapter-bun-sqlite` (`bun:sqlite`, the
  system SQLite); `@prisma/adapter-libsql` (a native addon with its own
  SQLite); `@prisma/adapter-better-sqlite3`. Schema: `prisma db push` at run
  time; migrations SQL embedded as quarry's `migrations.gen.ts`; Appendix A
  as the source with `schema.prisma` pulled from it.
- **Choice.** `bun build --compile --target=bun-darwin-{arm64,x64}` with
  Prisma 7.10.0 (generator `prisma-client`, runtime `bun`) and
  `prisma-adapter-bun-sqlite` 0.8.0. Appendix A is the source, as
  `src/store/ddl.ts` (an explicit array, run one statement per call);
  `schema.prisma` is pulled from it and only types the client; queries use
  the model API and TypedSQL. Prisma 7.10.0's pull mangles
  `question_to_validate`'s multi-line predicate; the pulled file is
  committed as it is (`validate` and `generate` pass; `migrate` is never
  run), Appendix A is not rewritten to suit it, and the bug goes upstream.
- **Consequences.** "The binary" is one file again (about 76 MB arm64, 84 MB
  x64): it runs as a copy and through a symlink. The SQLite is the user's
  macOS's (decision 20's floor), not one board ships, so `project add` and
  every read rely on its features. The adapter has one maintainer; it is
  about 1,100 lines of JS with no native part, pinned. The adapter creates a
  missing file, so board checks for the file first. Multi-statement strings
  run only their first statement, hence the array. The first x64 build needs
  the network once.
- **Libraries.** Bun 1.4.3, prisma and @prisma/client 7.10.0,
  `prisma-adapter-bun-sqlite` 0.8.0: built and run for arm64 and x64,
  relocated, running the embedded DDL and TypedSQL on a fresh `BOARD_DIR`.
  `@prisma/adapter-better-sqlite3` 7.10.0 (better-sqlite3 12.11.1): Bun
  refuses the addon (`ERR_DLOPEN_FAILED`). `@prisma/adapter-libsql` 7.10.0
  (`@libsql/client` 0.18.0): works from source, but the compiled binary
  loads its addon from the build machine's `node_modules` (a dynamic
  `require`), its ad hoc addon needs `disable-library-validation` under
  Developer ID, and it brings a second SQLite (3.45.1). `prisma db push`
  and migrations need the CLI and its engines at run time and keep a
  migrations table board does not want. With the MCP server removed
  (decision 45), `@modelcontextprotocol/server` and its Ajv leave the binary:
  382 modules become 273, 76.9 MB becomes 76.1 MB, and each call is 17–18 ms
  faster (decision 51).

## 20. macOS only, arm64 and x64 (owner)

- **Context.** The owner limited v1 to macOS, x64 included if the cross build
  is cheap.
- **Options.** Cross-compile from the arm64 Mac; an Intel CI runner.
- **Choice.** arm64 and x64, both built on the owner's arm64 Mac in one run:
  Bun cross-compiles (`--target=bun-darwin-x64`, under a second); Rosetta
  only runs the x64 self-test. macOS 13 or newer, Bun's floor (`minos
  13.0`).
- **Consequences.** No Linux, no Windows; `--exec` may rely on `sh -c`. No
  universal binary, since npm picks the package per architecture. **Known
  risk:** no Intel Mac is available, so x64 ships verified only under Rosetta
  (where it runs with and without the entitlement). This is recorded, not a
  release gate (owner). **Known risk:** only SQLite 3.51.0 (macOS 26) was
  tried; Appendix A needs 3.38 or newer.
- **Libraries.** Bun 1.4.3.

## 21. Distribution: npm only (owner; layout by the team)

- **Options.** npm; a Homebrew formula in a tap; tarballs on GitHub Releases.
- **Choice.** npm only for v1, as esbuild does it: the main package
  `@chorded/board` with a `bin/board.js` shim (the command is `board`) and
  exact-version `optionalDependencies` on `@chorded/board-darwin-arm64` and
  `@chorded/board-darwin-x64` (`os`, `cpu`), each holding the signed
  `bin/board` alone. The shim is a Node script (npm runs `bin` with the
  user's Node; the user need not have Bun); it `spawn`s the binary with
  inherited stdio, forwards `SIGINT` / `SIGTERM` / `SIGHUP` to it
  (decision 53) and re-raises its signal; no install script. Homebrew and
  tarballs are later, at most.
- **Consequences.** npm sets no quarantine, so the browser-download note
  (`xattr`) goes with the tarballs.
- **Libraries.** None; `npm pack` and `npm i` (npm 11.6.2, Node 24.13.0) of
  a Developer ID signed Bun binary: byte-identical, `0755`, no quarantine,
  `codesign --verify --strict` passes, v1's MCP round trip passed through the
  shim.

## 22. The pause is removed (owner)

- **Context.** v1 had `board_pause` / `board_resume`, refusing every write
  while paused.
- **Choice.** Removed entirely: the tools, the commands, the `paused` error,
  the per-write check and the state.
- **Why.** A pause only refused board writes while the agents kept working.
  Stopping work is `main` not starting runs and chord stopping them. It may
  come back later.
- **Libraries.** None involved.

## 23. One board per machine, with projects (owner; details by the team)

- **Context.** The owner moved from one board per project to one per machine,
  as quarry has, which overturns the "several projects in one board"
  non-goal.
- **Choice.** `$BOARD_DIR/board.db`, `BOARD_DIR` defaulting to `~/.board`,
  required to be absolute (a relative one would open a different file per
  process). A `project` table (key, name, directory). Tasks, milestones and
  events carry the project; claims and questions belong through their task.
  Task numbers are per project (`task.number`, `max + 1` under the lock;
  `task.id` stays internal). Parents, waits, milestones and a task's events
  stay inside one project by composite foreign keys, and a key of another
  project in a relation is `invalid_argument`. Milestone chains are per
  project. `board status`, `board next` and the milestone commands are always one
  project's; `board ls` and `board questions` take `--all` for every
  project; `watch` and `sql` see every project unless `-p` narrows.
- **Options considered.** One task sequence per machine (`APP-4013` as a
  project's first task); cross-project waits (one project's `board next` would
  depend on another's state).
- **Consequences.** Directory and file get default modes; the home directory
  shuts other users out on macOS, and `0700` would need FFI. A file of the
  machine pins the WAL for every project during a long `board sql`
  (checkpoints wait; writers do not).
- **Libraries.** Prisma 7.10.0 with `prisma-adapter-bun-sqlite` 0.8.0: the
  DDL, the composite keys (introspected as composite relations) and the
  numbering through TypedSQL, tried. Removal of an empty project under
  `defer_foreign_keys` was tried in Dart's `package:sqlite3` and is on the
  store test list for the new stack.

## 24. How a call finds its project (owner's rule; details by the team)

- **Context.** The owner fixed the order: a task key names its project;
  otherwise the working directory; otherwise the main repository's root
  through `git rev-parse --git-common-dir`; otherwise an error that says what
  was looked at and how to add the project.
- **Options considered.** A required `-p` (every agent's first command
  would fail); cwd only (no way out for a shell elsewhere); MCP roots (went
  with the server); caching git's answer; a pin, as v1's `board mcp
  --project KEY` was, kept as a `BOARD_PROJECT` variable (owner: no; every
  agent inherits chord's one environment, and `watch --exec` sets that name
  to the event's project).
- **Choice.** Key or question id → `-p KEY` (optional) → the cwd → git →
  `no_project`. Directories are compared as real paths, with a `/` boundary,
  the deepest winning. Each command resolves from its own process's cwd,
  inside the transaction, against the rows it reads there. git runs only when
  the cwd misses, outside any transaction: the operation rolls back, git is
  asked, and the operation runs once more. git's answer is never cached; a
  3 s timeout kills it; it costs about 25 ms a command (measured), which `-p`
  skips. The root is the parent of a common directory named
  `.git`; any other layout gives no root and says so. `no_project` tells an
  agent to ask the owner for a key rather than pick one.
- **One repository is one project (owner).** A project's directory is its
  repository's main root: `project add` and `project edit --dir` refuse a
  subdirectory or a linked worktree and name the root; a directory outside
  git is accepted. There are no subprojects, and no `--show-prefix`
  translation. Bare repositories (and separate git dirs, submodules) are not
  supported: their worktrees answer `no_project` unless `-p` is given.
- **Consequences.** A project added or moved is seen by the next command.
  `Place`'s shared pending git stays in the code, with one caller per
  process. git is an external program the owner named, not a package.
- **Libraries.** git 2.54 tried in a repository, a subdirectory, a linked
  worktree, `.git`, a bare repository, a separate git dir, a submodule and
  outside git. `git worktree list --porcelain` and `--show-toplevel` were
  tried and rejected. `fs.realpathSync` under Bun 1.4.3 tried with a symlink,
  `/tmp` and a mis-cased path (each gives the real path with the on-disk
  case, as `realpath(3)`); `process.cwd()` answers the real path.

## 25. Signed with Developer ID, notarised and published from the owner's Mac (owner; details by the team)

- **Context.** The owner chose Developer ID signing and notarisation over
  ad hoc binaries, and a release run locally as the sibling repository
  chorded's `Scripts/release.sh` does it, not in CI.
- **Options.** Ad hoc signatures with an `xattr` note; Developer ID without
  hardened runtime (notarisation refuses it); Developer ID with hardened
  runtime and (a) `com.apple.security.cs.allow-jit`, (b) no entitlement, or
  (c) `allow-unsigned-executable-memory`, which the owner had accepted for
  Dart. A CI job holding the certificate, an API key and an npm token in
  secrets; or a local script on the owner's Mac, using the keychain and the
  owner's npm login.
- **Choice.** `tool/release.sh [--dry-run]` on the owner's Mac:
  - It refuses a dirty tree, a version already published (the version is
    `package.json`'s), and a missing npm login.
  - It finds the one Developer ID Application identity of team
    `YQ8ZD2KZ3T` in the login keychain, refusing none or several.
  - It runs `bun run check` and builds arm64 and x64 on the arm64 Mac.
  - It signs each binary with `--force --options runtime --timestamp`,
    identifier `dev.katsuba.board` (after chorded's `dev.katsuba.chorded`),
    and one entitlement, `com.apple.security.cs.allow-jit` (owner, option
    a). It reads the signed entitlements back and stops on any difference
    from `tool/macos/board.entitlements`.
  - It self-tests both binaries, then notarises one zip of both with `xcrun
    notarytool submit … --keychain-profile roost-notary --wait` (the
    team-wide App Store Connect key in the login keychain). It keeps the log
    whatever the verdict and stops unless the verdict is `Accepted`.
  - It checks each binary against codesign's `=notarized` requirement
    (`spctl -a -t exec` rejects a bare Mach-O as not an app), then assembles the npm packages and verifies
    the installed copies.
  - It publishes the two platform packages, waits until npm answers for
    both at the version (decision 57), then publishes `@chorded/board`,
    from the owner's npm login. `--dry-run` stops before publishing.

  A rerun finishes a run that stopped between publishes, from the packages
  already built. There is no stapling, since a bare Mach-O cannot be stapled:
  Gatekeeper checks online on the first run of a quarantined copy. CI runs
  only tests and checks, with no signing step and no secrets.
- **Consequences.** `allow-jit` is required, not a speed-up. Under hardened
  runtime a Bun binary is never killed for lack of an entitlement, but
  without one JavaScriptCore runs with its JIT off and `SharedArrayBuffer`
  is undefined. Re-measured on the owner's Mac with the Developer ID (CLI
  build, no MCP SDK): with hardened runtime and an empty entitlements file,
  `--version` and `project add` work, and `board ls` answers `internal`
  (`ReferenceError: SharedArrayBuffer is not defined`); an ad hoc signature
  behaves the same; with `allow-jit` every call works. The earlier "everything
  works without it" was measured while the MCP SDK was in the binary and does
  not hold for the CLI. `allow-jit` is narrower than (c). Because some
  commands still work without it, the self-test alone does not prove the
  entitlement; the release's read-back comparison does.
  `disable-library-validation` is not needed: the only outside library is
  the system's `libsqlite3`, a platform library. A release needs the owner's
  Mac, keychain and npm login; nothing in CI can publish.
- **Libraries.** None. Tried on the owner's Mac with the real Developer ID
  and `--timestamp`: arm64 and x64 (under Rosetta) Bun binaries, a JIT probe
  and a Prisma + MCP probe, with no entitlement, `allow-jit`,
  `allow-unsigned-executable-memory`, and (ad hoc)
  `disable-executable-page-protection` and `disable-library-validation`;
  none was killed, and the JIT was off with no entitlement (and, on arm64, with `disable-library-validation` alone);
  `codesign --verify --strict` passes (Bun's payload is a `__BUN` segment);
  `spctl` before notarisation (`Unnotarized Developer ID`); the entitlement
  read-back (`{"com.apple.security.cs.allow-jit":true}`; `{}` for an
  empty file; nothing for an unsigned build); the npm pack and install round
  trip. Notarisation itself was not run in the design.

## 26. Milestone status is counted with the model API (owner, slice 1)

- **Context.** The design put milestone status (tasks per milestone by
  status) in TypedSQL. Prisma 7.10.0 `generate --sql` types every aggregate
  column of a per-group count as `null` once the query has a `$1` parameter:
  a scalar subquery per milestone, `LEFT JOIN … GROUP BY` with and without
  `CAST`, a plain `GROUP BY milestone_id, status`, a nullable `$1?` and a CTE
  wrapper all came out `null`. Without the parameter the same query types as
  `bigint`. Readiness and `board ls`, whose `count(*)` is top-level, type
  correctly and stay TypedSQL.
- **Options.** (a) The model API: `milestone.findMany` and
  `task.groupBy({ by: [milestone_id, status], where: { project_id } })`.
  (b) A parameterless TypedSQL query over every project's milestones,
  filtered in TypeScript. (c) Keep the parameter and assert the type over the
  generated one.
- **Choice.** (a), in one function in `src/rules/milestones.ts`. A query the
  model API can express uses it; one it cannot comes back to the owner.
- **Consequences.** Fully typed, nothing around Prisma, one round trip more
  than a single SQL query. (b) counts every project to answer for one; (c)
  is a type that lies. The bug is to be reported upstream.
- **Libraries.** Prisma 7.10.0 `prisma-client` generator with `--sql`, under
  Bun 1.4.3.

## 27. An empty `--contains` in the CLI means no filter (owner, slice 1)

- **Context.** `contains` is 1–200 characters, and the design meant
  `board ls --contains ""` to be a usage error. `@cliffy/command` 1.3.1 drops
  an empty option value before any type or `value` hook runs, so
  `--contains ""` and `--contains=` parse as the option absent.
- **Options.** (a) Accept cliffy's behaviour. (b) The same, and narrow the
  design's lower bound to the tool. (c) Inspect the raw argv for an empty
  value after `--contains`.
- **Choice.** (a). In the CLI an empty `--contains` is no filter, and
  `board ls` lists unfiltered with exit 0.
- **Consequences.** An empty variable in a script widens `board ls` instead
  of failing. Accepted at first because the CLI was for a person checking
  in; with agents on the CLI (decision 45) it still stands: an empty filter
  is a wider read, never a write, and (c) would be parsing of ours around
  the package. The same drop makes `--body ''` on `board edit` change
  nothing, hence `--no-body`, and makes a required flag given empty a usage
  error.
- **Libraries.** `@cliffy/command` 1.3.1, probed with a custom `Type` and a
  `value` hook; neither is called for an empty value.

## 28. Control characters are shown, not sent, in human CLI output (owner, slice 1)

- **Context.** Titles, bodies, actors and event data are written by agents
  and printed by `board ls`, `show`, `project ls`, and later `status` and
  `watch`. Raw, an escape sequence in them reaches the person's terminal:
  colours, cursor moves, OSC 8 links, window titles. `--json` is safe, since
  `JSON.stringify` escapes them.
- **Options.** (a) Show C0 and C1 control characters other than `\n` and
  `\t` as visible escapes (`\x1b` as `\u001b`). (b) Drop them silently, as
  `strip-ansi` does. (c) Leave them raw and accept it.
- **Choice.** (a), in human output only, through a maintained package if one
  does exactly this; our own few lines only if none fits, recorded here.
- **Consequences.** The terminal is never driven by board's data, and the
  person can still see that something was there; (b) would hide it. Machine
  output (`--json`, `watch --exec` stdin) is unchanged.
- **Libraries.** `escape-unicode` 0.3.0 (MIT, no dependencies), used as is
  through its documented `filter` option: C0 except `\n` and `\t`, and C1,
  become `\uXXXX`; it runs in a `bun build --compile` binary. Tried and not
  fitting: `jsesc` 3.1.0 (`minimal` escapes `\n` and `\t` too and passes C1
  such as `\x9b` raw; its other modes escape all non-ASCII), `strip-ansi`
  7.2.0 (drops instead of showing), `quote-js-string` 0.1.0 (escapes `\n` and
  `\t`, passes C1).

## 29. An extend after the clock jumped back past `since` is refused (owner, slice 2)

- **Context.** `board extend` sets `until = now + minutes`, and Appendix A
  keeps `CHECK (until > since)`. If the wall clock jumps back past a claim's
  `since` (claimed at 09:00 until 09:30, the clock now 08:00), `board extend
  --minutes 5` asks for 08:05, the CHECK refuses it, and the call answers `internal`,
  rolled back. "Runtime/Time" accepts that clock jumps move expiry but did
  not cover this case.
- **Options.** (a) Accept it as is. (b) Move `since` to now when now is
  before it, so `since` stops meaning the time the task was claimed. (c) Drop
  the CHECK.
- **Choice.** (a). Nothing changes; the refusal is `internal` and leaves the
  claim as it was.
- **Consequences.** It needs a backward jump on one machine larger than the
  lease's age, which is rare. The holder can release and claim again. The
  agent sees `internal` rather than a specific error in that case.
- **Libraries.** None involved.

## 30. `\n` and `\t` are escaped inside a `watch` line's fields (owner, slice 5)

- **Context.** Decision 28 shows control characters as escapes in human
  output but keeps `\n` and `\t` raw. `board watch` prints one event per
  line with tab-separated fields, so a raw newline or tab inside a field
  forges a line or a column for whoever reads or pipes the stream by line.
- **Options.** (a) Inside `watch`'s fields, show `\n` and `\t` as `\u000a`
  and `\u0009` too. (b) Decision 28 as written.
- **Choice.** (a). Everywhere else `\n` and `\t` stay raw, and `--json` is
  unchanged.
- **Consequences.** One event is always one line of the human stream.
- **Libraries.** `escape-unicode` 0.3.0, as in decision 28, with `\n` and
  `\t` added to its filter for these fields.

## 31. A narrowed `watch` filters by project in SQL (owner, slice 5)

- **Context.** "How it notices changes" narrows the drain query with
  `project_id IN (:ids) OR kind = 'project_removed'` and also says the cursor
  moves past every row read; the test plan asked that 1,200 events of another
  project move the cursor past them. With the condition in SQL those rows are
  never read, so the cursor cannot pass them.
- **Options.** (a) Keep the condition in SQL; the cursor passes every row
  the query returns, including rows dropped in TypeScript by `--kind` or
  `--task`. (b) Drop it from SQL and filter in TypeScript, reading every row
  on the machine.
- **Choice.** (a). The test checks that another project's events are not
  printed and cost one indexed query per tick.
- **Consequences.** A narrowed watcher's cost does not grow with other
  projects' traffic; its cursor stays behind their rows, which the index
  skips.
- **Libraries.** None involved.

## 32. `board upgrade` is cliffy's `UpgradeCommand` over one provider per package manager (owner; details by the team)

- **Context.** A person upgrading board must remember which manager
  installed it. The owner asked for `board upgrade` on
  `@cliffy/command/upgrade` and `@cliffy/upgrade` 1.3.1, with one provider per
  manager that extends `NpmProvider` and installs through that manager, so
  its records stay right and nothing swaps the binary behind its back.
- **Options.** cliffy's binary-swap path (`upgradeBinary`); cliffy's runtime
  script path; the provider's `upgrade()` hook with `standalone: false`.
  Managers: npm, bun, pnpm, yarn classic, yarn berry, Volta, Deno, npx/bunx.
  The manager's output piped (shown on failure) or inherited.
- **Choice.** `UpgradeCommand({ provider, standalone: false, spinner: false
  })` with four `NpmProvider` subclasses (`npm`, `bun`, `pnpm`, `yarn`),
  constructed with `{ package: "@chorded/board" }`, whose `upgrade()` runs
  `npm install --global`, `bun add --global`, `pnpm add --global` or `yarn
  global add` with `@chorded/board@<exact version>`, found on `PATH`, through
  `Bun.spawn` with stdio inherited, the environment unchanged, and no timeout
  or signal handler. Only the detected provider is mounted (decision 42).
- **Consequences.** The binary path is never reached (`NpmProvider` refuses
  it), and neither is the runtime path, which in a compiled binary would
  spawn board itself as `process.execPath install …`. No manager writes the
  binary in place, so running processes keep their old inode (probed with
  signed hardened-runtime fixtures; an in-place write is `SIGKILL`ed). The
  person sees the manager's progress and prompts, without a spinner. yarn
  berry (no global install), Deno, npx and bunx get no provider. Volta
  installs in npm's layout and is served by the npm provider.
- **Libraries.** `@cliffy/command/upgrade` and `@cliffy/upgrade` 1.3.1, from
  source, with a board-like root under Bun 1.4.3 and `tsc` 7.0.2. npm
  11.6.2, bun 1.4.3, pnpm 10.33.0 and 12.11.2, yarn 1.22.22 and 4.18.1, and
  Deno 2.9.7 were tried, each installing into a temporary prefix from a
  local registry or with `@biomejs/biome`. Nothing was installed globally.
  Drafts: `docs/design/drafts/upgrade/`.

## 33. `latest` is resolved to an exact version by overriding `resolveVersion`

- **Context.** `NpmProvider` delegates `latest` to the manager as `@*`.
  `bun add -g pkg@*` with a version installed changes nothing, exits 0 and
  records `"*"`, so board would report an upgrade that did not happen.
- **Options.** (a) Override the public `resolveVersion` so that `latest`
  becomes `dist-tags.latest`. (b) Narrow the protected
  `delegateLatestResolution` to `false`. (c) Keep delegation and spell
  `latest` per manager in `upgrade()`.
- **Choice.** (a). (b) fails `tsc`, because `NpmProvider`'s declaration types
  the member as the literal `true` (TS2416). The critic caught this; Bun's
  type stripping hides it. (c) never shows which version was installed.
- **Consequences.** Every manager gets an exact version, and the messages
  name it. One more registry fetch per plain `board upgrade`. A manager's
  min-release-age policy now refuses a too-new version instead of stepping
  down. bun and yarn record the exact version.
- **Libraries.** `@cliffy/upgrade` 1.3.1; checked with `tsc --noEmit` under
  board's `tsconfig.json`.

## 34. The installing manager is detected from the real path; none found is a refusal

- **Context.** The default provider is the manager that installed the
  running board. A binary can also be a copy, a development build, a local
  install, an npx or bunx cache, or a layout v1 does not recognise.
- **Options.** When nothing matches: fall back to npm; refuse unless a
  manager is named; refuse always.
- **Choice.** A pure `detectManager(realPath)` over an ordered table of path
  markers (npx, bunx, bun, pnpm, yarn, npm, none), each manager row requiring
  `@chorded/board-darwin-`. When none matches, every provider refuses,
  naming the path and the manual command per manager.
- **Consequences.** board never installs a second board somewhere else.
  "Refuse unless a manager is named" is not reachable, because cliffy's
  action receives only the chosen provider and cannot tell a typed `-r`
  from its default. Custom yarn global folders, pnpm global dirs, bun `globalDir`
  and npm's linked strategy are refused. The message says board "cannot
  identify a supported global installation", not that no manager installed
  it.
- **Libraries.** None; the layouts were probed per decision 32.

## 35. `registry`: a CLI-only refusal for an unreachable registry

- **Context.** `NpmProvider.getVersions` throws a plain `Error` offline or on
  a non-2xx answer. Inside the upgrade action, cliffy logs it and exits 1.
  `-l`'s option action runs outside that catch, so the error leaves `parse`
  and `main.ts` prints it as an internal error with a stack and "Report it".
- **Options.** (a) A new code `registry`, thrown by an override of the
  public `getVersions`, with `runCli` printing a `BoardError` as the
  commands do. (b) Leave it as `internal`.
- **Choice.** (a): `details {reason}`, `next` "check the network and try
  again; nothing was changed". `runCli` gains the `BoardError` branch.
- **Consequences.** One more code in Appendix B, used by the CLI only, like
  `project_exists`. Offline is a refusal, not a bug report.
- **Libraries.** `@cliffy/upgrade` 1.3.1; the listing itself is unchanged.

## 36. cliffy's own exits and exit codes are accepted in `board upgrade`

- **Context.** `UpgradeCommand` calls `process.exit(1)` after a failure and
  `process.exit(0)` after `-l`, past the root's `.noExit()`. An unknown
  `--version` is found after parse.
- **Options.** Accept; subclass `UpgradeCommand` and replace its action (not
  a documented extension point, a re-implementation).
- **Choice.** Accept. The codes fit board's convention: 0 done or already
  current, 1 every failure, 64 parse errors, 130 Ctrl-C. An unknown
  `--version` exits 1, not 64.
- **Consequences.** Command-level tests run in a subprocess through a test
  helper that builds the real CLI with an injected exec path, environment
  and, for registry cases, providers that override only `getVersions`. No
  global (`fetch`, `process.exit`) is stubbed, and production has no test
  branch.
- **Libraries.** `@cliffy/command/upgrade` 1.3.1.

## 37. The registry fetch is not bounded; versions come from npmjs.org only

- **Context.** `NpmProvider` fetches `registry.npmjs.org` with no timeout,
  from a private URL. Offline fails in under 100 ms. A silent network waits
  for Bun's limit, 360 s. A person's manager may install from a mirror.
- **Options.** Race `super.getVersions` against a 10 s timer in an
  override, or accept Bun's limit. List versions from npmjs.org, or override
  `getVersions` to ask each manager (`npm view`, …).
- **Choice.** Accept both as cliffy has them. The person has Ctrl-C, and no
  help or `--version` fetches (decision 41). board
  is published only on npmjs.org.
- **Consequences.** A mirror that lags makes the manager fail on the exact
  version. A blocked npmjs.org makes `board upgrade` fail although the
  mirror could install. `-f --version V` is the one path with no fetch.
- **Libraries.** `@cliffy/upgrade` 1.3.1; Bun 1.4.3's `fetch`, timed.

## 38. Ctrl-C during an install reaches the manager, as typed by hand

- **Context.** The shim, board and the manager share the terminal's
  foreground group. Probed: bun, yarn and pnpm 12 stop and keep the old
  version. npm rolls back for more than 13 s after the prompt returns.
  pnpm 10 leaves board uninstalled.
- **Options.** (a) Accept and document the reinstall line per manager.
  (b) The shim and board ignore `SIGINT` while the manager runs. (c) As (b),
  and the manager runs in its own process group.
- **Choice.** (a). (b) and (c) change the shim, which `board watch` also goes
  through, and (c) takes away cancelling a stuck install.
- **Consequences.** board is exactly as safe as its manager. The README,
  when `board upgrade` is built, gives the reinstall command per manager.
- **Libraries.** None; the managers of decision 32.

## 39. `board upgrade` never opens the board

- **Context.** An upgrade can cross a schema version (decision 10). Every
  command is its own process (decision 45), so the next command that runs
  the new binary sees the new schema version; a running `watch --follow`
  keeps the old binary until restarted.
- **Options.** (A) One line after success about what runs next. (A)+(C):
  also name the downgrade in `schema_mismatch`'s `next`. (B) Publish the
  schema version per release and warn before installing.
- **Choice.** (A). `upgrade` takes no store, so it works with no board and on
  a board the running binary refuses. `board upgrade --version <previous>`
  is then a way back from a mismatch. (B) needs a release change and a fetch
  of board's own, and (C) can follow the first release that fixes a schema.
- **Consequences.** A schema change shows on first use, with the existing
  `next`. The line reads "From now on, each board command runs the board
  your PATH finds, which is Y if PATH leads to the install just upgraded. A
  running board watch --follow keeps X until it is restarted." It promises
  no `schema_mismatch` (the board is not opened) and no binary (decision
  43). Two rule sets can serve one file while an old binary is still found
  through another `PATH`, which is accepted before the first release.
- **Libraries.** None involved.

## 40. cliffy's colours follow board's terminal rule

- **Context.** cliffy colours its upgrade messages through
  `@std/fmt/colors`, which under Bun stays on when piped and with
  `NO_COLOR`.
- **Options.** Call the documented `setColorEnabled(deps.colors)` at the
  entry point; accept ANSI codes in piped output.
- **Choice.** `setColorEnabled`, with `@jsr/std__fmt` added as a dependency
  under its own name (`"@jsr/std__fmt": "1.0.10"`, imported as
  `@jsr/std__fmt/colors`) at the version cliffy imports, so it is the same
  module. An alias (`"@std/fmt": "npm:@jsr/std__fmt@1.0.10"`) was tried in
  slice 7: Bun installs it as a second copy, and switching that copy leaves
  cliffy's colours on (owner, slice 7).
- **Consequences.** One more dependency, pinned to cliffy's.
- **Libraries.** `@jsr/std__fmt` 1.0.10, as cliffy 1.3.1 resolves it.

## 41. cliffy's version check is switched off through `hasRequiredPermissions` (owner)

- **Context.** With a command named `upgrade` mounted, cliffy's
  `checkVersion` runs on the root's long `--version`, every `-h`/`--help`
  and `HelpCommand`, fetching the registry with no bound and no catch. While
  `@chorded/board` is unpublished, and whenever offline, help and
  `--version` fail; tests asking for help would reach the network.
- **Options.** (a) The providers answer `hasRequiredPermissions()` with
  `false`, the one condition under which `checkVersion` skips the fetch.
  (b) Replace the help and version actions on every command and mount a help
  command of board's own. (c) Ask cliffy upstream for a switch, with (a)
  until it ships. (d) Keep the check.
- **Choice.** (a) (owner). The override carries a comment saying it switches
  the check off, since the method's name speaks of permissions.
- **Consequences.** Help and `--version` never touch the network, and the
  "new version available" hint is gone. The method's only callers in 1.3.1
  are `checkVersion` and `UpgradeCommand.hasRequiredPermissions`, which
  only `checkVersion` calls. A later cliffy that consults it before
  upgrading would make `board upgrade` refuse; the CLI tests catch that on
  the version bump.
- **Libraries.** `@cliffy/command/upgrade` and `@cliffy/upgrade` 1.3.1.

## 42. `board upgrade` updates the install it runs from; no `-r` (owner)

- **Context.** cliffy's `isOutdated` compares the target with the *running*
  binary's version before the provider runs, so `-r` naming another
  manager's install could answer "already latest" and install nothing, or
  report the wrong "from".
- **Options.** (a) Mount only the detected provider, which hides `-r`.
  (b) Keep `-r` and document `-f` for it. (c) Keep `-r` and refuse `-r`
  ≠ detected in the provider, which misses the "already latest" case.
- **Choice.** (a) (owner). This replaces the owner's earlier "`-r` picks
  one by hand". When nothing is detected, npm's provider is mounted and
  refuses (decision 34).
- **Consequences.** Installing board with another manager is a plain install
  with that manager, not an upgrade. cliffy's version comparison and
  messages are always about the install that runs.
- **Libraries.** `@cliffy/command/upgrade` 1.3.1.

## 43. The manager on `PATH` is the one that runs; no check of its root (owner)

- **Context.** A path names a manager's kind, not the install that the
  manager on `PATH` writes to: two nvm Nodes, a custom npm `prefix`, pnpm
  10 against 12, another `BUN_INSTALL`.
- **Options.** (a) Run whatever manager of the detected kind `PATH` finds.
  (b) Pass a root derived from the path (`--prefix`, `BUN_INSTALL`, …),
  rewriting the manager's input. (c) A read-only pre-check (`npm root -g`,
  `pnpm root -g`, `yarn global dir`; bun prints no root) that refuses on a
  mismatch.
- **Choice.** (a) (owner): board uses the environment it runs in.
- **Consequences.** With a mismatched `PATH` the upgrade goes to that
  manager's install and the running board stays as it is; the design and
  the README say so. No extra spawn, no second per-manager table.
- **Libraries.** None; the queries were probed (`runtime.md` §2) and are
  not used.

## 44. `upgrade -f --version` passes what is typed (owner, slice 7)

- **Context.** With `-f`, cliffy skips `isOutdated`, its only version check,
  and `resolveVersion` passes any value other than `latest` through, so
  `board upgrade -f --version '*'` or `'^0.2'` reaches the manager as a
  range. `bun add --global` can then leave the install as it is and exit 0,
  the no-op decision 33 closes for `latest`.
- **Options.** (a) Refuse anything that is not an exact version. (b) Leave it
  as is. (c) Under `-f`, check the version against the registry. (d) Resolve
  a range to the newest matching exact version through the registry.
- **Choice.** (b), for now. `-f` is for reinstalling or going back to a
  known version, typed exactly.
- **Consequences.** A range under `-f` behaves as the manager reads it: npm
  installs the newest match, bun may do nothing. Nothing is checked or
  fetched on that path.
- **Libraries.** None involved.

## 45. Agents use the CLI; the MCP server is removed (owner)

- **Context.** v1 served seventeen tools over stdio through
  `@modelcontextprotocol/server`, one `board mcp` process per agent, and
  kept the CLI for a person checking in. The owner: "MCP is not needed here
  at all; teach agents to do everything through the CLI."
- **Options.** Keep both interfaces; the CLI only.
- **Choice.** The CLI only. `board mcp`, `src/mcp/`,
  `@modelcontextprotocol/server` and `@modelcontextprotocol/client` go; every
  operation a tool offered is a command (decision 46); `board skill` prints
  the agent guide (decision 50). Rules, store, schema, the error codes, the
  expiry sweep, `watch`, `sql` and `upgrade` are unchanged. Nothing goes in
  `.mcp.json`.
- **Consequences.** Every call is one short process with one connection, as
  the CLI already was: no retried open, no captured cwd, no queue of writes
  in one process (decisions 11, 24), and a call costs about 75 ms (decision
  51). The input schemas lose their consumer (decision 48). The CLI's writes
  need an actor from the caller (decision 1). Tests drive the CLI in
  process, and across processes for concurrency; no MCP client is left in
  `test/`. A `.mcp.json` line starting `board mcp` now fails to start.
- **Libraries.** None added. `@modelcontextprotocol/server` and `/client`
  2.3.1 removed.

## 46. The command tree: flat verbs, typed positionals, flags for text

- **Context.** Seventeen tools become commands an agent types and reads back
  in its transcript; the CLI already had `status`, `ls`, `show`, `next`,
  `questions`, `answer`, `validate`, and the `project` and `milestone`
  groups.
- **Options.** (a) Flat verbs (`board claim BRD-14 --minutes 90`); (b) a
  `task` and a `question` group (`board task claim`), which renames six
  existing commands or keeps two names for each, and makes help two levels
  deep; (c) the tool names as commands (`board task_claim`).
- **Choice.** (a). `add`, `edit` (was `task_update`, matching `project edit`
  and `milestone edit`), `claim`, `extend`, `release`, `comment`,
  `handover`, `ask` join the existing commands; `project` and `milestone`
  stay groups; nothing existing is renamed. Four rules: free text is never a
  positional argument (cliffy hands an unknown flag to an unfilled
  positional, so `board add --tex x` would make `--tex` a title); a flag is
  its field in kebab case; one command per input shape (`comment` and
  `handover` instead of a `kind` with an `if/then/else`); cliffy checks the
  shape, `Board` the rules. Question options are numbered flags
  (`--option-1` … `--option-6`, `--detail-1` … `--detail-6`) with cliffy's
  `required` and `depends`. Clearing is cliffy's negatable options
  (`--no-parent`, `--no-body`). `--minutes` is a flag, not a positional. No
  short flags beyond the existing `-p`, `-f`, `-v`, `-l`. `-p` stays per
  command; commands that take a key or a question id take no `-p`. Every
  write gains `--json`.
- **Consequences.** The person's commands get longer (`board answer Q7 2 --as
  owner --actor owner`). `--help` for `ask` lists twelve option flags.
  `--directory` and `--branch` on `claim` have no default (main claims from
  its own checkout).
- **Libraries.** `@cliffy/command` 1.3.1, probed: an unknown flag before a
  `<title:string>` taken as the title; typed positionals refuse it; values
  with newlines, starting with `-` and `--x=-y` pass as is, `""` is dropped
  (decision 27); `--parent <KEY>` with `--no-parent` gives `false`, both is
  "can only occur once"; the two-argument option `--option <label>
  [detail]` with `collect: true` mixed shapes, refused a detail starting with
  `-` and threw on an empty one (not used); numbered options with `required`
  / `depends` checked at parse, naming the flag (used); a comma list with
  `collect: true` flattened by `value` (used).

## 47. Long text through the shell; board reads no stdin and no files (owner)

- **Context.** Bodies (20,000 code points), comments, handovers (four
  fields), question text and options must pass through an agent's shell
  safely.
- **Options.** (a) Every text a flag value, multi-line through a quoted
  heredoc inside `"$(…)"`; (b) also `--body-file` / `--text-file` with `-`
  for stdin; (c) a whole input object as JSON on stdin; curl's `@file`.
- **Choice.** (a). `board skill` teaches single quotes for one line, the
  quoted heredoc for anything else, never double quotes around text the
  agent did not write, and the two limits below.
- **Consequences.** No command can hang on input: a TTY, a pty, `/dev/null`
  and a closed stdin change nothing. macOS's `ARG_MAX` is 1 MiB for
  arguments and environment together, with no per-argument limit; the
  largest input, a handover, is at most 88 KB. Two limits the CLI adds: no
  NUL in any text (an argument cannot hold one; JSON could), and no trailing
  newline through `"$(…)"`, which strips every one. (b) adds a second path
  per field and stdin's lifecycle; (c) needs Ajv in the binary and a second
  contract beside the flags; `@file` would read a text starting with `@` as
  a path.
- **Libraries.** The shell. Tried for (b): `Bun.stdin.text()` (Bun 1.4.3)
  reads a pipe whole, `""` for `/dev/null` and a closed stdin, blocks on a
  TTY; `get-stdin` 10.0.0 the same, `""` on a TTY, works in a compiled
  binary. Measured through the binary: arguments of 80,000, 800,000 and
  1,000,000 bytes reached cliffy whole; 1,100,000 was refused by the shell.

## 48. Appendix B is output only, validated by tests

- **Context.** The input schemas had one consumer, the MCP SDK's Ajv, which
  ran them before a handler, and the SDK validated every successful output
  after it.
- **Options.** Keep the input schemas and run Ajv on the parsed input at run
  time; keep them as documentation; remove them. For outputs: validate at
  run time, or in tests.
- **Choice.** The input schemas and their `$defs` (`Actor`, `ProjectKeyIn`,
  `ProjectScope`, `KeyIn`, `QuestionIdIn`, `MilestoneRef`, `Minutes`) go; a
  command's input is its flags, and `Board`'s TypeScript input types. The
  output schemas stay in `src/schemas.ts` as `outputs.<command>`, with
  `json-schema-to-ts` for types, and are the `--json` contract. Tests
  validate every command's `--json` and every refusal with Ajv directly;
  every command with `--json` has a schema, and no schema is without a
  command.
- **Consequences.** No Ajv in the binary. A validation after a write's
  commit would have told the agent "failed" about a change that happened;
  an output mismatch is a bug found by the tests. `ajv` becomes a direct dev
  dependency (it was installed only through other packages).
- **Libraries.** Ajv 8.20.0, `ajv/dist/2020`: with `strict: true` it refuses
  the old `task_comment` input (`strictRequired` on `then.required`); with
  `strict: false` every schema compiles in 128 ms. At run time: 22–46 ms to
  import and 17–24 ms to compile one schema from source, 20–25 ms a call
  bundled in the binary. `ajv/dist/standalone`: 816 KB of generated code with
  CommonJS `require`s inside ESM and a build step; not taken.

## 49. Exit codes and the error line an agent reads

- **Context.** An agent must act on a refusal without parsing prose, and
  tell a refusal from a command line that does not fit.
- **Options.** One exit code for every refusal, the code in the output; an
  exit code per class (sysexits: 75 for `busy`, 69 for `no_board`, 65 for
  rules).
- **Choice.** 0 done; 1 refused (`board: <code>: <message> <next>` on stderr,
  the error object under `--json`); 64 usage (`board: usage: <message>`,
  never JSON); 130 / 143 by signal; 141 stdout closed (decision 52). A
  write's one line goes to stdout. `--json` is one object for the board
  operations; `milestone ls` and `sql` print arrays, `watch` lines, and
  `skill`, `help`, `upgrade` take none.
- **Consequences.** A refusal does not make the change asked for, but a
  write refused after its lock still commits the machine-wide sweep
  (decision 5); `internal` may follow a commit, so it says read first. `sql`
  keeps SQLite's own messages and its 64 after a read-only open (decision
  16); `upgrade` keeps cliffy's exits (decision 36). An exit code per class
  has no slot for most codes, and its table would live only in the docs.
- **Libraries.** `@cliffy/command` 1.3.1's `ValidationError` for usage.

## 50. `board skill`: typed prose and a generated index, tested

- **Context.** Agents must learn the board from the CLI itself; the text
  must not drift from the commands.
- **Options.** Generated whole from the cliffy tree; written text with a test
  that every command it names exists; both (as `../quarry/src/guide.ts`
  splits its guide). With or without an argument (a role, a topic).
- **Choice.** Both, no argument, no `--json`, stores nothing, opens no board.
  The prose (`src/skill.ts`) covers the model, `main`'s, a lead's and a
  member's flows, passing text, the notifier, reading a task's history,
  recovering a write that was cut off, and what to do per error code. The
  command index is walked from `buildCli`'s tree with each command's own
  description. Tests: every `board …` line of the prose parses against the
  tree with no-op actions; every error code has a row; the flows run against
  a temp board.
- **Consequences.** A renamed flag or command fails a test until the prose
  follows. A role argument was turned down: every role needs the model and
  the errors, and a lead sometimes acts as main.
- **Libraries.** cliffy's `getCommands()` for the walk. For splitting a line
  into words: `shell-quote` 1.8 and `string-argv` 0.3, to be tried when it
  is built; if neither fits, the weaker check is that each `board <path>`
  exists and each `--flag` is an option of its command.

## 51. One process per call is fast enough

- **Context.** The long-lived server paid its start once per agent; now
  every call starts a process and opens the board.
- **Options.** Accept it; lazy imports (Prisma only for commands that open
  the board); tune Prisma's start; a daemon (a non-goal).
- **Choice.** Accept it.
- **Consequences.** Measured on an M3 Pro, the arm64 binary without the MCP
  SDK, 40 runs each, medians: `--version` 32 ms, a read 73 ms, a write
  78 ms; +25 ms through the npm shim, +25 ms when git runs; the first run of
  a newly installed binary about 1.4 s, once. Of a read, about 37 ms is
  Prisma (`Store.open` and the first query's WASM plan), which has no option
  to tune. A session of a hundred calls spends about 8 s in board. Lazy
  imports would save about 9 ms on commands outside an agent's loop.
- **Libraries.** None added; Bun 1.4.3, Prisma 7.10.0 as built.

## 52. A closed stdout ends board quietly with 141

- **Context.** Bun ignores `SIGPIPE`: `board watch --json | head -1`
  printed a 17-line Bun stack and exited 1 (v1, measured), and agents cut
  output with `head`.
- **Options.** Leave it; handle `EPIPE` on stdout in the entry point.
- **Choice.** `src/main.ts` treats `EPIPE` on stdout as the end: no message,
  exit 141 (128 + `SIGPIPE`).
- **Consequences.** `set -o pipefail` sees what it sees for any Unix tool. A
  write whose answer could not be printed has still committed. A smoke-test
  step runs the binary into `head -c 1`.
- **Libraries.** None: it is the runtime's signal behaviour, handled on
  `process.stdout`'s `error` event and a throw from `write`.

## 53. The npm shim forwards signals

- **Context.** The shim `spawnSync`ed the binary, which blocks Node's event
  loop: `SIGTERM` to the shim's pid alone left a `watch --follow` running,
  reparented to `launchd` (measured). A harness that kills the command it
  started does exactly that.
- **Options.** Forward signals from an asynchronous spawn; have the watcher
  exit when its parent dies (polling `process.ppid`).
- **Choice.** `child_process.spawn` with inherited stdio, `SIGINT`,
  `SIGTERM` and `SIGHUP` forwarded, the child's signal re-raised or its
  status returned.
- **Consequences.** A signal to the whole group (Ctrl-C, chord's
  `stop_monitor`) reached both already and still does; decision 38's
  Ctrl-C during an upgrade is unchanged, the manager getting the terminal's
  signal. Polling for the parent would also kill a watcher detached on
  purpose with `nohup`.
- **Libraries.** Node's `child_process`; esbuild's shim has the same
  `spawnSync` shape and the same gap, so there is no package to take.

## 54. The agent's notifier is chord's `monitor` over `board watch --follow --json`

- **Context.** An agent must see `claim_expiring` in time to extend, and
  handovers and answers when they come, without a daemon and without a
  change to chord.
- **Options.** chord's `monitor` tool; a background job writing to a file;
  `watch --exec` running a board write.
- **Choice.** `board watch --follow --json -p KEY --since <cursor> --kind …
  2>&1` under chord's `monitor`, which delivers each stdout line to the
  session as a message and stops the process group on `stop_monitor`. A
  line is a wake-up, not data: the agent reads the task with board. The
  cursor starts at `board status --json`'s `last_event`, advances only on
  logged ids, catches up with a `watch` without `--follow` after a cut or
  dropped line, and survives restarts. `--exec` stays the person's notifier.
- **Consequences.** chord cuts lines past 1,000 characters, batches at most
  100 lines or 16 KiB, drops on a flood (over 1,000 lines or 256 KiB in
  10 s), allows 8 monitors a session and an hour each; `board skill` says
  so. `claim_expiring` is derived and not durable, so after a gap an agent
  checks `board status`. A file is not a notifier; a board write from
  `--exec` is seen by the same watch and runs again.
- **Libraries.** None; chord's `src/session/monitors.ts` and `src/shell.ts`
  read, not changed.

## 55. A closed stdout exits 141 with no `board:` line; earlier notes may show (delegate, slice 8)

- **Context.** "Errors" says board exits 141 with nothing on stderr when its
  reader closes stdout. Bun reports `EPIPE` as an asynchronous `error` event
  on stdout, not as a throw from `write`, so a note written to stderr before
  the event arrives is already out: `board sql 'SELECT * FROM task' | head
  -c 1` over 1,500 rows exits 141 after printing its "1500 rows" note.
- **Options.** (1) Accept it: no stack and no `board:` line, notes already
  written may show. (2) Write stdout through `fs.writeSync(1, …)` so `EPIPE`
  throws at once, which changes all stdout writing and may meet `EAGAIN` on
  a non-blocking descriptor. (3) Hold stderr notes until stdout drains and
  drop them on `EPIPE`, more code of ours.
- **Choice.** (1), by main as the owner's delegate, to be validated. The
  "Errors" row reads "nothing from board but notes already written".
- **Consequences.** `board watch --json | head -c 1` exits 141 with empty
  stderr; a command that writes a note before its rows may leave that note.
  The tests pin both.
- **Libraries.** None involved.

## 56. `board skill`'s command lines are split by the shell (delegate, slice 8)

- **Context.** The test that every fenced `board …` line in the skill's
  prose parses needs those lines split into words as a shell would. The
  prose has single quotes, trailing `# comments`, `2>&1`, backslash
  continuations and quoted heredocs inside `"$(…)"`.
- **Options.** (1) Run each fenced block under `/bin/sh -c` with `board`
  defined as a shell function that prints its argv NUL-separated, and parse
  those words against the no-op command tree. (2) `shell-quote` over whole
  blocks, with the prose changed to avoid continuations and the comment and
  operator objects dropped. (3) The design's weaker fallback: each command
  path exists and each flag belongs to its command.
- **Choice.** (1), by main as the owner's delegate, to be validated. The
  shell is the library, as for long text (decision 47).
- **Consequences.** Exact for every form the prose uses, no parser of ours,
  one `sh` per block (about 40, under a second).
- **Libraries.** `shell-quote` 1.8.4 (a trailing comment becomes a
  `{comment}` object, `2>&1` an operator object, a continuation an extra
  `""` word, and a heredoc's first line breaks it) and `string-argv` 0.3.2
  (a comment split into words, `2>&1` kept as a word, a continuation an
  extra `\` word, a whole heredoc block split wrongly); neither fits the
  prose as written.

## 57. The release waits for the platform packages before the main one (owner; details by the team)

- **Context.** At 1.0.0 `@chorded/board` went live while
  `@chorded/board-darwin-arm64@1.0.0` was still in npm's validation. In
  that window npm treats the missing optional dependency as no error:
  `npm i -g @chorded/board` and `board upgrade` installed the main package
  with no binary, pruned the old platform package, and left a `board` that
  could not run, so `board upgrade` could not fix it either.
- **Options.** (a) The release waits, after publishing the platform
  packages, until npm answers for both at the version, and publishes the
  main package only then. (b) A guard in `board upgrade` that refuses a
  version whose platform package does not answer; rejected by the owner:
  the fix belongs in the release only.
- **Choice.** (a), by the owner. The bounds are the team's: `publish_missing`
  in `tool/release.sh`, on the fresh and the resume path, asks
  `npm view @chorded/board-darwin-<arch>@<version> version` (the existing
  `published` helper) up to 60 times, 15 seconds apart (`wait_published`
  in `tool/release/lib.sh`). Each miss says on stderr which package@version
  it waits for and the attempt count. A registry failure other than a 404
  still stops the release, as before.
- **Consequences.** A release takes up to 15 minutes longer when npm is
  slow. A timeout leaves the platform packages published and the main one
  not, and says so; a rerun of `tool/release.sh` resumes from there without
  building again. A rerun while a platform package still does not answer
  would try to publish it again, and npm refuses a version it already holds,
  so the timeout's message says to rerun only once `npm view` answers.
- **Libraries.** None: a loop over the existing `npm view` check.
