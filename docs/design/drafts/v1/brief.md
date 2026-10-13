# Brief: v1

The whole first version of board, designed far enough that code can be written
from it without guessing. The starting point is `docs/design.md`; this brief
records what the owner has since decided and what each architect must answer.
The result is merged back into `docs/design.md`, with one entry per decision in
`docs/decisions.md`.

## The problem

`docs/design.md` names the model, the tools and the CLI, but not their exact
shapes: no schema, no tool input and output, no error forms, no account of
several server processes on one file, of a crash mid-write, or of how tests
reach the rules. Since it was written, the owner has answered its open
questions and added three things: milestones, `board watch` and `board sql`.

## The owner's decisions (fixed; do not reopen)

1. **Actor.** Every write takes a required `actor` string, trusted as given.
   chord passing the name in the environment is not in v1.
2. **One tool set.** Every agent sees every tool. Roles live only in team
   instructions; board checks no roles.
3. **Checkouts and processes.** Processes are out of scope (chord's job). A
   claim carries two optional informational fields: the directory and the
   branch the run works in. board stores and shows them (`task_read`,
   `board_status`, the CLI) and checks nothing about them.
4. **Lease.** There is no default length. The claimer sets the duration at
   `task_claim` from its own estimate, releases early when done, and extends
   through an explicit extend operation. Expiry still frees the task with a
   `claim_expired` event.
5. **No duplicate detection.** `task_add` adds; there is no `force` and no
   "likely duplicates" answer. `task_list` and `board ls` get full-text search
   over title and body through SQLite FTS5.
6. **Milestones.** An ordered chain of milestones in one board, with nothing
   above them (a feature is a parent task). A milestone is its own entity:
   name, what it delivers, its position in the chain, status. A task belongs
   to at most one milestone, independently of `parent`. A milestone is
   indivisible: tasks, findings included, are added to it. It is done when
   all its tasks are closed. `task_next` prefers ready tasks from the current
   milestone, which is the earliest open one.
7. **`board watch`**, modelled on quarry's `quarry watch` (sibling repository
   `../quarry`: `src/cli.ts` "watch", `src/events.ts`, `src/quiet.ts`). It
   prints events one per line, with `--follow` to keep waiting, filters by
   kind and task, `--json`, and `--exec` to run a command per line, with the
   line on stdin and the main fields in environment variables. It also emits
   a derived `claim_expiring` line some time before a claim runs out. The
   line is never written to the log; the watcher notices it, as quarry's
   `no_daemon` is noticed.
8. **`board sql`**, modelled on `quarry sql` (`../quarry/src/commands/sql.ts`,
   `src/sql.ts`). It runs any read-only query and prints a table or JSON. It
   refuses every write statement, because a change goes through the command
   that owns it so that its event is written beside it.

## Constraints

- Dart 3.12+, built with `dart compile exe`; `package:args`, `package:sqlite3`
  (WAL, busy timeout, every write in one `BEGIN IMMEDIATE`), `package:mcp_dart`,
  `package:test`.
- The one rule: take a maintained package before writing our own. Where a
  package does not fit, say what was tried and hand the question to the lead
  with options. Never work around the package on your own call.
- The rules (claims, readiness, pause, milestones) are pure Dart over the
  store, tested against an in-memory database. The MCP server is tested
  through `mcp_dart`'s client over an in-process transport.
- There is no release: the schema changes freely, with no migrations.
- Several `board mcp` processes, one per agent, write the same file at once.
  There is no daemon.
- Everything is in English. Nothing names a private path or machine.

## Non-goals

A daemon or runner. A UI beyond the CLI. Several projects per board, sync,
accounts, auth. Knowing chord's roles. Tracking processes. Detecting
duplicates. Migrations from earlier formats.

## Questions per architect

Each architect answers its own questions in its draft. Where an answer depends
on another's, state the assumption and flag it; the lead reconciles them.

### data (`data.md`)

1. The full schema: tables, columns, types, keys, indexes, `CHECK`s, foreign
   keys. Cover task, waits, claim (with directory and branch), question,
   event, board/pause, milestone, and the FTS5 table and how it is kept in
   step (triggers or writes in the same transaction).
2. Event kinds: the closed list, each with its `data` shape. Which writes
   append which events.
3. Key assignment (`<prefix>-<n>`) under concurrent writers. Milestone
   identity (key or name?).
