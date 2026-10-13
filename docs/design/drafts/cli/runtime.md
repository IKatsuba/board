# Draft: runtime, for board without MCP

Owner of this file: `runtime`. It answers the brief's runtime questions 1–7,
data's three asks (who reads the environment, whether an agent's environment
is inherited, the Prisma client's cost per call) and interfaces' two (whether
chord can give an agent its own variable, whether shell exports persist), and
checks interfaces' "board reads no stdin" against the argument size limit.

Measured on: an Apple M3 Pro (12 cores), macOS 26.6.2, Bun 1.4.3, the
system SQLite 3.51.0, Node 24.13.0 for the npm shim, git 2.54. The binary is
`bun run build:arm64` from the tree as committed (`build/darwin-arm64/board`,
76.9 MB, ad hoc linker signature, JIT on). Probes were built into
`build/probe/` from entry files outside `src/`; nothing under `src/`, `test/`
or `tool/` was changed. Every run used a temporary `BOARD_DIR` and a
temporary repository with a linked worktree; `~/.board` was not touched.

## 0. In short

- A call costs about **75 ms** of process once MCP is gone (measured
  medians: 73 ms a read, 78 ms a write, 84 ms an add and a claim in one
  process), **32 ms** for `--version`; the npm shim adds **25 ms**; a cwd that misses
  (git) adds **25 ms**. Against an agent's turn (seconds) it does not
  matter. Nothing to do: no lazy imports, no daemon.
- The first run of a newly installed or upgraded binary takes **1.4 s**
  (macOS checking a new 77 MB executable), once per file.
- Two defects found in the CLI as built, both of which become agent-facing:
  **a closed stdout prints a Bun stack trace and exits 1** (`board watch |
  head -1`), and **the npm shim leaves its child running when only the shim
  is signalled** (an orphaned `watch --follow`). Fixes in section 2.
- chord gives an agent **no variable of its own** and team files **cannot
  set one**; an agent's shell **does not keep exports** between calls
  (Claude Code, measured). Every agent inherits chord's environment, so a
  `BOARD_ACTOR` in the person's profile would reach every agent. This
  supports interfaces' `--actor` on every write, with no environment
  variable.
