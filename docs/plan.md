# board: development plan

The order in which v1, as `docs/design.md` specifies it, is built. Each slice
ends in working, tested code with `bun run check` passing on its last commit,
and is marked done here when it has passed review and tests. Section names
below are the design's headings. Nothing here changes the design: a question
it does not answer goes to the owner before the slice decides it.

Every slice is built by the ship team as units handed down one line
(developer, then reviewer, then tester). A unit is a module or a tool, in the
build order given.

## Slice 1: skeleton

**Status:** done (7fe69b1): every unit passed review and tests, and `bun
run check` passes from a clean clone. The owner settled its three open
questions in decisions 26–28; the control-character escaping of decision
28 is slice 2's first unit.

**Implements.** "The model"; "Projects" ("Adding one", "Which project a call
is about", "Run time"); "Storage" whole ("File and connections", "`board
project add`", "Schema", "Every operation", "Expiry, exactly once" as part
of the write path, "The substring filter", "Events" for the kinds this slice
writes); "The MCP server" ("Conventions", "Errors"); the tools `task_add`,
`task_list`, `task_read`; the CLI root and `project add`, `project ls`,
`ls`, `show`, `mcp`; "Runtime" ("Time", "Module layout"); "Tests" for the
parts above; "Build and distribution", the generation pipeline and the
`package.json` scripts only; Appendix A; Appendix B as one module, its
`$defs`, the error shape, the CLI-only `project ls` shape and the three
tools.

**Refined from main's order, with reasons.**
- The write path is built whole here (lock statement, `now`, `user_version`,
  resolution with the git retry, the machine-wide sweep, `SAVEPOINT op`),
  because "Every operation" defines one order for every write; adding the
  sweep in slice 2 would reopen `Store.write`. With no claim tool yet, the
  sweep is tested on claim rows a test inserts.
- Readiness and effective status (`blocked`, an expired claim read as
  absent) are read rules here, because `TaskSummary.ready`, `status` and
  `holder` are in every answer of `task_list` and `task_read`.
- The derived milestone status (`done` / `current` / `planned`, `Place`)
  and the `milestone_reopened` flip are here as read rules, because
  `task_add` takes `milestone` (the parent's milestone, a done one
  reopening) and `project ls` prints `current`. They are tested on milestone
  rows a test inserts; the milestone tools are slice 3.

**Out.** Every other tool and CLI command; claims tools, `task_update`,
`task_next`, comments; questions tools; milestone tools; `project edit`,
`project rm`; `board_status`; `watch`, `sql`; the compiled binary and its
smoke test; signing, npm packages, release, CI.

