# v1-projects: runtime

What changes at run time now that there is one board per machine with
projects in it, no FTS5 and no pause. Answers the brief's "runtime"
questions. Everything not named here holds as in
`docs/design/drafts/v1/runtime.md` and the merged `docs/design.md`.
Experiments were run outside the repository on macOS 26 arm64 with Dart
3.13.5, `sqlite3` 3.7.0 (SQLite 3.53.4) and git 2.54; results are quoted
where they are used and listed at the end.

## Summary of changes

- The file is `$BOARD_DIR/board.db`, `BOARD_DIR` defaulting to `~/.board`.
  No upward search. Only `board project add` creates the directory and the
  file. `no_board` stays, with a new cause and message.
- Project resolution is pure Dart over a **place** (the process's real
  working directory, and the main checkout git names for it) and the
  `project` rows. A `board mcp` captures its cwd once at start. git runs only
  when the cwd matches no project, outside any transaction (a call that finds
  it needs git rolls back, asks, and runs again once), never cached, with a
  3 s timeout.
- Nothing about a project is decided at server start: the server always
  starts and lists its tools, and every call resolves on its own.
- Paths are compared as real paths (`realpath(3)`), which on macOS also
  canonicalises `/tmp` → `/private/tmp`, symlinks and the letter case of an
  APFS case-insensitive volume. Tried.
- Build: `dart build cli` per architecture. **The cross build to x64 from an
  arm64 SDK does not exist**; the x64 Dart SDK under Rosetta builds x64 in
  13 s, so x64 is cheap and in. A quarantined `libsqlite3.dylib` is refused
  by macOS; npm, Homebrew and `curl | tar` do not quarantine, a browser
  download does.
- There is no reset (R0): `board.instance`, `board_reset` and the `board`
  table go; starting over is offline (§4). The busy timeout stays 5 s: 30 processes writing
  back to back saw a worst wait of 1.7 s and no `busy`.
- Tests: pause and FTS tests go; `projectAt`, the place, `BOARD_DIR` and the
  git runner get their own, with a fake git and with real git in temp
  directories; the build smoke test runs the bundle through a symlink and from
  a git worktree.

## 1. Where the board is, and first run

### The path

```
boardDir  = BOARD_DIR if set and non-empty, else $HOME/.board
boardFile = boardDir/board.db
```

- **Read once per process**, from the environment the process was started
  with. Only `bin/board.dart` touches `Platform.environment`; `lib/` takes an
  `Env` (a map) so tests set it.