- The notifier is **chord's own `monitor` tool** running `board watch
  --follow --json`: each line arrives in the agent's session as a message.
  No change to chord.

## 1. Start-up cost per call

### Method

A Deno script (`Deno.Command(...).output()`, stdout to `/dev/null`) timed the
wall clock from spawn to exit. Each case ran 3 warm-up runs, then 40 timed
runs, one after another, on an otherwise idle machine. The board held one
project, 300 tasks (20 claimed) and about 330 events. The shim case was
`node <prefix>/node_modules/@chorded/board/bin/board.js` with the platform
package laid out beside it as npm installs it. "Writes" that the CLI does not
have yet (`add`, `claim`) ran through a probe binary whose entry is
`src/main.ts`'s module graph plus two verbs that call `Board.taskAdd` /
`Board.taskClaim` inside `withBoard`, which is exactly what a CLI write will
do. Its bundle has the same 382 modules as `board`.

### Numbers (ms)

| Case | min | median | p90 |
| --- | --- | --- | --- |
| an empty `bun build --compile` binary (the floor) | 12 | 14 | 51 |
| `board --version` | 48 | 51 | 65 |
| `board --help` | 51 | 53 | 65 |
| shim: `board --version` | 73 | 78 | 94 |
| `board ls --json`, cwd = the project's directory | 87 | 94 | 118 |
| `board ls --json -p T`, cwd elsewhere | 87 | 93 | 127 |
| `board ls --json`, cwd = `<worktree>/sub` (git runs) | 110 | 119 | 191 |
| `board status --json`, cwd = the project's directory | 87 | 95 | 142 |
| shim: `board ls --json` | 110 | 119 | 153 |
| write: `task add` (probe) | 90 | 96 | 121 |
| write: `task add` then `task claim` in one process (probe) | 95 | 106 | 135 |
| write: `board milestone add` (the real CLI) | 90 | 97 | 128 |
| write: `task add` (probe) from `<worktree>/sub` (git runs) | 114 | 125 | 172 |

**Without MCP.** A copy of `src/` in `build/probe/` with `board mcp`
unmounted and `src/mcp/` removed (273 modules, 76.1 MB), against `board` as
built, 40 runs each:

| Case | as built, median | without MCP, median | saved |
| --- | --- | --- | --- |
| `--version` | 50 | 32 | 18 |
| `ls --json` | 90 | 73 | 17 |
| `status --json` | 92 | 75 | 17 |
| write: `task add` (probe) | 98 | 78 | 20 |
| write: `task add` then `task claim`, one process (probe) | 106 | 84 | 22 |

The write rows use the probe entry of "Method" built twice: once over `src/`
as committed, once over the MCP-free copy (382 and 273 modules), 40 runs each, same
board.

**Where the time goes**, in process (`performance.now()` from process start,
the median of 15 runs of a probe that loads the modules, opens the store,
runs `taskList` and closes):

| Phase | ms |
| --- | --- |
| Bun's runtime up, then every static import evaluated | 38 |
| of which the MCP SDK (`@modelcontextprotocol/server`) | 11–20 |
| of which Prisma's generated client and the adapter | 9 |
| of which cliffy and the rest of `src/` | about 1 |
| `Store.open`: `PrismaClient` built, `$connect`, the pragmas and identity checks | 21 |
| the first query (`taskList`; Prisma's query compiler is WASM and compiles the plan on first use) | 16 |
| `close` (`$disconnect`, the last connection's checkpoint) | 1 |
| process exit, after the last line | about 15 |

**Data's question on Ajv at run time.** Ajv 8.20.0 bundled into a compiled
probe: the import costs 2 ms (bundled, not resolved from disk); compiling
one input schema (`task_comment`'s) costs 19–21 ms, median of 9 runs. So
about 20–25 ms a call in the binary, less than the 40–70 ms measured from
source, and still a third of a read. It does not change data's
recommendation.

**Cold.** The page cache could not be dropped (no `sudo purge`), so "cold"
is the realistic one: the first exec of a new file, as after `npm install`
or `board upgrade`. Ten fresh copies of the binary, each run twice: the
first run took **1,312–1,677 ms** (median 1,418 for `--version`, 1,410 for
`ls --json`), the second 52 and 89. The cost is macOS's first look at a new
77 MB executable, once per file, whatever the command. The signed,
notarised release may differ (the ticket lookup does not apply: npm sets no
quarantine); not measured here.

**Signing.** The same binary re-signed ad hoc with hardened runtime and
`allow-jit` ran within noise of the unsigned one (`--version` 52 against 50,
`ls --json` 97 against 92). Re-signed with hardened runtime and **no**
entitlement, `--version` worked but every board call answered `internal`:
`ReferenceError: SharedArrayBuffer is not defined`. That contradicts the
design's row "a binary signed without its entitlement … passes every
functional test" (it was measured with the Developer ID signature, which
this probe could not use). The release's entitlement comparison still
guards it; the row should be re-measured with the real identity or
reworded. Out of this topic; reported to the lead.

### Does it matter?

No. An agent's step is a model turn of seconds; 75 ms per call is under 5%
of even a fast turn, and a session of a hundred board calls spends about
8 s in board in total. Under MCP a call paid only the round trip, but the
server paid its own start once per agent, and was a process per agent kept
alive for the whole session; nothing in an agent's loop is close to
latency-bound at this scale.

**Options weighed, none taken:**

- *Lazy imports* (Prisma only for commands that open the board): saves
  about 9 ms on `--version`, `--help`, `skill` and `upgrade`, which are not
  in the loop. Not worth a second import style.
- *Prisma's start* (`Store.open` plus the first query, about 37 ms, half a
  call): the client's construction and the WASM query compiler are Prisma's;
  there is no option to tune, and a store of our own on `bun:sqlite` is
  decision 11's turned-down (C). Recorded, not acted on.
- *A daemon or a socket*: a non-goal.

**Taken:** removing MCP saves 17–18 ms a call by itself. Nothing else. The
one rule needs no package here.

## 2. Process model: one process per call

Each command is one short process with one connection, as the CLI already
is. What that means at each boundary:

### The busy wait and Ctrl-C

Unchanged and re-measured on the binary, with `sqlite3` holding `BEGIN
IMMEDIATE`:

- A write behind the held lock answers `busy` after **5.17 s**, exit 1,
  nothing written.
- `SIGINT` 1 s into the wait: the process ends after **3 ms**, by the
  signal (130 to a shell); `SIGTERM`: 6 ms (143). Nothing written; the
  holder's lock was untouched. As decided: no CLI command installs a signal
  handler.
- A shell's `&` in a non-interactive shell starts the job with `SIGINT`
  ignored, so `kill -INT` on such a job does nothing; it waited out the lock
  and committed (measured, exit 0). An agent stopping a backgrounded board
  must use `SIGTERM` (or stop its process group). This is POSIX, not board's.
- What changes from MCP: **queued writes in one process are gone**. The
  "n-th write answers `busy` after about 5n s" row and consequence go: each
  agent's write is its own process and waits its own 5 s beside the others.
- An agent's shell timeout (Claude Code's default is 2 minutes) is far above
  5 s, so it never cuts a busy wait.

**Unknown outcome.** A call killed after its commit and before its answer
(Ctrl-C at the wrong millisecond, a shell timeout) leaves a write the agent
did not see. **Only reads are safe to retry blindly.** No write is:
`add`, `comment`, `handover` and `ask` file twice; `claim`, `extend`,
`release` and `edit` can undo a later write by another run (a `release`
retried after the same holder reclaimed drops the new claim; an `edit
--status ready` retried after another run claimed the task sends it back).
The rule the skill teaches: **after an interrupted write, re-read** (`board
show KEY --json`, its events since the last id the agent saw; `board ls
--contains` for an `add`), **then decide** whether the write happened and
whether it is still wanted. A `claim_held` naming the agent itself means the
claim is already its own. Asked of interfaces.

### git resolution per call

- Each process resolves from its own cwd (`process.cwd()`, a real path).
  Nothing is captured "at start" of anything longer than the call.
- git runs only when the cwd is in no project's directory: **25 ms** a call
  (measured: 119 against 94 for a read, 125 against 96 for a write), of which
  `git rev-parse` itself is about 20 ms. A team in a worktree pays it on
  every call; `-p KEY` skips it. chord runs every agent in the session's
  directory with no worktrees (chord's code, section 6), so with chord the
  usual case is a direct cwd match.
- The roll-back-and-retry with git's answer stays as built: it is about one
  call, not about a long-lived process.
- `Place`'s shared pending git ("concurrent calls share one pending git") no
  longer has a second caller in production. The code may stay (it is
  correct, and its test still passes); the design's sentence goes.
- **A cwd deleted under the shell**: Bun refuses before `main.ts` runs, with
  its own line `error: The current working directory was deleted, so that
  command didn't work. Please cd into a different directory and try again.`,
  exit 1 (measured, with and without `-p`). Not board's error shape, but one
  clear line; accepted, since nothing of board's runs.

