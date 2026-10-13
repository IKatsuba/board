# bun: runtime

The runtime architect's answers to the brief's "runtime" questions, and the
owner's added item on the busy-wait freeze. Everything marked "tried" was run
on this machine: macOS 26.6.2 (arm64), Bun 1.4.3, Node 24.13.0, npm 11.6.2,
prisma and @prisma/client 7.10.0 (generator `prisma-client`, `engineType =
"client"`, `runtime = "bun"`), prisma-adapter-bun-sqlite 0.8.0,
@prisma/adapter-libsql 7.10.0 with @libsql/client 0.18.0,
@modelcontextprotocol/server and /client 2.3.1, zod 4.6.7, @biomejs/biome
2.5.15, typescript 7.0.2, @types/bun 1.4.3. x64 was run under Rosetta.
Notarisation was not run.

The probes are throwaway, under `/tmp/bunprobe/`:

- `plain/probe.ts`: `bun:sqlite` only; opens a WAL file, `STRICT` table,
  `BEGIN IMMEDIATE`, prints `sqlite_version()`, `process.execPath`.
- `plain/jit.ts`: a hot loop and a regex loop; prints
  `bun:jsc`'s `numberOfDFGCompiles(f)`, which JavaScriptCore answers with
  1,000,000 when its JIT is off. That is how "JIT on/off" is read below.
- `prisma/probe.ts`: Prisma 7 over prisma-adapter-bun-sqlite: a model
  create, `count`, `$queryRawUnsafe`, an interactive `$transaction`; with
  `mcp`, an MCP server over stdio with one tool registered through
  `fromJsonSchema` with an input and an output schema (Ajv). `drive.sh` sends
  `initialize`, `tools/list`, a good call and a call the input schema refuses,
  then closes stdin.
- `prisma/interleave.ts`: a plain client call made while a transaction is
  open on the same client.
- `prisma/busy.ts`: two processes; the event loop's timers while one waits out
  `busy_timeout`.
- `libsql/probe.ts`: the same Prisma probe over @prisma/adapter-libsql.
- `freeze/`: the owner's item: `server.ts` (an MCP write tool done the
  owner's way, F), `cli.ts` and `sigint.ts` (Ctrl-C during the wait),
  `holder.ts`, `watcher.ts`, `watch-cases.ts` (a read-only poller against
  held, stopped, killed and recovering writers), `queue.sh` and
  `queue12.sh` (8 and 12 writes queued behind a stuck holder, with
  `maxWait`).
- `pipe/`: the generation pipeline of §7 and a binary that runs the
  embedded DDL and TypedSQL.
- `sign/`: the signed variants; `npm/`: the pack and install round trip.

## Findings in short

1. **One file per platform works.** `bun build --compile` of the Prisma 7 +
   prisma-adapter-bun-sqlite + MCP probe gives one Mach-O for
   `bun-darwin-arm64` (76 MB) and one for `bun-darwin-x64` (84 MB), both built
   on the arm64 Mac in under a second, no Rosetta needed to build. Each runs
   through a symlink and as a copy alone; nothing sits beside it. Prisma's
   query compiler is WASM, embedded as base64 in the bundle and instantiated
   with `new WebAssembly.Module` at run time.
2. **SQLite is the system's.** `bun:sqlite` on macOS loads
   `/usr/lib/libsqlite3.dylib` at run time, on arm64 and on x64 (3.51.0 on
   this macOS 26.6.2); nothing is embedded. The binaries require macOS 13.0
   (`LC_BUILD_VERSION minos 13.0`). The version a user gets is their macOS's
   (data owns whether the oldest one carries what Appendix A needs).
3. **A compiled Bun binary signs and verifies.** The payload is a Mach-O
   segment (`__BUN`), not bytes appended after the image, so `codesign
   --force --options runtime` and `codesign --verify --strict` both pass, ad
   hoc and with the owner's Developer ID with `--timestamp`. `spctl` says
   `Unnotarized Developer ID`, as it should before notarisation.
4. **No entitlement is needed to start; one is needed for speed.** Under
   hardened runtime without entitlements, a Bun binary is not killed (unlike
   Dart AOT): JavaScriptCore notices it cannot map JIT memory and runs
   interpreted. Prisma's WASM, Ajv's `new Function` and the MCP round trip
   all work that way. `com.apple.security.cs.allow-jit` alone turns the JIT
   back on; `allow-unsigned-executable-memory` is not needed.