- **`BOARD_DIR` must be absolute.** A relative value would resolve against
  each process's cwd, and the `board mcp` of every session would open a
  different file without a word. `"BOARD_DIR": "~/x"` in a JSON config is not
  expanded by anyone and is relative too. Refused with
  `BOARD_DIR must be an absolute path, got "~/x"`. An empty value counts as
  unset (as quarry's `QUARRY_DIR`).
- **`HOME` unset and no `BOARD_DIR`**: the same kind of refusal, naming both.
- `BOARD_DIR` names the directory, not the file, like quarry's `QUARRY_DIR`
  names `.quarry/`. The directory holds `board.db`, `board.db-wal` and
  `board.db-shm` and nothing else; no `.gitignore` is needed any more, since
  it is not inside a repository.
- These refusals are configuration errors. The CLI prints them and exits
  non-zero; `board mcp` still starts and answers every call with the same
  message (an MCP server that fails to start shows the agent only an opaque
  "failed"). Code: `no_board` with the message; *(interfaces may prefer a
  separate code; flagged)*.

### Who creates it

**Only `board project add`.** It creates `boardDir` (recursively, so a
`BOARD_DIR` naming a new directory works), creates `board.db`, sets
`journal_mode = WAL`, and creates the schema, `application_id` and
`user_version`, then inserts the project, all as in v1's `board init`:
the "is it already a board" check repeated under `BEGIN IMMEDIATE`, so two
first `project add`s on a fresh machine cannot both create the schema, and an
empty file left by an interrupted first run is initialised. A second
`project add` on an existing board only inserts its row.

Every other command, and every tool, opens with `OpenMode.readWrite` (or
`readOnly`), which never creates. A missing file is `no_board`:

```
no board at /Users/me/.board/board.db (BOARD_DIR is not set);
`board project add KEY` in a project's directory creates it
```

With `BOARD_DIR` set, the message says `BOARD_DIR names /path` instead, as
quarry separates "you named it wrong" from "there is none". Why not create on
any first command: a read that creates turns a mistyped `BOARD_DIR` into a
second, empty board that answers "no projects" forever; and `watch` and
`sql` open read-only and cannot create anyway.

`board mcp` started before the file exists starts, lists its tools, answers
`no_board`, and tries to open again on each call, so a `project add` run later
is picked up without restarting the agent (v1 behaviour, kept).

### Permissions

The directory and file get the default modes under the umask (`0755` and
`0644` under the usual `022`; SQLite gives `-wal` and `-shm` the mode of the
main file). Under `$HOME` that is enough on macOS: the home directory is
`drwxr-x---`, so no other user reaches `~/.board`. A `BOARD_DIR` outside the
home directory is the person's choice of place. `dart:io` has no `chmod`; a
`0700` would need `package:posix` (FFI to libc). Not in v1 (review): default
modes.

## 2. Project resolution at run time

### Inputs, in order

The order is the owner's; interfaces decides which tools take an explicit
`project`.

1. An explicit project (tool argument or `--project`), if interfaces gives
   one.
2. A task key (`APP-12`): its prefix names the project. No path is looked at.
3. **The cwd**: the project whose directory is the cwd or contains it.
4. **git**: if git is there and names a main checkout for the cwd, the
   project whose directory is that checkout's root or contains it.
5. Otherwise `no_project` with what was looked at.

Steps 3 and 4 use one pure matcher:

```dart
/// The project whose directory is `path` or lies above it; the deepest when
/// projects nest. A bare string prefix is not enough: /p/app-two is not
/// under /p/app.
Project? projectAt(Iterable<Project> projects, String path);
```

This is quarry's `projectAt` (commit "match a project by its directory, not
by a prefix of it"): equality or a prefix ending at a `/`, deepest wins, a
project at `/` holds everything. Which project wins when directories nest is
data's call; deepest is assumed here *(flagged)*.

### The place: what a process looks from

```dart
class Place {
  final String cwd;                 // real path, captured once
  Future<GitAnswer> git();          // asks git; one pending call shared
}
```

- **The cwd is fixed for the life of the process.** Nothing in board calls
  `Directory.current =`, and an agent's shell `cd` happens in another process.
  Tried: Claude Code (`claude -p` started in `repo/sub/deep`) starts an MCP
  server with cwd `…/repo/sub/deep`, the session's directory, not the
  repository root, with `PWD` inherited. So a server's project is the
  project of the session that started it, decided by where that session
  started. chord passes each ACP session a `cwd`, and the agent starts its MCP
  servers; that they inherit the session's cwd is assumed for chord, as
  measured for Claude Code *(not measured through chord; flagged)*. A team
  run in a git worktree therefore has the worktree as cwd, which is exactly
  the case step 4 is for.
- **Captured at start** by `board mcp` (one `getcwd`, no I/O beyond it), so a
  worktree removed later still resolves by the path it had.
- `Directory.current.path` on macOS is already the physical path with the
  on-disk letter case: started in `/tmp/x/case/inner` (typed in lower case,
  the directory is `Case/Inner`) it gives `/private/tmp/x/Case/Inner`, while
  `PWD` keeps what the shell typed. board uses `getcwd`, never `PWD`.
- **The CLI** builds its place per invocation, the same way.

### Matching runs inside the transaction

`projectAt` runs **inside** the operation's read or write transaction against
the `project` rows it reads there. So a `project add` by another process is
seen by the next call, and the project a write resolves is the one that write
commits against. The rows are re-read every call (a handful of rows), never
cached.

git is a process and no transaction may await, and whether git is needed is
known only inside the transaction, after the cwd missed every row. So (C6):

1. Run the operation's transaction with the cwd only (`git: null`).
2. If resolution reaches step 4 and there is no git answer yet, it throws an
   internal `NeedsGit` before any change; the transaction rolls back.
3. Outside any transaction, await `place.git()`.
4. Run the operation again, in a new transaction, with that answer. Once
   only: the second run never asks for git again, and resolves or answers
   `no_project`.

Nothing was written by the first run (the sweep included, since it rolled
back), so the retry is the operation as if it had started with the answer.
The cost is a second `BEGIN` on a path that is already slow (a cwd outside
every project).

### git

One command, run only when step 3 found nothing:

```
git -C <cwd> rev-parse --git-common-dir
```

Tried (paths under a temp directory; `/tmp` shown as git prints it,
`/private/tmp`):

| cwd | `--git-common-dir` | main checkout root |
| --- | --- | --- |
| repository root | `.git` | its parent: the root |
| a subdirectory | `../../.git` (relative to the cwd) | the root |
| a linked worktree | `/private/tmp/…/main/.git` (absolute) | `…/main` |
| inside `.git` | `.` → joined and made real: `…/main/.git` | its parent: the root |
| a bare repository | `.` → the bare directory | none |
| `--separate-git-dir` checkout | `/…/sep.gitdir` | none |
| a submodule | `/…/main/.git/modules/subm` | none |
| outside git | exit 128, `fatal: not a git repository …` | none |

The rule, and no more:

- A relative answer is relative to the directory git ran in (git's documented
  behaviour); it is joined to the cwd, then made real. `--path-format=absolute`
  (git ≥ 2.31) would do the join in git; plain output works with every git
  and the join is one line.
- **The root is the parent of the common directory when that directory is
  named `.git`.** That covers the repository, its subdirectories, its linked
  worktrees and standing inside `.git` itself, which is what the owner's rule
  is for.
- Any other common directory (bare repository, separate git dir, submodule)
  gives **no** root, and the error says so: "git
  names /x/repo.git as the common directory, which is not a `.git` inside a
  checkout". No guessing at a layout (the "bare repository plus worktrees
  beside it" pattern, for one). Open question 1.
- Rejected: `git worktree list --porcelain`, whose first entry is documented as
  the main worktree. Tried: for a separate git dir and for a submodule it
  prints the git directory, not the checkout. And `git --git-dir=<common>
  rev-parse --show-toplevel`, which answers the cwd's own worktree.
- Step 4 does not translate the cwd's position: a worktree's `pkg/sub`
  matches by the main root, not by `main/pkg/sub`. A project nested inside a
  repository (a monorepo package registered on its own) is therefore found
  from a worktree only if it is the repository root. Open question 2.

**Running it.** `Process.start('git', ['-C', cwd, 'rev-parse',
'--git-common-dir'])`, with the inherited environment as it is (git's own
`GIT_DIR`, `GIT_CEILING_DIRECTORIES` and so on keep their meaning; board
rewrites none). Measured: 20 ms from a shell, 51 ms for the first spawn from
the Dart binary.

| git outcome | What resolution says |
| --- | --- |
| exit 0, common dir named `.git` | the root; match it |
| exit 0, any other common dir | "no main checkout: <dir>" |
| exit ≠ 0 (128: not a repository; dubious ownership; anything else) | "git: <first line of stderr>" |
| `ProcessException` (no `git` on `PATH`) | "git not found on PATH" |
| no exit within **3 s** | "git did not answer in 3 s"; the child is killed |

- **No outcome is cached (C7).** git is asked again every time the fallback
  is needed, so a repository created, a worktree moved or a git installed
  after the server started is seen on the next call. The cost (≈20–50 ms)
  falls only on a cwd outside every project. **Concurrent calls share one
  pending call**: `place.git()` keeps the in-flight `Future` and drops it when
  it completes, so two requests in flight start one git, not two, and the
  next request after that starts a new one.
- **The timeout kills.** `Process.run(...).timeout(...)` stops waiting but
  leaves git running; the runner uses `Process.start`, and on timeout sends
  `SIGKILL` (git holds nothing that needs a clean exit for `rev-parse`). 3 s
  is about 60× the measured cost and short enough that the agent's call does
  not look hung.
- **macOS without the command line tools**: `/usr/bin/git` is a stub that
  exits non-zero and may open the "install developer tools" dialog. It is
  reached only when the cwd matches no project, and the exit is reported like
  any other. Noted in the docs, not worked around.
- The CLI runs git the same way, through the same retry.

### Real paths, symlinks and letter case

- **Stored directories are real paths.** `project add --dir D` (or the cwd)
  is resolved with `Directory.resolveSymbolicLinksSync()` (`realpath(3)`)
  before it is stored; a directory that does not exist is refused. Tried:
  `/tmp/x/case/inner` and `/tmp/x/link/inner/` (a symlink to `Case`) both
  resolve to `/private/tmp/x/Case/Inner`: the symlink, the `/tmp` link and
  the letter case of a case-insensitive APFS volume all collapse to one
  spelling. Uniqueness of directories (data's) is then meaningful.
- **The cwd and git's root are real paths too** (`getcwd` already is; git's
  answer is passed through `realpath` after the join). Comparison is then
  exact, byte for byte, with the `/` boundary of `projectAt`. On a
  case-sensitive volume, exact is right; on a case-insensitive one, both
  sides carry the on-disk case. Unicode normalisation follows the same
  logic: both sides come from the file system.
- Stored paths are not re-resolved at match time (quarry re-resolves; here the
  stored form is already canonical). A project whose directory was moved or
  renamed matches nothing until it is edited (interfaces' `project edit`, if
  any).

### The error

`no_project`, with what was looked at, as the owner asked. Example of the
message (wording is interfaces'):

```
no project for /Users/me/src/app-wt/pkg:
  - no project's directory contains it (3 projects on this board)
  - git: main checkout /Users/me/src/app, which no project contains
add it: board project add KEY --dir /Users/me/src/app
```

The `details` carry `cwd`, `git` (the root, or the reason there is none) and
the suggested directory (git's root when there is one, else the cwd), so an
agent can pass them to a person. The suggested directory is advice, never
acted on.

### `board mcp`: at start and per call

At start, in order; nothing here can make the server fail except stdio itself:

1. Read `Env`: `BOARD_DIR`/`HOME` → the board path, or the configuration
   error kept for every call.
2. Capture the cwd as a real path.
3. Try to open the board (pragmas, `application_id`, `user_version`). Missing
   → keep trying per call. Wrong id or version → kept and answered per call
   (`not_a_board`, `schema_mismatch`), as v1.
4. Connect `StdioServerTransport`.

No git and no project resolution at start: a server outside every project
must still start, and the place's git answer is only needed when the cwd
misses.

Per call: open the board if not open yet → one transaction: check
`user_version`, sweep, resolve (`projectAt` on the cwd), validate, apply,
events, `COMMIT`. If resolution needs git: roll back, await `place.git()`
outside the transaction, and run the transaction once more with the answer
(C6, above).

## 3. Build and distribution

### The build

```sh
dart build cli -t bin/board.dart --target-os macos --target-arch arm64 -o build/darwin-arm64
# → build/darwin-arm64/bundle/bin/board, build/darwin-arm64/bundle/lib/libsqlite3.dylib
```

- **arm64**: 1.7 s warm. Binary 6.1 MB, `libsqlite3.dylib` 1.7 MB, both
  ad-hoc signed by the build (`codesign -dv`: `Signature=adhoc`).
- **x64 from the arm64 SDK: not possible.** `dart build cli --target-os macos
  --target-arch x64` answers `Unsupported target platform macos_x64.
  Supported target platforms: linux_arm, linux_arm64, linux_riscv64,
  linux_x64`. The flags cross-compile to Linux only.
- **x64 with the x64 SDK under Rosetta: works and is cheap.** The
  `dartsdk-macos-x64-release.zip` of the same version (229 MB) run with
  `arch -x86_64 dart build cli …` built in 13 s; the result is
  `Mach-O x86_64` for both files and runs under Rosetta
  (`arch=macos_x64 sqlite=3.53.4`). So one arm64 machine (a CI runner) builds
  both. x64 is in v1.
- The `sqlite3` hook **downloads** a precompiled `libsqlite3.<arch>.macos.dylib`
  and checks it against a SHA-256 pinned in the package
  (`lib/src/hook/asset_hashes.dart`), so the first build needs the network.
- No universal (`lipo`) binary: every channel picks per architecture anyway.

### npm (as esbuild and chord do it)

```
<main>/                         package.json: bin {board: bin/board.js},
  bin/board.js                  optionalDependencies: exact versions of both
<main>-darwin-arm64/            os ["darwin"], cpu ["arm64"], files bin/ lib/
  bin/board  lib/libsqlite3.dylib     (the bundle, as built)
<main>-darwin-x64/              os ["darwin"], cpu ["x64"]
```

- The platform package is the bundle unchanged: the binary finds
  `../lib/libsqlite3.dylib` from its own real path. Tried: `npm pack` keeps
  `bin/board` at `0755`, and after `npm i` of the packed tarball the binary
  runs from `node_modules/…/bin/board` and loads its library. npm sets no
  quarantine (only `com.apple.provenance`).
- `bin/board.js` is chord's `npm/chord/bin/chord.js` shape:
  `require.resolve('<pkg>-${process.platform}-${process.arch}/bin/board')`,
  `spawnSync(bin, args, {stdio: 'inherit'})`, exit with the child's status,
  and **re-raise the child's signal** when it was killed by one (chord's shim
  returns 1 instead; for `board watch` interrupted by `Ctrl-C` the 130 matters).
  An unsupported platform prints which package is missing.
- `board mcp` through the shim: the shim's stdin and stdout are the agent's
  pipes, inherited by the binary, so MCP framing passes through untouched.
  When the agent closes the pipe the binary sees EOF and exits; the shim
  follows. Cost: one Node start (tens of ms) per CLI command and one extra
  process per server. No install script (esbuild's optional replace-the-shim
  step): package managers increasingly skip install scripts, and the shim
  works without one.

### Homebrew

A formula in the owner's tap, per architecture (`on_arm` / `on_intel`), from
the release tarballs:

```ruby
def install
  libexec.install "bin", "lib"
  bin.install_symlink libexec/"bin/board"
end

test do
  ENV["BOARD_DIR"] = testpath/"b"
  system bin/"board", "project", "add", "T", "--dir", testpath
end
```

The symlink in `bin` resolves to `libexec/bin/board`, beside `libexec/lib`
(owner's experiment: the bundle runs through a symlink from another
directory). Homebrew downloads with `curl`, so no quarantine. Homebrew may
rewrite the dylib's install id and re-sign it ad hoc after install; harmless,
since the binary loads the library by path through `dlopen`, not by link
(verify when the formula is written).

### Release tarballs

`board-<version>-darwin-arm64.tar.gz` and `…-darwin-x64.tar.gz`, each a
directory holding `bin/board`, `lib/libsqlite3.dylib`, `LICENSE` and
`README.md`, plus `SHA256SUMS`. Install: unpack anywhere, symlink `bin/board`
onto `PATH`. The same tarballs feed the formula.

### Code signing and quarantine

Tried: a copy of the bundle with `com.apple.quarantine` set as a browser sets
it. The **binary still starts** (from a terminal), but loading the library
fails: `dlopen(…/lib/libsqlite3.dylib): code signature … not valid for use in
process: library load disallowed by system policy`, and every command dies at
the first SQLite call. So:

| How it arrives | Quarantined | Runs |
| --- | --- | --- |
| npm | no | yes (tried) |
| Homebrew (curl) | no | yes |
| `curl -L … \| tar x` | no | yes |
| a browser download, unpacked by Finder | yes, on every file | no: the dylib is refused |

With ad-hoc signatures, the third channel needs
`xattr -dr com.apple.quarantine <dir>` in the install notes. Developer ID
signing and notarisation would remove that step; it needs an Apple developer
account and a CI secret, and a bare Mach-O cannot be stapled, so Gatekeeper
checks online. That is the owner's decision (questions below), not a choice
made here.

### Questions for the owner (distribution)

- **D1.** npm names: the main package (`board` is surely taken; a scope such
  as chord's `@chorded/…`?) and the platform package names.
- **D2.** The tap: which repository (`<owner>/homebrew-tap`?) and the formula
  name.
- **D3.** Signing: ship ad-hoc signed with the `xattr` note, or sign with a
  Developer ID and notarise in CI?
- **D4.** CI: build both architectures on one arm64 runner (x64 SDK under
  Rosetta, tried), or an Intel runner for x64?

## 4. Concurrency, watch and failures with one machine-wide file

### Writers on one lock: 5 s stays

Every agent of every project now writes to one file. Measured: 30 processes,
each doing 200 back-to-back `BEGIN IMMEDIATE` → sweep `DELETE` → `INSERT` →
`COMMIT` with `synchronous = FULL`, on one WAL file: 6 000 commits in 2.3 s
(about 0.4 ms each), **no `busy`**, mean wait for the lock 7–9 ms, worst
1.7 s. SQLite's busy handler sleeps and retries rather than queueing, so the
worst wait under a saturating load is far above the mean; that load is
thousands of times what agents produce (a few writes per agent per minute).
5 s still covers real queues many times over, and still surfaces a holder
that does not let go. Unchanged.

### Expiry: machine-wide sweep

Every write sweeps every project's expired claims, not just its own: the
`DELETE … WHERE until <= :now RETURNING` stays one statement over an index,
and each `claim_expired` event carries the claim's own project (data's
column). Exactly-once is unchanged (writes are serialised). A per-project
sweep would leave an idle project's claims unswept even while the machine is
busy. *(Data's decision; runtime's view.)*

### `board watch`

- `data_version` is per file, so every watcher wakes on any project's commit.
  At ~6 µs per poll and one drain query per change, that costs nothing.
- `--project K` turns the key into an id **once, at attach** (C10), and
  filters in the drain query by that id. The v1 rule that **the cursor moves
  over filtered-out rows** is what keeps a narrowed watcher from re-reading
  another project's burst. The v1 loop test (1 200 non-matching events) now
  uses another project's events.
- **`project_removed` ends a narrowed watch.** That event has a null
  `project_id` (data), so the drain query takes it explicitly:
  `WHERE id > :cursor AND (project_id = :p OR kind = 'project_removed')`.
  When its `data.key` is `K`, the watcher prints the line and exits 0; one for
  another key is skipped like any other filtered row. A project added again
  under the same key has a new id, so it needs a new `watch`. An unnarrowed
  watch prints `project_removed` and goes on.
- `claim_expiring` derives from the live claims of the watched projects only.
- The cursor is a machine-wide `event.id`, so `--since` works across
  projects.
- A missing board at start: `no_board`, exit 1. A `--follow` does not wait for
  the file to appear.

### `board sql --project`: narrowing by temp views

`board sql` spans every project. Interfaces will not narrow it by rewriting the
user's query. The lead asked for another way to be tried: before the user's
statement runs, board creates a `TEMP VIEW` for each per-project table under
the table's own name, so that unqualified names resolve to `temp` before
`main`. It works on a read-only connection.

The list is fixed, taken from the normative schema (C1), not discovered at
run time:

```sql
-- by board, for project id 1, before the user's statement
CREATE TEMP VIEW project   AS SELECT * FROM main.project   WHERE id = 1;
CREATE TEMP VIEW task      AS SELECT * FROM main.task      WHERE project_id = 1;
CREATE TEMP VIEW milestone AS SELECT * FROM main.milestone WHERE project_id = 1;
CREATE TEMP VIEW waits     AS SELECT * FROM main.waits     WHERE project_id = 1;
CREATE TEMP VIEW event     AS SELECT * FROM main.event     WHERE project_id = 1;
CREATE TEMP VIEW claim     AS SELECT c.* FROM main.claim c
  JOIN main.task t ON t.id = c.task_id WHERE t.project_id = 1;
CREATE TEMP VIEW question  AS SELECT q.* FROM main.question q
  JOIN main.task t ON t.id = q.task_id WHERE t.project_id = 1;
```

`event`'s view leaves out the rows with a null `project_id`
(`board_created`, `project_removed`); `main.event` has them. A table added to
the schema later gets its view in the same change, and a store test checks
that every table with a `project_id` or `task_id` column has one.

Tried with `package:sqlite3` 3.7.0 against a WAL file holding two projects
(`task`: 2 rows in project 1, 1 in project 2; `event`: 1 and 2):

| Question | Result |
| --- | --- |
| (1) `CREATE TEMP VIEW` on `OpenMode.readOnly` | **works**. The `temp` schema is the connection's own in-memory database, not the read-only file. Afterwards `sqlite_temp_master` lists both views, and `autocommit` is true. |
| (2) `SELECT count(*) FROM task` | **2**: the view. `temp.task` gives 2 as well. |
| (2) `SELECT count(*) FROM main.task` | **3**: everything. |
| (2) a join of `task` and `event` | goes through both views |
| (2) a second read-only connection on the same file | `task` gives 3: the views are private to the connection that made them |
| (3) `isReadOnly` of the user's `SELECT` on a view, of a join, of `EXPLAIN QUERY PLAN` | **true**: the gate passes them |
| (3) `DROP VIEW task`, `CREATE TEMP VIEW …` by the user | `isReadOnly` false: refused by the gate as before |
| `INSERT INTO task …` (unqualified) | fails at `prepare`: "cannot modify task because it is a view" |
| `DELETE FROM main.task` | `isReadOnly` false: refused, as in v1 |
| `EXPLAIN QUERY PLAN SELECT * FROM task WHERE n = 2` | `SEARCH main.task USING INDEX task_p (project_id=? AND n=?)`: the view is flattened, and the project index is used |
| `CREATE TEMP VIEW … WHERE project_id = ?` with a bound parameter | refused by SQLite: "parameters are not allowed in views" |
| `project` view (`WHERE id = 1`) | the one row |
| `claim` view through a join on `main.task` | only project 1's claims; `main.claim` gives all; the user's `task JOIN claim` works; plan: `SEARCH t USING COVERING INDEX … (project_id=?)`, then `claim` by primary key |

Consequences (accepted as C1):

- **The id goes into the view's text as a literal**, because views take no
  parameters. That id is an integer board read from its own `project` row
  after resolving `--project KEY`. Nothing the user typed reaches the DDL, so
  no escaping is needed.
- **The views are created on board's own connection, before the gate, and
  never pass through it.** The user's statement is still gated as in v1:
  read-only open, `isReadOnly` or `EXPLAIN`, one statement. Nothing about the
  user's text is rewritten.
- **It narrows; it does not wall off.** `main.task`, `sqlite_master`, or a
  table with no view still reach every project. That is fine for a read
  convenience on one person's machine. The help text should say
  "unqualified table names show only this project; `main.<table>` shows
  all".
- **Without `--project`** no view is made and the query sees every project.
- **Cost:** one `CREATE TEMP VIEW` per table per `board sql` call. That is
  microseconds, and the connection is thrown away afterwards.

### The reset story

The machine-wide file makes `board init --force` (drop everything, in place)
a much bigger hammer: one person's "start over" in one project would delete
every project's tasks and history. **There is no reset command (R0).**

- Starting over after a schema change (no migrations before the first
  release) is offline and the person's: stop the agents, move
  `board.db`, `board.db-wal` and `board.db-shm` aside, `board project add`
  again. `schema_mismatch`'s message says exactly that.
- With no in-place reset, nothing in board changes the schema or the board's
  identity under running processes. **`board.instance`, `board_reset` and
  the `board` table go**, and the per-operation identity check shrinks to the
  `user_version` check (a file whose schema is not this build's is refused).
  `board_created` stays as an event, written when `project add` creates the
  file.
- **A file removed under running servers** loses their later writes silently
  (they write to the deleted inode). No guard (C14): the offline procedure
  says to stop the agents first, and that is the whole defence.
- Removing a project is allowed only when it has no tasks (data), so no key
  that ever named a task can come back naming another. A narrowed `watch`
  ends on `project_removed` (above).

### Failure modes that change

| Situation | Outcome |
| --- | --- |
| No board file | `no_board` naming the path and whether `BOARD_DIR` set it, and `board project add`; `board mcp` starts and retries per call |
| `BOARD_DIR` relative, or no `HOME` | configuration refusal on every command and call; the server still starts |
| cwd in no project, git finds none | `no_project` with the cwd, git's answer and the `project add` line |
| git missing / slow / failing | resolution goes on without it; the reason is in the error; the next call that needs git asks again |
| cwd deleted after the server started | the captured path still matches its project; git (if needed) fails and says so |
| A project directory moved | it matches nothing; the cwd's `no_project` names the directory to edit or add |
| Board file removed while servers run | their writes are lost silently; the documented procedure stops the agents first |
| A project removed under a `watch --project` of it | the watcher prints `project_removed` and exits 0 |
| Quarantined bundle | the first SQLite call fails with macOS's "library load disallowed by system policy"; the docs give the `xattr` line |
| `paused` | gone, with the pause |

Everything else in v1's failure table holds (`SIGKILL` mid-write, busy,
damaged, not a board, disk full, a bug inside a write).

## 5. Module layout (changes)

```
bin/board.dart                 the only reader of Platform.environment and
                               Directory.current; builds Env and Place
lib/src/env.dart               Env: BOARD_DIR / HOME → the board path, or a
                               configuration error
lib/src/place/
  place.dart                   Place {cwd, git()}; shares one pending call
  git.dart                     GitRunner interface; ProcessGitRunner
                               (Process.start, 3 s, SIGKILL); the root rule
lib/src/rules/projects.dart    projectAt (pure), resolution order, NeedsGit,
                               no_project details; project add
lib/src/board.dart             the C6 retry: catch NeedsGit, await git, run
                               the operation once more
lib/src/sql/readonly.dart      + the fixed list of temp views for --project
lib/src/store/locate.dart      removed (no upward search)
lib/src/store/open.dart        open never creates; create() for project add
lib/src/rules/pause.dart       removed
lib/src/mcp/server.dart        buildServer(Board, Place) -> McpServer
```

`projectAt` and the resolution order are rules: pure, tested in memory.
`GitRunner` is the one seam to the outside world added here; `Place` takes it
injected, so no test needs a particular git. The root rule (`.git` basename →
parent) is a pure function of git's output and the cwd.

## 6. Tests

What goes:

- **Pause**: every pause test, and the "refuses every write but resume" rule
  test. The MCP tool-list test pins the exact tool set, which shows the pause
  tools are gone.
- **FTS5**: the search tests, and the build smoke test's search step.

What comes:

- **`projectAt`** (pure, table-driven, quarry's cases plus ours): equal path;
  a path below; `/p/app-two` not under `/p/app`; `/p/apple`; nested projects
  in either order → deepest; a project at `/`; no match.
- **Root rule** (pure): `.git` at the root, `../../.git` from a subdirectory,
  an absolute `…/main/.git` from a worktree, `.` from inside `.git` (→ the
  root), a bare directory, a separate git dir, `…/.git/modules/x` → root or
  the reason there is none.
- **Place with a fake `GitRunner`**: git never called when the cwd matches;
  called once for two concurrent calls; called again by the next call after
  that, whatever the first answer was (nothing cached); a runner that never
  completes → the 3 s timeout, with the timeout injected short, and the child
  killed (the fake records the kill).
- **The C6 retry** (in memory, fake git): a write whose cwd is in no project
  but whose git root is: the first transaction rolls back with nothing
  written (no sweep event either), git is asked once, the second transaction
  commits; a fake git whose answer still matches nothing → `no_project`, and
  git was asked exactly once.
- **`ProcessGitRunner` against real git** in temp directories, skipped when
  `git` is not on `PATH`: a repository and a subdirectory, a linked worktree
  (→ the main root), a bare repository, a separate git dir, a submodule,
  outside any repository. This is the table of §2 as tests.
- **Real paths** in temp directories: a symlinked directory and `/tmp` vs
  `/private/tmp` resolve to one stored form; a lower-case spelling of a
  mixed-case directory resolves to the on-disk case (skipped when the temp
  volume is case-sensitive, detected by the lower-case spelling not
  existing); a missing `--dir` refused.
- **`Env`**: unset → `$HOME/.board/board.db`; empty → unset; relative and
  `~/…` refused; no `HOME`; `BOARD_DIR` naming a missing directory → the
  "`BOARD_DIR` names …" message; `project add` creates the directory.
- **Creation**: only `project add` creates; `ls`, `status`, `watch`, `sql`
  and every tool on a missing file answer `no_board` and leave no file
  behind; two concurrent first `project add`s (two isolates) create one
  schema and both rows.
- **Resolution inside the transaction**: a `project add` by a second
  connection is seen by the first connection's next call with the same
  `Place`.
- **MCP**: the server built with a `Place` whose cwd is in no project and a
  fake git: it starts, lists its tools, a call answers `no_project` with
  `cwd` and `git` in `details`; after `project add` on the same board the
  same call works. Started on a missing file: `no_board`, then works once the
  file exists.
- **Multi-project concurrency** (temp file, two connections): a write in
  project A sweeps B's expired claim and logs one `claim_expired` with B's
  project; the same task number in two projects under two writers.
- **Watch**: `--project` skips another project's events and moves the cursor
  past them; `project_removed` of its key prints and exits 0, of another key
  is skipped; an unnarrowed watch prints it and goes on.
- **Substring filter**: data's `LIKE` rules (escaping of `%`, `_` and the
  escape character, ASCII-only case folding pinned with a non-ASCII case) as
  rule tests; nothing runtime-specific.
- **`board sql --project`**: every row of the §4 temp-view table is a case,
  against a temp-file board with two projects, each view counted against its
  `main.` table; and the schema check that every table with `project_id` or
  `task_id` has a view in the fixed list.

**The build smoke test** (tagged `build`, skipped unless `BOARD_BIN` names a
built `bin/board`):

1. Temp `BOARD_DIR`, a temp git repository with a linked worktree and a
   subdirectory in it.
2. Symlink `BOARD_BIN` into another temp directory and use the symlink from
   here on (the Homebrew layout).
3. `board project add T --dir <repo>`.
4. Start `board mcp` with cwd = `<worktree>/sub`, over real stdio:
   `initialize`, `tools/list`, `task_add` with no project and no key (it must
   resolve through git to `T`), `task_list` with a substring filter that
   contains `%`.
5. `board sql` reads the task back.

That proves, in the shipped binary: the library is found through a symlink,
git is reachable and parsed, the substring filter runs. CI runs it once per
architecture; the x64 run under `arch -x86_64`.

## Experiments

All in a throwaway project under `/tmp`, macOS 26 arm64, Dart 3.13.5,
`sqlite3` 3.7.0, git 2.54 (Apple Git-157):

- `dart build cli` arm64 (bundle sizes, ad-hoc signatures, `otool -L` shows
  only system frameworks); `--target-arch x64` refused on macOS; the x64 SDK
  under Rosetta builds and runs x64.
- The hook's precompiled, hash-pinned dylibs.
- `git rev-parse --git-common-dir` in a repository, a subdirectory, a linked
  worktree, `.git`, a bare repository, a separate git dir, a submodule and
  outside git; `git worktree list --porcelain` and `--git-dir … --show-toplevel`
  compared and rejected; timing.
- Claude Code starting an MCP server (`claude -p` with `--mcp-config` from a
  subdirectory): the server's cwd, `PWD`, `HOME`, and git from inside it.
- `getcwd` and `resolveSymbolicLinksSync` with a mis-cased path and a symlink.
- Quarantine set on a bundle: binary runs, dylib refused.
- `npm pack` / `npm i` of a platform package: modes kept, binary runs.
- 30 writer processes on one WAL file: waits and `busy`.
- `CREATE TEMP VIEW` shadowing per-project tables on a read-only connection:
  name resolution, `main.` bypass, the `isReadOnly` gate, the query plan, and
  parameters in a view (§4).

## Assumptions on other drafts (flagged)

- **data:** nested projects, deepest directory wins; directories stored as
  real paths and unique; expiry sweep machine-wide with `project` on each
  `claim_expired`; no reset and no `board` table (R0); a project with tasks
  cannot be removed; `project_removed` has a null `project_id` and a
  `data.key`; `claim` and `question` reach their project through `task_id`.
- **interfaces:** `no_board` covers a missing file and a configuration
  error, each with its own message (C3); `no_project` carries the message
  above; `watch --project` resolves its key once at attach; `board sql
  --project` is optional; an explicit `project` or a `board mcp --project`
  pin beats the cwd.

## Open questions

Settled in review and removed from this list: the removed-file guard (not
adopted, C14), `0700` on `~/.board` (default modes), caching git (none, C7).

1. **Bare repositories with worktrees (owner).** When git's common directory
   is not a `.git` (bare repository, separate git dir, submodule), step 4
   finds no root and resolution fails with that reason. The "bare clone in
   `x/.bare`, worktrees beside it" layout is found by step 3 if the project
   is registered at `x`. Not supported beyond that as drafted.
2. **Nested projects from a worktree (owner).** Step 4 matches the main
   checkout's root, not the cwd's place inside it, so a project registered on
   a subdirectory of a repository is not found from a worktree of that
   repository. Translating the position (`root` + `git rev-parse
   --show-prefix`) would fix it, but goes beyond the owner's rule. Wanted?
3. Distribution D1–D4 above (owner).
