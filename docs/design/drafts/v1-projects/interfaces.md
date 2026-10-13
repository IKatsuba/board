# v1-projects: interfaces

The MCP tools and the CLI under the owner's four new decisions: one board per
machine with projects, no FTS5, no pause, and a project key chosen by a
person. This draft answers the "interfaces" section of `brief.md` and says
what changes relative to `docs/design.md`; where v1 holds, it says so in one
line. Appendix B at the end is complete and normative, and replaces the
current one.

Shapes that depend on the other drafts are marked **[data]** or **[runtime]**
and collected under "Assumptions on the other drafts".

**Revised after review** under "Resolutions after review" in `brief.md`
(R0, C1–C4, C9–C13). What changed: `board sql --project` is back, through
temp views (C1); `milestone: "none"` is no longer a `oneOf` (C2, which the
probe below shows was a bug); `no_board` returns (C3); `Event.project` is
nullable, `board_created` returns, and `project_removed` carries `{key, name,
directory}` (C4); `events` lists every appended id (C9); `watch --project`
exits when its project is removed (C10); cross-project relations, including
`waits_remove`, are `invalid_argument` (C11); the combinations of key, `"*"`,
pin and parent are spelt out (C12); the sql examples use `t.number` (C13);
there is no reset (R0).

## What was checked

- **`package:mcp_dart` 2.4.2** (the version v1 tried). Nothing new is needed
  from it: an optional `project` argument is a plain string property, and
  `project: "*"` is a `oneOf` of a key pattern and `const "*"`, which no
  value matches both of.
- **`milestone: "none"` (C2), probed in process** (a server with three tools
  over `IOStreamTransport`, called through `McpClient`) with the milestone
  pattern `^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`:

  | Schema | `"none"` | `"NONE"` | `"v1"` | `"-bad"` |
  | --- | --- | --- | --- | --- |
  | `oneOf: [pattern, const "none"]` (v1) | **refused**: "Value must match exactly one oneOf schema" | passes | passes | refused, names no field |
  | `anyOf: [pattern, const "none"]` | passes | passes | passes | refused: "Value does not match anyOf (at milestone)" |
  | the pattern alone | passes | passes | passes | refused: "String does not match pattern …" |

  v1's `oneOf` refused the very value it was there to allow, because `none`
  matches the name pattern too. Taken: **the pattern alone**, as the `$def`
  `MilestoneRef`, with `none` (any case) meaning "no milestone" in its
  description; it gives the clearest refusal, and the store already refuses
  `none` as a name, so the two never meet. `milestone_add.name` and
  `milestone_update.name` use the same pattern, and `none` there is board's
  `invalid_argument`, as in v1.
- The server side also has `Server.listRoots()` (`roots/list`), by which a
  client can tell a server its workspace directories. Not in v1 (lead's
  resolution): the owner's rule is the working directory and git, and roots
  depend on each client supporting them.
- **`package:args` 2.7.0.** A nested command group (`project add`, `project
  ls`, …) is what v1's `milestone` group already is. `-p, --project` is
  declared per command, not on the runner: an option on the runner's own
  parser is accepted only before the command name (`board --project BRD ls`),
  which nobody types. `--all` and `--project` together are refused through
  `usageException`, as v1's required options are.