### stdin

Interfaces recommend that board read no stdin and no files (long text
through a quoted heredoc inside `"$(…)"`). From the runtime side that is the
safest choice: **no command can hang on input**. Measured here: Claude
Code's shell gives a command `/dev/null` as stdin (a character device
`3,2`), so a reader would see EOF at once there; but other harnesses run
commands on a pty, where a reader would wait for a person forever.

**The argument size limit holds.** macOS's `ARG_MAX` is 1,048,576 bytes
(`getconf ARG_MAX`, `kern.argmax`) for the arguments and the environment
together, and macOS has **no per-argument limit** (Linux's 128 KiB
`MAX_ARG_STRLEN` does not exist there; Linux is out of scope anyway).
Measured through the binary: one argument of 20,000 astral characters
(80,000 bytes), of 200,000 (800,000 bytes) and of 1,000,000 ASCII bytes all
reached cliffy whole (its `lengthIn` reported the exact code-point count);
1,100,000 bytes was refused by the shell, `argument list too long`, before
board ran. The largest inputs board takes:

| Command | Largest | Worst-case bytes (4 per code point) |
| --- | --- | --- |
| `add` / `edit` | body 20,000 + title 200 | 80,800 |
| `handover` | text 10,000 + changed, ran, unchecked 3 × 4,000 + to 64 | 88,256 |
| `ask` | text 2,000 + 6 options × (80 + 500) | 21,920 |

Each is under a tenth of `ARG_MAX` with a typical environment (about 6 KB
here). Through the npm shim the arguments are passed twice (to `node`, then
to the binary), each exec with its own limit. **It holds.**

`$(…)` strips every trailing newline, not just the heredoc's one; a body
that should end in blank lines loses them. Harmless for board's texts.

If the owner takes interfaces' alternative (B) instead (`--body-file -`):
`Bun.stdin.text()`, read **only** when `-` is given, and refused as usage
(64) when `process.stdin.isTTY` is true, so a pty never blocks. A stdin
never closed by its writer would still hang until the harness's timeout;
that is the cost of (B).

### A closed stdout: a defect today

`board watch --json | head -1`, measured on the binary as built:

```
EPIPE: broken pipe, write
 syscall: "write",
   errno: -32,
    code: "EPIPE"

      at write (unknown:1:1)
      at writeFast (internal:fs/streams:382:38)
      …
Bun v1.4.3 (macOS arm64)
```

17 lines on stderr, exit 1. Bun ignores `SIGPIPE`, so a write to a closed
pipe is an `EPIPE` error rather than a quiet death; the same holds for
`board sql` with a large result. A small output (`ls --json` of 300 tasks)
fits the pipe's buffer and exits 0 before the reader closes, so the defect
shows only on long output. An agent piping to `head` is ordinary: agents
cut output to save context.

**Proposed:** `src/main.ts` treats `EPIPE` on stdout as the end: no message,
**exit 141** (128 + `SIGPIPE`), which is what a shell shows for `yes | head`
and what `set -o pipefail` reports for any well-behaved Unix tool. The
handler is a few lines on `process.stdout`'s `error` event and on a throw
from `write`, in board's own entry point; no package is involved (it is the
runtime's own signal behaviour, not a package's), and nothing is retried or
rewritten. A test runs the binary into `head -c 1` and checks exit 141 and
an empty stderr. A write whose answer could not be printed has still
committed; that is the "unknown outcome" above.

### Exit codes as the shell sees them

