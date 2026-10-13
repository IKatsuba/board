# v1: runtime

How board behaves at run time: several `board mcp` processes and CLI
invocations on one SQLite file, crashes and stale claims, the clock, the
compiled binary, and how all of it is tested. Answers the brief's "runtime"
questions; everything below was tried where it says so (see "Experiments").

## One finding the owner must decide first

**`dart compile exe` refuses `package:sqlite3` as it is today.** The current
`sqlite3` (3.7.0, SQLite 3.53.4) ships SQLite through a build hook, and

```
$ dart compile exe bin/fts.dart -o build/fts
'dart compile' does not support build hooks, use 'dart build' instead.
Packages with build hooks: sqlite3.
```

This holds with `source: system` in the hook's user defines too: the hook is
there either way, and `dart compile` refuses any package that has one.
`mcp_dart` has no hook. CLAUDE.md's stack says `dart compile exe`, so per
the one rule this goes up, not around. Options, all tried on macOS arm64:

| | Build | What ships | SQLite and FTS5 |
| --- | --- | --- | --- |
| **A** (recommended) | `dart build cli -t bin/board.dart` | `bundle/bin/board` (5.8 MB) + `bundle/lib/libsqlite3.dylib` (1.7 MB); the binary finds the library at `../lib/` relative to its real path | bundled 3.53.4, built with `SQLITE_ENABLE_FTS5`, the same on every OS |
| B | `dart build cli` with `hooks: user_defines: sqlite3: source: system` | one file in `bundle/bin/` | the OS's libsqlite3 (macOS: 3.51.0, FTS5 present); on Linux whatever the distribution built, FTS5 not verified |
| C | pin `sqlite3: ^2.9.0` (2.9.4) and keep `dart compile exe` | one file | the OS's libsqlite3, loaded with `dlopen` at run time; same caveat as B; an old major line |

Under A, a symlink to `bundle/bin/board` on `PATH` works (tried: the
library is found relative to the resolved path); copying the binary alone does
not (`Failed to load dynamic library '../lib/libsqlite3.dylib'`). `dart run`
and `dart test` run the hook themselves and need nothing.