4. Lease expiry: how a `claim_expired` event is written exactly once when
   several processes notice it at once, and whether reads (which take no
   write lock) write it at all.
5. Claim operations: claim with a duration, extend, release. Do the holder's
   other writes also renew the claim? Choose and justify.
6. Milestones in the data: ordering and reordering, status values, and what
   "done" means when tasks are `cancelled`. Can a milestone be closed by hand
   with open tasks? Where does a finding filed against a closed milestone go?
   What happens to a milestone with no tasks?
7. Readiness and `task_next` as queries: the current milestone first, then
   what? (Are tasks outside any milestone eligible, and in what order?)
8. Status transitions: which are allowed, and which are implied (for example,
   `blocked` while a question is open).
9. How `.board/board.db` is found from the working directory, and what
   `board init` (and `--force`) does.

### interfaces (`interfaces.md`)

1. Every MCP tool: name, input JSON schema, `structuredContent` output schema,
   the one-line text, and error results (not found, `paused`, claim held by
   another, invalid transition). One error shape for all of them.
2. The claim tools: `task_claim` (duration, directory, branch), extend,
   release. Their names and arguments.
3. Milestone tools: create, edit, reorder, close if allowed, and how a task is
   put into or taken out of a milestone (on `task_add`, on `task_update`).
4. `task_list` with FTS5 search, and its filters (status, parent, milestone,
   text) and paging.
5. `board_status`: what it shows, including the claims with directory and
   branch, and milestone progress ("milestone 2 of 5, 3 tasks left").
6. The CLI: every command, its flags and its output (human-readable and
   `--json`), including `board watch` (line format, filters, `--follow`,
   `--json`, `--exec` with stdin and environment variables, how a derived
   line differs from a logged one) and `board sql` (table and JSON output,
   the refusal message).
7. Whether `package:args` covers the CLI as is, with nothing written around it.

### runtime (`runtime.md`)

1. Concurrency: busy timeout value, `SQLITE_BUSY` under `BEGIN IMMEDIATE`, WAL
   checkpoints, and what the agent sees when the timeout is exceeded.
2. `board watch --follow` without a daemon: how it notices new events (polling
   `max(event.id)`, `PRAGMA data_version`, file watching through
   `package:watcher` or `dart:io`) and at what cost. How it derives
   `claim_expiring`: the threshold (fixed, a share of the lease, or a flag),
   and how it avoids printing the same line twice in one watcher. `--exec`:
   sequential or concurrent, timeouts, and what a failing command does.
3. `board sql` read-only: does `package:sqlite3` expose
   `sqlite3_stmt_readonly`, or a read-only open (`OpenMode.readOnly`, or the
   `?mode=ro` URI), and does that refuse every write, including
   `ATTACH`, `PRAGMA` with side effects, and multiple statements? Try it
   before proposing to port quarry's statement splitter.
4. Time: one clock, injected, so leases and expiry are testable. UTC storage
   format.
5. Failure modes: a process killed mid-transaction, a missing or damaged
   database, a database from another schema version (there are no migrations,
   so what message?), a disk-full error.
6. `dart compile exe` with `package:sqlite3`: system libsqlite or a bundled
   build (`sqlite3_flutter_libs` is Flutter only; check what the current
   `sqlite3` package offers for native builds, and whether FTS5 is in it).
7. Test layout: what is tested against the store, what goes through the MCP
   client over an in-process transport, and how `watch` and the CLI are
   tested without a real agent.

## Process

data, interfaces and runtime write their drafts in parallel, each only its own
file in `docs/design/drafts/v1/`. critic then reviews the brief and all three
drafts. The lead resolves conflicts and findings and merges.

## Resolutions after review