- **quarry** (`src/cli.ts`, `src/commands/project.ts`, `src/lookup.ts`), as
  the owner asked. Taken from it: `project add` / `ls` / `set` / `remove`,
  the key not changeable after add (tasks carry it), a directory stored
  resolved, "the deepest directory wins" when projects nest. Not taken: the
  key derived from the name (owner decision 6), the name as a second
  identifier (board's only identifier is the key; the name is a label), and
  "where you stand never narrows a list" (the brief makes the working
  directory decide, and an agent's `task_list` must mean its own project).

## 1. How a tool learns its project

**Rule, the same for every tool and every CLI command:**

1. A task key (`BRD-12`) names its project. A question id names its question,
   and so its task and project **[data: `Q<n>` one sequence per machine]**.
   A tool that takes a key or a question id takes no `project` argument; its
   input schema refuses one (`additionalProperties: false`).
2. Otherwise the `project` argument, when given.
3. Otherwise the project pinned by `board mcp --project KEY`, when the server
   was started with one (section 6).
4. Otherwise the working directory of the process: the project whose
   directory contains it, the deepest when projects nest; failing that, the
   main repository's root from `git rev-parse --git-common-dir`, matched the
   same way **[runtime: realpath, case, git missing or slow, caching]**.
5. Otherwise `no_project`, which says what was looked at and how to add the
   project (section 4).

`project` is **optional, never required**. Required, every agent's first
call would fail until it learned a key it has no way to know; inferred only,
an agent in a worktree outside the tree, or `main` looking at a second
project, would have no way out. The argument is an override, and every answer
says which project it was about.

| Tool | Project from |
| --- | --- |
| `board_status`, `task_next`, `milestone_add`, `milestone_update`, `milestone_delete` | `project`, else pin, else cwd |
| `task_list` | `project` (a key, or `"*"`), else `parent`'s project, else pin, else cwd |
| `question_list` | `project` (a key, or `"*"`), else `key`'s project, else pin, else cwd |
| `task_add` | `project`, else `parent`'s project, else pin, else cwd |
| `task_read`, `task_update`, `task_claim`, `task_extend`, `task_release`, `task_comment`, `question_ask` | the key only |
| `question_answer`, `question_validate` | the question id only |

**Every combination (C12).** "Ref" is the task reference a tool may take
beside `project`: `parent` for `task_list` and `task_add`, `key` for
`question_list`. The pin is `board mcp --project`; the CLI has none.

| `project` | ref | Scope | Notes |
| --- | --- | --- | --- |
| absent | absent | pin, else cwd, else git, else `no_project` | the pin is never checked against the cwd |
| absent | given | the ref's project | pin and cwd are not consulted, so a pinned server still reaches another project through a key |
| `K` | absent | `K` | beats the pin and the cwd; an unknown `K` is `not_found` (`what: project`) |
| `K` | in `K` | `K` | |
| `K` | in another project | refused | `invalid_argument`, `field: "project"` |
| `"*"` | absent | every project | lists only; newest first by `task.id` across projects |
| `"*"` | given | every project, filtered by the ref | the ref narrows as a filter; the answer's `project` is `"*"` |

- Tools that take a key or a question id take no `project`, and the pin and
  the cwd play no part: the pin is a default, not a fence.
- `"*"` is accepted only by `task_list` and `question_list` (the schema
  refuses it elsewhere), because a status, a next task or a milestone chain
  is one project's. Under `"*"`, `milestone` may only be `none` (a name means
  nothing across projects), else `invalid_argument`, `field: "milestone"`.
- **Relations never cross projects (C11).** In a write, `parent`, `waits`,
  `waits_add`, `waits_remove` and a milestone name are looked up in the
  task's project. A key of another project in any of them is
  `invalid_argument` naming that field, `waits_remove` included, where it
  could only be a no-op: it is a mistake worth saying.
- **Answers carry the project.** A task key's prefix *is* its project key
  **[data: the v1 prefix rule carries over as the project key]**, so `Task`,
  `TaskSummary`, `Claim` and `Question` need no new field. Every answer
  scoped to a project says it at the top level: `board_status.project` (the
  whole `Project`), `task_list.project`, `task_next.project`,
  `question_list.project`, and the milestone tools' `project`. `Event` gains
  `project`, because milestone and project events have no task; it is null
  only on `board_created` and `project_removed` (C4).
- **`events` is every id the write appended (C9)**, ascending, including the
  `claim_expired` lines its sweep wrote for any project, since the sweep is
  machine-wide and always commits. "Changes nothing" is `changed: []`, not
  `events: []`: a no-op update may still answer sweep ids.
- **`board_status` is per project**: what v1 showed for the board, for one
  project, with `project` in place of `paused`. A machine-wide view is `board
  project ls` for a person; agents have no tool for it (section 3).

## 2. The pause and FTS5 removed

- **Pause.** Gone: `board_pause`, `board_resume`, the `Pause` def,
  `board_status.paused`, the `paused` code, `details.pause`, the
  `board_paused` / `board_resumed` kinds, `board pause` / `board resume`,
  and "every write can answer `paused`". Seventeen tools remain.
- **Search.** `task_list.text` (FTS5) becomes `task_list.contains`, and `board
  ls --search` becomes `board ls --contains`. The new name says what it does:
  a task matches when its title or its body contains the string, as given.
  - 1–200 characters. No character is special: `%`, `_` and `\` match
    themselves, and `APP-12` or `claim-release` is just text **[data: the
    `LIKE … ESCAPE` that guarantees it]**.
  - Case is folded for ASCII letters only: `lease` finds `Lease`, `é` does
    not find `É` **[data]**. The tool description says so.
  - Order is the list's usual one, newest first; there is no ranking.
  - It can no longer fail as a query: the `invalid_argument` with `field:
    "text"` and SQLite's message is gone. `details.sqlite` stays for
    `storage` and `damaged`.
  - Anything richer (several words, a word in the title only) is `board sql`.

## 3. The CLI

```
board project add KEY [--name NAME] [--dir DIR] [--json]
board project ls [--json]
board project edit KEY [--name NAME] [--dir DIR] [--json]
board project rm KEY
board mcp [--project KEY]
board status [-p KEY] [--json]
board ls [-p KEY | --all] [--status S,…] [--milestone NAME|none] [--parent KEY]
         [--ready] [--contains TEXT] [--limit N] [--offset N] [--json]
board show KEY [--since ID] [--json]
board next [-p KEY] [--milestone NAME] [--json]
board questions [-p KEY | --all] [--state open|to_validate|answered|withdrawn|all]
                [--task KEY] [--json]
board answer QID [N] [--text TEXT]
board validate QID
board milestone [ls] [-p KEY] [--json]
board milestone add NAME --delivers TEXT [--before NAME | --after NAME] [-p KEY]
board milestone edit NAME [--name NEW] [--delivers TEXT] [--before NAME | --after NAME] [-p KEY]
board milestone rm NAME [-p KEY]
board watch [-f|--follow] [--since ID] [-p|--project KEY,…] [--kind K,…] [--task KEY,…]
            [--json] [--expiring-within MINUTES] [--exec CMD] [--exec-timeout SECONDS]
board sql QUERY [-p KEY] [--json]
board help [COMMAND]
```

What changes from v1: `init` is gone and `project` takes its place; `pause`
and `resume` are gone; `--search` is `--contains`; `-p, --project` on every
command whose project is not named by a key, and on `sql`; `--all` on the
two lists; `--project` on `mcp`. Exit codes, stdout/stderr, `--json`, the actor `owner`
and the tables hold as in v1. `-p` resolves as in section 1, step 2; a
command with neither a key nor `-p` resolves from its working directory.

### `board project add KEY [--name NAME] [--dir DIR]`

Adds a project. `KEY` is required and is the key every task of the project
carries (owner decision 6); it is never derived from anything.

- `KEY`: `^[A-Za-z][A-Za-z0-9]{0,9}$`, stored and shown in upper case
  **[data]**. Taken (case-insensitively) is `project_exists`.
- `--dir`: the project's directory, default the working directory. Stored
  resolved **[runtime: `realpath`]**, so a symlink or a relative path means
  the same thing later. A directory that does not exist is a usage error
  (64). A directory another project has is `project_exists`. A directory
  inside or around another project's is allowed **[data: deepest wins]**.
- `--name`: a label, default the directory's last component. Not unique and
  not an identifier: nothing looks a project up by name.
- When `--dir` lies inside a git repository whose main root is a different
  directory, a note on stderr says so, because agents elsewhere in that
  repository will not resolve to the project:
  `note: /work/app/server is inside the git repository /work/app; agents started elsewhere in it will not find BRD`.
- `project add` is the only command that creates the board: the first one on
  a machine creates `~/.board/board.db` (or `$BOARD_DIR/board.db`), logging
  `board_created {}` (project null) before `project_added` (C3, R0).
- Logs `project_added {key, name, directory}`, actor `owner`.

```
$ board project add BRD --dir ~/src/board
BRD  board  /work/board
keys BRD-1, BRD-2, …; agents started under /work/board use it
```

The first line is stdout (the project, tab-separated); the second is a note
on stderr. `--json` prints the `Project`.

There is no `--force` and no reset (R0). Starting a project over is a new
key. A fresh machine-wide board, the way out of `schema_mismatch`, is the
person's offline act: stop the agents, move `board.db`, `board.db-wal` and
`board.db-shm` aside, then `board project add`.

### `board project ls`

Every project on the machine, by key, with a mark on the one the working
directory resolves to.

```
$ board project ls
   KEY  NAME   OPEN  CLOSED  CURRENT MILESTONE  DIRECTORY
*  BRD  board  4     11      v1 (2 of 5)        /work/board
   APP  app    12    40      -                  /work/app
```

`OPEN` is backlog, ready, active and blocked; `CLOSED` done and cancelled.
An empty list prints nothing on stdout and `no projects; board project add
KEY` on stderr, exit 0. `--json` prints `ProjectList` (Appendix B, CLI-only
shapes): `{projects: [{project, open, closed, current}], here}`, `here` the
resolved key or null. Resolution failing here is not an error: `here` is
null and no row is marked.

### `board project edit KEY [--name NAME] [--dir DIR]`

Changes the label or the directory (the repository moved). The key is not
changeable: every task key, comment, handover and chat line that names
`BRD-12` would point at nothing. At least one option, else a usage error. A
directory another project has is `project_exists`. Logs `project_edited`
with `{field: {from, to}}` **[data]**. Prints the project as `add` does.

### `board project rm KEY`

Removes a project that has no tasks, with its milestones and its events; for
a key typed wrong at `add`. A project with tasks, cancelled ones included, is
`invalid_transition` with `reason: "has_tasks"`; there is no removal of a
project with tasks in v1. Logs `project_removed {key, name, directory}` with
`project: null`, since the project's row is gone (C4). Prints `removed BRD`.
A `board watch -p BRD` prints that line and exits 0 (C10).

### `board init`

Gone, with no alias: before the first release no command is kept for
compatibility, and `args` already answers `Could not find a command named
"init".` with the command list, where `project` is the second line.

### Per-project commands

`status`, `ls`, `next`, `questions` and `milestone …` act on one project,
resolved as in section 1, and say which: `board status` starts with the
project line, and the others' notes on stderr name it (`12 tasks in BRD`).
`ls --all` and `questions --all` span every project; `--all` with `-p` is a
usage error.

```
$ board status
project           BRD  board  /work/board
milestone 2 of 5  v1  The tools and the CLI.  3 tasks left (5 done, 1 cancelled of 9)
tasks             2 ready, 1 active, 1 blocked, 4 backlog, 11 done, 1 cancelled
questions         1 open, 2 to validate

claims
KEY     HOLDER  UNTIL                     LEFT    DIRECTORY      BRANCH
BRD-12  @lead   2026-10-12T16:00:00.000Z  in 47m  /work/board-2  feat/claims
```

`show KEY`, `answer QID` and `validate QID` work from any directory: the key
or the id names the project.

### `board watch`

Every project unless narrowed. `-p, --project KEY,…` is a multi-option like
`--kind` and `--task`; filters intersect. Each key is turned into its
project's id once, at attach; an unknown key is `not_found` before
attaching, exit 1. Without `-p`, `board_created` and `project_removed` (both
with no project) are shown like any other line; with `-p`, the line shown is
the narrowed project's own `project_removed`, matched on `data.key`.

- **A narrowed project is removed (C10).** When a `project_removed` arrives
  whose `data.key` is one of the `-p` keys, the watcher prints that line and
  stops watching that key; when no `-p` key is left, it exits 0. A project
  added again under the same key is a new project with a new id, so it needs
  a new `watch`. Without `-p`, a removal is one more line.

- **The human line** gains the project after the id: time, `#id`, project,
  task (`-` when none), actor, kind, summary.

  ```
  2026-10-12T14:03:00.000Z  #436  BRD  BRD-14  main   claimed          @lead for 90 min, until 2026-10-12T15:33:00.000Z, feat/watch
  2026-10-12T14:05:00.000Z  #437  APP  -       owner  milestone_added  v2 at 3 of 3
  2026-10-12T15:23:00.000Z  -     BRD  BRD-14  board  claim_expiring   @lead's claim ends at 2026-10-12T15:33:00.000Z (in 10m)
  ```

- **`--json`** lines are `{id, derived, at, actor, kind, project, task,
  milestone, data}`; `project` is null on `board_created` and
  `project_removed`. The human line shows `-` there.
- **`--exec`** adds `BOARD_PROJECT` (empty when null) to the environment.
- There is no reset, so v1's "a reset makes the watcher exit 1" goes (R0).
  A missing file at start is `no_board`, exit 1; `--follow` does not wait for
  one **[runtime]**. Everything else in v1's `board watch` holds.

### `board sql QUERY [-p KEY] [--json]`

Without `-p`, the query sees every project. With `-p KEY` (C1), unqualified
table names show only that project: before the query runs, board creates on
its own throwaway read-only connection one `TEMP VIEW` per table, under the
table's own name, from a fixed list taken from the normative schema:

| View | Rows |
| --- | --- |
| `project` | the one row of `KEY` |
| `task`, `milestone`, `waits`, `event` | `WHERE project_id = <id>` |
| `claim`, `question` | those whose task is in the project, through a join on `task` |

The id is an integer board read from its own `project` row, written into the
view's text as a literal (views take no parameters). Nothing the user typed
reaches the DDL, and the query itself is not rewritten: it passes the same
gate as in v1 (read-only open, `isReadOnly` or `EXPLAIN`, one statement).
An unknown `KEY` is `not_found`, exit 1, before anything runs. Without `-p`,
no views and no resolution from the cwd: `sql` is the machine's.

**It narrows; it does not wall off.** `board help sql` says so:

```
-p, --project KEY   Unqualified table names (task, event, …) show only this
                    project. main.<table> and sqlite_master still see every
                    project.
```

Keys are not stored: a task's key is the project's key, `-`, and
`task.number` **[data]**.

```
$ board sql -p BRD "SELECT number, title FROM task WHERE status = 'ready'"
$ board sql "SELECT p.key || '-' || t.number AS key, t.title FROM task t JOIN project p ON p.id = t.project_id WHERE t.status = 'ready' ORDER BY t.id DESC"
```

The refusal message names the file as `~/.board/board.db` (or under
`$BOARD_DIR`) instead of `.board/board.db`, and drops `board pause` from its
examples. The rest holds.

## 4. Errors

Changes to the closed list, which stays at 17 codes:

| Code | Change |
| --- | --- |
| `paused` | removed with the pause |
| `board_reset` | removed: there is no reset (R0) |
| `no_board` | **kept, new causes (C3)**: the board file is missing (only `board project add` creates it), or the board's location is misconfigured (`BOARD_DIR` relative, or no `HOME` and no `BOARD_DIR`). `board mcp` still starts and answers every call with it, retrying the open per call **[runtime]** |
| `no_project` | **new**: no key, no `project` and no pin, and the working directory resolves to no project |
| `project_exists` | **new**: `board project add` / `edit` with a key or directory another project has. CLI only (no tool adds a project), but in the one enum because the CLI prints the same error object |
| `not_found` | `details.what` gains `project`: a `project` argument, `-p`, a pin, or a key whose prefix is no project (`XYZ-3`) |
| `invalid_argument` | gains: a key of another project in `parent`, `waits`, `waits_add` or `waits_remove` (C11); `project` contradicting `parent` / `key`; a milestone name under `"*"`. Loses: the FTS5 query |
| `damaged`, `not_a_board`, `schema_mismatch` | `next` names the file and the offline recovery: stop the agents, move `board.db` and its `-wal` / `-shm` aside, `board project add` again. `schema_mismatch` no longer says `board init --force` |

### `no_board`

Runtime's messages, with board's `message` / `next` split. `details.path` is
the file looked for, `details.reason` one of `missing`, `board_dir_relative`,
`no_home`.

| `reason` | `message` | `next` |
| --- | --- | --- |
| `missing`, `BOARD_DIR` unset | `No board at /home/me/.board/board.db (BOARD_DIR is not set).` | `` `board project add KEY` in a project's directory creates it. `` |
| `missing`, `BOARD_DIR` set | `No board at /srv/b/board.db (BOARD_DIR names /srv/b).` | `` Check BOARD_DIR, or `board project add KEY` in a project's directory to create a board there. `` |
| `board_dir_relative` | `BOARD_DIR must be an absolute path, got "~/x".` | `Set BOARD_DIR to an absolute path in the environment that starts board (for an MCP server, the "env" of its .mcp.json entry), or unset it for ~/.board.` |
| `no_home` | `Neither BOARD_DIR nor HOME is set, so board cannot tell where the board is.` | `Set BOARD_DIR to an absolute path.` |

From an agent, `missing` means the owner has not set board up on this
machine: the agent cannot fix it and should say so.

### `no_project`, as the owner asked

It says what was looked at and how to add the project. The key in `next` is
a placeholder on purpose: the key is the person's choice (owner decision 6),
so an agent is told to ask, not to pick one.

```json
{ "error": {
    "code": "no_project",
    "message": "No project here. Looked at the working directory /work/app/server: no project's directory contains it. Looked at its git repository: the main repository is /work/app, and no project's directory contains it. Projects on this machine: BRD /work/board.",
    "next": "Pass `project` with one of the keys above, or ask the owner to choose a key and run `board project add KEY --dir /work/app`.",
    "details": {
      "cwd": "/work/app/server",
      "git": "found", "git_root": "/work/app",
      "projects": [ { "key": "BRD", "name": "board", "directory": "/work/board",
                      "created_at": "2026-10-12T09:00:00.000Z" } ] } } }
```

- `details.git` is one of `found`, `not_a_repo`, `missing` (no `git` on
  `PATH`), `failed` (non-zero exit or a timeout, with git's stderr line in
  `reason`) **[runtime]**; `git_root` is null unless `found`.
- `--dir` in `next` is the git root when found, else the working directory.
- With no projects at all: `Projects on this machine: none.` and `projects:
  []`.
- From the CLI, the same text on stderr, exit 1; `-p` is offered in place of
  `project`.
- From a server pinned with `--project` the code cannot occur: the pin is used
  before the working directory, and an unknown pinned key is `not_found`.

### `project_exists`

```
board: BRD is already a project (board, /work/board). Choose another key.
board: /work/board is already the directory of BRD. `board project edit BRD --dir …` moves that one first.
```

`details: {field: "key" | "directory", project: Project}`, exit 1.

## 5. Events

data owns the catalog (C4); what the interface shows:

- `board_paused`, `board_resumed` removed.
- `board_created {}`: the machine's file made by the first `project add`;
  `project: null`.
- `project_added {key, name, directory}`; `project_edited {<field>: {from,
  to}}` for `name` and `directory` (`board project edit` exists, so the kind
  stays); `project_removed {key, name, directory}` with `project: null`,
  because the project's row and its own events are gone.
- `Event.project` is the project's key, or null on exactly those two kinds.

`board watch --kind` takes the new catalog plus `claim_expiring`.

## 6. `.mcp.json`

No change is needed for the normal case: Claude Code and chord start a stdio
server in the session's working directory, which lies in the project's tree
or in a git worktree of it **[runtime: confirm for both]**, and the README's
line stays:

```json
{ "mcpServers": { "board": { "command": "board", "args": ["mcp"] } } }
```

For a client that starts servers elsewhere, or a session that must stay on
one project wherever it runs, `board mcp --project KEY` pins it:

```json
{ "mcpServers": { "board": { "command": "board", "args": ["mcp", "--project", "BRD"] } } }
```

The pin is not checked at start (the project may be added later); an unknown
key is `not_found` on each call. A `project` argument still overrides it per
call. The pin beats the cwd, which runtime still captures at start for when
there is no pin. `BOARD_DIR` in `env` names another board directory, for
tests and a second board on one machine; it must be absolute, else every call
answers `no_board` (`board_dir_relative`). No new environment variable is
added.

## How the tools map onto the rules

As in v1, with two changes: no tool checks a pause, and every operation
first resolves its project (section 1) inside its transaction, so a project
added, edited or removed by the CLI is seen by the next call of a running
server. When the git fallback is needed and its answer is not at hand, the
transaction rolls back before any change, git is asked outside it, and the
operation runs once more in a new transaction (C6, runtime); the agent sees
one call. Milestone order, `task_next`'s groups and `board_status` counts
are per project; the expiry sweep is machine-wide (C9).

## Assumptions on the other drafts

Checked against `data.md` and `runtime.md` and the lead's resolutions; what
remains an assumption:

- **[data]** `project.key` follows the v1 prefix rule, `NOCASE UNIQUE`;
  `name` is not unique; `directory` is unique and canonical; the deepest
  directory wins when projects nest.
- **[data]** Task numbers per project in `task.number`; a key is
  `<project.key>-<number>`. `Q<n>` is one sequence per machine. Milestone
  names are unique per project.
- **[data]** `project rm` deletes the project's milestones and events and
  only works with no tasks; `board_created` and `project_removed` have a
  null `project_id`.
- **[data]** `contains` is `LIKE … ESCAPE` with ASCII case folding.
- **[runtime]** The cwd is captured at start as a real path; resolution runs
  per call; git is asked again each time the fallback is needed (C7), with a
  timeout that ends as `git: "failed"`.
- **[runtime]** `no_board` messages as in its §1; the temp views of
  `sql -p` as in its §4, on the list fixed above.

## Open questions for the owner

None from interfaces after the lead's resolutions. Removing a project with
tasks and MCP roots are recorded as not in v1.

## Appendix B: tool schemas

JSON Schema 2020-12, normative: `mcp_dart` validates every successful result
against the output schema. Each registered tool schema carries the `$defs` it
refers to, so `$ref: "#/$defs/…"` resolves inside it. Every object has
`additionalProperties: false`, and every property is listed in `required`: an
output field that may be absent is `null`, never missing.

```json
{
  "$defs": {
    "Time": { "type": "string",
      "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" },
    "Actor": { "type": "string", "minLength": 1, "maxLength": 64 },
    "ProjectKey": { "type": "string", "pattern": "^[A-Z][A-Z0-9]{0,9}$" },
    "ProjectKeyIn": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9]{0,9}$" },
    "ProjectScope": { "oneOf": [{ "$ref": "#/$defs/ProjectKeyIn" }, { "const": "*" }] },
    "Key": { "type": "string", "pattern": "^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$" },
    "KeyIn": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]*$" },
    "QuestionId": { "type": "string", "pattern": "^Q[1-9][0-9]*$" },
    "QuestionIdIn": { "type": "string", "pattern": "^[Qq][1-9][0-9]*$" },
    "MilestoneName": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$" },
    "MilestoneRef": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$",
      "description": "A milestone's name, or none (any case) for no milestone." },
    "Status": { "enum": ["backlog", "ready", "active", "blocked", "done", "cancelled"] },
    "Priority": { "enum": ["urgent", "high", "normal", "low"] },
    "Minutes": { "type": "integer", "minimum": 1, "maximum": 1440 },
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
- `ProjectScope` is a key or `"*"` for every project; only `task_list` and
  `question_list` take it. `ProjectKeyIn` matches no `"*"`, so the two never
  meet.
- `Project.directory` is the stored, resolved path **[runtime]**.
- `Claim.minutes_left` is whole minutes rounded up, so a live claim never
  shows 0 unless it has under a minute; a claim is only ever shown live.
- `Option.detail` and `Answer.text` are `null` when not given. An answer has
  `choice`, `text` or both.
- `Question.validated` is non-null only on an answer given `as: delegate`. An
  owner's override leaves it null.
- `Milestone.tasks.left` is `total − done − cancelled`. `Place` is "milestone
  2 of 5, 3 left".
- `Events`, on every write, is every id the write appended, ascending, the
  sweep's `claim_expired` lines of any project included (C9).
- `Event.project` is null only on `board_created` and `project_removed`.
- `Event.data` is `{ "type": "object" }` on the wire; its shape per kind is
  the normative table under "Events", held by the store's tests (C8).
- `MilestoneRef` is the name pattern alone, which `none` matches: a
  `oneOf` with `const "none"` refuses `none` itself (see "What was
  checked"). `none`, any case, means no milestone wherever a `MilestoneRef`
  is taken; the store refuses it as a name.

### CLI-only shapes

`board project add` and `edit` print a `Project` under `--json`. `board
project ls --json` prints:

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

Every refusal board makes, from every tool, has this shape (the CLI prints
the same object under `--json`):

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
          "not_a_board", "schema_mismatch", "internal"] },
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
            "path": { "type": "string" },
            "sqlite": { "type": "string" } } } } } }
}
```

The result is `isError: true`; the text line is `message` and `next` joined by
a space. `message` says what is wrong and names the thing; `next` says what to
do. `details` carries only the fields listed for the code below, and is `{}`
when there are none. A refusal changes nothing and appends no event.

| Code | When | `next` says | `details` |
| --- | --- | --- | --- |
| `not_found` | a project, key, question or milestone does not exist (a key whose prefix is no project is `what: project`) | check it; `task_list` / `question_list` / `board_status` to find it; for a project, the keys there are | `what`, `id` |
| `claim_held` | `task_claim` with a live claim (any holder); `task_extend` / `task_release` whose `holder` is not the live claim's | for a claim: wait or `task_extend` if it is yours; for extend/release: re-read the claim | `claim` |
| `not_claimed` | `task_extend` / `task_release` with no live claim (none, or expired) | `task_claim` to take it | — |
| `not_ready` | `task_claim` on a task that is not ready | the reason, and what would make it ready | `task`, `reason` (`status`, `question`, `waits`) |
| `invalid_transition` | a status, question, milestone or project change the rules do not allow (closing with an open question, validating an owner's answer, deleting a milestone that has tasks, removing a project that has tasks, asking on a closed task, answering a withdrawn question) | what is allowed from here | `from`, `to`, `allowed`, `reason` |
| `already_answered` | answering a question that is answered and not overridable | `question_list`; the owner may override a delegate's unvalidated answer | `question` |
| `cycle` | a wait or a parent that would close a loop | the loop | `path` (keys) |
| `invalid_argument` | a value the schema allows and the rules do not: a key of another project in `parent` / `waits` / `waits_add` / `waits_remove`; `project` contradicting `parent` or `key`; a milestone name with `project: "*"`; the same key in `waits_add` and `waits_remove`; `choice` or `recommended` past the options; a move relative to itself; a milestone name taken or `none`; the actor `board` | what to change | `field` |
| `busy` | the write lock was not obtained within the busy timeout | retry; nothing was changed | — |
| `storage` | disk full, I/O error, read-only file | SQLite's message; nothing was changed | `sqlite` |
| `no_board` | the board file is missing (only `board project add` creates it), or `BOARD_DIR` is relative, or neither `BOARD_DIR` nor `HOME` is set | for `missing`: `board project add KEY` in a project's directory creates it; otherwise fix the environment (see "`no_board`") | `path`, `reason` (`missing`, `board_dir_relative`, `no_home`) |
| `no_project` | no key and no `project` given (and no pin), and the working directory resolves to no project, directly or through git | pass `project` with a key listed, or ask the owner to choose a key and run `board project add KEY --dir DIR` | `cwd`, `git`, `git_root`, `projects`, `reason` (git's message when `failed`) |
| `project_exists` | CLI only: `board project add` / `edit` with a key or a directory another project has | choose another key; or move the other project first | `field` (`key`, `directory`), `project` |
| `damaged` | the file is not a database or is malformed | stop the agents, move `~/.board/board.db` and its `-wal` / `-shm` aside, then `board project add` | `sqlite` |
| `not_a_board` | a SQLite file that is not a board (`application_id`) | move it aside, then `board project add` | — |
| `schema_mismatch` | a board from another build (`user_version`) | there are no migrations before the first release: move the file aside, after the owner agrees, then `board project add` | `from`, `to` (versions) |
| `internal` | an exception in board's own code; the transaction was rolled back | report it; nothing was changed | `reason` |

The one exception: arguments that do not fit a tool's input schema are refused
by `mcp_dart` before board runs, in the package's shape (text only, no
`structuredContent`). Each tool's description says so:
"A refusal without `structuredContent` means the arguments do not fit this
tool's schema; the text names the field."

### The MCP tools

Seventeen tools, `<thing>_<verb>`, so related tools sort together.

| Tool | Kind |
| --- | --- |
| `board_status`, `task_list`, `task_read`, `task_next`, `question_list` | read |
| `task_add`, `task_update`, `task_claim`, `task_extend`, `task_release`, `task_comment` | write |
| `question_ask`, `question_answer`, `question_validate` | write |
| `milestone_add`, `milestone_update`, `milestone_delete` | write |

Every tool can also answer `busy`, `storage`, `no_board`, `damaged`, `not_a_board`,
`schema_mismatch` and `internal`; every tool that resolves a project as in
"How a tool learns its project" can answer `no_project`, and `not_found`
with `what: project`. These are not repeated per tool. Input schemas below
omit `"type": "object", "additionalProperties": false` and the `$defs`, which
every one has.

Every tool that takes `project` says in its description: "`project`: the
project's key. Omitted: the project whose directory contains the server's
working directory, or its git repository's."

#### `board_status`

```json
// input
{ "properties": { "project": { "$ref": "#/$defs/ProjectKeyIn" } } }
// output
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
- `last_event` is the project's newest event id, for `task_read.since` and
  `board watch --since`; 0 when it has none.

Text: `BRD: milestone 2 of 5 (v1), 3 tasks left; 2 ready, 1 active, 1 blocked; 1 claim; 1 open question, 2 to validate`.

#### `task_list`

```json
// input
{ "properties": {
    "project": { "$ref": "#/$defs/ProjectScope" },
    "status": { "type": "array", "minItems": 1, "uniqueItems": true,
                "items": { "$ref": "#/$defs/Status" } },
    "parent": { "$ref": "#/$defs/KeyIn" },
    "milestone": { "$ref": "#/$defs/MilestoneRef" },
    "ready": { "type": "boolean" },
    "contains": { "type": "string", "minLength": 1, "maxLength": 200 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
    "offset": { "type": "integer", "minimum": 0 } } }
// output
{ "required": ["project", "tasks", "total", "next_offset"],
  "properties": {
    "project": { "oneOf": [{ "$ref": "#/$defs/ProjectKey" }, { "const": "*" }] },
    "tasks": { "type": "array", "items": { "$ref": "#/$defs/TaskSummary" } },
    "total": { "type": "integer", "minimum": 0 },
    "next_offset": { "type": ["integer", "null"], "minimum": 0 } } }
```

- `project` omitted: `parent`'s project if given, else the resolved one.
  `"*"`: every project; then `milestone` may only be `"none"`.
- `status` defaults to the open ones: `backlog`, `ready`, `active`,
  `blocked`. Filters are by effective status, so `["blocked"]` is "has an open
  question" and `["ready"]` includes tasks whose claim expired. `ready: true`
  keeps only tasks ready by the rule (status `ready`, no open question,
  nothing it waits for open), intersected with `status`.
- `milestone: "none"` is tasks in no milestone; `MilestoneName` matches
  `none` too, and the store refuses `none` as a name, so the two never meet.
- `contains` keeps tasks whose title or body contains the string as given:
  no character is special, and only ASCII letters are matched regardless of
  case.
- Newest first, by `task.id`, which also orders across projects under
  `"*"`. `limit` defaults to 50, `offset` to 0; `next_offset` is null
  on the last page; `total` counts every match.

Text: `3 tasks in BRD` / `3 tasks in BRD containing "lease"` / `50 of 120 tasks in every project; next_offset 50`.

#### `task_read`

```json
// input
{ "required": ["key"],
  "properties": { "key": { "$ref": "#/$defs/KeyIn" },
                  "since": { "type": "integer", "minimum": 0 } } }
// output
{ "required": ["task", "events", "cursor", "more"],
  "properties": {
    "task": { "$ref": "#/$defs/Task" },
    "events": { "type": "array", "maxItems": 200, "items": { "$ref": "#/$defs/Event" } },
    "cursor": { "type": "integer", "minimum": 0 },
    "more": { "type": "boolean" } } }
```

`events` are the task's events with `id > since` (default 0), oldest first, at
most 200. `cursor` is the id of the last event in the page, or `since` when
the page is empty; `more` says call again with `since: cursor`. The task's
fields are always whole, so the current state never needs a replay. The key
names the project; the working directory plays no part. Refusals:
`not_found`.

Text: `BRD-12 active, held by @lead until 2026-10-12T16:00:00.000Z; 2 events since 420`.

#### `task_next`

```json
// input
{ "properties": { "project": { "$ref": "#/$defs/ProjectKeyIn" },
                  "milestone": { "$ref": "#/$defs/MilestoneName" } } }
// output
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
`later`, or `milestone` when an explicit `milestone` was given, which
restricts the search to it with no fallback; `null` when `task` is null.
`milestone` is the current milestone's place, or the explicit one's; null
when there is none. `waiting` counts the open tasks in the searched scope
that are not ready, by reason.

`task_next` only reads: it claims nothing, two callers may get the same task,
and the second `task_claim` gets `claim_held`. Refusals: `not_found` for an
explicit milestone.

Text: `next in BRD: BRD-14 "Watch tool" (current milestone v1)`; `next in BRD: BRD-20 "Bump deps" (no milestone; v1 has nothing ready)`; `nothing ready in BRD: 1 blocked on a question, 1 active, 2 waiting on other tasks`.

#### `task_add`

```json
// input
{ "required": ["actor", "title"],
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "project": { "$ref": "#/$defs/ProjectKeyIn" },
    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
    "body": { "type": "string", "maxLength": 20000 },
    "priority": { "$ref": "#/$defs/Priority" },
    "parent": { "$ref": "#/$defs/KeyIn" },
    "milestone": { "$ref": "#/$defs/MilestoneRef" },
    "waits": { "type": "array", "uniqueItems": true, "maxItems": 50,
               "items": { "$ref": "#/$defs/KeyIn" } },
    "status": { "enum": ["backlog", "ready"] } } }
// output
{ "required": ["task", "events"],
  "properties": { "task": { "$ref": "#/$defs/Task" }, "events": { "$ref": "#/$defs/Events" } } }
```

- Project: `project`, else `parent`'s, else the resolved one. `project` and a
  `parent` of another project is `invalid_argument`; so is a `waits` key of
  another project.
- Defaults: `body` `""`, `priority` `normal`, `status` `ready`. No duplicate
  detection.
- `milestone` omitted: the parent's milestone if `parent` is given, else
  none. `"none"` puts it in no milestone explicitly. A name is the project's
  milestone.
- A done milestone takes the task and reopens: `milestone_reopened` is among
  the `events`.
- Refusals: `not_found` (parent, a wait, the milestone); `invalid_argument`
  (a title that is only whitespace, which the schema cannot refuse; another
  project's key). A new task cannot close a loop, so there is no `cycle` here.

Events: `task_added`, and `milestone_reopened` when it applies.
Text: `added BRD-17 "Claim error lacks the holder" (v1, under BRD-12, ready)`.

#### `task_update`

```json
// input
{ "required": ["actor", "key"], "minProperties": 3,
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "key": { "$ref": "#/$defs/KeyIn" },
    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
    "body": { "type": "string", "maxLength": 20000 },
    "priority": { "$ref": "#/$defs/Priority" },
    "status": { "enum": ["backlog", "ready", "done", "cancelled"] },
    "parent": { "oneOf": [{ "$ref": "#/$defs/KeyIn" }, { "type": "null" }] },
    "milestone": { "$ref": "#/$defs/MilestoneRef" },
    "waits_add": { "type": "array", "minItems": 1, "uniqueItems": true, "maxItems": 50,
                   "items": { "$ref": "#/$defs/KeyIn" } },
    "waits_remove": { "type": "array", "minItems": 1, "uniqueItems": true, "maxItems": 50,
                      "items": { "$ref": "#/$defs/KeyIn" } } } }
// output
{ "required": ["task", "changed", "events"],
  "properties": {
    "task": { "$ref": "#/$defs/Task" },
    "changed": { "type": "array", "uniqueItems": true, "items": { "enum": [
      "title", "body", "priority", "status", "parent", "milestone", "waits"] } },
    "events": { "$ref": "#/$defs/Events" } } }
```

- The key names the project; `parent`, `waits_add` and `milestone` are looked
  up in it, and a key of another project is `invalid_argument`. A task does
  not move between projects.
- `status` cannot be `active` (only `task_claim` makes a task active) or
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

#### `task_claim`

```json
// input
{ "required": ["actor", "key", "minutes"],
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "key": { "$ref": "#/$defs/KeyIn" },
    "minutes": { "$ref": "#/$defs/Minutes" },
    "holder": { "$ref": "#/$defs/Actor" },
    "directory": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "branch": { "type": "string", "minLength": 1, "maxLength": 255 } } }
// output
{ "required": ["claim", "task", "events"],
  "properties": { "claim": { "$ref": "#/$defs/Claim" },
                  "task": { "$ref": "#/$defs/TaskSummary" },
                  "events": { "$ref": "#/$defs/Events" } } }
```

- `minutes` has no default (owner decision 4). `holder` defaults to `actor`:
  main claims a task for the lead it starts by passing `holder: "@lead"`.
- The task must be ready; an expired claim on it is swept in the same
  transaction, so retaking a lapsed task is one call. The task becomes
  `active`.
- `directory` is informational, as in v1: it is not compared with the
  project's directory.
- Refusals: `not_found`; `claim_held` when a live claim exists, by anyone,
  the same holder included (`next`: `task_extend` if it is yours);
  `not_ready` with `reason` `status`, `question` or `waits`.

Events: `claimed` (plus any `claim_expired` the sweep writes).
Text: `BRD-14 claimed by @lead until 2026-10-12T15:33:00.000Z (90 min)`.

#### `task_extend`

```json
// input
{ "required": ["actor", "key", "holder", "minutes"],
  "properties": { "actor": { "$ref": "#/$defs/Actor" }, "key": { "$ref": "#/$defs/KeyIn" },
                  "holder": { "$ref": "#/$defs/Actor" }, "minutes": { "$ref": "#/$defs/Minutes" } } }
// output
{ "required": ["claim", "events"],
  "properties": { "claim": { "$ref": "#/$defs/Claim" }, "events": { "$ref": "#/$defs/Events" } } }
```

`until` becomes now plus `minutes`, not the old end plus `minutes`: the
claimer re-estimates from where it stands. `holder` is required and compared
with the live claim's: it is not a role check, it stops a caller acting on a
stale view. Anyone may call it. Refusals: `not_found`; `not_claimed` (no live
claim, or expired: it is claimed again, not extended); `claim_held` when
`holder` differs, with the current claim. Events: `claim_extended`.
Text: `BRD-14 held by @lead until 2026-10-12T16:40:00.000Z (60 min from now)`.

#### `task_release`

```json
// input
{ "required": ["actor", "key", "holder"],
  "properties": { "actor": { "$ref": "#/$defs/Actor" }, "key": { "$ref": "#/$defs/KeyIn" },
                  "holder": { "$ref": "#/$defs/Actor" },
                  "note": { "type": "string", "minLength": 1, "maxLength": 500 } } }
// output
{ "required": ["task", "released", "events"],
  "properties": { "task": { "$ref": "#/$defs/TaskSummary" },
                  "released": { "$ref": "#/$defs/Claim" },
                  "events": { "$ref": "#/$defs/Events" } } }
```

The task goes back to `ready`. `released` is the claim as it stood. `note`
goes into `claim_released.data.note`. Refusals as `task_extend`. To close and
release at once, `task_update status: done`. Events: `claim_released` with
reason `release`.
Text: `BRD-14 released by main (held by @lead since 2026-10-12T14:03:00.000Z)`.

#### `task_comment`

```json
// input
{ "required": ["actor", "key", "kind", "text"],
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" }, "key": { "$ref": "#/$defs/KeyIn" },
    "kind": { "enum": ["note", "handover"] },
    "text": { "type": "string", "minLength": 1, "maxLength": 10000 },
    "to": { "$ref": "#/$defs/Actor" },
    "changed": { "type": "string", "minLength": 1, "maxLength": 4000 },
    "ran": { "type": "string", "minLength": 1, "maxLength": 4000 },
    "unchecked": { "type": "string", "minLength": 1, "maxLength": 4000 } },
  "if": { "properties": { "kind": { "const": "handover" } } },
  "then": { "required": ["to", "changed", "ran", "unchecked"] },
  "else": { "not": { "anyOf": [{ "required": ["to"] }, { "required": ["changed"] },
                               { "required": ["ran"] }, { "required": ["unchecked"] }] } } }
// output
{ "required": ["event", "events"],
  "properties": { "event": { "$ref": "#/$defs/Event" }, "events": { "$ref": "#/$defs/Events" } } }
```

A handover's `text` is why and what is asked; `changed`, `ran` and
`unchecked` are what changed, what was run and what is not checked. A
handover is an event and nothing more: it moves no claim and changes no
status, and nothing in `text` is read. Comments on closed tasks are allowed.
Refusals: `not_found`. Events: `comment` or `handover`.
Text: `note on BRD-14` / `handover on BRD-14 from @lead to main`.

#### `question_ask`

```json
// input
{ "required": ["actor", "key", "text", "options", "recommended"],
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" }, "key": { "$ref": "#/$defs/KeyIn" },
    "text": { "type": "string", "minLength": 1, "maxLength": 2000 },
    "options": { "type": "array", "minItems": 2, "maxItems": 6, "items": {
      "type": "object", "additionalProperties": false, "required": ["label"],
      "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80 },
                      "detail": { "type": "string", "minLength": 1, "maxLength": 500 } } } },
    "recommended": { "type": "integer", "minimum": 1, "maximum": 6 } } }
// output
{ "required": ["question", "task", "events"],
  "properties": { "question": { "$ref": "#/$defs/Question" },
                  "task": { "$ref": "#/$defs/TaskSummary" },
                  "events": { "$ref": "#/$defs/Events" } } }
```

`recommended` is 1-based into `options`; past the end is `invalid_argument`.
The task becomes `blocked` until its last open question is answered or
withdrawn. Ids are `Q<n>`, one sequence per machine **[data]**. Refusals:
`not_found`; `invalid_transition` on a closed task. Events: `question_asked`.
Text: `Q7 asked on BRD-14; BRD-14 is blocked until it is answered`.

#### `question_answer`

```json
// input
{ "required": ["actor", "question", "as"],
  "anyOf": [{ "required": ["choice"] }, { "required": ["text"] }],
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "question": { "$ref": "#/$defs/QuestionIdIn" },
    "choice": { "type": "integer", "minimum": 1, "maximum": 6 },
    "text": { "type": "string", "minLength": 1, "maxLength": 2000 },
    "as": { "enum": ["owner", "delegate"] } } }
// output
{ "required": ["question", "task", "events"],
  "properties": { "question": { "$ref": "#/$defs/Question" },
                  "task": { "$ref": "#/$defs/TaskSummary" },
                  "events": { "$ref": "#/$defs/Events" } } }
```

- `as` has no default, so nobody records an owner's answer by leaving out an
  argument. `choice` past the options is `invalid_argument`.
- **The owner's override**: `as: owner` on a question answered
  `as: delegate` and not yet validated replaces the answer. The question then
  reads `answer.as: "owner"`, `validated: null`, and leaves the to-validate
  list; the `question_answered` event carries `overrides` with the previous
  answer.
- Otherwise an answered question is `already_answered` (an owner's answer, a
  validated delegate answer, or a delegate answering again); a withdrawn one
  is `invalid_transition`.

Events: `question_answered`. Text: `Q7 answered by main as delegate: up to 8 at once; BRD-14 unblocked; waits for the owner to validate` / `Q7: the owner's answer replaces the delegate's`.

#### `question_validate`

```json
// input
{ "required": ["actor", "question"],
  "properties": { "actor": { "$ref": "#/$defs/Actor" },
                  "question": { "$ref": "#/$defs/QuestionIdIn" } } }
// output
{ "required": ["question", "events"],
  "properties": { "question": { "$ref": "#/$defs/Question" }, "events": { "$ref": "#/$defs/Events" } } }
```

Marks a delegate's answer checked. For main to record the owner's approval
said in the chat window; `board validate` is the same from the terminal.
Refusals: `invalid_transition` for an open, withdrawn, owner-answered or
already validated question. Events: `question_validated`. Text: `Q7 validated`.

#### `question_list`

```json
// input
{ "properties": {
    "project": { "$ref": "#/$defs/ProjectScope" },
    "state": { "enum": ["open", "to_validate", "answered", "withdrawn", "all"] },
    "key": { "$ref": "#/$defs/KeyIn" } } }
// output
{ "required": ["project", "questions"],
  "properties": {
    "project": { "oneOf": [{ "$ref": "#/$defs/ProjectKey" }, { "const": "*" }] },
    "questions": { "type": "array", "items": { "$ref": "#/$defs/Question" } } } }
```

`project` omitted: `key`'s project if given, else the resolved one; `"*"`
for every project, so the owner sees everything to validate at once. `state`
defaults to `open`; `to_validate` is answered `as: delegate` and not
validated. Oldest asked first. Refusals: `not_found` for `key`;
`invalid_argument` for a `project` other than `key`'s.
Text: `2 questions to validate in BRD` / `5 questions to validate in every project`.

#### `milestone_add`

```json
// input
{ "required": ["actor", "name", "delivers"],
  "not": { "required": ["before", "after"] },
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "project": { "$ref": "#/$defs/ProjectKeyIn" },
    "name": { "$ref": "#/$defs/MilestoneName" },
    "delivers": { "type": "string", "minLength": 1, "maxLength": 500 },
    "before": { "$ref": "#/$defs/MilestoneName" },
    "after": { "$ref": "#/$defs/MilestoneName" } } }
// output
{ "required": ["project", "milestone", "chain", "events"],
  "properties": { "project": { "$ref": "#/$defs/ProjectKey" },
                  "milestone": { "$ref": "#/$defs/Milestone" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Goes last in the project's chain unless `before` or `after` names one of its
milestones. `name` is unique in the project, case-insensitively **[data]**;
`none` (any case) and a taken name are `invalid_argument`. A new milestone is
empty, so if it lands before the current one it becomes current, and
`task_next` falls through it. Refusals: `not_found` for `before`/`after`.
Events: `milestone_added`. Text: `BRD: milestone v2 added at 3 of 5`.

#### `milestone_update`

```json
// input
{ "required": ["actor", "milestone"],
  "anyOf": [{ "required": ["name"] }, { "required": ["delivers"] },
            { "required": ["before"] }, { "required": ["after"] }],
  "not": { "required": ["before", "after"] },
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "project": { "$ref": "#/$defs/ProjectKeyIn" },
    "milestone": { "$ref": "#/$defs/MilestoneName" },
    "name": { "$ref": "#/$defs/MilestoneName" },
    "delivers": { "type": "string", "minLength": 1, "maxLength": 500 },
    "before": { "$ref": "#/$defs/MilestoneName" },
    "after": { "$ref": "#/$defs/MilestoneName" } } }
// output
{ "required": ["project", "milestone", "chain", "changed", "events"],
  "properties": { "project": { "$ref": "#/$defs/ProjectKey" },
                  "milestone": { "$ref": "#/$defs/Milestone" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "changed": { "type": "array", "uniqueItems": true,
                               "items": { "enum": ["name", "delivers", "position"] } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Rename, re-describe, and move relative to another milestone of the same
project. v1's `minProperties: 3` becomes an `anyOf`, because with an optional
`project` three properties no longer mean "something to change". There is no
status field: a milestone is done when all its tasks are closed and reopens
when a task comes in. A move relative to itself, a taken name or `none` is
`invalid_argument`; `not_found` for the milestone or the anchor. No change:
`changed: []`, with `events` holding only sweep ids. Events: `milestone_edited` with `{field: {from,
to}}`, with `position` when moved. Text: `BRD: milestone v2 → v1.1, moved before v3`.

#### `milestone_delete`

```json
// input
{ "required": ["actor", "milestone"],
  "properties": { "actor": { "$ref": "#/$defs/Actor" },
                  "project": { "$ref": "#/$defs/ProjectKeyIn" },
                  "milestone": { "$ref": "#/$defs/MilestoneName" } } }
// output
{ "required": ["project", "deleted", "chain", "events"],
  "properties": { "project": { "$ref": "#/$defs/ProjectKey" },
                  "deleted": { "$ref": "#/$defs/MilestoneName" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Only an empty milestone; one with tasks, cancelled ones included, is
`invalid_transition` with `reason: "has_tasks"` and `next`: move its tasks
out with `task_update milestone: none` first. Later milestones of the project
shift up. Events: `milestone_deleted`. Text: `BRD: milestone v2 deleted; 4 left`.