**Units, in build order.**
1. Package setup: `package.json` (private, the design's scripts), `bun.lock`,
   `.npmrc` (`@jsr` → `npm.jsr.io`), `tsconfig.json`, `biome.json`,
   `.gitignore` (`build/`, `src/store/generated/`), `prisma.config.ts`.
2. Schema and generation: `src/store/ddl.ts` (Appendix A, one statement per
   element), `tool/schema-db.ts`, the pulled `prisma/schema.prisma`,
   `prisma/sql/*.sql` for this slice's TypedSQL; `bun run gen` from clean.
3. `src/env.ts`, `src/clock.ts`, `src/errors.ts`, with the Env tests.
4. `src/store/`: open (never creates; `no_board`, `damaged`, `not_a_board`,
   `schema_mismatch`), create (`project add`'s ordered procedure), `read`,
   `write` (the lock statement, the sweep, the savepoint), outcome mapping
   (`busy`, `storage`, `internal`); the Store tests with spawned holder
   processes.
5. `src/place/`: `projectAt`, the root rule, `GitRunner`,
   `ProcessGitRunner` (3 s, `SIGKILL`), `Place` with one shared pending git;
   the Projects tests.
6. `src/rules/` and `src/board.ts` for projects: `project add`, `project
   ls` (with `here` and `current`), resolution inside the transaction and
   the roll-back-and-retry with git's answer.
7. `src/rules/` and `src/board.ts` for tasks: `task_add`, `task_list`
   (filters, `"*"`, `contains` with its escaping, paging), `task_read`
   (events after `since`, 200 a page), readiness, effective status, milestone
   derivation and the reopen flip; the Rules tests for them.
8. `src/schemas.ts` (Appendix B, `as const`, handler types through
   `json-schema-to-ts`) and `src/mcp/server.ts` (`buildServer`, the one
   wrapper, the three tools); the MCP tests over `InMemoryTransport`.
9. `src/main.ts` and `src/cli/`: the root `Command`, usage errors (exit 64),
   `project add`, `project ls`, `ls`, `show`, `mcp`, `--json`, tables; the
   CLI tests in process.

**Done when.** `bun run check` passes from a clean checkout; tester's
`test/slice1*.test.ts` passes; and, under a temp `BOARD_DIR`: `bun
src/main.ts project add T --dir <temp repo>` creates the board; an MCP
client started in a linked worktree's subdirectory adds a task with no
`project`, lists it with a `contains` holding `%`, and reads its
`task_added` event; `board ls` and `board show T-1` print it.

## Slice 2: work on tasks

**Status:** done (d505894): every unit passed review and tests, `bun run
check` passes from a clean clone, and the "Done when" run passed over real
stdio with a real lapsed lease. Owner rulings: decisions 28 and 29.

**Implements.** "Statuses and transitions"; "Claims"; "`task_next`";
`task_claim`, `task_extend`, `task_release`, `task_update` (every field,
`waits_add` / `waits_remove`, cycles by recursive CTE, a claim dropped by
`sent_back` / `closed`, moves into a done milestone, refusing `done` with an
open question and withdrawing open questions on `cancelled`), `task_next`,
`task_comment` (note and handover); CLI `next`; their events and tests.
Also decision 28: control characters in human CLI output shown as visible
escapes. The carried Store test of two processes racing for one claim
belongs here.

**Out.** Questions tools (the question rules of `task_update` are tested on
rows a test inserts); milestone tools; `board_status`; `watch`, `sql`;
build and release.

**Units, in build order.**
1. Decision 28: C0/C1 control characters other than `\n` and `\t` shown as
   visible escapes in human CLI output (`ls`, `show`, `project ls`), a
   maintained package first; `--json` unchanged.
2. Claims: `rules/claims` and `Board` for claim, extend, release (holder
   compare-and-set, an expired claim swept and retaken in one call, minutes
   1–1440); the Rules tests and two processes racing for one claim.
3. `task_update` rules: every field, the transitions table, a dropped claim
   (`sent_back`, `closed`), `waits_add` / `waits_remove` and cycles by
   recursive CTE for waits and parent, moves and reopening with the
   milestone flips, `done` refused and `cancelled` withdrawing with open
   questions, `changed: []`, the events in the given order.
4. `task_next`: the order, `from`, `milestone`, `waiting`.
5. `task_comment`: note and handover.
6. MCP: `task_claim`, `task_extend`, `task_release`, `task_update`,
   `task_next`, `task_comment`; the MCP tests.
7. CLI `board next`; the CLI tests.

**Done when.** `bun run check` passes; the slice's tests pass; through MCP a
task is added, claimed, extended, commented with a handover, sent back,
reclaimed after its lease lapses (one `claim_expired`), and closed; after
this slice board can track its own development.

## Slice 3: milestones and status

**Status:** done (afe82f4): every unit passed review and tests, `bun run
check` passes from a clean clone, and the "Done when" run passed over real
stdio.

**Implements.** "Milestones" whole; `milestone_add`, `milestone_update`,
`milestone_delete`, `board_status`; CLI `status`, `milestone [ls]`,
`milestone add`, `milestone edit`, `milestone rm`, `project edit`, `project
rm` (an empty project, under `defer_foreign_keys`); their events and tests.

**Out.** Questions; `watch`, `sql`; build and release.

**Units, in build order.**
1. Milestone rules: `milestone_add` (`before` / `after` / last, names 1–40,
   unique case-insensitively, never `none`), `milestone_update` (rename,
   `delivers`, moves relative to another, `changed`, `position` events),
   `milestone_delete` (only with no tasks, later ones shift up); the Rules
   tests.
2. `board_status`: counts by effective status, the chain, `current`, live
   claims soonest first, open and to-validate questions, `last_event`.
3. `project edit` (name, `--dir` under the root rule, `project_exists`,
   `project_edited`) and `project rm` (no tasks; its milestones and events
   removed under `defer_foreign_keys`; `project_removed`); the carried Store
   test of removing an empty project.
4. MCP: `milestone_add`, `milestone_update`, `milestone_delete`
   (destructive), `board_status`; the MCP tests.
5. CLI: `status`, `milestone [ls]`, `milestone add`, `milestone edit`,
   `milestone rm`, `project edit`, `project rm`; the CLI tests.

**Done when.** `bun run check` passes; the slice's tests pass; a chain of
three milestones is built, reordered and walked to done through MCP, with
`task_next` and `board status` following the current one.

## Slice 4: questions

**Status:** done (dd8ab0d): every unit passed review and tests, `bun run
check` passes from a clean clone, and the "Done when" run passed over real
stdio.

**Implements.** "Questions"; `question_ask`, `question_answer` (with the
owner's override), `question_validate`, `question_list` (`"*"`, `key`,
states); CLI `questions`, `answer`, `validate`; their events and tests.

**Out.** `watch`, `sql`; build and release.

The list of decisions to validate is `question_list` with `state:
to_validate` (`"*"` for every project), as the design has it; there is no
separate tool.

**Units, in build order.**
1. Question rules: `question_ask` (2–6 options, `recommended` within them,
   `invalid_transition` on a closed task, `Q<n>` machine-wide),
   `question_answer` (`choice`, `text` or both, `as` with no default, the
   owner's override with `overrides`, `already_answered`, a withdrawn one
   `invalid_transition`), `question_validate` (only an unvalidated
   delegate's answer), `question_list` (states, `"*"`, `key`, oldest first,
   `project` against `key`); the Rules tests, including the task becoming
   `blocked` and unblocked.
2. MCP: `question_ask`, `question_answer`, `question_validate`,
   `question_list`; the MCP tests.
3. CLI: `questions`, `answer QID [N] [--text]` (`as: owner`), `validate QID`;
   the CLI tests.

**Done when.** `bun run check` passes; the slice's tests pass; a question
blocks its task, a delegate's answer waits on `to_validate`, the owner's
override replaces it, and `board validate` clears another.

## Slice 5: watch and sql

**Status:** done (305462c): every unit passed review and tests, `bun run
check` passes from a clean clone, and the "Done when" run passed from
source.

**Implements.** "`board watch`" (derive, the polling loop, `--exec`) and
"`board sql`" (the read-only gate, `query_only`, the `-p` views, the three
losses in `board help sql`); "Runtime" for readers; their tests, including
the read-only matrix of `docs/design/drafts/bun/data.md` §5.

**Out.** Build and release.

**Units, in build order.**
1. `src/watch/derive`: the human line and its summary per kind, the JSON
   line shape, `claim_expiring` (the default and fixed thresholds, once per
   lease, re-armed by an extend, the attach lines); pure, with its tests.
2. `src/watch/` loop: `data_version` polling every 500 ms on one read-only
   `bun:sqlite` connection, the attach and tick order, the cursor moved past
   every row read, pages of 500, the filters, a narrowed watcher on
   `project_removed`; tested tick by tick with an injected clock and sleep,
   and against a spawned holder of the write lock.
3. `src/watch/exec`: `sh -c` per line in order, the JSON on stdin, the
   `BOARD_*` environment, output to stderr, the timeout (`SIGTERM`, then
   `SIGKILL` 2 s later), a failing command as one stderr line.
4. CLI `watch`: its options as listed under "The CLI", `-p` keys resolved
   once at attach (`not_found` before attaching), `no_board`, exit 130 / 143.
5. `src/sql/readonly.ts`: the read-only open, the `-p` temp views from the
   fixed list, `query_only`, statements with parameters refused, the
   `SQLITE_READONLY` refusal; the read-only matrix of
   `docs/design/drafts/bun/data.md` §5 and the carried test that every
   table with a `project_id` or `task_id` has a view.
6. CLI `sql`: the table (`NULL`, blobs as hex, the row count on stderr) and
   `--json`, exit codes 0 / 1 / 64, and `board help sql` with the three
   losses and "it narrows; it does not wall off".

**Done when.** `bun run check` passes; the slice's tests pass; a `board
watch --follow --exec` sees another process's writes and a
`claim_expiring`, and `board sql` refuses every write of the matrix.

## Slice 6: build and packaging

**Status:** done (252d1f3): every unit passed review and tests, `bun run
check` passes from a clean clone, and the "Done when" run passed. By the
owner's word, `tool/release.sh` was not run in this slice, `--dry-run`
included: its steps 1–7 and 9 were run separately and pass; step 3 refuses
here because this machine has no npm login. Notarisation (step 8) stays
unrun until the first real release, and nothing was published. The CI
workflow's steps pass locally; GitHub Actions has not run it, as the
repository has no remote yet.

**Implements.** "Build and distribution": `build:arm64`, `build:x64`,
`tool/macos/board.entitlements`, the `npm/` templates and `bin/board.js`
shim, `tool/release.sh` (with `--dry-run`), the CI workflow (install,
check, smoke test of the unsigned arm64 binary); the built-binary smoke test
of "Tests".

**Out.** Publishing and a notarisation run (the owner's, on the owner's
Mac).

**Units, in build order.**
1. The built-binary smoke test of "Tests" (skipped unless `BOARD_BIN` names
   a built `board`): through a symlink and as a copy, `project add`, `board
   mcp` in a linked worktree's subdirectory over `StdioClientTransport`,
   `task_add` with no project, `task_list` with `%`, `board sql` reading it
   back, `sqlite_version()` printed; run on `build:arm64` and `build:x64`
   (x64 under `arch -x86_64`).
2. `tool/macos/board.entitlements` and the signing step: `codesign` with
   hardened runtime, timestamp and the identifier, `--verify --strict`, the
   entitlements read back and compared; checked locally with the owner's
   Developer ID.
3. `npm/`: the three `package.json` templates and the `bin/board.js` shim
   (`spawnSync` with inherited stdio, the child's status, its signal
   re-raised); `npm pack` and a scratch install running `board` and the
   MCP round trip through the shim.
4. `tool/release.sh` as "Build and distribution" lists its steps, with
   `--dry-run`; how far it is run here is the owner's call (notarisation).
5. The CI workflow: `bun install --frozen-lockfile`, `bun run check`, and
   the smoke test on `build:arm64`'s unsigned binary.

**Done when.** `bun run check` passes; both binaries build and `file`
names their architectures; the smoke test passes on the arm64 binary run
through a symlink and as a copy; `npm pack` of the three packages and an
install of the tarballs runs `board` through the shim.

## Slice 7: `board upgrade`

**Status:** done (831e614): every unit passed review and tests, `bun run
check` passes from a clean clone with no test reaching the registry, a real
manager or a global install, and the "Done when" run passed. The owner's
rulings: `@jsr/std__fmt` under its own name; the running-servers line before
cliffy's success line; `-f --version` passes what is typed (an accepted gap);
the real-main refusal checked as `upgrade -f --version <exact>`.

**Implements.** "`board upgrade`" in `docs/design.md` whole, with decisions
32–43: cliffy's `UpgradeCommand` with `standalone: false` and `spinner:
false` over one provider per manager (npm, bun, pnpm, yarn classic), only
the detected one mounted; `latest` resolved to an exact version;
`detectManager` over the real path, with the refusal when nothing is
identified; the manager on `PATH` run with stdio inherited, no timeout and
no signal handler; the `registry` refusal and `runCli`'s `BoardError`
branch; the version check switched off through `hasRequiredPermissions`;
`setColorEnabled`; the post-success line about running servers; the README
lines (a reinstall line per manager, and that a mismatched `PATH` upgrades
that manager's install).

**Out.** Any real upgrade: tests never reach the registry, a real manager or
a global install, and nobody installs board globally while building it. No
MCP tool. Publishing.

**Units, in build order.**
1. Dependencies and the pure parts: `@cliffy/upgrade` and `@std/fmt` at
   cliffy's versions; `src/upgrade/detect.ts` (`detectManager`, the seven
   rows) and `src/upgrade/argv.ts` (`installArgv`); their tests over real
   paths per layout, with the pin that no argv carries `@*` or `@latest`.
2. `src/upgrade/spawn.ts` (`runManager`) and `src/upgrade/providers.ts`
   (`NpmManagerProvider` and the four: `resolveVersion`, `getVersions` with
   the `registry` refusal, `hasRequiredPermissions` answering `false`, the
   `upgrade()` hook with its refusals and the line after success); the
   `registry` code in the error union and Appendix B's schema; the spawn
   tests against fake managers on a temporary `PATH`.
3. `src/cli/upgrade.ts` and `src/main.ts` (`Deps.upgrade`, the detected
   provider alone, `setColorEnabled`, `runCli`'s `BoardError` branch); the
   subprocess CLI tests through `test/helpers/upgrade-cli.ts`, including
   help and `--version` making no fetch and Ctrl-C during a fake install.
4. The binary smoke test's `board upgrade --help`, and the README lines.

**Done when.** `bun run check` passes from a clean clone with no network
reached by any test; the slice's tests pass; `bun src/main.ts upgrade` in
the checkout refuses with no supported installation and spawns nothing; a
built arm64 binary answers `board upgrade --help` with exit 0 and no fetch;
a fake-manager run through the CLI helper upgrades to an exact version and
prints the line about running servers.

## Slice 8: the CLI replaces the MCP server

**Status:** done (e4016be): every unit passed review and tests, and `bun
run check` passes on its last commit; the arm64 binary passes the smoke
test through a symlink and as a copy. Main ruled four points as delegate:
`details.field` follows the rule, the paging note names `--offset`, a 141
may follow notes already written, and the shell splits `board skill`'s
lines. x64 under Rosetta and `tool/release.sh --dry-run` were not run.

**Implements.** "No server to configure"; "The CLI" whole ("Four rules the
surface follows", "Conventions", "Commands", "Inputs", "The actor", "Long
text", "Output", "Errors", "`board skill`" with its text); "Runtime" for a
closed stdout (141), the shim's signals and the environment; "Module
layout"; "Tests" for the CLI, `board skill`, concurrency across processes,
the npm shim and the built binary; "Build and distribution" for the shim;
the closing line of "`board upgrade`"'s "Output and exit codes"; "How it
runs with chord"; Appendix B as output schemas only; decisions 1, 2, 13,
14, 24 and 45–54.

**Out.** The rules, the store, the schema, the error codes, the sweep,
`watch` and `sql` beyond their `next` strings; publishing and notarisation;
any change to chord.

**Who keeps the earlier tests green.** Tests of earlier slices that drive
the MCP server, or the CLI surface this slice changes, are deleted or
updated by developer in the unit that breaks them; tester writes only
`test/slice8-*.test.ts`.

**Units, in build order.**
1. Remove the MCP server: `src/mcp/`, `src/cli/mcp.ts` and `board mcp`,
   `@modelcontextprotocol/server` and `/client` from `package.json` and
   `bun.lock`, every test that drives them (the binary and npm tests lose
   their MCP steps until units 8 and 10).
2. `Board` and the rules: the constructor takes a `Store` (no lazy open),
   `OWNER` goes and every write takes its actor, `board` refused as an
   actor (`field: actor`); every `next` names a command, `board sql`'s
   write refusal included; `details.field` is the flag as typed
   (`waits-add`, `waits-remove`, `dir`, `KEY`, `N`); the existing writes
   (`project add/edit/rm`, `milestone add/edit/rm`, `answer`, `validate`)
   take `--actor`, required, and `answer` takes `--as`, required; the test
   that no `next` names a tool.
3. Output and errors: `src/schemas.ts` as Appendix B's `outputs.<command>`
   and the error shape, the input schemas gone; `ajv` 8.20.0 as a dev
   dependency and a test helper over `ajv/dist/2020`; every existing
   command's `--json` and human line as Appendix B says, `--json` added
   where "Output" adds it; refusals as `board: <code>: <message> <next>`
   or the error object on stderr, usage as `board: usage: <message>`.
4. The task writes: `add`, `edit`, `claim`, `extend`, `release`,
   `comment`, `handover`, with the "Inputs" checks at parse, `--json`, the
   human lines and their CLI tests.
5. `ask`, with the numbered option flags, and `answer`'s "at least one of
   `N` and `--text`"; their CLI tests.
6. Concurrency through the CLI across processes: two claims of one task
   started together (one 0, one `claim_held`), 20 times; concurrent edits.
7. `src/main.ts`: `EPIPE` on stdout ends silently with 141; the upgrade
   closing line's new text.
8. The npm shim: `child_process.spawn` with inherited stdio, `SIGINT`,
   `SIGTERM`, `SIGHUP` forwarded, the child's signal re-raised or its
   status returned; the shim tests.
9. `board skill`: `src/skill.ts` with the design's prose, `src/cli/skill.ts`
   with the index generated from the tree (each command's description as
   the index prints it); the tests that every `board …` line parses
   (`shell-quote` or `string-argv` tried first), every code has a row, and
   the flows run.
10. The built-binary smoke test's eight steps, the release self-test with
    `--actor`, and the README's status line.

**Done when.** `bun run check` passes from a clean clone; tester's
`test/slice8-*.test.ts` passes; nothing in `package.json`, `bun.lock`,
`src/` or `test/` names `@modelcontextprotocol`; from source under a temp
`BOARD_DIR`, a project added with `--actor`, a task added from a linked
worktree's subdirectory, claimed, claimed again (`claim_held`, exit 1), a
claim without `--minutes` (exit 64), handed over and closed; `board watch
--json | head -c 1` exits 141 with empty stderr; `board skill` exits 0 with
a `BOARD_DIR` that does not exist; the arm64 binary passes the smoke test.

## Not in v1

As "Not in scope" in `docs/design.md`.
