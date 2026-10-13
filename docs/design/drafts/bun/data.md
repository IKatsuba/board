# Draft: storage on Bun and Prisma 7 (data)

Everything below was tried on this machine (macOS arm64, Bun 1.4.3) in the
scratch directory `/tmp/bdp`, never in the repository. Packages, as installed
there:

| Package | Version | Role |
|---|---|---|
| `prisma` (CLI) | 7.10.0 | `db pull`, `generate`, `generate --sql` (dev only; npm `latest` is 8.0.0-rc.22, so 7.10.0 is pinned) |
| `@prisma/client` | 7.10.0 | the client, generator `prisma-client`, `runtime = "bun"` |
| `prisma-adapter-bun-sqlite` | 0.8.0 | the adapter chosen |
| `@prisma/adapter-better-sqlite3` | 7.10.0 (`better-sqlite3` 12.11.1) | tried, refused by Bun |
| `@prisma/adapter-libsql` | 7.10.0 (`@libsql/client` 0.18.0) | tried, works, not chosen |
| `@prisma/driver-adapter-utils` | 7.10.0 | read for the adapter interface |
| `bun:sqlite`, `node:sqlite` | Bun 1.4.3 built-ins | read-only connection for `board sql` and `watch` |

The probes are `/tmp/bdp/p*.ts`. They are named per answer, and the parts that
matter are quoted, because `/tmp` does not last.

**The owner's decision (through the lead):** option F. Prisma and
`prisma-adapter-bun-sqlite` are used as they are. Every write is Prisma's
deferred `$transaction`, whose first statement is `UPDATE project SET id = id
WHERE 0`; then comes `now`, then steps 3–9. There is no adapter code and no
retry loop of ours. Options A, C, D and E were turned down (§2).

## 1. Adapter

**Tried.**