| Exit | Meaning |
| --- | --- |
| 0 | done |
| 1 | refused by board (17 codes + `registry`); also Bun's own refusals before board runs (a deleted cwd) and the shim's "no platform package" |
| 64 | usage (cliffy), and `board sql` refusing a write |
| 126 / 127 | the shell could not run `board` (not executable, not on `PATH`) |
| 130 / 143 | ended by `SIGINT` / `SIGTERM` (any command, not only `watch`; the shim re-raises the child's signal) |
| 141 | stdout closed by the reader (proposed above) |

### Who reads the environment (data's first ask)

cliffy's `.env()` reads `process.env` itself: `@jsr/cliffy__internal`'s
`getEnv(name)` returns `Deno.env.get(name)` or `process.env[name]`, with no
way to inject another source. Under `bun test`, a test of a variable would
have to mutate the global `process.env`, shared by every test in the file.
So, **if** any variable is chosen (interfaces recommend none), `src/main.ts`
reads it into `Deps` beside `env` and `cwd`, and the command takes it as the
fallback for its flag, as `BOARD_DIR` is read today; `.env()` is not used.
The help names the variable in the option's description. This keeps "only
`src/main.ts` reads the environment" true. With interfaces' recommendation
(`--actor` and `-p` only), the question does not arise.

### The failure table, re-read without `board mcp`

Rows that go: "An agent exits → its server's stdin closes", "`board mcp`
keeps running and retries", "a bug in board → the server keeps running",
"n writes queued in one process", "cwd deleted after the server started".

| Situation | Outcome |
| --- | --- |
| A process killed inside a write | SQLite rolls it back; the lock is free at once; rows and events never disagree. A claim committed earlier stays until its lease runs out |
| A call killed after commit, before its answer | the write stands; the agent did not see it; only reads are safe to retry; after any write, re-read, then decide (above) |
| Lock held past 5 s | `busy`, exit 1, nothing changed; retry |
| Ctrl-C or `SIGTERM` during the busy wait | the process dies at once (3–6 ms), 130 / 143, nothing written, no lock held |
| No board file / bad `BOARD_DIR` | `no_board`, exit 1; the next call opens afresh, so a board created later is simply there |
| cwd in no project, git finds none | `no_project` with the cwd, git's outcome and the `project add` line |
| git missing, slow or failing | resolution goes on without it; the reason is in the error; 3 s at worst |
| The shell's cwd deleted | Bun's one line, exit 1, before board runs |
| A project's directory moved | it matches nothing until `board project edit --dir` |
| Damaged file / not a board / another schema | `damaged` / `not_a_board` / `schema_mismatch`, with the offline recovery |
| **An upgrade with another `user_version`** | every next call **that runs the new binary** answers `schema_mismatch` at once (no long-lived process keeps the old one), until the person moves the file aside and runs `project add`. Per decision 43, `PATH` may resolve another install for some shells (two nvm Nodes, another prefix): those calls keep running the old binary against the file, and after the move-aside and `project add` by the new one, they answer `schema_mismatch` instead. Which binary an agent runs is its `PATH`'s. Before the first release that is the documented path; the skill says to stop and report `schema_mismatch`, and `board upgrade`'s closing note says so (today it says "running `board mcp` servers keep the old version") |
| A call during an upgrade's install window | the binary or the platform package is briefly missing: 127, or the shim's "no platform package", exit 1; the next call runs the new version. pnpm 10 interrupted leaves no `board` (README) |
| The first call after an install or upgrade | about 1.4 s, once (macOS's first look at the new file) |
| Board file removed by hand while agents work | every later call is `no_board`; nothing is lost silently any more, since no process holds the old file open between calls (writes in flight at that moment are lost, as before) |
| Disk full, I/O error | `storage`, rolled back, exit 1 |
| A bug in board inside a write | rolled back, `internal`, exit 1 |
| stdout closed by the reader | today a stack trace and exit 1; proposed: silent, exit 141 |
| The shim signalled alone | today its child keeps running, orphaned; proposed: the shim forwards the signal (section 3) |
| A binary signed without its entitlement | to re-measure (section 1, "Signing"); the release's entitlement comparison stays |

## 3. `watch --follow` as the agent's notifier

### How an agent runs it

**With chord: chord's `monitor` tool.** chord exposes `monitor`,
`stop_monitor` and `list_monitors` on its own MCP server (chord's
`src/server/tools.ts`). `monitor` runs a command through the person's
`$SHELL -c` in the session's directory, in its own process group; **each
stdout line becomes an event**, batched and delivered into the session as a
message from "<description> · monitor", starting a turn after the current
one. stderr is dropped unless merged; the default timeout is 10 minutes, the
maximum 1 hour. Its limits (chord's `src/session/monitors.ts`): a line is cut
at 1,000 characters; a batch gathers for 200 ms and carries at most 100
lines and 16 KiB, past which lines are counted, not sent; more than 1,000
lines or 256 KiB within 10 s stops the monitor as a flood; at most 8
monitors per session. So **a line is a wake-up hint, not data**: a
`handover` event's JSON can pass 1,000 characters and arrive cut, and a
burst can arrive as a count. On a line, the agent reads the board (`board
show KEY --json`, `board watch --since ID --task KEY --json` without
`--follow`) for the content. That is the notifier this needs, with no change
to chord:

```sh
board watch --follow --json -p BRD --kind claim_expiring,handover,question_answered 2>&1
```

- `--json`: one object per line, so each message is self-describing.
- `-p` and `--kind`: every line is a turn of the agent; an unfiltered watch
  of a busy board would wake it for every comment. `--task KEY` narrows a
  member to its own task.
- `2>&1`: a refusal (`no_board`, `not_found` for `-p`) goes to stderr,
  which `monitor` drops; merged, the agent sees why the watch ended.
- **The cursor, across restarts.** Before the first attach, the agent takes
  `last_event` from `board status --json` and starts with `--since` that id
  (not a bare `--follow`, which starts from "now" as of attach, so a write
  between the agent's last read and the attach would be missed). It
  advances its cursor only on lines whose `id` is not null (a derived
  `claim_expiring` has `id: null`), and only on lines it saw whole: a line
  cut by the monitor, or counted and not sent, means re-reading from the
  cursor without `--follow`. When the monitor ends (its hour, a flood, a
  refusal), the agent starts it again with `--since <cursor>`; nothing
  logged is missed. A `claim_expiring` whose window fell in the gap is
  re-derived on attach if the claim is still inside its window.
- `stop_monitor`, the timeout and a flood end the command with `SIGTERM` to
  its whole process group, then `SIGKILL` to what is left (chord's
  `src/shell.ts`, `terminate`). So the watcher ends even through today's
  shim, and `--exec` children with it.

**Without chord:** whatever background facility the harness has (Claude
Code's background shell, `&` in a persistent shell). A background job whose
output goes to a file is not a notifier: the agent must look. The skill
should say "if your harness can show you a command's output as it comes"
(interfaces' wording already does) and leave the mechanism to the harness.

### `--exec`: what it is for, and what not

`--exec` is the person's notifier (a sound, `osascript`, a terminal
notification), not the agent's. For an agent:

- **Do not** run a board write from `--exec`. The write appends an event,
  the watcher reads it, and the command runs again: with a filter that
  admits the write's own kind, a loop. And `--exec` sets `BOARD_ACTOR` /
  `BOARD_PROJECT` to the event's values (`src/watch/exec.ts`): if board
  ever read those names, the write would be made as whoever caused the
  event. (A reason, with interfaces', not to read them.)
- **Do not** start an agent or a long job from `--exec`: the watcher stops
  reading while the command runs, and kills it after `--exec-timeout`.
- The agent's notifier is the stream itself (`monitor` above); `--exec` adds
  nothing an agent can use.

### An orphaned watcher through the npm shim: a defect today

Measured: `node …/board.js watch --follow` in its own process group,
`SIGTERM` sent to the `node` pid only. The shim died; the binary child
stayed, reparented to `launchd` (ppid 1), still watching. The shim uses
`spawnSync`, which blocks Node's event loop, so it cannot forward a signal;
a signal to the whole group (Ctrl-C in a terminal, chord's `stop_monitor`)
reaches both and is fine, but anything that signals the top pid alone (a
harness's kill of the command it started, a `kill $!`) leaves a watcher
running until the machine restarts. With per-call commands that is any
command, but only `watch --follow` lives long enough to matter.

**Proposed:** the shim spawns with `child_process.spawn` (asynchronous,
`stdio: "inherit"`), forwards `SIGINT`, `SIGTERM` and `SIGHUP` to the child,
and on the child's exit re-raises its signal or exits with its status, as
now. That is Node's own API in the shim board already ships, about fifteen
lines; esbuild's shim has the same `spawnSync` shape and the same gap, so
there is no package to take. A `npm.test.ts` case: the shim signalled alone
leaves no child. Rejected alternative: the watcher exiting when its parent
dies (polling `process.ppid`), which would also kill a watcher someone
deliberately detached with `nohup`.

## 4. Module layout, dependencies, build and release

### Layout after `src/mcp/` goes

```
src/main.ts           the entry point: the only reader of the environment,
                      the cwd and the process's streams; EPIPE → exit 141
src/env.ts, clock.ts, errors.ts, text.ts, visible.ts   unchanged
src/place/            Place, GitRunner, ProcessGitRunner, the root rule;
                      unchanged (the shared pending git stays, unused twice)
src/store/            unchanged
src/rules/            unchanged
src/board.ts          Board = Store + Clock; the constructor takes a Store
                      (the lazy `() => Promise<Store>` and its retry go, per
                      data); `Context` loses `pin`; `OWNER` goes (data)
src/schemas.ts        output schemas and types only (data)
src/skill.ts          the guide's prose, pure (interfaces)
src/cli/root.ts       the tree; `mcp` unmounted, the new commands mounted
src/cli/io.ts         Deps, withBoard, refusing, table; unchanged in kind
src/cli/task.ts …     the write commands, one file per group as interfaces
                      name them (add/edit, claim/extend/release,
                      comment/handover, ask)
src/cli/skill.ts      `board skill`: the prose plus the index walked from
                      the tree; opens no board
src/watch/, src/sql/, src/upgrade/   unchanged; one text in
                      `upgrade/providers.ts` changes (below)
```

Deleted: `src/mcp/server.ts`, `src/cli/mcp.ts`. `rules/` and `board.ts` keep
knowing nothing of cliffy or stdout; the CLI is now the only adapter.

### Dependencies

- `dependencies`: **remove `@modelcontextprotocol/server`**.
- `devDependencies`: **remove `@modelcontextprotocol/client`**; add `ajv`
  (data's choice, for output-schema tests; tests only, never bundled).
- Nothing added at run time. The bundle drops from 382 to 273 modules, the
  binary from 76.9 MB to 76.1 MB, and each call by 17–18 ms (section 1).
  Ajv's `new Function` leaves the binary with the SDK; JIT stays wanted for
  speed (and, per section 1, possibly for Prisma at all).

### Build and release

- `package.json`'s scripts: unchanged.
- `tool/release.sh` and `tool/release/*.sh`: no MCP in them (checked). Step
  7's self-test (`project add`, `ls`) stays; the smoke test it runs
  (`test/binary.test.ts`) changes as below. The comment "MCP round trip" in
  the design's signing paragraph goes.
- `npm/board/package.json`'s description ("an MCP server and a CLI") and
  `npm/board/bin/board.js`'s comment ("so MCP framing passes through") are
  reworded; the shim changes as in section 3.
- `src/upgrade/providers.ts`: "Running board mcp servers keep X until their
  agents restart them." becomes "Every board command from now on runs Y; if
  the schema changed, the board answers schema_mismatch until it is moved
  aside." (wording to interfaces), and `test/slice7-providers.test.ts`'s
  expected text with it.

## 5. The test plan

### How a test runs a command

As now: `runCli(argv, deps)` in process, the root built by `buildCli`, with
`.noExit()`, injected `io` sinks, `env`, `cwd`, a `FakeClock` and a fake or
real `GitRunner`. Nothing new is needed in `Deps` under interfaces' surface
(no stdin, no variables). Under (B) or a variable, `Deps` gains `stdin:
{isTTY, text()}` and the variable's value, wired in `main.ts` only.

**Concurrency is tested across processes, never in process.** Two `runCli`
calls in one process would open two connections in one thread; the busy
handler blocks the thread in C, so the waiting one stops the one holding the
lock from committing, and the test measures a self-made `busy` after 5 s.
That is not the production shape (one call, one process). Concurrent cases
spawn `bun src/main.ts …` (or `test/helpers/holder.ts`) as processes, as the
store tests already do.

### What each MCP test becomes

| Today | Becomes |
| --- | --- |
| `mcp.test.ts`: the tool list, schemas, annotations | the command tree: every command `interfaces.md` lists is mounted with its flags (walked from `buildCli`); the skill tests below |
| `mcp.test.ts`, `mcp-work`, `mcp-chain`, `mcp-questions`: per tool, one success with text and `structuredContent` agreeing | per command, one success: the human line and `--json` agree; `--json` validated against `outputs.<command>` with Ajv (data) |
| … each tool's refusals in board's shape; every database refusal | per command, its refusals: exit 1, `board: <code>: …` on stderr, the error object under `--json` validated against `errorShape`, stdout empty |
| … "arguments the schemas refuse are the library's, text only" (`mcp-*`, `slice1–4-mcp`) | usage errors: exit 64, `board: usage: …`, never JSON, **nothing opened** (no `board.db` created on a missing board), **no event appended**; one case per row of data's validation table, including code-point lengths at the maximum and one past it |
| `mcp.test.ts`: a rule that throws answers `internal` | the same through `runCli` (`spyOn` the rule, as `cli.test.ts` already does): exit 1, `internal`, the write rolled back |
| `mcp.test.ts`: `no_project` with `details`, then works after `project add` | the same through `runCli`, cwd in a temp directory, no `-p` |
| `mcp.test.ts`: the pin names the project | goes (no pin); `-p` overriding the cwd, and `-p` contradicting a key → `invalid_argument` |
| `mcp.test.ts`: missing board / bad `BOARD_DIR` answered on every call, then works | one call answers `no_board`; after `project add`, the next call works (no retry loop to test) |
| `mcp.test.ts`: Board lifecycle (close waits for an open) | goes with the lazy open |
| `slice1-mcp`: two transport calls share one pending open | goes |
| `mcp-work`, `mcp-chain`, `mcp-questions`: the paths (add, claim, extend, handover, send back, lapse, reclaim, close; the chain built and walked; block, delegate's answer, override, validate) | the same scenarios as sequences of `runCli` calls on one temp board, the lapse by moving the `FakeClock`. These are also the skill's flows, so the skill's examples are taken from them |
| `mcp-work`: two claims at once → one claimed, one `claim_held`; `slice2/3-mcp`: concurrent updates and aliases | two **spawned** `bun src/main.ts` processes started together; exactly one exits 0, the other exits 1 with `claim_held` (or the rule's code); repeated 20 times |
| `slice4-mcp`: Unicode maxima round trip | through argv: a 20,000-code-point body of astral characters (80,000 bytes) passed as one argument and read back equal by `show --json` |
| `slice6-binary`: MCP refusals over stdio, validated | refusals through the binary, `--json`, validated against `errorShape` |
| `test/binary.test.ts` | below |
| `npm.test.ts`: "board runs through the shim, with the MCP round trip" | through the shim: a write and a read with `--json`, a refusal's exit 1 and a usage error's 64 kept; new: the shim signalled alone leaves no child |
| `slice7-providers`: the closing note | the new text |

Rules, store, place, env, watch and sql tests: unchanged.

### The binary smoke test

Skipped unless `BOARD_BIN` names a built `board`; run through a symlink and
as a copy, as now; CI on the unsigned arm64 build, the release on both
signed ones (x64 under `arch -x86_64`). With a temp `BOARD_DIR` and a temp
repository with a linked worktree:

1. `board project add T --dir <repo>`, exit 0.
2. From `<worktree>/sub`, no `-p`: `board add --actor smoke --title 'Smoke
   100% done' --body "$(cat <<'EOF' … EOF)"` with a body holding quotes, `$`
   and a backtick, through `sh -c` so the heredoc is the shell's; it must
   resolve through git; `--json` gives `T-1`.
3. `board ls --contains '100%' --json` → `[T-1]`; `board show T-1 --json`
   gives the body back byte for byte.
4. `board claim T-1 --actor smoke --minutes 5`, then the same again → exit
   1, `claim_held`; a missing flag → exit 64, nothing written.
5. Five processes claim one fresh task at once: one 0, four `claim_held`.
6. `board watch --json | head -c 1` → exit 141, empty stderr.
7. `board skill` exits 0 and opens no board (run with a `BOARD_DIR` that
   does not exist).
8. `board sql` reads the task back; `sqlite_version()` printed, as now;
   `board upgrade --help`, as now.

No MCP client anywhere in `test/`.

### Keeping `board skill` in step

Interfaces' three tests (every `board …` line in the prose parses against the
tree with no-op actions; every error code is in the prose's table; the index
is generated) are the right ones. Runtime adds one: **the flows run**. Each
flow's fenced lines, in order, are run with `runCli` against a fresh temp
board (keys and ids substituted from the previous answers' `--json`), each
expected to exit as the text says. A command that parses but no longer does
what the prose says (a renamed `--kind`, a refusal that changed code) fails
here and nowhere else. If substitution proves heavier than the flows, the
fallback is the scenario tests above sharing their command lines with the
prose through one constant.

## 6. With chord

What was verified in chord's code (read only, nothing changed) and in this
session, which runs inside chord:

- **How an agent starts.** chord spawns each agent (main, a lead, a member)
  in its own process group, with **chord's own environment** plus a few
  fixed per-runtime variables (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and the
  like), in the tab's directory (chord's `src/platform/process.ts`,
  `src/session/session.ts`). **No variable names the agent, its role or its
  team.** Every member works in the session's directory; chord makes no
  worktrees.
- **No per-agent variable without a change to chord.** Team files are
  markdown with YAML frontmatter, a strict schema (`description`, `lead`,
  `members[]` with `name`, `role`, `agent`, `model`, `effort`, `mode`,
  `instructions`): unknown keys are refused. Settings likewise (an agent's
  `command`, `model`, `effort`, `permissionMode`); the `command` override
  refuses shell syntax, so `BOARD_ACTOR=x cmd` cannot be smuggled in. The
  one `env` key in chord is for stdio MCP servers. So **the answer to
  interfaces' (a) is no.**
- **An agent's environment reaches its commands.** This session's Bash
  commands see the agent process's environment (variables set for the agent
  process are present in every command); the shell is a fresh child of the
  agent process per call.
- **Exports do not persist** (interfaces' (b)): `export X=1` in one Bash call,
  `$X` unset in the next (measured, Claude Code under chord). Codex and
  chord's other runtimes were not measured; their shells may differ, and
  nothing should depend on either behaviour.
- **Consequence for the actor.** A `BOARD_ACTOR` exported in the person's
  profile reaches chord and through it every agent: all would write as that
  name whenever they leave out `--actor`. Per-agent values can come only
  from the agent typing them on each call. That is `--actor` on every write
  (interfaces' recommendation), which runtime supports. The agent knows its
  name: chord writes "You are <name>, a member of team <team>" or "You are
  the lead of team <team>" at the top of its instructions, and `main` is
  `main`.
- **The project.** With chord, agents run in the session's directory, so the
  cwd resolves the project with no flag and no git. `-p` covers the rest;
  no `BOARD_PROJECT` is needed.
- **Nothing in `.mcp.json`.** The board's line goes from the README; chord
  starts no board process. An existing `.mcp.json` with the old line would
  start `board mcp`, which no longer exists: the agent's client reports the
  server failed and goes on. The README's migration note should say to
  remove it.
- **The flow** (for the merged "How it runs with chord"): the person adds
  the project; `main` runs `board next` and `board claim KEY --actor main
  --holder <lead> --minutes N`, starts the team with the key in the job;
  the lead runs `board show`, comments, `handover`, `add --parent`,
  `extend`, `ask`, all with `--actor <its name>`; the lead (or `main`) runs
  a chord `monitor` on `board watch --follow --json` for `claim_expiring`;
  `main` closes with `board edit KEY --status done`. Teaching this lives in
  `board skill` and the team file's body ("run `board skill` first; pass
  `--actor` with your name on every write"); nothing in chord changes.

## 7. Decisions to replace or amend (runtime side)

- **1. The actor.** Context: no `.mcp.json`; the CLI. Add the facts of
  section 6: chord passes no per-agent variable and team files cannot set
  one; agents inherit chord's environment; exports do not persist. Option
  (b) of the old entry stays unavailable without a change to chord.
- **2. One tool set** → one command set; unchanged in substance.
- **11. Concurrency.** Drop "writes queued in one process … the n-th after
  about 5n s". Keep the freeze and "no CLI command installs a SIGINT
  handler", re-measured: 3 ms for `SIGINT`, 6 ms for `SIGTERM`. Add: tests
  of concurrency spawn processes, since two connections in one thread can
  block each other.
- **19. Built with `bun build --compile`.** The MCP SDK and its Ajv leave
  the binary. Re-measure the "signed without `allow-jit`" claim (section 1).
- **24. How a call finds its project.** The pin (`board mcp --project`)
  goes; `-p` is the explicit override. "A server captures its cwd at start"
  becomes "each call resolves from its process's cwd". "Concurrent calls
  share one pending git" goes from the decision (the code may stay).
- **New: one process per call is fast enough.** Context: MCP's long-lived
  server gone. Measured (section 1): 32 ms `--version`, 73 ms a read and 78 ms
  a write after MCP's removal, +25 ms through the shim, +25 ms when git
  runs, 1.4 s on a new file's first run. Options: accept; lazy imports;
  tune Prisma's start; a daemon (non-goal). Choice: accept.
- **New: a closed stdout ends board quietly with 141.** Context: Bun
  ignores `SIGPIPE`; today a stack trace and exit 1. Choice: `main.ts`
  handles `EPIPE` on stdout, no output, exit 141. No package involved.
- **New: the shim forwards signals.** Context: `spawnSync` cannot; an
  orphaned `watch --follow` measured. Choice: asynchronous `spawn` with
  `SIGINT` / `SIGTERM` / `SIGHUP` forwarded. Turned down: the watcher
  polling for its parent's death.
- **New: the agent's notifier is chord's `monitor` over `board watch
  --follow --json`**, filtered by `-p` / `--kind`, `2>&1`; `--exec` stays the
  person's notifier and must not write to the board.
- **No stdin (interfaces).** Runtime agrees and adds the measurement:
  `ARG_MAX` 1 MiB, no per-argument limit on macOS, the largest input about
  88 KB.

## Open questions

- **Owner (through the lead), the actor.** Runtime's facts favour
  interfaces' (a), `--actor` required on every write with no variable:
  chord cannot set a per-agent variable, an inherited one is shared by
  every agent, and exports do not persist. Data's "a person sets
  `BOARD_ACTOR=owner` in their profile" would make every agent the owner
  whenever it forgets the flag; under (a) the person types `--actor owner`
  (or keeps a shell alias, which agents' non-interactive shells do not
  necessarily share; not verified).
- **Lead:** accept the start-up cost with no action (recommended), or ask
  for lazy imports.
- **Lead:** the two defects (EPIPE, the shim's signals) are in the built
  CLI and the shipped shim, independent of this topic; fix them with this
  change (recommended) or separately.
- **Lead:** the `allow-jit` finding (section 1, "Signing") touches decision
  25's consequences; a re-measure with the Developer ID is the owner's
  machine's.

### Asked of the other architects

- **interfaces:** the skill should (1) say that after any interrupted write
  the agent re-reads, then decides (only reads are safe to retry blindly);
  (2) say that `claim_held` naming oneself means the claim is already one's
  own; (3) show the notifier as a chord `monitor` (with `--json`, `-p`,
  `--kind`, `--since` from `status --json`'s `last_event`, and `2>&1`)
  where the harness has one, say that a line is a hint to read the board,
  not the data, and say `--exec` is not for board writes; (4) word `board upgrade`'s new closing note (section 4) and the
  skill's line for `schema_mismatch` ("stop; tell the owner").
- **data:** nothing beyond the answers above (the environment is read by
  `main.ts` if at all; inheritance confirmed; Prisma's start measured at
  about 37 ms of a 75 ms call; Ajv in the binary 20–25 ms a call; the
  upgrade row added to the failure table).