A is recommended: FTS5 is a requirement (owner's decision 5), and only A
guarantees it without depending on how each OS built its SQLite. Its cost is
that "the binary" is a directory, and the `dart compile exe` line in
CLAUDE.md and the README's install story change to `dart build cli`.
**Everything else in this draft holds under A, B or C.**

## Module layout

Which logic lives where. Names are proposals; the boundary is the point.

```
bin/board.dart              CommandRunner from package:args; nothing else
lib/src/clock.dart          Clock (now() in UTC), SystemClock
lib/src/errors.dart         BoardError: one sealed type, one case per error code
lib/src/store/
  locate.dart               find .board/board.db from a directory upward
  open.dart                 open read-write or read-only, pragmas, identity check
  write.dart                Store.write(): BEGIN IMMEDIATE, the instance check,
                            now from the Clock, then a sync callback
  schema.dart               DDL and the schema version (data's content)
lib/src/rules/              the board's rules, pure Dart over a transaction
  tasks.dart claims.dart questions.dart milestones.dart pause.dart
  readiness.dart events.dart
lib/src/board.dart          Board: Store + Clock; one method per operation,
                            each one transaction calling into rules/
lib/src/mcp/server.dart     buildServer(Board) -> McpServer; decode args, call
                            Board, encode structuredContent + one text line
lib/src/cli/                one file per command; decode flags, call Board,
                            print; owns exit codes
lib/src/watch/
  derive.dart               pure: claims + now + threshold + said -> derived lines
  loop.dart                 the follow loop over injected source, clock, sleep
  exec.dart                 runs --exec for one line
lib/src/sql/readonly.dart   board sql: open read-only, prepare, gate, run
```

Rules for the layering:

- **`rules/` and `board.dart` know nothing of MCP, `args` or stdout.** Every
  rule the brief lists (what a claim allows, when a task is ready, what a pause
  refuses, milestone order, expiry) is a function over a transaction and a
  `now`, reachable from a test with an in-memory database.
- **The MCP server and the CLI are adapters.** They turn input into a `Board`
  call and a `BoardError` or result into output. No rule is decided there; a
  test that needs to reach a rule through the MCP client is a sign the rule is
  in the wrong place.
- **`buildServer` takes no transport.** `board mcp` connects it to
  `StdioServerTransport`; tests connect it to `IOStreamTransport` (below).
- **No `await` inside a write.** `package:sqlite3` is synchronous, and
  `mcp_dart` may dispatch two requests from one agent before the first
  finishes. `Store.write<T>(T Function(Tx tx, DateTime now) body)` takes a
  synchronous callback (the type is `T`, not `Future<T>`), so two writes on one
  connection can never interleave between `BEGIN` and `COMMIT`. The same holds
  for multi-statement reads (`Store.read`, a deferred `BEGIN` for one snapshot,
  so `task_read` never shows a claim from after its events).

## Connections and pragmas

One connection per process, opened once. `board mcp` opens it at start and
keeps it; each CLI command opens and closes one.

| Pragma | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | set by `board init`; persistent in the file, so other opens only check it |
| `busy_timeout` | `5000` | below |
| `foreign_keys` | `ON` | per connection, so set on every open |
| `synchronous` | `FULL` | an agent told "claimed" must still hold the claim after a power loss; writes are rare and tiny, so the extra fsync per commit is not felt. `NORMAL` would be safe from corruption but may lose the last commits |

`board sql` and `board watch` open with `OpenMode.readOnly` and set only
`busy_timeout`; they never write (see `board sql` below).

### Which board a process is on

A reset (`board init --force`) replaces the board inside the same file while
other processes keep it open. So that no process goes on working on the new
board while it still thinks it is on the old one:

- The `board` row has an `instance` column: a random value set by `init` and
  by every reset *(data's column)*. At open, each process caches `instance`
  and `PRAGMA user_version`.
- **Every operation, read or write, reads the board row and `user_version`
  inside its own transaction** (inside `BEGIN IMMEDIATE` for a write, inside the
  read's snapshot for a read), before anything else. A mismatch with the cache
  refuses the call with `board_reset` and changes nothing. The process then
  re-attaches: it re-reads `instance` and `user_version` (and refuses with
  `schema_mismatch` if the new version is not this build's), so the **next**
  call works on the new board. The call that saw the reset never does, because
  its caller decided on the old board.
- `board watch` does not re-attach. On `board_reset` it prints one line on
  stderr and exits non-zero: its cursor is an event id from the old board and
  means nothing on the new one.
- The check costs one primary-key read and one header read per operation.

## 1. Concurrency

**Every write is one `BEGIN IMMEDIATE` transaction, and every check a write
depends on is inside it.** "Is this task claimed by someone else?" and "take
the claim" are one transaction, so two servers claiming one task serialize on
the write lock: the second sees the first's claim and gets `claim_held`.
Measured: a deferred transaction that reads and then writes fails at once with
`SQLITE_BUSY_SNAPSHOT` (517) when another process committed in between, and
the busy handler is never consulted. That is why no write may start deferred.

**Busy timeout: 5 seconds.** A board write is a few rows and an FTS update,
milliseconds long; the realistic contention is ten or so agents' servers each
writing now and then. 5 s covers any queue of real board writes many times
over. What it does not cover is a holder that does not let go (a person in the
`sqlite3` shell with an open transaction), and there waiting longer only hides
it. Measured with a second process holding the lock: `BEGIN IMMEDIATE` with a
1000 ms timeout failed after 1063 ms with `SqliteException` 5/5 "database is
locked"; with 5000 ms it got the lock 2 ms after the holder committed. Reads
during a held write lock answered at once (WAL).

The wait blocks the server's isolate, since the package is synchronous. That is
acceptable: one server serves one agent, which has nothing else in flight that
could be answered meanwhile. No isolate pool.

**What the agent sees past the timeout:** an error result (`isError: true`)
with code `busy`, nothing changed, safe to retry: "the board is locked by
another writer for over 5s; nothing was changed; retry". The CLI prints the
same sentence and exits non-zero. *(Shape is interfaces'; flagged.)*

**Event order is `event.id`, never `at`.** Ids are assigned under the write
lock, so they are a total order across processes; `at` comes from each
process's clock and may disagree by microseconds.

**WAL checkpoints: SQLite's automatic one** (passive, at 1000 pages, by
whichever connection commits), plus the final checkpoint the last connection
does on close. Nothing of ours holds a read transaction open across time — the
watcher in particular reads in short statements, never one long transaction —
so a checkpoint is never starved and the WAL stays small. No manual
`wal_checkpoint` calls.

**Lease expiry and concurrency** *(data's question 4; runtime's view)*: the
expiry sweep is a write, `UPDATE`/`DELETE` the claims with `until <= :now`
and append `claim_expired` for each row actually changed, inside the writer's
`BEGIN IMMEDIATE`. Two processes noticing the same expired claim serialize on
the lock; the second finds no row and writes no event, so the event is written
exactly once. Recommendation: **reads do not write.** A read treats a claim
with `until <= :now` as absent (readiness, `task_next`, `board_status` all
filter by `:now`), so the answer is right without taking the write lock; the
`claim_expired` event is written by the next write of any kind, which sweeps
first. Reads that write would make every read wait on the write lock and fail
with `busy`, and `board watch` and `board sql`, which open read-only, could
not do it at all. Cost: on an idle board the `claim_expired` line appears only
at the next write. *(Depends on data; flagged.)*

## 2. `board watch --follow` without a daemon

### Noticing new events: `PRAGMA data_version`, polled

The watcher keeps one read-only connection and polls `PRAGMA data_version`
every 500 ms. The order is exact, because a commit can land between any two
steps:

**On attach (`--follow`):**

1. Read `data_version` and keep it.
2. Set the cursor: `--since` if given, otherwise `max(event.id)`.
3. Read the live claims (with the instance check).
4. Print the attach `claim_expiring` lines (below).

**On every tick:**

1. Read `data_version`. If it equals the kept value, skip to step 4.
2. Keep the new value **before** reading anything, then drain:
   `SELECT … FROM event WHERE id > :cursor ORDER BY id LIMIT 500`, print the
   rows that pass the filters, and **move the cursor to the last row read,
   whether it was printed or not**; repeat while a page is full, stop at the
   first short page. Advancing over filtered-out events is what keeps a filter
   for a rare kind from re-reading the same 500 rows forever.
3. Re-read the live claims.
4. Evaluate `derive` against `now` and print what it gives.

Keeping `data_version` before the drain means that a commit landing during the
drain changes it again and is read on the next tick; reading it after would
lose that commit until some later write. Reading claims after the events means
a derived line is never computed from claims older than the events already
printed.

Measured:

- `data_version` changes on a commit by another connection or another process,
  not on the connection's own writes (2 → 3 on another connection's insert, 3
  on its own, 4 after another process's), and works on a read-only connection.
- 10 000 × `PRAGMA data_version`: 57 ms, so about 6 µs a poll; at 2 polls a
  second the cost is nothing. (`SELECT max(id)` is cheaper still, 1.3 µs, but
  `data_version` also says when claims changed, which the derived line needs.)

Rejected:

- **File watching** (`dart:io` `File.watch` or `package:watcher`) on the
  `-wal` file: it does fire, but what it reports is file churn, not commits —
  the `-wal` file is created and deleted as connections come and go (seen:
  create, delete, delete, create for one writer process), macOS FSEvents
  coalesces with latency, inotify differs, and `package:watcher` falls back to
  polling where native events are missing. And the watcher needs a timer
  anyway, for `claim_expiring`, which is about time passing, not about writes.
- **A signal from writers** (quarry's sockets in `.quarry/`): it buys
  milliseconds of latency at the cost of every writer knocking on files, and
  of stale sockets after a kill. Half a second is fast enough for a person and
  for `--exec`.

### Deriving `claim_expiring`

The watcher keeps the live claims in memory, re-read whenever `data_version`
changes, and on every tick calls a pure function:

```
derive(claims, now, threshold, said) -> (lines, said')
```

- **Threshold:** by default `min(10 minutes, a quarter of the lease)`, the
  lease being `until − since` of the claim as it stands (so after an extend,
  the extended length). Leases are set by the claimer and range from minutes to
  hours: a fixed 10 minutes would fire at once on a 10-minute lease, a pure
  share would warn 30 minutes ahead of a 2-hour one, and the minimum of the two
  is sensible at both ends. `--expiring-within MINUTES` (1–1440, like every
  duration) replaces it with a fixed one.
- **Fires** when `until − threshold <= now < until`. A claim already past
  `until` gets no `claim_expiring` (it has expired; `claim_expired` is the
  logged line for that).
- **Once per lease, per watcher:** `said` is a set of `(task, holder, until)`.
  An extend changes `until`, so the extended lease can warn again, which is
  right: it is a new deadline. A release or expiry drops the entry. Held in
  memory and never written: the watcher opens read-only, and two watchers each
  print their own, as quarry's `no_daemon` is noticed by each watcher.
- **On attach:** a claim already inside its threshold when `--follow` starts is
  said once, before the first logged line.
- **Only under `--follow`.** A one-shot `board watch` reads history, where a
  line about now is a lie by the time it is read.
- **Distinguishable:** a derived line has the same flat shape as a logged one,
  with `id: null` and `derived: true` (empty `BOARD_EVENT_ID` under `--exec`),
  so a consumer that tracks its cursor by id cannot advance onto it. No
  heartbeat line.
- **Best effort while `--exec` runs.** The loop does not tick while a command
  runs (below), so a lease whose whole warning window falls inside one command
  gets no `claim_expiring`: when the loop comes back the claim is past `until`
  and nothing is derived. With the 30 s default timeout and a threshold of at
  least a quarter of the lease, that takes a lease under two minutes or a
  command that runs near its timeout. Logged lines are never lost this way;
  only the derived one is. The help text for `--exec` says so.

### `--exec`

- **Sequential, in stream order, one command at a time.** board's log is board
  moves only (no agent chatter, unlike quarry), so the rate is low, and order
  matters to a consumer (a claim before its handover). Sequential needs no cap
  and drops nothing: while a command runs the watcher does not read, and the
  events wait in the database, which is a durable queue. quarry runs calls
  concurrently and drops over 8 because its stream carries chatter; board does
  not need that.
- **How:** `Process.start('sh', ['-c', command])`, the line's JSON plus a
  newline on stdin, stdin closed after; the main fields in environment
  variables (names are interfaces'); the child's stdout and stderr copied to
  the watcher's **stderr**, never stdout, so a parser of the stream never sees
  them. A child that never reads its stdin is normal: the write is not awaited
  and a broken pipe is ignored.
- **Timeout:** 30 s by default, `--exec-timeout SECONDS` to change it (in
  seconds, the one duration that is not in minutes: a notifier is measured in
  seconds, and a minimum of one minute would be too long); past
  it the child gets `SIGTERM`, and `SIGKILL` 2 s later. The timeout is on the
  child's exit, not its pipes (a backgrounded grandchild must not hold the
  watcher). Grandchildren the command started are not tracked: processes are
  out of scope.
- **A failing command** (non-zero exit, timeout, failure to start) is one line
  on stderr — `--exec: exited 2: <command>` — and the watcher goes on with the
  next line. The cursor advances whether or not the command succeeded: a
  notifier that fails must not replay the stream.
- **Interrupt:** `SIGINT`/`SIGTERM` to the watcher terminate the running child
  the same way and exit 130/143.

## 3. `board sql` read-only

**The boundary, as the docs state it:** `board sql` runs one statement, on a
read-only connection, if SQLite marks it read-only (`sqlite3_stmt_readonly`)
or it is an `EXPLAIN`. Everything else is refused before it runs. A bare
`ATTACH` passes, and what it attaches is read-only too. There is no parser of
our own: what counts as read-only is SQLite's own judgement, not a list we
keep.

Tried before porting quarry's statement splitter; the splitter is not needed.
`package:sqlite3` gives two independent guards, and together they refuse every
write tried:

1. **`OpenMode.readOnly`** (`SQLITE_OPEN_READONLY`). The database refuses
   writes itself, and the flag carries over to `ATTACH`, so an attached file is
   also read-only and cannot be created.
2. **`CommonPreparedStatement.isReadOnly`** (`sqlite3_stmt_readonly`), checked
   after `prepare` and before stepping, so the refusal is ours, clean and
   before anything ran.
3. **One statement only:** `prepare(sql, checkNoTail: true)` throws on a second
   statement; a trailing `;`, whitespace or comment is accepted.

Results (`ALLOWED` means the statement ran):

| Statement | `isReadOnly` | `readOnly` open | `?mode=ro` URI | `query_only=1` |
| --- | --- | --- | --- | --- |
| `INSERT`, `CREATE`, `DROP`, FTS insert | false | refused (8) | refused | refused |
| `PRAGMA user_version = 5` | false | refused | refused | refused |
| `PRAGMA journal_mode = DELETE` | false | refused (5) | refused | refused |
| `PRAGMA wal_checkpoint(TRUNCATE)` | false | refused (10) | refused | ALLOWED |
| `PRAGMA query_only = 0; INSERT` | true, then false | refused | refused | ALLOWED |
| `CREATE TEMP TABLE` + insert | false | ALLOWED (memory, connection-local) | ALLOWED | ALLOWED |
| `ATTACH ':memory:'` + write into it | true for `ATTACH` | refused | ALLOWED | ALLOWED |
| `ATTACH '<new file>'` | true | refused, no file made | ALLOWED, **file made** | ALLOWED, file made |
| `ATTACH '<existing file>'` + `INSERT` | true for `ATTACH` | refused | ALLOWED | ALLOWED |
| `VACUUM INTO '<file>'` | false | **ALLOWED, file made** | ALLOWED | ALLOWED |
| `VACUUM`, `ANALYZE` | false | refused | refused | ALLOWED |
| `BEGIN IMMEDIATE` | false | ALLOWED | ALLOWED | ALLOWED |
| `WITH … INSERT … RETURNING` | false | — | — | — |
| `SELECT 1; DELETE FROM t` | — | `checkNoTail` throws; `select()` throws too | | |

So:

- `?mode=ro` is weaker than `OpenMode.readOnly` (it guards the main file
  only) and `PRAGMA query_only` weaker still; neither is used.
- `OpenMode.readOnly` alone lets `VACUUM INTO` write a new file;
  `isReadOnly` refuses it. `isReadOnly` alone passes `ATTACH` and
  `PRAGMA query_only = 0`; the read-only open makes both harmless. Hence both.
- `isReadOnly` also refuses a few harmless reads, `PRAGMA journal_mode`
  (no `=`) among them, because SQLite marks them as possibly writing. Accepted:
  the side to err on, and `EXPLAIN` of anything is still allowed
  (`isExplain`).
- What passes besides reads is a bare `ATTACH` of an existing file, opened
  read-only: a read of another file the user could read anyway. Connection
  pragmas SQLite marks read-only (`PRAGMA foreign_keys = ON`,
  `PRAGMA query_only = 0`) also pass. They change only this throwaway
  connection, and the read-only open still refuses any write. Everything
  else in the table that a write-capable statement could reach (`CREATE TEMP`,
  `VACUUM INTO`, `PRAGMA … =` that writes) is refused by `isReadOnly`.
- Not available: an authorizer (`SQLITE_OMIT_AUTHORIZATION` in the bundled
  build) and a progress handler (`SQLITE_OMIT_PROGRESS_CALLBACK`), so a long
  query is stopped by `Ctrl-C`, not by a time limit. A read-only query does not
  block writers in WAL.
- A statement with parameters (`?`) is refused before running: `board sql`
  takes none. *(Message is interfaces'.)*

The refusal names the command that owns the change, as quarry's does.

## 4. Time

- **One `Clock`, injected.** `abstract interface class Clock { DateTime now(); }`
  returning UTC; `SystemClock` in `lib/`, a settable `FakeClock` in
  `test/support/`. `Board`, the watch loop and `derive` take it; nothing in
  `lib/` calls `DateTime.now()` except `SystemClock`.
- **SQL never reads the clock.** Every comparison with now is a bound `:now`
  from the `Clock` — never `datetime('now')`, `CURRENT_TIMESTAMP`,
  `julianday('now')` or `unixepoch()`. Otherwise a lease test would depend on
  the wall clock. This is a review rule, not a test.
- **A write samples `now` after it holds the lock.** `Store.write` runs
  `BEGIN IMMEDIATE`, then the instance check, then `clock.now()`, and hands
  that `now` to the callback. A `now` taken before a 5 s busy wait would be up
  to 5 s old by the time it is written: an expiry sweep would miss a claim that
  had lapsed while it waited, and `at` would disagree with id order by the
  length of the wait. Taken after, writers' `now`s follow commit order,
  barring a clock jump.
- **One format** in storage and in every interface: UTC ISO 8601 with
  milliseconds and `Z`, `2026-10-12T09:14:03.123Z`. Fixed width, so text order
  is time order. Dart's `toIso8601String()` writes microseconds when they are
  non-zero, so the clock truncates to milliseconds before formatting, or widths
  differ and text order breaks.
- **Wall clock, not monotonic.** Leases are deadlines between processes, so
  only the wall clock is shared. A clock jump (NTP, a laptop waking) moves
  expiry with it: a jump forward can expire leases early, and the
  `claim_expired` event records it. Accepted for a single machine.

## 5. Failure modes

Each was tried where marked ✓.

| Situation | Outcome |
| --- | --- |
| ✓ A process killed (`SIGKILL`) inside `BEGIN IMMEDIATE` | Its uncommitted rows are gone; the OS releases the lock at once (the next writer got it in 0 ms); `quick_check` ok. A claim it had committed before stays until its lease runs out — the lease is what handles a dead run. |
| An agent exits and its `board mcp`'s stdin closes | The server closes the connection and exits 0. A write in progress is synchronous, so it has either committed or not started. |
| ✓ Write lock held past the busy timeout | `busy` error, nothing changed, retryable (§1). |
| ✓ No `.board/board.db` from the working directory upward | Never created implicitly: only `board init` creates (others open with `OpenMode.readWrite`, which fails with 14 on a missing file). CLI: message naming the directory searched and `board init`, exit non-zero. `board mcp` **still starts and lists its tools**; every call answers `no_board` with the same message, and the search is retried on each call, so `board init` run later is picked up without restarting the agent. A server that fails to start shows the agent only an opaque "MCP server failed". |
| ✓ Damaged file | A non-database file opens and fails on the first statement with 26 "file is not a database"; a damaged page fails at query time with 11 "database disk image is malformed". Error `damaged` with SQLite's message and the way out: stop the agents, move `board.db`, `board.db-wal` and `board.db-shm` aside, then `board init`. No repair attempted, and `--force` does not do it for you (below). |
| A SQLite file that is not a board, or a board from another build | `board init` and every reset set `PRAGMA application_id = 0x424F5244` (`BORD`) and `PRAGMA user_version` (the schema version, a constant in `schema.dart`; both read from the file header, no table needed). Every open checks both, and every operation re-checks `user_version` with the instance. Wrong id: `not_a_board`. Other version: `schema_mismatch`, "board.db has schema N, this build expects M; there are no migrations before the first release: `board init --force` starts over and deletes every task". |
| A reset while other processes have the board open | Their next operation refuses with `board_reset` and re-attaches; `watch` exits non-zero (see "Which board a process is on"). |
| ✓ Disk full | 13 "database or disk is full"; SQLite rolled the transaction back itself (`autocommit` was true after). Error `storage` with SQLite's message, nothing changed; the server keeps running. The same mapping for 10 (I/O), 8 (read-only file), 14 (cannot open). |
| An exception in our own code inside a write | `Store.write` rolls back in `finally` when `autocommit` is false and rethrows; the MCP adapter answers `internal` with the message; the server keeps running. |
| `board init --force` | **Never unlinks.** Unlinking would leave open servers writing to a deleted inode. On a file that opens as a board (any schema version), it resets in place: drop and recreate inside one `BEGIN IMMEDIATE`, set `application_id`, `user_version` and a new `instance`, and no `VACUUM` afterwards (it would need the whole file locked and gains nothing a small board needs). On a file that is not a readable board (`damaged`, `not_a_board`) it refuses, changes nothing, and says to move the three files aside by hand with the agents stopped: recovery is offline and the person's. |
| The board on a network file system | WAL needs shared memory between processes on one host; not supported, and said so in the docs. |

## 6. `dart compile exe` and libsqlite

See the finding at the top. Tried on macOS arm64 with Dart 3.12.2:

- `sqlite3` 3.7.0: `dart compile exe` refuses (build hooks); `dart build cli`
  produces the bundle with SQLite 3.53.4 and FTS5 working
  (`sqlite_compileoption_used('ENABLE_FTS5') = 1`, an `fts5` table with
  `unicode61 remove_diacritics 2` and `bm25()` ran in the built binary).
- `sqlite3` 3.7.0 with `source: system`: `dart compile exe` still refuses;
  `dart build cli` gives one file using macOS's SQLite 3.51.0, FTS5 working.
- `sqlite3` 2.9.4: `dart compile exe` works, one file with no SQLite inside
  (`otool -L` shows only system frameworks), `dlopen`s macOS's 3.51.0, FTS5
  working.
- Not tried: Linux and Windows. On Linux, options B and C depend on the
  distribution's build including FTS5.

`sqlite3_flutter_libs` is not needed: the hook replaced it.

## 7. Tests

No test reaches a real agent or a real `board` binary.

```
test/support/   FakeClock; a fresh in-memory board (schema + prefix);
                a temp-directory board for multi-connection tests;
                the MCP harness (below); captured CLI output
test/rules/     against the in-memory board, through Board with a FakeClock
test/store/     open, identity checks, write(), errors, concurrency
test/mcp/       through mcp_dart's client over an in-process transport
test/watch/     derive (pure), the loop, exec
test/sql/       the read-only gate
test/cli/       the CommandRunner in process
```

- **Rules, against an in-memory database** (`sqlite3.openInMemory()`): every
  operation's happy path and every refusal; that each write appends its event
  in the same transaction (a rule that throws leaves neither row nor event);
  readiness and `task_next` order; milestone progression; pause refusing every
  write and no read; lease expiry by moving the `FakeClock` past `until`
  (expired claim invisible to reads, `claim_expired` written by the next write,
  exactly once).
- **Store, against a temp file** (WAL needs a file): two `Database`
  connections in one test for the races — two claims of one task (one wins, the
  other gets `claim_held`), two sweeps of one expired claim (one event), keys
  under two writers. The busy timeout is tested with a second **isolate**
  holding `BEGIN IMMEDIATE` (the main isolate cannot hold and wait at once),
  and a short timeout so the test takes about 100 ms. Disk full through
  `PRAGMA max_page_count`. Damaged and foreign files written by the test.
  Missing file. Schema version and application id mismatch. A reset by one
  connection: the other's next read and next write both refuse with
  `board_reset` and change nothing, and the call after works on the new board.
  `--force` on a damaged or foreign file refuses and leaves the file
  byte-for-byte unchanged. A write's `now` is taken after the lock (a
  `FakeClock` advanced while a second isolate holds the lock shows in the
  written `at`).
- **MCP, in process.** Tried: `McpServer` and `McpClient` connected through
  two `StreamController<List<int>>` and `IOStreamTransport` (exported by
  `package:mcp_dart`), `listTools` and `callTool` round-trip, an
  `isError: true` result with `structuredContent` arrives intact. `mcp_dart`'s
  own logging goes to stderr, never into the stdio protocol. Tests: the tool
  list and input schemas; per tool one success and the error codes it can give;
  that `structuredContent` and the text line agree. Rules are not re-tested
  here, only that the adapter reaches them and maps errors.
- **Watch.** `derive` is pure: thresholds at both ends, the minimum, once per
  lease, re-armed by an extend, nothing for a claim past `until`, the attach
  line. The loop takes its source (a read-only `Store`), `Clock`, a `sleep`
  function and an output sink, so a test drives it tick by tick on a temp-file
  board, writing through `Board` between ticks. Loop tests: an event committed
  between reading `data_version` and the drain is printed on the next tick, not
  lost; with a `--kind` filter that matches nothing among 1 200 events, the
  cursor ends past all of them and the next tick reads no rows; a reset makes
  the loop exit non-zero; the derived line is flat with `id: null` and
  `derived: true`. **The missed window:** a 1-minute lease, a `FakeClock`, and
  an `--exec` command that blocks until the test advances the clock past
  `until` and releases it: no `claim_expiring` is printed and every logged line
  is. That is the documented best effort, pinned so a change to it is a
  decision. `exec` is tested with real
  `sh -c` one-liners: the JSON on stdin, the environment, sequential order, a
  non-zero exit reported on stderr and the stream going on, a `sleep 60` killed
  by a short timeout.
- **sql:** each row of the table in §3 is a test case, against a temp-file
  board.
- **CLI:** the `CommandRunner` run in process with its output written to
  injected sinks, against a temp-file board; exit codes and `--json` output.
  `watch --follow` through the CLI only for argument parsing; the loop is
  tested above.
- **The built binary: one minimal smoke test, added once the build is
  chosen.** It is tagged (`@Tags(['build'])`) and skipped unless a built
  binary is there, so plain `dart test` does not build anything. It runs the
  binary from the build output: `board init` in a temp directory, then
  `board mcp` over real stdio with `initialize`, `tools/list` and one
  `task_add` / `task_list` with search, which proves FTS5 is in the binary.
  The command that builds it (`dart build cli` under A or B,
  `dart compile exe` under C) is the owner's choice, so the test names no
  build tool. It locates the binary by a path given in the environment.

## Experiments

Run in a throwaway project outside the repository with Dart 3.12.2 on macOS
arm64, `sqlite3` 3.7.0 (SQLite 3.53.4) and `mcp_dart` 2.4.2, plus `sqlite3`
2.9.4 for option C. Results are quoted in the sections above: the build matrix
(§6 and the top), the read-only matrix (§3), `data_version` and file-watch
behaviour and cost (§2), busy timeout, deferred upgrade, `SIGKILL` mid-write,
disk full, damaged and missing files (§1, §5), and the in-process MCP round
trip (§7).

## Assumptions on other drafts (flagged)

- **data:** an `event.id` integer key assigned in commit order; claims carry
  `since` and `until`; expiry swept by writes, reads filter by `:now` (§1); a
  `board.instance` column set by init and every reset (resolution 2).
- **interfaces:** `--exec-timeout` is in seconds, against the minutes rule
  (§2); `--exec` environment variables and stdin as above; `board sql`
  refuses parameters and multiple statements.

## Open questions

1. **Build (owner):** A, B or C at the top; A recommended. CLAUDE.md's
   `dart compile exe` and the README change with A or B.
2. **Worktrees (owner):** a claim records the directory a run works
   in, which may be a git worktree outside the project; a `board mcp` started
   there finds no `.board/` walking upward. Should there be an override in v1
   (`BOARD_DB` in the environment, or `board mcp --board <path>` in that
   worktree's MCP configuration), or is starting agents inside the project tree
   the team's business?
3. **Idle expiry (data, lead):** with reads not writing, `claim_expired`
   reaches the log only at the next write. If a watcher waiting for it on a
   silent board matters, either the watcher also derives an unlogged line at
   `until`, or `board watch --follow` is allowed one write (the sweep), which
   means it can no longer open read-only. Recommendation: neither for v1.
4. **Windows (owner):** `--exec` uses `sh -c`, and the bundle layout was seen on macOS
   only. Is Windows a v1 target?
