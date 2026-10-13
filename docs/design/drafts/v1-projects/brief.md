# Brief: v1 rework (one board per machine, projects, no FTS5, no pause)

The owner answered the open questions of the merged v1 design
(`docs/design.md`, `docs/decisions.md`). Four of the answers change the
design. This brief is the rework: each architect revises its part of v1 under
the new decisions and writes a draft in this directory. The lead then merges
the drafts into `docs/design.md` (appendices included) and `docs/decisions.md`.

Start from `docs/design.md` and `docs/decisions.md` as they stand, and from
your own v1 draft in `docs/design/drafts/v1/`. Your new draft describes what
**changes** relative to v1, completely enough to merge: new or changed SQL,
schemas, rules, commands. Where v1 holds as it is, say so in one line.

## The owner's decisions (fixed; do not reopen)

1. **Build: option A.** `dart build cli` with the SQLite bundled by
   `package:sqlite3` 3.x. Verified on Dart 3.13.5: `dart compile exe` still
   refuses build hooks; `dart build cli` has `--target-os` / `--target-arch`;
   the bundle (`bin/board` + `lib/libsqlite3.dylib`) runs, including through a
   symlink from another directory. Distribution has three channels:
   - npm, as esbuild does it: a main package, and one package per platform
     pulled in through `optionalDependencies` with `os` / `cpu`;
   - a Homebrew formula in the owner's tap, installed into `libexec` with a
     symlink in `bin`;
   - tarballs on GitHub Releases.
2. **FTS5 is removed entirely.** There is no FTS index, no `match`, and no
   question about query syntax. `task_list` and `board ls` keep at most a
   plain substring filter: `LIKE` on title and body, parameters bound, and no
   wildcard interpreted from the agent's text. The escaping is ours to decide.
   Anything richer goes through `board sql`.
3. **The pause is removed from v1 entirely.** Drop `board_pause` /
   `board_resume`, `board pause` / `board resume`, the `paused` error, the
   pause check on every write and the `board.paused` state. The reason, to
   record: a pause only refused board writes while the agents kept working.
   Stopping work is `main` not starting runs and chord stopping them. The
   pause may come back later.
4. **One database per machine**, as quarry has: `~/.board/board.db`, which
   `BOARD_DIR` overrides. A `project` table (key, name, directory) is added.
   Tasks, milestones, claims, questions and events belong to a project, and
   each project has its own milestone chain. This overturns the "several
   projects in one board" non-goal.
   - **Project resolution.** A task key (`BRD-12`) names its project.
     Otherwise the working directory decides: the project whose directory
     contains the cwd. If none matches and git is available there, take the
     main repository through `git rev-parse --git-common-dir` and match its
     root. If neither resolves, fail with an error that says what was looked
     at and how to add the project.
   - `watch` and `sql` see every project; `--project` narrows.
   - `board init` becomes `board project add`, or similar (the CLI shape is
     ours).
   - Check what the MCP server does at startup and what it does per call,
     given the server process's cwd.
5. **macOS only for v1**: arm64, and x64 too if the cross build allows it
   cheaply, otherwise arm64 alone. No Linux, no Windows.
6. **The project key is required at `project add`**, chosen by a person and
   never derived from the directory name.

These stand from before: no task writes in the CLI; a handover does not move
the claim; `question_validate` is a tool.

## Constraints (unchanged)

These are the same as in `docs/design/drafts/v1/brief.md`:

- The one rule. No workarounds around a package.
- Rules are pure Dart over the store, tested in memory.
- The MCP server is tested in process.
- No release, so no migrations.
- Several processes on one file, with no daemon.
- Everything in English, and no private paths.

`git` is an external program, not a package. Calling `git rev-parse` through
`Process.run` is the owner's own instruction. Say what happens when git is
missing or fails.

## Questions per architect

### data (`data.md`)