5. **@prisma/adapter-libsql does not make a single binary.** Its loader's
   `require(\`@libsql/${target}\`)` is not bundled; the compiled binary
   reaches for `node_modules` at its build path, and anywhere else fails with
   `Cannot find module '@libsql/darwin-arm64'`. Its addon is ad hoc signed,
   so under Developer ID hardened runtime `dlopen` refuses it ("different
   Team IDs") without `disable-library-validation`.
6. **Serialisation inside a process is the store's job.** The adapter
   serialises `$transaction`s with an in-process mutex, but a plain client
   call made while a transaction is open runs inside that transaction on the
   one connection; when the transaction rolls back, the plain call's write is
   gone after it was answered "created". The MCP SDK runs tool calls
   concurrently. So every call goes through `Store.read` / `Store.write`, and
   nothing else holds the client.
7. **The busy wait freezes the process, and that is acceptable for board.**
   A process waiting for the write lock runs no JavaScript for up to 5 s:
   no timers, no stdin, no signal handlers. One `board mcp` serves one
   agent; its queued calls answer late, never wrong; an exit on stdin close
   comes after the wait. A CLI command with no SIGINT handler of its own dies
   at once on Ctrl-C with nothing written. `board watch` never writes and
   never waited behind a writer in any case tried, including a writer frozen
   with `SIGSTOP` while holding the lock, a writer killed mid-write, and WAL
   recovery after `-shm` was removed. Details and the limits are in §3.
   One limit is new: Prisma's `maxWait` and `timeout` are JavaScript
   timers and never fire during the wait, so n writes queued behind a
   stuck holder answer `busy` after about 5n s (measured to 12 calls at
   60 s; open question 3).
8. **One generation pipeline from a clean checkout.** The DDL array →
   `build/schema.db` → `prisma db pull` → `prisma generate --sql` (client
   and TypedSQL in one run), 2.6 s. It is the same for tests, CI and the
   release (§7). A compiled binary, relocated and signed, ran the embedded
   DDL on a fresh `BOARD_DIR` and two TypedSQL queries, on arm64 and on x64
   under Rosetta.
9. **The release must read the entitlement back.** An unentitled binary
   passes every functional test, so the self-test cannot catch a missing
   `allow-jit`; the release compares `codesign -d --entitlements - --xml`
   with `tool/macos/board.entitlements` (§5).

## 1. Single binary

### What was built

```sh
bun build --compile --target=bun-darwin-arm64 probe.ts --outfile pp-arm64
bun build --compile --target=bun-darwin-x64   probe.ts --outfile pp-x64
```

| | arm64 | x64 |
| --- | --- | --- |
| build time on the arm64 Mac | 0.15 s | 0.08 s (2 s the first time: Bun downloads `bun-darwin-x64-v1.4.3` into `~/.bun/install/cache/`) |
| size, plain `bun:sqlite` probe | 70.9 MB | 78.7 MB |
| size, Prisma + adapter + MCP probe | 76.5 MB | 84.3 MB |
| `npm pack` tarball (arm64) | 33.3 MB | |
| `file` | Mach-O 64-bit executable arm64 | Mach-O 64-bit executable x86_64 |
| links (`otool -L`) | libicucore, libresolv, libc++, libSystem | same |
| minimum macOS | 13.0 | 13.0 |
| signature as built | ad hoc, linker-signed, identifier `a.out` | Oven's Developer ID (team `7FRXF46ZSN`), hardened runtime, identifier `bun` |
| runs | yes | yes, `arch -x86_64` |
| SQLite at run time (`DYLD_PRINT_LIBRARIES=1`) | `/usr/lib/libsqlite3.dylib`, 3.51.0 | `/usr/lib/libsqlite3.dylib`, 3.51.0 |
| WAL file opened, `journal_mode` reads `wal` | yes | yes |
| Prisma create, count, raw query, `$transaction` | yes | yes |
| MCP over stdio: `initialize`, `tools/list` with the output schema, a call with `structuredContent`, an Ajv refusal as `isError` | yes | yes |
| run through a symlink in another directory | yes | yes |
| run as a copy alone in another directory | yes | yes |

The x64 runtime Bun cross-compiles against comes signed by Oven with
hardened runtime; `codesign --force` replaces that signature like the arm64
ad hoc one.

The compiled binary's `process.execPath` is the binary's real path; argv[0]
is what was typed (a symlink stays a symlink in `argv0`). Nothing in board
needs either: there is no library to find beside the binary any more, which
removes decision 19's "runs through a symlink, not as a copy alone".

### Prisma's query compiler

The generated client imports
`@prisma/client/runtime/query_compiler_fast_bg.sqlite.wasm-base64.mjs` and
decodes it with `new WebAssembly.Module(Buffer.from(wasm, "base64"))`
(`prisma/generated/internal/class.ts`, lines 41–52). `bun build` bundles
that module like any other, so the WASM is inside the binary; only the
SQLite flavour is pulled in. It instantiates under hardened runtime with
and without the JIT entitlement (§2).

### The libsql fallback

Built and run the same way: the arm64 and x64 binaries run on the build
machine and report SQLite 3.45.1 (libsql's own). But
`DYLD_PRINT_LIBRARIES` shows the addon loaded from
`/tmp/bunprobe/libsql/node_modules/@libsql/darwin-arm64/index.node`, the
build directory. With `node_modules` moved away the binary fails:

```
error: Cannot find module '@libsql/darwin-arm64' from '/$bunfs/root/lp-arm64'
```

`libsql/index.js` line 26 is `require(\`@libsql/${target}\`)`, which
`bun build` cannot resolve statically. Making it single-file would mean
rewriting the package's loader (a workaround the one rule forbids) or
shipping the `.node` beside the binary (a directory again, as Dart's
bundle was). Signed with Developer ID and `allow-jit`, the same binary
then fails at `dlopen`: "mapping process and mapped file (non-platform)
have different Team IDs"; with `disable-library-validation` added it runs.
So the fallback costs a directory, a wider entitlement or a re-signed
third-party addon, and two SQLite libraries in one process (the system's,
loaded by Bun and by system frameworks, and libsql's), which is data's
POSIX-lock question. `@prisma/adapter-better-sqlite3` was not tried here:
data found Bun refuses it.

## 2. Signing

### Ad hoc, hardened runtime

`codesign --force --sign - --options runtime --timestamp=none --entitlements
E --identifier dev.katsuba.board`, then `codesign --verify --strict`, then
run. Every combination verified; none was killed.

| Entitlements (`com.apple.security.cs.`) | arm64 JIT probe | x64 JIT probe (Rosetta) |
| --- | --- | --- |
| none | runs, JIT off, 7.4 s | runs, JIT off, 4.1–7.1 s |
| `allow-jit` | runs, JIT on, 1.4 s | runs, JIT on, 1.4 s |
| `allow-unsigned-executable-memory` | runs, JIT on, 1.5 s | runs, JIT on, 1.3 s |
| `disable-executable-page-protection` | runs, JIT on, 1.3 s | runs, JIT on, 1.3 s |
| `disable-library-validation` | runs, JIT off, 8.0 s | runs, JIT on, 1.3–1.5 s |
| `allow-jit` + `disable-library-validation` | runs, JIT on, 1.6 s | runs, JIT on, 1.4 s |

Unsigned (as built) the JIT probe takes 1.2 s on arm64 and 1.5 s on x64.
The x64 row for `disable-library-validation` alone is Rosetta's oddity,
not a reason to use it.

### Developer ID, hardened runtime, secure timestamp

The owner's identity is in this machine's login keychain (`Developer ID
Application: … (YQ8ZD2KZ3T)`, one valid identity). `codesign --force --sign
"$ID" --options runtime --timestamp --entitlements E --identifier
dev.katsuba.board`:

| Binary | Entitlements | `--verify --strict` | Result |
| --- | --- | --- | --- |
| JIT probe, arm64 | none | valid, satisfies its DR | runs, JIT off, 8.6 s |
| JIT probe, arm64 | `allow-jit` | valid | runs, JIT on, 1.3 s |
| JIT probe, arm64 | `allow-unsigned-executable-memory` | valid | runs, JIT on, 1.3 s |
| JIT probe, x64 | none / `allow-jit` / `allow-unsigned-executable-memory` | valid | runs; JIT off, on, on |
| Prisma + MCP probe, arm64 | none, `allow-jit`, `allow-unsigned-executable-memory`, `allow-jit` + `disable-library-validation` | valid | each: the Prisma run, and the MCP round trip with the Ajv-validated output schema |
| Prisma + MCP probe, x64 | none, `allow-jit`, `allow-unsigned-executable-memory` | valid | each, as above |
| libsql probe, arm64 | `allow-jit` | valid | fails at `dlopen` of the addon: different Team IDs |
| libsql probe, arm64 | `allow-jit` + `disable-library-validation` | valid | runs |

`codesign -dvv` on the signed binary: `flags=0x10000(runtime)`, the chain
Developer ID Application → Developer ID Certification Authority → Apple Root
CA, `Timestamp=`, `TeamIdentifier=YQ8ZD2KZ3T`. `spctl -a -vvv -t exec`:
`rejected`, `source=Unnotarized Developer ID`.

`/usr/lib/libsqlite3.dylib` is a platform library, so library validation
never refuses it: `disable-library-validation` is not needed on the
bun:sqlite path, ad hoc or Developer ID.

The Prisma + MCP probe's start-up, signed with Developer ID: 0.24 s without
the JIT, 0.15 s with `allow-jit` (one Prisma create, count, raw query and
transaction, then exit). Ajv compiles every tool's validators at
registration; with 17 tools that cost grows without the JIT.

### What to sign with

One entitlement, `com.apple.security.cs.allow-jit`, on the one binary.
It is narrower than decision 25's `allow-unsigned-executable-memory` (it
permits `MAP_JIT` regions only, which is what JavaScriptCore asks for) and
is a hardened-runtime exception the notary service accepts for Developer
ID. Without any entitlement board still works, interpreted, at a few times
the CPU on hot paths: a fallback, not the plan. Since the entitlement
changes from the one the owner accepted, it is listed in the open
questions.

### npm round trip

The Developer ID signed arm64 Prisma + MCP binary as
`@chorded/board-darwin-arm64` (`os`, `cpu`, `files: ["bin"]`), and a main
`@chorded/board` with the `bin/board.js` shim and an exact
`optionalDependencies` entry, both `npm pack`ed and installed from the
tarballs into a scratch project (npm 11.6.2, Node 24.13.0):

- the installed binary is byte-identical to the signed one (`cmp`), mode
  `0755`; the only xattr is `com.apple.provenance`, no quarantine;
- `codesign --verify --strict --verbose=2` on the installed copy: valid,
  satisfies its Designated Requirement;
- `node_modules/.bin/board` (the Node shim, `spawnSync` with inherited
  stdio) runs it, and the MCP round trip passes through the shim untouched.

The shim stays a Node script: npm runs `bin` entries with the user's
`node`, and a user installing from npm has Node, not necessarily Bun. It
needs nothing from Bun.

## 3. Event loop, serialisation and the busy-wait freeze

### One connection, one queue

Every `bun:sqlite` call is synchronous; the adapter wraps them in promises.
A `board mcp` holds one `PrismaClient` over one connection for its life, so
everything below is about one process's one connection.

Two requests from one agent: the MCP SDK runs tool calls concurrently
(`drive.sh`'s call 4 answered before call 3). The adapter's
`transactionMutex` makes two `$transaction`s run one after the other
(`interleave.ts`: `begin1 end1 begin2 end2`), so two writes never
interleave. A plain client call does not take that mutex:

```
B answered { id: 2, title: "B (outside any transaction)" }
A: A refused
rows after: []
```

B was issued while A's transaction was open, ran inside it on the shared
connection, was answered "created", and vanished with A's rollback. So the
rule Dart's synchronous callback gave for free is now a rule of the code:
**`Store` owns the one `PrismaClient` and exposes only `read(fn)` and
`write(fn)`, each a `$transaction`; nothing else in `src/` imports the
client.** Reads are transactions too (the design's deferred read with steps
2–4), so they queue on the same mutex; that is what keeps a read's snapshot
from seeing half a write of its own process. A review rule and one test
(`two concurrent calls through Board, one refused, the other kept`) hold it.

### Where the wait happens, and what freezes

Under the owner's choice (F), a write is a deferred `$transaction` whose
first statement, `UPDATE project SET id = id WHERE 0`, takes the write lock
and waits on SQLite's busy handler for up to `busy_timeout = 5000` ms. That
wait is in C, on the only thread: no JavaScript runs.

`prisma/busy.ts`, one process holding `BEGIN IMMEDIATE` for 7 s, the other
with a 100 ms `setInterval` beside its `BEGIN IMMEDIATE`:

```
{"waited":5003,"code":"SQLITE_BUSY","errno":5,"msg":"database is locked","ticks":[102,203,5254,5356,5457]}
{"usableAfterBusy":true,"dataVersionChanged":true}
```

No tick between 203 ms and 5,254 ms: the loop was stopped for the whole
wait, as quarry measured. The connection is usable after the busy failure
(data covers the ROLLBACK side).

Quarry's jams came from a process waiting on a lock **it held itself**
(a client it had left inside a transaction, whose release was queued behind
the wait). Board cannot do that while the rule above holds: one writing
connection per process, and the adapter's mutex lets the next transaction
begin only after the previous one committed or rolled back. A second
connection in the same process that writes would bring the jam back; the
design has none (`watch` and `sql` open read-only connections, which never
take the write lock). `project add`'s WAL switch is on the same connection
before its transaction (data's part).

### What each process does while it waits

**`board mcp`** (`freeze/mcp-freeze.sh`: another process holds the lock;
the agent sends two `task_add`s at once, then closes stdin 1 s later):

| Lock held for | Call a | Call b | stdin closed at 1 s | Exit |
| --- | --- | --- | --- | --- |
| 3 s | locked at 2.93 s, `ok 1` | locked at 2.94 s, `ok 2` | `end` seen at 2.94 s | 0 at 2.94 s, both answers written |
| 7 s | `busy` at 5.04 s | locked at 6.95 s, `ok 1` | `end` seen at 6.96 s | 0 at 6.96 s, both answers written |

- Its agent's other requests wait in the pipe and are read after the wait;
  none is lost, none is answered out of the order the mutex gives.
- **Waits add up per queued write, and `maxWait` does not bound them.**
  Call b's own 5 s begins only when call a's ends. Data sets Prisma's
  `$transaction` options to `maxWait: 30_000, timeout: 10_000`, expecting
  `maxWait` to end a queue past 30 s with `P2028` (mapped to `busy`).
  Measured (`freeze/queue.sh`, `queue12.sh`: `server-mw.ts` with those
  options, a holder keeping the lock 60 and 90 s, 8 and then 12
  `task_add`s sent at once):

  ```
  busy c1 at 5.04 s, c2 at 10.04 s, … c6 at 30.07 s, c7 at 35.07 s,
  c8 at 40.08 s, … c12 at 60.12 s
  ```

  Every call failed with `P2010` `SQLITE_BUSY` after its own 5 s. None got
  `P2028`, including the six that had waited for the mutex for longer than
  `maxWait`. The cause: `maxWait` is a JavaScript timer, and the loop is
  stopped in the busy handler. When one wait ends, the adapter's mutex hands
  the turn to the next transaction in a promise continuation, which runs
  before the overdue timer, and that transaction freezes the loop again. So
  under a stuck holder the queue is **unbounded**: the n-th of n concurrent
  writes answers after about 5n s. Data's `maxWait` measurement held the
  mutex with a JavaScript sleep, where the loop was free and the timer
  fired; it does not carry over to a lock wait. Each call is still told the
  truth (`busy`, nothing written), and nothing else is wrong. `timeout:
  10_000` is equally a timer and cannot interrupt a wait either; it can
  only end a callback that yields while still inside it.

  This needs another process to hold the write lock for many seconds (a
  `sqlite3` shell inside a transaction): board's own writes take
  milliseconds (data's 10 processes × 100 write-first transactions: 1,000
  of 1,000 committed in 1.35 s, no failure). And it needs the agent to send
  many writes at once. Whether 5n s is acceptable, or the store should refuse
  a write as `busy` when its turn comes after a bound it has already passed,
  is an open question below. That check would be a few lines of our own in
  `Store.write`, not a retry and not a patch of the adapter, but it is the
  lead's and owner's call.
- stdin closing during the wait is noticed after it. The in-flight and
  queued calls finish, their answers are written to the closed pipe's
  reader if it is still there, and the process exits 0 when its loop is
  empty. The client has gone, so a late answer harms nothing; a write that
  committed after the agent left is a write the agent asked for.
- `SIGTERM`/`SIGKILL` from the agent's host (no handler in board) end the
  process at once; SQLite rolls back whatever it held.

**A CLI command** (`freeze/sigint.ts`: a holder keeps the lock 4 s; a
writing CLI is sent `SIGINT` 1 s into its wait, spawned with `Bun.spawn` so
SIGINT is not inherited as ignored, which a non-interactive `sh &` does):

| CLI | Outcome |
| --- | --- |
| no SIGINT handler (Bun's default) | dies by SIGINT 1 ms after the signal; nothing written; the holder commits normally |
| a `process.on("SIGINT")` handler | the handler runs only after the wait (3 s later), by which time the write has **committed**; exit 130 says "interrupted" about a write that happened |

The waiter holds no write lock while it waits (it is waiting for it), so
its death needs no clean-up; a read snapshot it may hold is freed with the
process. So **no writing command installs a SIGINT handler**: Bun's default
death is the right Ctrl-C. Exit 130 then comes from the signal itself
(the shim re-raises it).

**`board watch`** never writes: one read-only connection, polling
`data_version` every 500 ms and draining on change. In WAL a reader takes
no lock a writer holds, so it does not enter the busy handler behind a
writer. Tried (`freeze/watch-cases.ts`, the watcher with `busy_timeout =
5000` set, so a wait would show):

| Another process | Watcher: polls, worst gap between ticks, worst poll, errors |
| --- | --- |
| holds the write lock 3 s with 1,000 uncommitted rows, then commits | 10 polls, 503 ms, 1.2 ms, none; the 1,000 rows seen on the tick after the commit |
| holds the write lock and is frozen with `SIGSTOP` | 10 polls, 503 ms, 1.5 ms, none |
| was `SIGKILL`ed mid-write (hot `-wal` and `-shm` left) | 4 polls, 503 ms, 1.6 ms, none |
| none open; the committed data only in a 9.9 MB WAL and `-shm` deleted (the next opener rebuilds the index: WAL recovery), with a writer opening at the same moment | 4 polls, 506 ms, 4.9 ms, none; the writer committed in 3 ms |

Where a read-only connection can still meet the busy handler: while another
connection runs WAL recovery (`SQLITE_BUSY_RECOVERY`), which lasts as long
as rebuilding the index of the WAL takes (ms for 10 MB; board's WAL is
checkpointed at SQLite's default 1,000 pages, about 4 MB); and on the
watcher's own first open of a file whose WAL needs recovery. Checkpoints are
SQLite's automatic `PASSIVE` ones, run by a committing writer, and never
wait on or block readers. Both are bounded by the size of the WAL, not by
another process's lock, so a frozen writer cannot freeze a watcher.

`claim_expiring` timing and `--exec` timeouts live on the watcher's own
loop and clock, which no other process can stop. A writer frozen in its
busy wait holds nothing; a writer holding the lock for long delays only the
moment its own events appear, which the watcher prints on the tick after
the commit. `--exec` children are `Bun.spawn`ed and their timeouts are the
watcher's timers, so they fire on time while anything else on the machine
waits.

**`board sql`**: read-only, one statement, like the watcher; never behind a
writer.

## 4. Tests

`bun test` (Bun 1.4.3's runner, `bun:test`; nothing to add), started as
`bun run test` so that §7's pipeline runs first. The generated client lives
under `src/store/generated/`, ignored by git.

- **Rules**, against a fresh in-memory database per test (the adapter
  accepts `:memory:`; `src/store/ddl.ts`'s `DDL` is executed on it, the
  same array the binary runs) and a `FakeClock`. Everything the Dart plan listed under Rules
  stays, unchanged. One addition: two `Board` calls started together, one
  refused, both through the store: the other's write is kept (§3's
  interleaving, pinned).
- **Projects**: unchanged in content; `GitRunner` is injected,
  `ProcessGitRunner` uses `Bun.spawn` with the 3 s timeout and `SIGKILL`.
- **Store**, against a temp file (WAL needs one), with the second party
  a **process**, not a `Worker`: `Bun.spawn([process.execPath,
  "test/helpers/holder.ts", …])`, as `busy.ts` and `freeze/` did. A worker
  shares the process, so a busy wait in it would not show a second
  process's behaviour, and the lock tests are about processes. Cases: the
  Dart list (two connections racing one claim, two sweeps of one expiry,
  numbers under two writers, cross-project sweep, two first `project add`s,
  busy with a holder, disk full through `max_page_count`, damaged, foreign
  and missing files, `now` after the lock, a view for every project table),
  plus: the waiter's loop is stopped for the wait and the connection is
  usable after `busy`; SIGINT during a CLI's wait leaves nothing written.
- **Env**: unchanged.
- **MCP**, through @modelcontextprotocol/client's `Client` and the server
  joined by `InMemoryTransport.createLinkedPair()`: the Dart list
  unchanged, plus two concurrent calls through the transport (the SDK's
  concurrency meets the store's queue).
- **Watch**: `derive` pure; the loop driven tick by tick with an injected
  clock and sleep; `exec` with real `sh -c` one-liners through
  `Bun.spawn`. Plus, against a temp file: a watcher keeps its 500 ms ticks
  while a spawned holder keeps the write lock.
- **sql**, **CLI**: unchanged in content; the CLI in process with injected
  sinks.
- **The built binary**: one smoke test, skipped unless `BOARD_BIN` names a
  built binary. The Dart scenario stays (temp `BOARD_DIR`, a temp repository
  with a linked worktree, `project add`, `board mcp` in `<worktree>/sub`
  over real stdio through `StdioClientTransport`, `initialize`,
  `tools/list`, `task_add` resolved through git, `task_list` with `%`,
  `board sql` reading it back). The binary is run through a symlink **and**
  as a copy in another directory (both work now, and a later change that
  needed a file beside it would show here). CI runs it on the unsigned
  arm64 binary; the release on both signed ones (x64 under `arch -x86_64`).

## 5. Release

`tool/release.sh [--dry-run]`, same steps and same order as now; only the
tools change.

1. Refuse a dirty tree, untracked files included.
2. Version from `package.json` (`jq -r .version`, or `node -p`). The
   platform packages and the main package take that version when assembled.
   Refuse it if `@chorded/board` has it; finish a stopped run from
   `build/release/` as now.
3. `npm whoami`.
4. Find the one Developer ID Application identity of team `YQ8ZD2KZ3T`;
   refuse none or several.
5. `bun install --frozen-lockfile`, then `bun run check` (§7): the
   generation pipeline from the DDL, the refusal of a `schema.prisma` that
   differs from what was committed, `tsc --noEmit`, `biome ci .` (format
   and lint in one tool; Biome 2.5.15 tried on the probes), `bun test`. Bun
   has no formatter or linter of its own; Biome is one dependency for both,
   against Prettier + ESLint.
6. Build both from the arm64 Mac, no Rosetta and no second toolchain:

   ```sh
   bun build --compile --target=bun-darwin-arm64 \
     src/main.ts --outfile build/darwin-arm64/board
   bun build --compile --target=bun-darwin-x64 \
     src/main.ts --outfile build/darwin-x64/board
   ```

   (`--minify` and `--sourcemap` were not tried; left out until they are.)

   Bun fetches the x64 runtime of its own version into its cache on the
   first cross build (network once). `file` checks both.
7. Sign and verify each, then self-test (`board project add` and `board
   ls` under a temporary `BOARD_DIR`; x64 through `arch -x86_64`):

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

   One file per architecture; no dylib to sign first. **The entitlement
   check is its own step**, not left to the self-test: a binary signed
   without `allow-jit` passes every functional test (it runs with the JIT
   off, §2), so only reading the signature back shows it. Tried: the
   Developer ID signed arm64 and x64 binaries read back
   `{"com.apple.security.cs.allow-jit":true}`, equal to the file's; one
   signed with an empty entitlements file reads back `{}`; an unsigned
   build prints nothing and `plutil` fails, which also stops the release.
8. Notarise one zip of both binaries (`ditto -c -k --norsrc --noextattr
   --keepParent`), `--keychain-profile roost-notary --wait`, keep the log,
   stop unless `Accepted`; `spctl -a -t exec` on both must say `Notarized
   Developer ID`. Not run in this design.
9. Assemble `build/release/npm/`: `@chorded/board-darwin-arm64` and `-x64`
   each `bin/board` plus a `package.json` (`os`, `cpu`, `files: ["bin"]`,
   version), and `@chorded/board` with the shim. `npm pack`, install in a
   scratch project, verify and self-test the installed copies.
10. `--dry-run` stops here.
11. Publish the two platform packages, then `@chorded/board`.

What moves to the repository's `package.json`: the version (was
`pubspec.yaml`), the dependencies and their exact versions (`bun.lock`
pins the tree), and the scripts of §7. The three npm packages'
`package.json`s stay under `npm/` as templates; the repository's own
`package.json` is `private: true` and is not one of them.

CI: `bun install --frozen-lockfile`, `bun run check`, and the smoke test on
`bun run build:arm64`'s unsigned binary. No signing, no secrets.

## 7. The generation pipeline

One ordered pipeline from a clean checkout, the same for a person's
`bun run test`, CI and the release. Data's §4 owns what the sources hold;
this is the order they are run in and what was measured.

**Sources, committed:**

- `src/store/ddl.ts`: Appendix A as an explicit array, one statement per
  element, in order (`export const DDL: readonly string[] = [ … ]`),
  pragmas first, triggers last. Nothing splits text at run time.
- `prisma/schema.prisma`: generated by `db pull`, then committed with
  data's hand renames (which a later pull keeps).
- `prisma/sql/*.sql`: the TypedSQL queries (sweep, next number,
  readiness, the substring filter).
- `prisma.config.ts`: the datasource is `file:./build/schema.db`.

**Generated, not committed:** `build/schema.db`, `src/store/generated/`
(the client and `sql/`).

**Scripts:**

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

1. `schema:db`: `tool/schema-db.ts` deletes and rebuilds
   `build/schema.db` by running `DDL` in one transaction on `bun:sqlite`.
2. `schema:pull`: `prisma db pull` rewrites `prisma/schema.prisma` from it.
3. `prisma generate --sql` writes the client **and** the TypedSQL
   functions in one run (a separate `prisma generate` first is not needed;
   tried), reading the queries' types from the same `build/schema.db`.
4. `check` refuses a `schema.prisma` the pull changed
   (`git diff --exit-code`): a DDL change committed without its pulled
   schema fails in CI and in the release, whose tree is clean by step 1.
   Data's test comparing `db pull --print` with the committed file says the
   same thing inside `bun test`; one of the two is enough, and the lead
   picks (the `git diff` needs no test of its own; data's test also
   catches it on a dirty tree).

`bun test` alone, without `bun run`, does not generate. A test run on a
fresh checkout without `gen` fails at the first import of
`src/store/generated/`, which says what is missing. `PRISMA_HIDE_UPDATE_MESSAGE=1`
keeps Prisma's update banner out of the release log.

**Measured** (`/tmp/bunprobe/pipe/`, the probe's `package.json` scripts as
above, `tool/` as `scripts/`): Appendix A turned into a 22-element array.
From a state with no `build/` and no generated code, `bun run gen` took
2.6 s, and `db pull` produced 7 models. A second run left
`prisma/schema.prisma` byte-identical (`cmp`), so the `git diff` check is
stable. `tsc --noEmit --strict` passed on the probe against the generated
client and TypedSQL. Then `bun run build:arm64` and `build:x64` ran the
pipeline again and built 75.8 MB and 83.6 MB binaries. Both were copied to a
temporary directory, signed with Developer ID, `--options runtime
--timestamp` and `allow-jit`, and verified. With `build/` moved away, each
was run on a fresh `BOARD_DIR` (x64 under `arch -x86_64`). Each created the
directory and the file, set WAL, ran the embedded `DDL` and inserted a
project in one `$transaction`. It numbered the task with the TypedSQL
`nextNumber`, created a claim, and swept it with the TypedSQL `sweep`
(`DELETE … RETURNING`) in a second transaction:

```
{"arch":"arm64", …, "swept":["a"], "next":2, "app":1112494660, "uv":1, "jm":"wal", "objects":28, "v":"3.51.0"}
{"arch":"x64",   …, "swept":["a"], "next":2, "app":1112494660, "uv":1, "jm":"wal", "objects":28, "v":"3.51.0"}
```

`application_id` 1112494660 is `0x424F5244`. 28 objects are in
`sqlite_master` (tables, indexes, triggers and the autoindexes of the
`UNIQUE`s). The DDL is TypeScript, so `bun build` embeds it like any other
module, and data's question whether `--compile` embeds a `.sql` text import
no longer arises.

## 6. Module layout

```
src/main.ts                 the entry point: the CLI; the only reader of the
                            environment and the cwd; builds Env and Place
src/env.ts                  BOARD_DIR / HOME → the board path, or a
                            configuration error
src/clock.ts                Clock, SystemClock
src/errors.ts               BoardError: one discriminated union, one case per code
src/place/                  Place {cwd, git()}; GitRunner, ProcessGitRunner
                            (Bun.spawn, 3 s, SIGKILL); the root rule
src/store/                  open (pragmas, identity; never creates), create
                            (project add only), read/write (the only holders
                            of the PrismaClient)
src/store/ddl.ts            Appendix A as an array of statements: the one
                            schema source
src/store/generated/        prisma generate --sql's output; not in git
src/rules/                  projects, tasks, claims, questions, milestones,
                            readiness, events: pure TypeScript over a transaction
src/board.ts                Board = Store + Clock; one method per operation
src/mcp/server.ts           buildServer(Board, Place) → McpServer; no transport
src/cli/                    one file per command; owns exit codes
src/watch/                  derive (pure), loop, exec
src/sql/readonly.ts         the read-only gate and the project views
prisma/schema.prisma        pulled from build/schema.db, committed
prisma/sql/                 TypedSQL queries
prisma.config.ts            the datasource: file:./build/schema.db
tool/schema-db.ts           builds build/schema.db from ddl.ts (§7)
test/                       *.test.ts; test/helpers/ for spawned holders
npm/                        the three package.json templates and bin/board.js
tool/release.sh             the release, on the owner's Mac (--dry-run)
tool/macos/board.entitlements  com.apple.security.cs.allow-jit
package.json, bun.lock, tsconfig.json, biome.json
```

The boundaries are the Dart ones: `rules/` and `board.ts` know nothing of
MCP, the CLI library or stdout; `GitRunner` is the one seam to the outside
world; `buildServer` takes no transport. One new boundary: `store/` is the
only module that imports the generated client, and it hands `rules/` a
transaction, never the client (§3).

## Proposed text for `docs/design.md`

### Storage, "File and connections" (the lines this draft owns)

- Replace "SQLite through `package:sqlite3`" with: SQLite through Prisma 7
  over prisma-adapter-bun-sqlite, on `bun:sqlite`, which uses macOS's own
  `/usr/lib/libsqlite3.dylib` (the version varies with macOS; the binary
  requires macOS 13).
- "`board watch` and `board sql` open with `OpenMode.readOnly`" becomes
  "open read-only (`bun:sqlite`, `readonly: true`)" (data owns the exact
  API).

### Storage, "Every operation", last paragraph

Replace the `package:sqlite3` sentence with:

> One process has one writing connection, and its `Store` alone holds it:
> `read(fn)` and `write(fn)` are each one Prisma `$transaction`, which the
> adapter runs one at a time per process. Nothing else touches the client,
> because a call made outside a transaction while one is open runs inside
> it and goes with its rollback. So two requests from one agent, which the
> MCP SDK runs concurrently, never interleave inside a transaction.

### Runtime

- **Busy timeout** bullet: keep the measurement, replace the last sentence
  with: "The wait is SQLite's busy handler, in C on the only thread: the
  process runs no JavaScript for up to 5 s (no timers, no stdin, no signal
  handlers). That is fine because the process can never wait on a lock it
  holds itself (one writing connection, one transaction at a time). A
  `board mcp`'s queued calls answer after the wait, each with the truth,
  and the n-th of n concurrent writes may wait up to 5n s; stdin closing is
  noticed after the wait, and the server exits 0 once its answers are
  written. A CLI command installs no SIGINT handler, so Ctrl-C during the
  wait ends it at once with nothing written. `board watch` and `board sql`
  read on a read-only connection and never wait behind a writer in WAL."
  The measurement the bullet keeps becomes Bun's, replacing Dart's 30
  processes: 10 processes × 100 write-first transactions through Prisma and
  the adapter, 1,000 of 1,000 committed in 1.35 s, no failure (data's §2).
  Prisma's `maxWait` and `timeout` are JavaScript timers and cannot fire
  during the wait; the queue behind a stuck holder is bounded only as open
  question 3 decides.
- **Time** bullet: `Clock` returns a `Date` truncated to milliseconds and
  formatted with `toISOString()` (which already writes milliseconds and
  `Z`). The rest stays.
- **Failures** table: the last row becomes "A binary signed without its
  entitlement, or with another | runs, with JavaScriptCore's JIT off when
  `allow-jit` is missing: every functional test still passes, so the
  self-test cannot catch it; the release compares the signed entitlements
  with `tool/macos/board.entitlements` and stops on any difference". Add:
  "Ctrl-C during a CLI's busy wait | the process dies at once; nothing
  written; it held no lock", and "Another process holds the write lock for
  long while an agent sends n writes at once | each answers `busy` after its
  own 5 s, the n-th after about 5n s (Prisma's `maxWait` cannot fire during
  the wait)".

### Module layout

§6 above, with its paragraph.

### Tests

§4 above; the Rules, Projects, Env, sql and CLI bullets keep their Dart
content with `sqlite3.openInMemory()` → an in-memory database through the
adapter, isolates → spawned processes, `McpClient`/`IOStreamTransport` →
`Client`/`InMemoryTransport.createLinkedPair()`, and the smoke test's
`BOARD_BIN` naming a built `board`.

### Build and distribution

- **Build**: `bun build --compile --target=bun-darwin-arm64 src/main.ts
  --outfile build/darwin-arm64/board`, and `--target=bun-darwin-x64` for
  x64, both on the arm64 Mac. One file per architecture (about 75–85 MB, a
  33 MB tarball), with Bun's runtime, the bundle and Prisma's WASM query
  compiler inside, and the system's SQLite loaded at run time. It runs from
  anywhere: through a symlink and as a copy.
- **x64**: Bun cross-compiles; Rosetta is needed only to run the x64
  self-test. The x64 runtime arrives signed by Oven; the release replaces
  that signature.
- **npm**: unchanged, except that each platform package holds `bin/board`
  alone. The shim stays a Node `spawnSync` script.
- **Signing**: one file, one call:
  `codesign --force --sign "$identity" --options runtime --timestamp
  --entitlements tool/macos/board.entitlements --identifier
  dev.katsuba.board "$B/board"`. The entitlement is
  `com.apple.security.cs.allow-jit`. Without it the binary still runs, with
  JavaScriptCore's JIT off. `disable-library-validation` is not needed: the
  only library loaded from outside the binary is the system's
  `libsqlite3`, a platform library.
- **Release** steps: as §5, with the entitlement read back and compared in
  step 7.
- **Generation**: §7's pipeline and scripts, the same for tests, CI and
  the release.
- **CI**: as §5.
- **Known risk: x64 is verified only under Rosetta**: unchanged in
  substance. Under Rosetta the x64 binary runs with and without the
  entitlement.
- Drop "`dart run` and `dart test` run the hook themselves".

## Proposed replacements for decisions 19, 20, 21, 25

**19. Built with `bun build --compile`.**

- **Context.** The owner moved board to Bun, TypeScript and Prisma 7.
- **Options.** `bun build --compile` over prisma-adapter-bun-sqlite
  (`bun:sqlite`, the system's SQLite); the same over @prisma/adapter-libsql
  (its own SQLite in a native addon).
- **Choice.** `bun build --compile` per target, with
  prisma-adapter-bun-sqlite. One file per architecture.
- **Consequences.** "The binary" is a file again: it runs as a copy. The
  SQLite version is the user's macOS's; the binary requires macOS 13. The
  first x64 build needs the network once (Bun's x64 runtime).
- **Libraries.** Bun 1.4.3, prisma 7.10.0, prisma-adapter-bun-sqlite 0.8.0,
  @modelcontextprotocol/server 2.3.1: built and run for arm64 and x64,
  through a symlink and as a copy. @prisma/adapter-libsql 7.10.0
  (@libsql/client 0.18.0) tried and rejected: the compiled binary loads its
  addon from the build machine's `node_modules` (a dynamic `require` the
  bundler cannot follow) and fails elsewhere, and the ad hoc signed addon
  needs `disable-library-validation` under Developer ID.

**20. macOS only, arm64 and x64.** Choice unchanged. The arm64 Mac
cross-compiles x64 with `--target=bun-darwin-x64` (under a second); Rosetta
only runs the x64 self-test. Known risk unchanged: x64 is verified only under
Rosetta. Libraries: Bun 1.4.3.

**21. Distribution: npm only.** Choice unchanged; each platform package holds
`bin/board` alone. The shim stays Node (`spawnSync`, inherited stdio,
re-raised signal), because npm runs `bin` with the user's Node. Libraries:
`npm pack` and `npm i` (npm 11.6.2) of a Developer ID signed Bun binary:
byte-identical, `0755`, no quarantine, `codesign --verify --strict` passes,
the MCP round trip passes through the shim.

**25. Signed with Developer ID, notarised and published from the owner's
Mac.** Choice unchanged, except: one file per architecture is signed (no
dylib, no second identifier `dev.katsuba.board.libsqlite3`); the entitlement
is `com.apple.security.cs.allow-jit`; the version comes from `package.json`;
the checks are `tsc --noEmit`, `biome ci .` and `bun test`; both builds run
natively on the arm64 Mac; the release reads the signed entitlements back
and compares them with the file. Consequences: without the entitlement the
binary runs with the JIT off rather than being killed, which no functional
test notices; `allow-unsigned-executable-memory`
also works but is wider, and `disable-library-validation` is not needed.
Libraries: tried on this Mac with the owner's Developer ID, `--timestamp`,
for arm64 and x64 (Rosetta), with and without each candidate entitlement;
`codesign --verify --strict`; `spctl` (`Unnotarized Developer ID`); the npm
round trip. Notarisation not run.

## Open questions

1. **For the owner (the lead takes it): the entitlement.** Decision 25 accepted
   `allow-unsigned-executable-memory` for Dart. Bun needs no entitlement to
   run; `allow-jit` gives it its JIT. Options: (a) `allow-jit` (proposed:
   narrowest that keeps the JIT; start-up 0.15 s against 0.24 s, hot code
   several times faster); (b) no entitlement at all (the binary is
   interpreted; the narrowest signature possible); (c) keep
   `allow-unsigned-executable-memory` (works, wider than needed).
2. **For data: the system SQLite.** The binary requires macOS 13; data
   should confirm the oldest supported macOS's `libsqlite3` has `STRICT`,
   `RETURNING` and whatever Appendix A uses, or name the floor. The smoke
   test prints `sqlite_version()` so a release records which one it ran on.
3. **For the lead and the owner: the queue behind a stuck holder is
   unbounded.** Prisma's `maxWait: 30_000` does not bound it (§3, measured
   with 8 and 12 concurrent writes: every one `P2010` busy after its own
   5 s, the 12th at 60 s, no `P2028`). Options: (a) accept: each call is
   told the truth, and the case needs a lock held for many seconds by
   something outside board; (b) `Store.write` notes when a write was
   queued and, when its turn comes, refuses it `busy` without touching the
   database if more than a bound (say 30 s) has passed: no timer, no retry,
   a few lines of ours before `$transaction`; (c) one write in flight per
   process at a time, refusing a second write `busy` while one waits for
   the lock: no added wait, but an agent's parallel writes would fail
   under ordinary contention too. Proposed: (a). (b) if the owner wants
   the 30 s bound data intended.
4. **Native Intel** is still untried, as before.