The lead's decisions on conflicts between the drafts and on the critic's
findings (numbers are the critic's). Items marked *owner* wait for the
owner's answer and are not decided here.

1. *Owner.* The build (A, B or C) is the owner's.
2. **Accepted.** `board` gets an `instance` column (random, set by init and by
   every reset). Each process caches it at open. Every operation reads the
   board row and `user_version` inside its transaction and refuses with
   `board_reset` on a mismatch, then re-attaches, so only the next call works
   on the new board. `watch` exits non-zero on a reset.
3. **Accepted in part.** extend and release require `holder` as a
   compare-and-set, with a mismatch answering `claim_held` and naming the
   current claim. Anyone may call them. No claim token: a holder who releases
   and reclaims is the same run. The implicit release by `task_update`
   (close, send back) is unconditional.
4. **Accepted.** Questions are `Q<n>`, one sequence per board. Options are
   `{label, detail?}` objects, 1-based in every interface. `withdrawn` is a
   public status.
5. **Accepted.** An owner's answer over an unvalidated delegate answer
   replaces it, with `answered_as = owner` and no validation fields.
   `question_answered` carries `overrides: {previous answer}`.
6. **Accepted.** A done milestone takes new and moved tasks and reopens
   (`milestone_reopened`); there is no `milestone_done` error. A finding with
   no `milestone` takes its parent's. Public status: `done`, `current`,
   `planned`.
7. **Accepted.** `task_next`: current milestone → no milestone → later
   milestones in order. An empty or exhausted current milestone falls
   through. An explicit `milestone` restricts to it, with no fallback. `from`
   is `current`, `unassigned`, `later` or `milestone` (explicit), or null.
8. **Accepted.** `cursor` is the id of the last event in the page, or the
   `since` given if the page is empty.
9. **Accepted.** The watcher reads `data_version` before draining events,
   and drains until a short page. The cursor advances over filtered-out
   events too.
10. **Accepted.** runtime's policy: sequential, `--exec-timeout` default 30 s,
    nothing dropped. `claim_expiring` is best effort while a command runs;
    this is documented and tested.
11. **Accepted.** data's kind names are the one catalog. `task_edited` and
    `milestone_edited` carry `{field: {from, to}}` for each changed field.
    `claim_released` carries an optional `note`.
12. **Accepted.** One catalog: `not_found`, `paused`, `claim_held`,
    `not_claimed`, `not_ready`, `invalid_transition`, `already_answered`,
    `cycle`, `invalid_argument` (FTS syntax included), `busy`, `storage`,
    `no_board`, `damaged`, `not_a_board`, `schema_mismatch`, `board_reset`,
    `internal`. `mcp_dart`'s input-validation shape is the one accepted
    exception.
13. **Accepted; sent back to interfaces.** Normative input and output
    schemas for every tool.
14. **Accepted.** `init` always targets the working directory; a nested board
    is allowed. The "already initialised" check is repeated under
    `BEGIN IMMEDIATE`.
15. **Accepted.** `application_id` is set by init and reset, value
    `0x424F5244`. No `VACUUM` after a reset.
16. **Accepted.** `--force` never unlinks. On a file that is not a readable
    board it refuses and says to move the file aside: offline recovery by
    the person.
17. **Accepted.** One time format, UTC ISO 8601 with milliseconds and `Z`, in
    storage and in every interface. Durations are minutes, 1–1440. Write-time
    `now` is sampled after the write lock is taken.
18. **Accepted.** `updated_at` is the `at` of the task's latest event. Reads
    treat an expired claim as absent (claim null, effective status `ready`).
19. **Accepted.** A new task defaults to `ready`: a milestone's findings are
    its work, and `backlog` is for main to choose. Filters use the effective
    status that reads return. The same key in both `waits_add` and
    `waits_remove` is `invalid_argument`. An update that changes nothing
    writes nothing.
20. **Accepted.** Milestone names follow interfaces' pattern, and `none` is
    reserved. Reordering is a relative move (`before` / `after`); the stale
    check by the full set is dropped. An empty milestone can be deleted:
    `milestone_delete`, `board milestone rm`.
21. **Accepted.** `board sql` runs any statement SQLite marks read-only
    (`isReadOnly`, or `EXPLAIN`) on a read-only connection. A bare `ATTACH`
    passes and stays read-only. The doc states this boundary; there is no
    parser. The example is fixed.
22. **Accepted.** A derived line is flat, `id: null`, with `derived: true`.
    The flag is `--expiring-within MINUTES`. No heartbeat.
23. **Accepted in part.** interfaces tries one maintained table package and
    reports the result. The clock grep test is dropped. A minimal smoke test
    of the built binary is added once the build is chosen.
24. *Owner.* The location override and the platforms.

Owner questions still open: the build; the FTS5 query syntax; whether a pause
lets answers through; the `--board` / `BOARD_DB` override; Windows;
whether `--prefix` is required.