1. The `project` table: columns, constraints, key shape (does the v1 prefix
   rule carry over?), uniqueness of key and directory, nested directories (a
   project inside another's directory: which one wins?).
2. How every other table belongs to a project. Are task numbers per project
   (`BRD-1`, `APP-1`) or one sequence? Is the `Q<n>` sequence per project or
   per machine? Are milestone names unique per project? What happens to the
   v1 `board` row and to `instance`?
3. A reset (`--force`) on a machine-wide file: is there still one, and what
   does it reset (one project, or everything)? Removing a project: allowed,
   refused while it has tasks, or out of v1?
4. Removing the pause: what goes from the schema, the write sequence and the
   transitions.
5. Removing FTS5: the `LIKE` filter, its escaping (`ESCAPE` clause, `%`, `_`,
   the escape character itself), case folding (`LIKE` is ASCII-only
   case-insensitive in SQLite: say what that means for non-ASCII), and
   whether an index helps.
6. `task_next`, readiness, claims and expiry now that several projects share
   one file. Does the expiry sweep stay machine-wide? Can a wait cross
   projects?
7. Events: which kinds change (`board_created`, `board_paused`,
   `board_resumed`, and new ones such as `project_added`), and the `project`
   column on event.

### interfaces (`interfaces.md`)

1. How a tool learns its project. Options include the server's cwd at start,
   a `project` argument, and a task key that implies it. Which tools take
   `project`, and is it required, optional, or inferred? What does
   `task_list` with no project mean? Answers carry the project, and
   `board_status` is per project.
2. Remove `board_pause` / `board_resume` and `paused`; replace `text` (FTS)
   with the substring filter in `task_list` and `board ls`.
3. The CLI: `board project add KEY [--name] [--dir]`, and `project ls`,
   `project rm` or `project edit` if any, each with its output. `--project`
   on the commands that need it. What `board init` becomes. How `watch` and
   `sql` show the project. `board sql` now spans every project.
4. The new error codes (for example `no_project`, `project_exists`), with the
   error message the owner asked for: what was looked at, and how to add the
   project.
5. Appendix B: the complete normative schemas again (`$defs` with `Project`
   and `ProjectKey`), every tool that changed.
6. The `.mcp.json` line in README and design: does it need anything (a cwd,
   an env var)?

### runtime (`runtime.md`)

1. `BOARD_DIR`, `~/.board/` creation and permissions, and first run (who
   creates the database: the first command of any kind, or `project add`
   only?). What `no_board` becomes.
2. Project resolution at run time: the cwd of a `board mcp` process (whose
   cwd is it when chord or Claude Code starts it? is it fixed at start?), when
   resolution runs (at start, per call, cached), `git rev-parse
   --git-common-dir` (relative vs absolute output, worktrees, bare repos, git
   missing, git slow, a timeout), and symlinked or case-insensitive paths on
   macOS (`realpath`, APFS case-insensitivity).
3. The build and distribution: `dart build cli --target-os macos
   --target-arch arm64|x64`. Does the x64 cross build work from arm64 cheaply?
   Try it if you can. The npm layout (main package, `@…/board-darwin-arm64`,
   the bin shim that finds the bundle), the Homebrew formula (`libexec`,
   symlink), the release tarballs, and code signing / quarantine on macOS for
   a downloaded dylib. Whatever has to be decided by the owner (package names,
   tap name, signing), list as questions, not choices.
4. What concurrency, watch and failure modes change with one machine-wide
   file. More writers on one lock: is a 5 s busy timeout still right? `watch`
   across projects, and the reset story.
5. Tests: project resolution with a fake git and temp directories; what
   replaces the pause and FTS tests; the smoke test under the chosen build.

## Process

data, interfaces and runtime draft in parallel, each writing only its own
file here. critic reviews the brief and the drafts. The lead resolves the
findings and merges the result into `docs/design.md`, `docs/decisions.md`,
and the build and distribution lines of `CLAUDE.md` and `README.md`.

## Resolutions after review

The lead's decisions on the conflicts between the drafts and on the critic's
findings (C1–C14).

- **R0, reset.** There is no reset command; runtime's position stands. To
  start over (on `schema_mismatch`) the person stops the agents and moves the
  three files aside, offline. `board.instance`, `board_reset` and the `board`
  table go. `board_created` stays as an event: `project_id` null, `data {}`,
  written when `project add` creates the file. The removed-file `stat` guard
  is not adopted (C14): the offline procedure says to stop the agents first.
- **C1, `board sql --project`: accepted.** The flag is optional; without it
  the query sees every project. board creates TEMP VIEWs with the names of the
  project tables, from a fixed list taken from the normative schema:
  `project` (the one row), `task`, `milestone`, `waits`, `event`, plus
  `claim` and `question` through a join on `task`. The project id goes in as
  an integer literal from board's own row. Help says that `main.<t>` and
  `sqlite_master` still see everything.
- **C2: accepted.** `milestone` input is `MilestoneName` or `"none"` without
  `oneOf` (`anyOf`, or a pattern that excludes `none`), checked through
  `mcp_dart` on the literal `"none"`.
- **C3: runtime's contract.** A missing file is `no_board`, and only
  `project add` creates it. A configuration error (relative `BOARD_DIR`, no
  `HOME`) is also `no_board`, with its own message. `no_board` returns to the
  error catalog.
- **C4: data's event catalog.** `board_created` and `project_removed` have
  `project: null`, so `Event.project` is nullable. `project_removed` is
  `{key, name, directory}`.
- **C5: interfaces' scope contract.** With no `project`, lists resolve the
  project (key/parent, pin, cwd, git). `"*"` is the only machine-wide request.
  data passes the resolved scope into the transaction.
- **C6: accepted.** If the transaction needs the git fallback and the answer
  has not been fetched: roll back, ask git outside the transaction, and run
  the operation again in a new transaction. Once only, before any change.
- **C7: accepted.** git outcomes are not cached. git is asked again every time
  the fallback is needed; concurrent requests share one pending call. The
  cost (≈20–50 ms) applies only to a cwd outside every project.
- **C8: accepted.** No compatibility with "older builds" anywhere, and no
  such rationale. `user_version = 1`, since nothing has been built. Event
  `data` on the wire is an object; the per-kind table is normative and
  checked by store tests.
- **C9: accepted.** The sweep commits always. `events` returns every id
  appended, `claim_expired` from other projects included. "Changes nothing"
  means `changed: []`, not "nothing committed".
- **C10: accepted.** `watch --project K` turns the key into an id at attach.
  On `project_removed` with `data.key = K` it prints that line and exits 0.
  A project added again needs a new `watch`.
- **C11: accepted.** A relation to a task of another project (`parent`,
  `waits_add`, `waits_remove`) is `invalid_argument` naming the field.
- **C12, C13: accepted.** interfaces states exactly how key, `"*"`, the pin
  and parent combine; the sql examples use `t.number`; the newest-first
  order across projects goes by `task.id`.
- **C14 (git inside `.git`): accepted.** The table follows the rule as
  written: `.`, joined with the cwd and passed through realpath, gives a
  directory named `.git`, so the root is its parent.
- **`board mcp --project`** (interfaces) stays. It is an explicit pin that
  beats the cwd; runtime's capture of the cwd at start stays too.
- **Not in v1:** removing a project that has tasks (refused); MCP roots;
  `0700` on `~/.board` (default modes).

Questions for the owner: (1) `--show-prefix` for a subproject reached from a
worktree, which goes beyond the owner's rule; (2) bare repositories with
worktrees: not supported as drafted; (3) D1–D4 for distribution.