- `@prisma/adapter-better-sqlite3` 7.10.0. Bun refuses the native addon
  outright: `error: 'better-sqlite3' is not yet supported in Bun` (code
  `ERR_DLOPEN_FAILED`, oven-sh/bun#4290). It is out.
- `@prisma/adapter-libsql` 7.10.0. It loads and works under `bun`. It brings a
  native addon (`@libsql/darwin-arm64`) with its own SQLite, **3.45.1**. It
  starts a transaction as `client.transaction("deferred")`. quarry
  (`../quarry/src/db.ts`) measured a connection poisoned after a busy timeout
  (writes accepted and then lost) and a held lock that `$disconnect()` did not
  release. The `--compile` question for its `.node` file is runtime's.
- `prisma-adapter-bun-sqlite` 0.8.0 (one maintainer, mvsk; peer
  `@prisma/client ^7.0.0`; it depends only on `@prisma/driver-adapter-utils`).
  It is pure TypeScript over `bun:sqlite`, so `--compile` has no native file
  to carry. Measured: CRUD, nested writes, interactive and batch
  transactions, nested `tx.$transaction` as a savepoint, `RETURNING`, TypedSQL.
  `connect()` is called once per `PrismaClient` (counted), so it uses **one
  connection per process**, as the design wants. Transactions are serialised
  in process by an `AsyncMutex` around `startTransaction`.

**Which SQLite.** On macOS, `bun:sqlite` loads the system library:
`vmmap` of a Bun process shows `/usr/lib/libsqlite3.dylib` (from the dyld
shared cache), and `sqlite_version()` answers **3.51.0**, the same as
`/usr/bin/sqlite3` here. The `3.53.4` string inside the `bun` executable is
not what `bun:sqlite` runs on macOS. `node:sqlite` under Bun answers 3.51.0
as well. Apple's compile options that matter here:
`DEFAULT_WAL_SYNCHRONOUS=1` (a WAL connection starts at `NORMAL`),
`OMIT_LOAD_EXTENSION`, `ENABLE_API_ARMOR`, `THREADSAFE=2`.

**Choice.** `prisma-adapter-bun-sqlite` 0.8.0, created with **no `wal`
option** (see §3): `new PrismaBunSqlite({ url: "file:" + path })`.

Consequences:

- The SQLite version is the one the user's macOS ships, not one board
  bundles. Appendix A needs `STRICT` (3.37), `RETURNING` (3.35) and built-in
  JSON (3.38). The macOS floor is an open question (§7).
- `bun:sqlite`'s `Database.setCustomSQLite(path)` could load a bundled
  dylib instead, but the binary would then be a file plus a library again,
  which is what decision 19 had to accept for Dart. It is not proposed.

## 2. BEGIN IMMEDIATE

**Finding.** No Prisma 7 SQLite adapter can begin `IMMEDIATE`. Read in the
installed sources: `prisma-adapter-bun-sqlite` runs `this.db.run("BEGIN")`,
`@prisma/adapter-better-sqlite3` runs `prepare("BEGIN")`, and
`@prisma/adapter-libsql` runs `transaction("deferred")`. None has an option.
`$transaction` takes `isolationLevel`, where SQLite accepts only
`SERIALIZABLE`. Prisma's transaction manager
(`client-engine-runtime/src/transaction-manager/transaction-manager.ts`)
leaves `BEGIN` to the adapter and sends `COMMIT` / `ROLLBACK` itself
(`usePhantomQuery: false`).

**The hazard, measured** (`p2-contend.ts deferred`, two processes): a Prisma
`$transaction` that reads `user_version` and the project, while another
process takes the lock and commits, then writes. It fails
`SQLITE_BUSY_SNAPSHOT` **2 ms** after the write is issued, with no busy
handler. Under load (`p5-stress.ts read`: 10 processes × 100 transactions,
read first), **989 of 1000 failed** within ≤150 ms (987 `SQLITE_BUSY` with no
wait, 2 `BUSY_SNAPSHOT`), and 11 committed.

**Option F, the owner's choice: a deferred BEGIN whose first statement takes
the write lock.** SQLite retries a write's lock through the busy handler when
the transaction holds no snapshot yet, so a transaction whose first statement
is a write waits like `BEGIN IMMEDIATE`. Measured (`p4-first.ts`,
`p5-stress.ts`, `p12-fail.ts`):

- **The lock is taken at the first statement**, even when that statement
  matches no row. After `UPDATE project SET id = id WHERE 0`, `DELETE FROM
  claim WHERE 0`, and a sweep `DELETE … RETURNING` that matched nothing, a
  second connection's `BEGIN IMMEDIATE` got `SQLITE_BUSY` at once.
- **It waits out `busy_timeout`.** Another process held the lock 3 s and
  committed: the first statement returned at 2660 ms, and the transaction read,
  wrote and committed. There was no `BUSY_SNAPSHOT`. When the lock was held
  7 s, it failed at **5029 ms** with `P2010`,
  `meta.driverAdapterError.cause.originalCode = "SQLITE_BUSY"`.
- **Under load:** 10 processes × 100 write-first transactions (lock, then
  `user_version`, `max(number)`, sweep, `create`): **1000/1000 committed in
  1.35 s, no failure.**
- **A refused operation keeps its sweep.** Nested `tx.$transaction(async op =>
  …)` is Prisma's savepoint. A nested callback that wrote a task and threw
  left no task, while the sweep and the writes after it committed (`p3-wrap.ts`,
  same Prisma path).

**The order of a write** (it replaces "Every operation", steps 1–2):

1. `db.$transaction(fn, { maxWait, timeout })`. The adapter runs `BEGIN`
   (deferred) under its in-process mutex.
2. First statement: `UPDATE project SET id = id WHERE 0`. It takes the write
   lock and waits up to `busy_timeout`; past it, `busy` and nothing written.
3. Take `now` from the injected clock. This is after the lock, so decision 12
   holds.
4. onwards: steps 3–9 as designed (user_version, project, sweep, `SAVEPOINT
   op` as a nested `tx.$transaction`, validate, apply, release, commit).

The sweep is **not** made the first statement. It needs `now` as a
parameter, so `now` would be sampled before a wait of up to 5 s. A lease
would then be measured from before the lock, and a claim lapsing during the
wait would be left unswept.

`project add` has its own lock statement, `PRAGMA application_id`, because a
fresh file has no `project` table yet; its full recipe is in §3.

**The public outcome of a write is `done` or `busy`, nothing else from
contention.** The store maps three Prisma shapes to `busy` (nothing
written):

| Prisma error | When | Measured |
|---|---|---|
| `P2010` (raw query) with `meta.driverAdapterError.cause.originalCode === "SQLITE_BUSY"` | the lock statement waited out `busy_timeout` | 5029 ms; `ROLLBACK` sent; rows 0; client usable |
| `P1008` with the same `originalCode` | the adapter's `BEGIN` itself failed busy (not reached under F: a deferred `BEGIN` takes no lock) | in option A's probe only |
| `P2028` "Unable to start a transaction in the given time" | **at start**: `maxWait` ran out while the transaction waited for the adapter's in-process mutex | rows 0; the queued `BEGIN` is discarded by Prisma; the next write committed (`p16-queue.ts`) |
| `P2028` "A query cannot be executed on an expired transaction" | **at execution**: `timeout` ran out; Prisma sends `ROLLBACK` | rows 0; lock free; client usable (`p12-fail.ts timeout`) |

A `P2028` at execution could, in principle, also come from a callback that
hangs, not from contention. The store's callbacks do no I/O and await no
timer: git runs before the transaction, and a missing answer rolls back and
retries once (step 4). A `P2028` at execution is therefore contention in
practice, and its result (nothing written) is the same as `busy`'s. The store
recognises busy by these shapes and by nothing else. Every other error stays
`internal`.

**The store never calls the client outside a transaction.** Measured
(`p4-first.ts inproc`): two concurrent `$transaction`s on one client are
serialised by the adapter's mutex. A plain `db.event.create` issued while a
transaction was open is not. It ran on the same single connection inside
the open transaction, and it vanished without an error when that transaction
rolled back. So every store call, read or write, is a `$transaction` (a read
is one deferred transaction anyway), and nothing else holds the client. How
requests from one agent are queued is runtime's question 3.

**Every failure ends in ROLLBACK, and the lock is free after it.** Measured
in `p12-fail.ts` and `p14-signals.ts`. "Free" means another process's
`BEGIN IMMEDIATE` with no busy timeout succeeded at once. "Usable" means the
next write on the same client committed.

| Case | What Prisma sent | Lock after | Client after |
|---|---|---|---|
| Lock statement fails busy after 5062 ms | `ROLLBACK` | free once the holder committed (nothing of ours held it) | usable |
| Callback throws (`internal`, an escaping refusal) | `UPDATE …`, `INSERT …`, `ROLLBACK` | free | usable; the write's rows: 0 |
| Statement fails, `P2002` unique | `…`, `ROLLBACK` | free | usable; earlier rows of the write: 0 |
| Statement fails, `SQLITE_FULL` (`max_page_count`) | no `ROLLBACK` logged (SQLite rolls the whole transaction back on `FULL`) | free | usable; earlier rows: 0 |
| Prisma's `timeout` fires (2000 ms, lock wait 2.5 s, then one `await`) | `UPDATE …`, `ROLLBACK`; next query `P2028` "expired transaction" | free | usable |
| stdin closed, `process.exit(0)` with the write open | — | free | rows: 0 |
| `SIGINT` / `SIGTERM` / `SIGHUP` / `SIGKILL` with the write open | — | free (exit 130 / 143 / 129 / 137) | rows: 0 |

quarry's `$disconnect()` problem does not arise on this path. Prisma itself
sends `ROLLBACK` on every failure in the table, and a process that ends
drops its locks. One artefact to know about for tests: a writer started with
a shell's `&` ignores `SIGINT` (non-interactive shells set it to `SIG_IGN`).
Its callback then ran to the end and committed. The signal tests must spawn
from Bun (`p14-signals.ts`), not from `sh … &`.

**Prisma's timers and the blocked event loop.** `busy_timeout` blocks in C,
with the event loop stopped, so Prisma's `maxWait` and `timeout` timers
cannot fire during a lock wait. A timer fires at the first macrotask after
it. Measured:

- **`timeout`.** With a 2000 ms `timeout` and a 2.7 s lock wait, the write
  committed when the callback never yielded to a macrotask. It was rolled back
  (`P2028`, nothing written, lock freed) when the callback made one 10 ms
  `await`.
- **`maxWait`, a burst behind a stuck holder in another process**
  (`p15-burst.ts`, 10 concurrent writes on one client, the holder keeping the
  lock 50 s). The writes ran one after another through the adapter's mutex,
  and each waited out its own `busy_timeout`: `busy` at 5008, 10010, …,
  45033 ms. The tenth committed at 49668 ms, once the holder let go, and the
  next write was `done`. **No `P2028`, even though the later writes waited
  well past `maxWait` (30 000).** Each mutex hand-over and the next `BEGIN`
  settle in microtasks, before any timer callback runs. With `maxWait: 2000`
  and 4 writes, the result was the same: `busy` at 5, 10, 15 and 20 s.
- **`maxWait`, a burst behind an in-process transaction that yields**
  (`p16-queue.ts`: A holds the mutex and awaits a 3 s timer; 5 writes queue
  with `maxWait: 2000`). All 5 got `P2028` at start at 2002 ms. A committed,
  the 5 wrote nothing, and the next write was `done`.

The bound on a call is therefore **not** `maxWait`. It is `busy_timeout`
times the call's position in the in-process queue, because the queue drains
while the loop is blocked. A burst of n writes from one process behind a
stuck holder answers `busy` to each, at 5 s, 10 s, …, 5n s. Both outcomes are
`done` or `busy`. The latency of a burst is for runtime (its question 3: how
one agent's requests are queued, and whether the server refuses a request
while one is in flight).

The values the store sets, so that a mere wait ends as `busy` from SQLite
and not from Prisma's timers:

- **`timeout: 10_000`.** `busy_timeout` (5 s) plus a margin for the work,
  which takes milliseconds. Since no store callback yields to a macrotask,
  the timer cannot fire on contention alone. It remains the only bound on a
  callback that hangs while holding the machine's write lock, and that ends
  in `ROLLBACK`.
- **`maxWait: 30_000`.** It cannot fire behind blocked waits (measured). It
  could fire only behind an in-process transaction that yields, which the
  store does not have. It is a backstop, and when it fires the outcome is
  `busy` with nothing written.
- The adapter's `AsyncMutex` refuses with `Transaction queue full` after
  1000 queued transactions. One agent per `board mcp` does not reach that,
  and runtime's queuing bounds it.

**Options turned down** (all measured or read, kept for the record):

- **A. A delegating driver adapter of ours** (about 50 lines on
  `SqlDriverAdapterFactory`; `startTransaction` runs `BEGIN IMMEDIATE`, the rest
  delegates; `p3-wrap.ts`). It worked: lock at BEGIN, `P1008`/`SQLITE_BUSY`
  after 5023 ms, a savepoint through a nested `$transaction`, the client usable
  after busy. Turned down because it is code of ours around a package, and F
  needs none.
- **B. Raw `BEGIN IMMEDIATE` / `COMMIT` through `$executeRawUnsafe`** around
  plain client calls (`p2-contend.ts raw`). The locking was right, but every
  nested model write failed with `cannot start a transaction within a
  transaction` (Prisma wraps those in its own `BEGIN`), and Prisma serialises
  nothing in process.
- **C. Writes on `bun:sqlite` directly** (`db.transaction(fn).immediate()`,
  a synchronous callback as in the Dart design). Turned down because it
  leaves Prisma off the core path the owner chose it for.
- **D. An upstream option** (a transaction mode in the bun adapter or in
  Prisma). Nothing to take today; it may be worth an issue later.
- **E. Deferred BEGIN with a retry on `BUSY_SNAPSHOT`.** It changes decisions
  5, 11 and 12 and adds a retry loop of ours.

**Risk carried by F.** The lock statement relies on SQLite starting a write
transaction for a statement that writes no row. A store test pins it: after
the first statement of `write`, a second connection's `BEGIN IMMEDIATE` must
get `SQLITE_BUSY`. If a future SQLite optimised `WHERE 0` away, that test is
what fails.

## 3. Pragmas and connections

**What the adapter does at `connect()`** (read in `dist/index.js`, measured in
`p1-load.ts` and `p9-create.ts`):

- It always sets `PRAGMA foreign_keys = ON`.
- With no `wal` option, it sets `busy_timeout = 5000` and nothing else.
- With `wal: { enabled: true, synchronous, busyTimeout }`, it sets
  `journal_mode = WAL` **on every open**, throws `Failed to enable WAL mode`
  when the switch is refused, and then sets `synchronous` and `busy_timeout`.
  That is wrong for board in two ways. It would turn any file `BOARD_DIR`
  points at into WAL before board has checked that the file is a board. And
  it throws on the refused switch that `project add` is designed to go past.
  So **board passes no `wal` option.**
- **It creates a missing file.** `new Database(path)` opens read-write and
  create (`p9-create.ts`: no file before the first query, a file after). The
  adapter has no option that stops it.

**Per open, by board** (one connection per process, so once per process):

1. A command that is not `project add` checks that `board.db` exists before
   it constructs the client. A missing file is `no_board`. The check is a
   `stat` in board's own open function. It is ordinary code rather than a
   workaround: the adapter does not offer to refuse creation, and the only
   race is with the offline move procedure, which stops the agents first.
2. `await db.$connect()`, then `await db.$executeRawUnsafe("PRAGMA
   synchronous = FULL")`. Measured: a fresh connection on a WAL file reports
   `synchronous = 1` (Apple's default) until it is set. `foreign_keys = 1` and
   `busy_timeout = 5000` come from the adapter, and board reads both back once
   at open in a test, not at run time.
3. `application_id` and `user_version` are read at open (`not_a_board`,
   `schema_mismatch`), and `user_version` again in every transaction, as
   designed.

**`board project add`, the full recipe.** It was implemented as a probe
(`p17-add.ts`, Prisma and the adapter as they are) and run in every branch
below.

Before the transaction (each step a statement of its own, autocommit, with
no snapshot carried):

1. `mkdir -p $BOARD_DIR`. Open the client: the adapter creates an empty
   `board.db` if none exists, and sets `foreign_keys` and `busy_timeout`.
   Then `PRAGMA synchronous = FULL`.
2. `PRAGMA application_id`. A value other than `0` and `0x424F5244` is
   `not_a_board`, and nothing is written. This is the early answer for
   somebody else's file. The same check is repeated under the lock (step 7).
3. `PRAGMA journal_mode = WAL` through `$queryRawUnsafe`. Answered `wal`:
   go on. Refused `SQLITE_BUSY` (measured: 21 ms, no wait), meaning another
   first `project add` holds the file: go on as well, because the next step
   waits.

The transaction, `db.$transaction(fn, { maxWait: 30_000, timeout: 10_000 })`:

4. **Lock statement:** `PRAGMA application_id = 1112494660`. It is a write in
   both branches. On a fresh file it is the header the schema needs; on an
   existing board it rewrites the same value, and it still takes the lock
   (measured: a second connection's `BEGIN IMMEDIATE` got `SQLITE_BUSY`). Past
   `busy_timeout` the answer is `busy`, with nothing written.
5. **`now`** from the injected clock, after the lock, in both branches.
6. `PRAGMA journal_mode` must read `wal`. Otherwise the answer is `busy` and
   nothing is written: the file is fresh and its creator died before
   committing.
7. **What the file is, under the lock:** `SELECT count(*) FROM sqlite_master`.
   - **0 objects, the fresh branch:** run Appendix A's statements one per
     call (§4), including `PRAGMA user_version = 1`. Append `board_created`
     (no project), insert the project, append `project_added`. A refusal here
     (a bad key, a directory that is not canonical) rolls back everything,
     because there is no sweep to keep on a file that has no board yet; the
     file stays empty and in WAL. Then commit.
   - **Objects present, the existing branch:** this is the ordinary write
     path from its step 3. `user_version` must be 1 (`schema_mismatch`), and a
     file with tables but neither the version nor a `project` table is
     `not_a_board`. Either refusal rolls back, which also undoes step 4's
     header write. Then the machine-wide **sweep** (`DELETE … RETURNING`,
     `claim_expired` per row), then **`SAVEPOINT op`** as a nested
     `tx.$transaction`, then validate (key and directory unique; `key`
     compares `NOCASE`). A refusal rolls back to the savepoint and keeps the
     sweep. Otherwise insert the project and `project_added`. Commit.

An empty file that a refused or failed first `project add` leaves behind
(application_id 0, no objects) reads as `no_board` to every other command:
the open check counts `sqlite_master` and does not only test that the file
exists.

**Measured** (`p17-add.ts`; a racing run starts every process at the same
wall-clock millisecond):

| Case | Result |
|---|---|
| 2 first creators racing on an empty `BOARD_DIR`, 10 trials | every trial: one creator took the fresh branch and the other the existing branch; 28 schema objects, 2 projects, **1 `board_created`**, 2 `project_added`, `wal`, application_id `0x424F5244`, user_version 1. In one trial the loser's WAL switch was refused `busy`; it went on and waited. |
| 5 first creators racing, 10 trials | every trial: 1 fresh, 4 existing; 28 objects, 5 projects, **1 `board_created`**, 5 `project_added` |
| A creator holds a fresh, not-yet-WAL file (`BEGIN IMMEDIATE`, header written) and is `SIGKILL`ed before committing | the second `project add`: WAL switch `busy`, it waited on the lock, got it after the kill, read `journal_mode = delete`, answered **`busy`**, wrote nothing (application_id 0, 0 objects). Run again: it created the board. |
| Existing board with a lapsed claim, `project add` with a key taken in another case (`k1` vs `K1`) | refused (`conflict`), **swept 1**: claim gone, one `claim_expired`, the task back to `ready`, still 2 projects |

**Multi-statement strings are silently cut.** Through Prisma,
`$executeRawUnsafe("CREATE TABLE a …; CREATE TABLE b …")` created `a` and not
`b`, with no error. `bun:sqlite`'s `prepare` and `query` do the same (§5). So
the DDL is executed **one complete statement per call**, from the array in §4,
never as one string.

**Integers.** The adapter defaults to `safeIntegers: true`. Prisma's `Int` is
32-bit, so ids above 2³¹ would not fit. That is unreachable for a local board
and noted only.

## 4. Schema without migrations

**Introspection** (`prisma db pull` against a file built from Appendix A;
output kept as `/tmp/bdp/prisma/pulled.prisma`):

| Appendix A feature | In Prisma's schema |
|---|---|
| `STRICT` | lost, no warning |
| `CHECK` (all) | lost, no warning |
| `COLLATE NOCASE` (`project.key`, `milestone.name`) | lost, no warning |
| triggers `event_no_update`, `event_no_delete` | lost, no warning |
| `WITHOUT ROWID` (`waits`) | lost, no warning |
| composite FKs onto `UNIQUE (project_id, id)` | kept, as composite relations |
| `UNIQUE (…)` | kept (`@@unique`) |
| partial indexes | kept with `previewFeatures = ["partialIndexes"]`, **except** `question_to_validate` (the bug below) |
| `task.id INTEGER PRIMARY KEY`, `claim.task_id INTEGER PRIMARY KEY` | `@default(autoincrement())` on both; for `claim.task_id` this is wrong in spirit (it makes `task_id` optional in `claim.create`'s types) |

Prisma's schema language has no `STRICT`, `CHECK`, collation or trigger. So
Prisma's schema cannot be the source of the DDL.

**A Prisma 7.10.0 introspection bug (for the owner; not worked around).**

- **Input:** Appendix A as it is, where the partial index's `WHERE` starts
  on its own line:

  ```sql
  CREATE INDEX question_to_validate ON question (answered_at)
    WHERE answered_as = 'delegate' AND validated_at IS NULL;
  ```

- **`prisma db pull` (7.10.0, `previewFeatures = ["partialIndexes"]`)
  writes:**

  ```prisma
  @@index([answered_at], map: "question_to_validate", where: raw("INDEX question_to_validate ON question (answered_at)\n  WHERE answered_as = 'delegate' AND validated_at IS NULL"))
  ```

  The predicate is taken from the wrong offset: it carries the DDL's own head
  and the newline. The other partial indexes, whose `WHERE` sits on the
  `CREATE INDEX` line, came out right. The same index written on one line
  also came out right (`raw("answered_as = 'delegate' AND validated_at IS
  NULL")`).
- **The consequences, measured:** `prisma validate` passes, and `prisma
  generate` generates the client, so the client is unaffected. `prisma
  migrate diff --from-empty --to-schema` turns it into invalid SQL (`CREATE
  INDEX "question_to_validate" ON "question"("answered_at") WHERE INDEX
  question_to_validate ON question (answered_at) WHERE …`). board never runs
  `migrate` or `push`, so the wrong text sits in `schema.prisma` and does
  nothing there.
- **Options for the owner:**
  1. Keep Appendix A as it is, and commit the pulled `schema.prisma`
     verbatim, mangled line included. The comparison test compares verbatim
     and passes (`check`'s `git diff` sees no change). Cost: one line of `schema.prisma` is visibly wrong, and
     harmful only to someone who runs `migrate diff` on it.
  2. Keep Appendix A as it is, and hand-maintain that line of
     `schema.prisma`. `gen` would undo the hand edit each run, so `check`'s `git diff` fails
     unless `gen` re-applies it: a patch of ours on the package's output.
  3. Write the `WHERE` on the `CREATE INDEX` line in Appendix A. This is
     a change to our input made to suit the package, so CLAUDE.md puts it
     to the owner, and it is not adopted here.
  4. Report it upstream (prisma/prisma, SQLite introspection of a multi-line
     partial index), together with any of 1–3.

  Recommendation: 1 and 4.

**One source of truth: Appendix A as a TypeScript array.**

- runtime's `src/store/ddl.ts` exports an explicit array of the 22
  statements, with each element one complete statement of Appendix A in order: the two pragmas,
  each `CREATE TABLE`, each `CREATE INDEX`, and each `CREATE TRIGGER … BEGIN …
  END` whole. There is no splitter at run time and no `.sql` file to embed.
  `project add` runs them one per `$executeRawUnsafe` call (§3).
  Probe: `/tmp/bdp/appendix-a.ts`, 22 statements; the race runs above used
  it. Appendix A in `docs/design.md` shows the same statements as SQL.
- `prisma/schema.prisma` is **derived from it**. A `bun run schema` script
  (runtime's `gen`) builds a temporary database by running the array, then
  runs `prisma db pull`, then `prisma generate --sql`. Re-introspection keeps manual names:
  relation fields renamed by hand (`waited_by`, `waits_on`, `parent`) and an
  added `@@map` survived a second `db pull` unchanged. So the readable names
  live in the committed `.prisma` file, and `db pull` keeps them.
- **The check** is runtime's: `check` runs `gen` and then `git diff
  --exit-code prisma/schema.prisma`, so a DDL change that was not pulled
  fails. There is no separate pull-compare test. The Prisma schema is never
  pushed or migrated; it only types the client.
- `prisma db push`, `migrate` and a `_prisma_migrations` table are never
  used. quarry's `migrations.gen.ts` is not needed either: board has no
  migrations, and the DDL is already source.

**The query layer: a mix, by what each query is.**

- **The model API** for single-row and nested CRUD (`task.create` with its
  `event` rows, `claim.delete`, `milestone.update`, `findUnique` by key or
  number). It is typed, and its nested writes run inside the transaction
  (measured).
- **TypedSQL** (`prisma/sql/*.sql`, `$queryRawTyped`) for what the model API
  cannot say or says badly: the sweep (`DELETE … RETURNING`; Prisma 7 has no
  `deleteManyAndReturn`), `max(number) + 1`, readiness and `task_next`'s
  ordering, milestone status, and the substring filter. Measured: `-- @param
  {String} $1:now` / `DELETE FROM claim WHERE until <= $1 RETURNING …`
  generated `sweep(now: string)` with a typed `Result`. It ran inside a
  `$transaction` and returned the swept row. `generate --sql` needs a database
  at build time, the same temp file the schema script builds.
- **`$executeRawUnsafe`** only for fixed text of board's own: the lock
  statement, pragmas, and DDL statements. Never with user text.

## 5. `board sql` and `board watch`

**Through Prisma: no.** The adapter cannot open read-only (it builds `new
Database(path, { safeIntegers })`, after stripping `file:`) and exposes no
statement handle.

**`bun:sqlite` directly, `new Database(path, { readonly: true })`**
(`p6-ro.ts`, `p7-matrix.ts`):

- A missing file opened read-only fails `SQLITE_CANTOPEN` and creates nothing,
  so `no_board` comes for free.
- `PRAGMA data_version` works on the read-only connection (watch, decision 15
  unchanged).
- `TEMP VIEW`s work on the read-only connection, shadow `main` for unqualified
  names, and refuse `DELETE` / `UPDATE` ("cannot modify task because it is a
  view").
- **There is no `sqlite3_stmt_readonly`** and **no tail check**. `Statement`
  exposes `columnNames`, `columnTypes`, `declaredTypes`, `paramsCount` and
  nothing else (the native object neither). `prepare("SELECT 1; DELETE FROM
  task")` runs the `SELECT` and **silently drops the rest**. `node:sqlite`
  under Bun drops the tail the same way and has no read-only flag on
  statements either. `paramsCount` covers "a query with parameters is a usage
  error".

**The guards that remain, measured as a matrix of 21 statements:** a
read-only open, the temp views created, then **`PRAGMA query_only = 1` set by
board**, then the user's one statement, on a throwaway connection.

| Passed | Refused (code) |
|---|---|
| `SELECT …`, `SELECT … FROM main.task`, `EXPLAIN …`, `PRAGMA journal_mode` (read), `ATTACH ':memory:'`, `PRAGMA query_only = 0` (the connection then dies unused) | `DELETE`/`UPDATE` on a view (`SQLITE_ERROR`), `INSERT`, `CREATE TABLE`, `CREATE TEMP TABLE`, `DROP VIEW`, `VACUUM`, `VACUUM INTO`, `PRAGMA user_version = 9`, `PRAGMA wal_checkpoint`, `REINDEX`, `ANALYZE` (`SQLITE_READONLY`); `ATTACH '<new file>'` (`SQLITE_CANTOPEN`); `PRAGMA journal_mode = DELETE` (`SQLITE_BUSY`) |

After the run, the board file was unchanged (`user_version` 1, rows equal,
mtime unchanged).

**What decision 16 loses on Bun (for the owner).** Decision 16 promised that
a write is refused before anything runs (`sqlite3_stmt_readonly` on the
prepared statement) and that a query with more than one statement is refused
(`checkNoTail`). With `bun:sqlite`, three things change:

1. **A refusal comes at execution, not before.** SQLite still makes the
   judgement (`query_only`, the read-only open), and nothing is written to
   the board. But board learns of the refusal from the error a running
   statement returns (`SQLITE_READONLY`, `SQLITE_CANTOPEN` for `ATTACH` of a
   new file, "cannot modify … because it is a view"), not by asking before
   running. The exit-64 message is shown on those codes.
2. **`VACUUM INTO '<path>'` creates a 0-byte file at `<path>` before it is
   refused.** That is a write outside the board, to a path the user typed,
   and it is not undone. Without `query_only` (a read-only open alone), it
   writes a full copy of the board, the hole decision 16 names.
3. **A multi-statement query runs only its first statement.** `board sql
   "SELECT 1; DELETE FROM task"` runs the `SELECT` and drops the `DELETE`
   without a word. This is safe (nothing after the first statement runs), but
   it is silent where decision 16 said "refused".

`node:sqlite` under Bun was tried for the same purpose (the lead confirmed it
too). It also accepts `SELECT 1; SELECT 2` and returns the first result only,
and it has no read-only flag on statements, so it changes none of the three.
Options are in §7, question 1.

**Two SQLite libraries in one process.** On this path there is one: Prisma's
adapter and the read-only connection both go through `bun:sqlite`, which is
`/usr/lib/libsqlite3.dylib`. quarry's POSIX-lock hazard (closing any
descriptor on the file drops every lock the process holds there, across
separate library copies) does not arise. It would, if board mixed `bun:sqlite`
with `@prisma/adapter-libsql` (its own SQLite 3.45.1) in one process, which is
one more reason against libsql. In any case, `board mcp` holds only the Prisma
connection, and `watch` and `sql` hold only the read-only one.

## 6. Proposed text for `docs/design.md` and `docs/decisions.md`

### Storage → File and connections

- Replace "SQLite through `package:sqlite3`." with: "SQLite through Prisma
  7.10.0 (`@prisma/client`, generator `prisma-client`, runtime `bun`) and the
  driver adapter `prisma-adapter-bun-sqlite` 0.8.0 over `bun:sqlite`, which
  on macOS is the system SQLite (3.51.0 on the machine tried)."
- Replace the pragmas bullet with: "One connection per process (one
  `PrismaClient`; the adapter connects once). The adapter sets `foreign_keys =
  ON` and `busy_timeout = 5000`; board sets `synchronous = FULL` right after
  `$connect()` (Apple's SQLite starts a WAL connection at `NORMAL`). The
  adapter's `wal` option is not used: it would switch any file to WAL on open.
  The adapter creates a missing file, so every command but `project add`
  checks that the file exists and holds a schema first (a missing file, or
  an empty one a failed first `project add` left, is `no_board`). `board
  watch` and `board sql` open with `bun:sqlite` directly, `{ readonly: true
  }`."
- `project add`: replace the bullet with the recipe of §3 of this draft
  (steps 1–7: the pre-check, WAL outside the transaction, the lock by `PRAGMA
  application_id`, `now`, the WAL check, and the two branches under the
  lock), together with its measured race results.
- "Only `bin/board.dart` reads the environment; `lib/` takes it as a
  parameter": runtime renames the paths.

### Storage → Every operation

Replace steps 1–2 and the paragraph after them:

> A write is one Prisma interactive `$transaction` (`timeout: 10_000`,
> `maxWait: 30_000`):
>
> 1. The adapter begins it deferred; its first statement is `UPDATE project
>    SET id = id WHERE 0`, which takes the write lock (waits up to the busy
>    timeout; past it, `busy`, nothing written). No statement precedes it.
> 2. Take `now` from the injected clock: after the lock …
>
> (steps 3–9 unchanged; `SAVEPOINT op` is a nested `tx.$transaction`, whose
> throw rolls back to the savepoint.)
>
> Contention ends in `busy`, with nothing written. That covers `P2010` or
> `P1008` whose original code is `SQLITE_BUSY`, and `P2028` (Prisma's
> `maxWait` or `timeout`, mapped as a defensive case). Writes queued in one
> process go through the adapter's mutex one at a time, each with its own
> `busy_timeout`. Behind a stuck holder, the n-th queued write answers `busy`
> after about 5n s. `maxWait` does not bound this, because the event loop is
> frozen in the busy handler.
>
> No write reads before its lock statement: in WAL, a deferred transaction
> that has read and then writes fails `SQLITE_BUSY_SNAPSHOT` without
> consulting the busy handler (measured: 989 of 1000 under ten writers). A
> read is one deferred `$transaction` with steps 2–4. The store never calls
> the client outside a `$transaction`: a call made while a transaction is
> open runs inside it on the one connection. Every failure ends in Prisma's
> `ROLLBACK` (or SQLite's own, on `SQLITE_FULL`), and a process that ends
> frees the lock.

The sentence about a synchronous callback goes; runtime replaces it with how
interleaving is prevented.

### Storage → Schema

Add: "Appendix A is the one source of the schema: `src/store/ddl.ts`, an
explicit array of its 22 complete statements, run one per call in `project
add`. `prisma/schema.prisma` is generated from it by `prisma db pull` in
`gen` (manual relation names survive re-introspection) and only types the
client; `check` fails when `gen` changes it. Prisma's schema cannot express `STRICT`,
`CHECK`, `COLLATE NOCASE`, triggers or `WITHOUT ROWID`, which is why it is
not the source. Queries: the model API for row CRUD and nested writes,
TypedSQL for the sweep, numbering, readiness, `task_next` and the filter,
`$executeRawUnsafe` only for board's own fixed text."

"Cross-row rules … live in Dart over the store" → "in TypeScript over the
store".

### `board sql`

Replace the guard paragraph:

> The query runs on a throwaway `bun:sqlite` connection opened `{ readonly:
> true }`. After the `-p` views are created, board sets `PRAGMA query_only =
> 1`, then prepares the user's text; a statement with parameters
> (`paramsCount > 0`) is a usage error. A write is refused by SQLite when it
> runs (`SQLITE_READONLY`, `SQLITE_CANTOPEN` for `ATTACH` of a new file,
> "cannot modify … view"), and board turns those into the exit-64 refusal.
> `bun:sqlite` exposes neither `sqlite3_stmt_readonly` nor the prepared tail:
> only the first statement runs (owner's question). `VACUUM INTO` is
> refused, but leaves an empty file at the path it names.

(This text stands only if the owner accepts the three losses in §5.)

"The bundled SQLite is built without an authorizer or a progress handler" →
"`bun:sqlite` exposes neither an authorizer nor a progress handler".

### Appendix A

- Header: "The DDL as tried through Prisma 7.10.0 and
  `prisma-adapter-bun-sqlite` 0.8.0 on Bun 1.4.3 (system SQLite 3.51.0)."
- Add: "The same statements, one per element, are `src/store/ddl.ts`."
- The DDL does not change. Every statement ran unchanged on SQLite 3.51.0
  through Prisma's raw API. `question_to_validate` stays as written; Prisma's
  introspection bug on it is the owner's question (§4, §7).

### Decisions

- **5, Libraries:** "Tried in Prisma 7.10.0 with `prisma-adapter-bun-sqlite`
  0.8.0 (system SQLite 3.51.0): `DELETE … RETURNING` through TypedSQL, two
  processes, a committed sweep under a refused operation through a nested
  `$transaction` savepoint. A transaction that reads before it writes fails
  `SQLITE_BUSY_SNAPSHOT` or `SQLITE_BUSY` without waiting (989 of 1000 under ten writers), which is why a
  write's first statement takes the lock."
- **9, Libraries:** "`package:sqlite3`" → "Dart's `package:sqlite3`, before the
  move to Bun". It is history; nothing in it changes.
- **10, Libraries:** "SQLite's header pragmas, read and written through
  Prisma's raw API; the creating transaction takes its lock with `PRAGMA
  application_id`."
- **11, Choice:** "WAL; every write one Prisma `$transaction`, a deferred
  BEGIN whose first statement (`UPDATE project SET id = id WHERE 0`) takes the
  write lock; busy timeout 5 s, past which the agent gets `busy`;
  `synchronous = FULL`, set by board on each open; SQLite's automatic
  checkpoints; one connection per process. Prisma's `timeout` 10 s and
  `maxWait` 30 s; their `P2028` maps to `busy` as a defensive case, and
  neither bounds a queue behind a stuck holder (the n-th queued write
  answers `busy` after about 5n s)."
  **Options considered** adds: "`BEGIN IMMEDIATE` through a driver adapter of
  ours (worked, code around a package); raw `BEGIN IMMEDIATE` around client
  calls (nested writes fail); writes on `bun:sqlite` directly (Prisma off the
  core path); a deferred read-then-write with retries (changes decisions 5
  and 12)." **Libraries:** "Prisma 7.10.0, `prisma-adapter-bun-sqlite` 0.8.0,
  Bun 1.4.3. `@prisma/adapter-better-sqlite3` does not load in Bun;
  `@prisma/adapter-libsql` brings a second SQLite (3.45.1). No adapter can
  begin `IMMEDIATE`. Measured: the lock statement takes the lock even when it
  matches no row; a contender waits and gets `SQLITE_BUSY` at 5029 ms; ten
  processes × 100 writes: 1000 commits in 1.35 s, none failed. A busy, a
  throw, a constraint failure, `SQLITE_FULL`, Prisma's own timeout, stdin
  closed, `SIGINT`/`SIGTERM`/`SIGHUP`/`SIGKILL`: each leaves the lock free."
  The Dart figures (30 processes, 6,000 commits) are replaced by these.
- **16, Choice:** "`bun:sqlite` `{ readonly: true }`, plus `PRAGMA query_only
  = 1` set after the `-p` views, plus `paramsCount = 0`." **Consequences**
  adds the execution-time refusal, the empty file `VACUUM INTO` leaves, and
  the dropped tail. **Libraries:** "`bun:sqlite` (Bun 1.4.3), a matrix of 21
  statements; it exposes neither `sqlite3_stmt_readonly` nor the tail, and
  `node:sqlite` under Bun neither; Prisma's adapter cannot open read-only."
- **19:** runtime owns the build. From storage: no native file is needed,
  because `bun:sqlite` is built in and SQLite is the system's.
- **23, Libraries:** "Prisma 7.10.0 / `prisma-adapter-bun-sqlite` 0.8.0: the
  DDL, the composite keys (introspected as composite relations) and the
  numbering through TypedSQL, tried." Removal of an empty project under
  `defer_foreign_keys` was not re-tried here. It is a pragma inside the
  transaction through `$executeRawUnsafe` and goes on the test list.

## 7. Open questions

1. **`board sql` with more than one statement** (owner). `bun:sqlite` runs
   the first and drops the rest silently. Options: (a) accept and document it
   in `board help sql`, which is safe because nothing after the first runs;
   (b) call `sqlite3_prepare_v2`'s tail and `sqlite3_stmt_readonly` through
   `bun:ffi` on the system library, which is a binding of ours; (c) ask Bun to
   expose both, and take (a) until then. Recommendation: (a), then (c).
2. **The macOS floor** (owner or runtime). The SQLite is the system's, so
   Appendix A needs a macOS whose SQLite has `STRICT` (3.37), `RETURNING` and
   built-in JSON (3.38). The floor is not measured here; there is one machine.
   board could check `sqlite_version()` at open and refuse below the floor.
3. **Decision 16's three losses** (owner): refusal at execution, `VACUUM
   INTO`'s empty file, and the dropped tail (§5). The options are those of
   question 1, plus taking all three as documented consequences.
4. **Prisma's introspection bug on `question_to_validate`** (owner): the
   options in §4. Recommendation: commit the pulled file verbatim and report
   the bug upstream. The DDL rewrite is not adopted.
5. **The adapter's upkeep** (owner, for the record). `prisma-adapter-bun-sqlite`
   has one maintainer and was last published 2026-04-23. It is about 1,100
   lines of JS with no native part, so pinning it is cheap, but it is a single
   point.
6. **`WHERE 0` as a lock** (none now). It holds on SQLite 3.51.0 and is pinned
   by a store test. If the test ever fails on a newer macOS, the fallback is a
   one-row write (`UPDATE project SET id = id WHERE id = (SELECT min(id) FROM
   project)`), which no optimiser can skip. It was not measured, because
   `WHERE 0` held.
