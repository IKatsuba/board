# Draft: interfaces, for board without MCP

The surface after `board mcp` goes: every operation of the seventeen tools as
a command an agent runs from its shell, the flags each input becomes, how long
text gets through a shell, what is printed, what a refusal looks like, where
the actor comes from, and the text `board skill` prints. It answers the
brief's interfaces questions 1–8 in order. Library tries are at the end of
each section that needed one, and summed up in section 9.

Everything was probed against `@cliffy/command` 1.3.1 (the version in
`package.json`) under Bun 1.4.3, in a scratch directory outside the
repository, importing the repository's installed copy. Nothing under `src/`,
`test/` or `tool/` was changed.

## 0. Four rules the surface follows

These came out of the probes and shape every command below.

1. **Free text is never a positional argument.** cliffy 1.3.1 hands an
   unknown flag to a positional argument that is still unfilled (it is
   deliberate, in `@jsr/cliffy__flags/flags.js`: "Check if value is a
   positional argument"). Measured: with `add <title:string>`, `board add
   --zzz` parses as the title `--zzz`, and `board add --tex x T` (a typo of
   `--text`) takes `--tex` as the title and then fails "Too many arguments:
   x T". A mistyped flag would become a task's title. A *typed* positional
   (a task key, a question id, a milestone name, an integer) refuses a
   `--…` token through its type, so positionals are kept for identifiers
   only, and every title, body and text is a flag. `board sql QUERY` is the
   one free-text positional, and stays (it is read-only and the hazard there
   is a failed query).
2. **A flag is named after its field, in kebab case**: `waits_add` is
   `--waits-add`, `recommended` is `--recommended`, and a refusal's
   `details.field` is the flag as typed (`waits-add`), section 5. data asked
   for this, and it is what an agent guesses.
3. **One command per input shape.** Where a tool's schema had an
   `if/then/else` or a `kind`, the CLI has two commands, so cliffy's own
   `required` says what each needs (note and handover, below).
4. **cliffy checks the shape, `Board` checks the rules.** No new parsing of
   ours: lists are cliffy list types, enums `EnumType`, ranges and lengths
   the existing `inRange` / `lengthIn` `value` hooks, exclusions `conflicts`
   and `depends`. What fits the command and breaks a rule is board's refusal,
   as now.

## 1. The command tree

**Flat verbs for tasks and questions, groups for projects and milestones.**
The read commands an agent already had a name for (`ls`, `show`, `next`,
`status`, `questions`, `answer`, `validate`) are flat today; the task and
question writes join them at the top level as verbs, so nothing that exists
is renamed. `project` and `milestone` stay groups, as they are.

Options weighed:

- (a) **Flat verbs** (picked): `board claim BRD-14 --minutes 90`. Shortest
  for an agent to type and to read back in a log; no existing command moves;
  the root help lists every verb an agent uses on one screen.
- (b) A `task` and a `question` group (`board task claim`, `board question
  ask`), as the brief suggests. It reads well, but it renames `ls`, `show`,
  `next`, `questions`, `answer` and `validate` (or keeps both spellings,
  which is two names for one thing), and `board help` reaches one level, so
  `board task help claim` is the help path. Nothing it adds is needed: tasks
  and questions are what the board is.
- (c) Tool names as commands (`board task_claim`). Mechanical, and
  un-shell-like; rejected.

`update` becomes **`edit`**, because the CLI already says `project edit` and
`milestone edit` for the same act. `task_comment` becomes **`comment`** and
**`handover`** (rule 3). `question_ask` becomes **`ask`**. `board mcp` goes.
`board skill` is new.

```
board project add KEY --actor NAME [--name NAME] [--dir DIR] [--json]
board project ls [--json]
board project edit KEY --actor NAME [--name NAME] [--dir DIR] [--json]
board project rm KEY --actor NAME [--json]

board status [-p KEY] [--json]
board ls [-p KEY | --all] [--status S,…] [--milestone NAME|none] [--parent KEY]
         [--ready] [--contains TEXT] [--limit N] [--offset N] [--json]
board show KEY [--since ID] [--json]
board next [-p KEY] [--milestone NAME] [--json]

board add --actor NAME --title TEXT [--body TEXT] [--priority P]
          [--status backlog|ready] [--parent KEY] [--milestone NAME|none]
          [--waits KEY,…] [-p KEY] [--json]
board edit KEY --actor NAME [--title TEXT] [--body TEXT | --no-body]
           [--priority P] [--status backlog|ready|done|cancelled]
           [--parent KEY | --no-parent] [--milestone NAME|none]
           [--waits-add KEY,…] [--waits-remove KEY,…] [--json]
board claim KEY --actor NAME --minutes N [--holder NAME]
            [--directory DIR] [--branch BRANCH] [--json]
board extend KEY --actor NAME --holder NAME --minutes N [--json]
board release KEY --actor NAME --holder NAME [--note TEXT] [--json]
board comment KEY --actor NAME --text TEXT [--json]
board handover KEY --actor NAME --to NAME --text TEXT --changed TEXT
               --ran TEXT --unchecked TEXT [--json]

board ask KEY --actor NAME --text TEXT --recommended N
          --option-1 LABEL [--detail-1 TEXT] --option-2 LABEL [--detail-2 TEXT]
          [--option-3 LABEL [--detail-3 TEXT]] … [--option-6 LABEL [--detail-6 TEXT]]
          [--json]
board questions [-p KEY | --all] [--state open|to_validate|answered|withdrawn|all]
                [--task KEY] [--json]
board answer QID [N] [--text TEXT] --as owner|delegate --actor NAME [--json]
board validate QID --actor NAME [--json]

board milestone [ls] [-p KEY] [--json]
board milestone add NAME --actor NAME --delivers TEXT [--before NAME | --after NAME]
                    [-p KEY] [--json]
board milestone edit NAME --actor NAME [--name NEW] [--delivers TEXT]
                     [--before NAME | --after NAME] [-p KEY] [--json]
board milestone rm NAME --actor NAME [-p KEY] [--json]

board watch [-f|--follow] [--since ID] [-p|--project KEY,…] [--kind K,…] [--task KEY,…]
            [--json] [--expiring-within MINUTES] [--exec CMD] [--exec-timeout SECONDS]
board sql QUERY [-p KEY] [--json]
board skill
board upgrade [--version VERSION] [-f] [-v] | -l
board help [COMMAND]
board COMMAND [SUBCOMMAND] --help
```

What stays exactly as it is: `project ls`, `status`, `ls`, `show`, `next`,
`questions`, `milestone [ls]`, `watch`, `sql`, `upgrade`, `help`. What
changes on an existing command: every write gains `--actor` and `--json`
(`project add/edit/rm`, `answer`, `validate`, `milestone add/edit/rm`), and
`answer` gains a required `--as` (section 6).

**Short flags.** Only those that exist: `-p` (project), `-f` (watch
`--follow`), and upgrade's `-f`, `-v`, `-l`. No new ones. An agent writes the
long form, the skill teaches the long form, and a log of `board claim BRD-14
--minutes 90 --actor @lead` reads without a legend; a short flag is one more
spelling to recognise, not one less to type.

**`-p` stays per command**, offered only where a project applies: `status`,
`ls`, `next`, `add`, `questions`, `milestone …`, `sql`, `watch`. Commands
that take a task key or a question id take no `-p` (the key names the
project, rule 1 of resolution). The pin goes with `board mcp` (section 6).

Mapping, tool → command:

| Tool | Command | Kind |
| --- | --- | --- |
| `board_status` | `board status` | read |
| `task_list` | `board ls` | read |
| `task_read` | `board show` | read |
| `task_next` | `board next` | read |
| `question_list` | `board questions` | read |
| `task_add` | `board add` | write |
| `task_update` | `board edit` | write |
| `task_claim` / `task_extend` / `task_release` | `board claim` / `extend` / `release` | write |
| `task_comment` (`note`) | `board comment` | write |
| `task_comment` (`handover`) | `board handover` | write |
| `question_ask` | `board ask` | write |
| `question_answer` / `question_validate` | `board answer` / `validate` | write |
| `milestone_add` / `_update` / `_delete` | `board milestone add` / `edit` / `rm` | write |

## 2. Every input, mapped

Lengths and ranges are data's table (`data.md` §2); the column "How" here is
the cliffy construct. "required" is cliffy's `required: true`.

### `board add` (`task_add`)

| Input | Flag | How |
| --- | --- | --- |
| `actor` | `--actor NAME` | section 6 |
| `project` | `-p, --project KEY` | `projectType` |
| `title` | `--title TEXT` | required, `lengthIn(1, 200)` |
| `body` | `--body TEXT` | `lengthIn(0, 20000)`; absent is `""` |
| `priority` | `--priority P` | `EnumType(urgent, high, normal, low)` |
| `parent` | `--parent KEY` | `keyType` |
| `milestone` | `--milestone NAME\|none` | `milestoneType`; `none` as now |
| `waits` | `--waits KEY,…` | `keyType[]`, `collect: true`, flattened `value` (as `ls --status`); count ≤ 50 in the `value` |
| `status` | `--status backlog\|ready` | `EnumType` of the two |

```
$ board add --actor @lead --title "Claim error lacks the holder" --parent BRD-12
added BRD-17 "Claim error lacks the holder" (v1, under BRD-12, ready)
```

### `board edit` (`task_update`)

| Input | Flag | How |
| --- | --- | --- |
| `key` | `KEY` | positional, `keyType` |
| `title` | `--title TEXT` | `lengthIn(1, 200)` |
| `body` | `--body TEXT`, `--no-body` | `--no-body` sets `""` (below) |
| `priority` | `--priority P` | `EnumType` |
| `status` | `--status S` | `EnumType(backlog, ready, done, cancelled)` |
| `parent` | `--parent KEY`, `--no-parent` | `--no-parent` is `null` |
| `milestone` | `--milestone NAME\|none` | `milestoneType` |
| `waits_add` | `--waits-add KEY,…` | as `--waits` |
| `waits_remove` | `--waits-remove KEY,…` | as `--waits` |

- **Clearing a parent** is `--no-parent`, cliffy's own negatable option:
  declaring `--parent <KEY>` and `--no-parent` gives `parent: false` for the
  second, and both on one line is cliffy's "Option `--parent` can only occur
  once" (measured). The action maps `false` to `null`. No sentinel word is
  parsed.
- **Clearing a body** needs the same, because cliffy drops an empty option
  value before any type runs (decision 27): `--body ""` parses as no
  `--body`, so `""` cannot be passed. `--no-body` gives `body: false`,
  mapped to `""`. Without it a body could never be emptied from the CLI. On
  `add`, an absent body is already `""`, so `add` has no `--no-body`.
- **`milestone: none`** stays the word `none`, any case, as in the tool and
  `ls` today: it is a value of the field, not a flag of ours.
- **Something to change** (`minProperties: 3`): no field flag given is a
  usage error in the action, `Nothing to change: give --title, --body,
  --no-body, --priority, --status, --parent, --no-parent, --milestone,
  --waits-add or --waits-remove.`, as `milestone edit` does today.
- The same key in `--waits-add` and `--waits-remove`, or the task's own key,
  stays `invalid_argument` from the rules (`field: waits-add`).

```
$ board edit BRD-17 --actor main --status ready --milestone v2
BRD-17: status backlog → ready, milestone v1 → v2
```

### `board claim`, `extend`, `release`

| Input | Flag | How |
| --- | --- | --- |
| `key` | `KEY` | positional, `keyType` |
| `minutes` (claim, extend) | `--minutes N` | required, `integer`, `inRange(1, 1440)` |
| `holder` (claim) | `--holder NAME` | optional; defaults to the actor, as now |
| `holder` (extend, release) | `--holder NAME` | required |
| `directory` (claim) | `--directory DIR` | `lengthIn(1, 1024)`; stored as given |
| `branch` (claim) | `--branch BRANCH` | `lengthIn(1, 255)` |
| `note` (release) | `--note TEXT` | `lengthIn(1, 500)` |

`--minutes` is a flag, not a second positional: `board claim BRD-14 90` would
read, but a bare number in a log says nothing, and the lease's size is the
one thing the design wants an agent to choose on purpose (decision 4).

`--directory` and `--branch` get **no default** from the process's cwd or
git. `main` claims for a lead from main's own directory; a default would
record main's checkout as the lead's, which is worse than nothing. The skill
shows passing `"$PWD"` and `"$(git branch --show-current)"` when the claimer
is the one who works there.

```
$ board claim BRD-14 --actor main --holder @lead --minutes 90 --directory /work/brd-wt --branch feat/watch
BRD-14 claimed by @lead until 2026-10-12T15:33:00.000Z (90 min)
$ board extend BRD-14 --actor @lead --holder @lead --minutes 60
BRD-14 held by @lead until 2026-10-12T16:40:00.000Z (60 min from now)
$ board release BRD-14 --actor main --holder @lead --note "run stopped"
BRD-14 released by main (held by @lead since 2026-10-12T14:03:00.000Z)
```

### `board comment` and `board handover` (`task_comment`)

`kind` is the command. `comment` has `--text` only; `handover` has `--to`,
`--text`, `--changed`, `--ran`, `--unchecked`, all `required: true`. The
schema's `if/then/else` becomes two option lists cliffy checks: a handover
missing `--ran` is "Missing required option `--ran`", and a note with `--to`
is "Unknown option `--to`" (rule 3). Both call `board.taskComment` with
`kind` set.

| Input | Flag | How |
| --- | --- | --- |
| `text` | `--text TEXT` | required, `lengthIn(1, 10000)` |
| `to` | `--to NAME` | required on `handover`; the actor type |
| `changed`, `ran`, `unchecked` | `--changed`, `--ran`, `--unchecked TEXT` | required on `handover`, `lengthIn(1, 4000)` |

```
$ board comment BRD-14 --actor @tester --text 'The flaky test is the 500 ms tick, not the drain.'
note on BRD-14
$ board handover BRD-14 --actor @lead --to main --text "$(cat <<'EOF'
Ready for review: watch derives claim_expiring.
EOF
)" --changed 'src/watch/derive.ts, test/watch.test.ts' --ran 'bun run check' --unchecked 'x64 binary'
handover on BRD-14 from @lead to main
```

### `board ask` (`question_ask`)

Options are **numbered flags**: `--option-1` … `--option-6` for labels and
`--detail-1` … `--detail-6` for the optional details. `--option-1` and
`--option-2` are `required: true`; `--option-N` `depends` on
`--option-(N-1)`; `--detail-N` `depends` on `--option-N`. Every constraint is
cliffy's, checked at parse (measured: a missing `--option-2`, a
`--option-4` without `--option-3`, a `--detail-3` without `--option-3` and a
repeated `--option-1` are each a `ValidationError` naming the flag; a detail
starting with `-` is taken as a value). The action builds `options` in
number order.

Options weighed, each probed:

- **`--option <label> [detail]`, two arguments, `collect: true`**: cliffy's
  multi-argument option. Broken for this: three `--option`s parsed to
  `[["Up to 8","Bounded memory"], "Unbounded", true]`, a detail starting with
  `-` is "Unknown option", and an empty detail threw `TypeError: JSON.stringify
  cannot serialize cyclic structures` from cliffy's value. Rejected.
- **`--option LABEL` repeated, `--detail TEXT` repeated, paired by order**:
  details are optional, so pairing needs a placeholder for "none", and an
  empty value is dropped by cliffy (decision 27). Rejected.
- **`--option "LABEL: detail"`** or any delimiter: a parser of ours, and a
  label that holds the delimiter is ambiguous. Rejected (data's ask 2).
- **`--options JSON`**: a JSON parser plus a validator for one flag, which
  brings Ajv (or a hand check) into the binary. Rejected (data's ask 1).
- **Numbered flags** (picked): wordy in `--help` (twelve lines), but the
  limit of six is the design's own, every check is cliffy's, and an agent
  writing `--option-2 Unbounded --detail-2 'No cap'` cannot pair them wrong.

| Input | Flag | How |
| --- | --- | --- |
| `key` | `KEY` | positional, `keyType` |
| `text` | `--text TEXT` | required, `lengthIn(1, 2000)` |
| `options[n].label` | `--option-N LABEL` | 1 and 2 required; `depends` on N−1; `lengthIn(1, 80)` |
| `options[n].detail` | `--detail-N TEXT` | `depends` on `--option-N`; `lengthIn(1, 500)` |
| `recommended` | `--recommended N` | required, `inRange(1, 6)`; past the options stays `invalid_argument` |

```
$ board ask BRD-14 --actor @lead --text 'How many runs may hold claims at once?' \
    --option-1 'Up to 8' --detail-1 'Memory stays bounded' \
    --option-2 'Unbounded' --recommended 1
Q7 asked on BRD-14; BRD-14 is blocked until it is answered
```

### `board answer`, `validate`, `questions`

| Input | Flag | How |
| --- | --- | --- |
| `question` | `QID` | positional, `questionType` |
| `choice` | `N` | optional positional `integer`, `inRange(1, 6)` (exists) |
| `text` | `--text TEXT` | `lengthIn(1, 2000)` (exists) |
| `as` | `--as owner\|delegate` | **required**, `EnumType` (new) |
| `anyOf choice, text` | — | the action's check (exists) |

`question_list`: `-p` / `--all` (`"*"`), `--state`, `--task` (`key`), all as
today.

### Reads

As today: `status` (`-p`), `ls` (`-p`/`--all`, `--status`, `--milestone`,
`--parent`, `--ready`, `--contains`, `--limit`, `--offset`), `show KEY
[--since ID]`, `next` (`-p`, `--milestone`), `questions`.

**Paging.** `board ls --limit N --offset N`: the human note on stderr ends
`; next page: --offset 50` when `next_offset` is not null; `--json` has
`next_offset` and `total`. `board show KEY --since ID`: at most 200 events;
when `more` is true the note ends `; more: board show BRD-14 --since 842`;
`--json` has `cursor` and `more`. The `since` an agent keeps is a write's last
`events` id, `status --json`'s `last_event`, or `show`'s `cursor`.

### Milestones and projects

As today plus `--actor` and `--json`: `milestone add NAME --delivers TEXT
[--before | --after] [-p]`, `milestone edit NAME [--name NEW] [--delivers]
[--before | --after] [-p]`, `milestone rm NAME [-p]`; `project add KEY
[--name] [--dir]`, `project edit KEY [--name] [--dir]`, `project rm KEY`.
`project …` takes `--actor` like every write, as data proposes (`data.md` §3);
the skill tells agents never to run it (decision 17: the key is the
person's).

## 3. Long text through a shell

### Recommendation: the shell carries it; board reads no stdin and no files

Every text is a flag value. Inline for one line in single quotes; for
anything with a newline, a quote, `$` or a backtick, a quoted heredoc in a
command substitution:

```sh
board comment BRD-14 --actor @lead --text "$(cat <<'EOF'
Anything goes here: 'quotes', "quotes", $HOME, `ticks`, \backslashes.
Nothing is expanded, because the delimiter is quoted.
EOF
)"
```

Why this and not a reading mechanism of board's own:

- It works with what exists: the shell is the library, cliffy takes the
  value as is (probed: a value with newlines, a value starting with `-`, and
  `--text=-x` all arrive unchanged). board adds no stdin reader, no file
  reader and no rule for which flag owns stdin.
- It covers every field the same way, including the four of a handover and
  the six labels of a question, which a single stdin cannot.
- The limits fit: the longest field is 20,000 code points (at most 80 KB of
  UTF-8), and macOS's `ARG_MAX` is 1 MiB for the whole command line and
  environment.
- `$(…)` removes **every** trailing newline, which covers the one a heredoc
  adds; nothing else is touched. An agent never has to think about the last
  `\n` (the price is a limit, below).
- Coding agents already use exactly this for `git commit -m "$(cat <<'EOF'
  …)"`; it is the most practised form there is.

What the skill teaches (section 7): single quotes for one line without `'`;
the quoted heredoc for everything else; never double quotes around text an
agent did not write itself (`$` and backticks expand inside them); the
delimiter line must not occur in the text (pick another word if it does).

Edge cases, all cliffy's or the shell's, none board's:

| Case | What happens |
| --- | --- |
| `--text ''` (empty) | cliffy drops it (decision 27): for a required flag, "Missing required option `--text`", exit 64; for `--body` on `edit`, no change (use `--no-body`) |
| text that is only whitespace | passes the parse; `title` refuses it in the rules (`invalid_argument`), other fields keep it, as the tools did |
| the heredoc's trailing newline | removed by `$(…)`, with every other trailing newline |
| text starting with `-` | taken as the value (measured) |
| a NUL byte | cannot be in an argument (C strings) |
| stdin | never read: a TTY, `/dev/null` or a closed stdin change nothing, so no command can hang waiting for input |

**Two limits the CLI adds**, which the tools did not have, accepted with
this recommendation and stated in `docs/design.md` when merged:

- **No NUL in any text.** JSON could carry `\u0000` to a tool; an `argv`
  element cannot hold one. The store never needed one; a text with NUL
  cannot be written through the CLI at all.
- **A text sent through `"$(…)"` cannot end in a newline.** Command
  substitution strips all of them. A trailing newline is still possible
  inline (`--text $'line\n'` in bash and zsh), but the skill does not teach
  it: nothing in the board reads one.

### Alternatives, for the owner if the recommendation is not taken

- **(B) `--body-file PATH` and `--text-file PATH`, with `-` for stdin**, on
  `add`, `edit`, `comment`, `handover` and `ask` (only the two largest
  fields; each `conflicts` with its inline twin; two `-` on one line is a
  usage error). Tried: `Bun.stdin.text()` (Bun 1.4.3, runtime API, no
  package) reads a pipe whole, returns `""` for `/dev/null` and for a closed
  stdin, and blocks on a TTY; `get-stdin` 10.0.0 (sindresorhus, MIT) does the
  same and returns `""` on a TTY instead of blocking, and runs inside a
  `bun build --compile` binary (measured: piped `x\n` read, `/dev/null` gave
  `""`). If (B) is taken: `Bun.stdin.text()` behind a check of
  `process.stdin.isTTY` that refuses a terminal as a usage error (`--text-file
  -: stdin is a terminal; pipe the text in`), since `get-stdin`'s `""` on a
  TTY would surface as a misleading "empty" error; one trailing `\n` (or
  `\r\n`) removed, matching what a heredoc adds; empty after that is a
  usage error for a field with a minimum of 1 (data's rule). Cost: a second
  path per field, stdin's lifecycle for runtime to own, and a `-` that means
  "stdin" only for those flags.
- **(C) A whole input object as JSON on stdin** (`board ask BRD-14 --input -`),
  validated against Appendix B's input schemas. It needs Ajv (or another
  validator) at run time in the binary, keeps the input schemas alive as a
  second contract next to the flags, and needs a rule for flags and JSON
  given together. data asks for no JSON input (`data.md` §1). Rejected.
- `@file` (curl-style) on any text flag: a text that starts with `@` would be
  read as a path, which is guessing at ambiguous input. Rejected.

## 4. Output

- **stdout carries the answer; stderr carries notes and errors.** Unchanged
  in spirit, with one change: **a write's one line goes to stdout**, not
  stderr as `answer`, `validate` and `milestone add/edit/rm` print it today.
  For a write the line is the answer: `added BRD-17 …`, `Q7 asked …`. An
  agent reading only stdout, or a script doing `$(board add …)`, gets it.
- **`--json` on a board operation** (`status`, `ls`, `show`, `next`,
  `questions`, every task, question and milestone write, `project
  add/edit/rm/ls`) prints **one JSON object** on stdout, one line, nothing
  else on stdout: the old tool's `structuredContent` where there was a tool.
  Shape changes: none for the tools' outputs (data's §1 keeps Appendix B's
  output schemas as the contract). Writes that had no `--json` get it:
  `answer`, `validate`, `milestone add/edit/rm` (each the tool's output),
  `project rm` (the removed `Project`). `project ls --json` stays the
  CLI-only object.
- **The exceptions, as built:** `milestone [ls] --json` prints a
  `Milestone[]` **array**; `sql --json` prints an **array** of row objects;
  `watch --json` prints **one object per line**, as a stream; `skill`,
  `help` and `upgrade` have **no `--json`**.
- **Human form**: one line for a write (the tool's text line, as in
  Appendix B); a borderless `@cliffy/table` for a list (`ls`, `questions`,
  `milestone ls`, `project ls`, `sql`) with the count note on stderr;
  `status` and `show` as today; `next` a one-row table and the reason on
  stderr. Control characters shown, not sent (decision 28), in human output
  only.
- `board skill` prints its text on stdout, plain, no colour, no `--json`.

## 5. Errors an agent acts on

### Three outcomes, by exit code

| Exit | What | stdout | stderr |
| --- | --- | --- | --- |
| 0 | done | the answer | notes |
| 1 | refused by board (one of the 17 codes + `registry`) | nothing | the error line, or under `--json` the error object |
| 64 | usage: the command line does not fit the command (cliffy's `ValidationError`, or an action's shape check) | nothing | `board: usage: <cliffy's message>` |

A refusal (exit 1) did not make the change it was asked for, but a write
refused after its lock **still commits the machine-wide expiry sweep**
(decision 5): `claim_expired` lines for other claims may have been logged.
`internal` is weaker still: the failure may come after the commit (writing
the answer, closing the connection), so it promises nothing about the
change; read before retrying. A usage error from cliffy or an action's
shape check comes before the board is opened: board wrote nothing.

The exceptions, as built and kept:

- **`board sql`**: a query that fails as SQL prints SQLite's own message,
  exit 1, with no code and no error object; a write it refuses is exit 64
  **after** opening the board read-only (decision 16), so 64 there is not a
  parse error, and `VACUUM INTO '<path>'` leaves an empty file at `<path>`
  (decision 16's second loss).
- **`board upgrade`** keeps cliffy's own exits and codes (decision 36);
  `registry` is its one board code.
- **130 / 143**: any command ended by `SIGINT` / `SIGTERM` (runtime: the
  shim re-raises its child's signal). A write ended that way may or may not
  have committed.

**One exit code for every refusal**, with the code in the output. Options:

- (a) **1 for all, the code in the text and the JSON** (picked). An agent
  reads a word, not a number table; a shell script uses `--json`.
- (b) One exit code per class (e.g. 75 `EX_TEMPFAIL` for `busy`, 69 for
  `no_board`, 65 for the rule refusals). Lets a shell loop retry `busy`
  without JSON, but sysexits has no slot for most codes, two codes share a
  number either way, and an agent would have to learn a mapping that lives
  nowhere but the docs. Not needed: `busy` is rare (decision 11's
  measurements) and the skill says to retry it.

### The human error line carries the code

Today: `board: <message> <next>`. Proposed: **`board: <code>: <message>
<next>`**, so an agent that did not pass `--json` still branches on a fixed
token in a fixed place:

```
$ board claim BRD-14 --actor @dev --minutes 60
board: claim_held: BRD-14 is held by @lead until 2026-10-12T15:33:00.000Z. Wait for it, or `board extend` it if the claim is yours.
$ echo $?
1
```

Under `--json`, the error object on stderr, unchanged:

```json
{"error":{"code":"claim_held","message":"BRD-14 is held by @lead until 2026-10-12T15:33:00.000Z.","next":"Wait for it, or `board extend` it if the claim is yours.","details":{"claim":{"key":"BRD-14","title":"Watch tool","holder":"@lead","since":"2026-10-12T14:03:00.000Z","until":"2026-10-12T15:33:00.000Z","minutes_left":47,"directory":null,"branch":null}}}}
```

### Usage errors

cliffy's `ValidationError` takes the place of the SDK's `Input validation
error`: same role (the input does not fit), and now its own exit code. The
line is prefixed **`board: usage:`** so the class is visible in prose as
well; this formats our output, it does not touch cliffy's input or message:

```
$ board claim BRD-14 --actor @dev
board: usage: Missing required option "--minutes".
$ echo $?
64
```

- **Never JSON**, even with `--json`: cliffy fails before the options are
  known, and finding `--json` in the raw argv ourselves would be parsing of
  ours. An agent tells usage from refusal by the exit code (64 vs 1) or the
  `usage:` token. No `usage` code is added to the error enum (data agrees).
- **Never the help**: as now. The skill says `board COMMAND --help` is the
  way to see a command's flags.
- cliffy names the flag for missing, unknown, conflicting, depending and
  repeated options and for type and `value` failures (all measured above or
  already in the CLI). Unlike the SDK's `not` / `else`, nothing here is
  refused without a name, because the shapes that needed those keywords are
  now separate commands or cliffy constraints.

### `next` must name commands, not tools

Every refusal's `next` that names a tool must name the command instead. This
is a text change in `src/rules/` and `src/board.ts` (strings only; no rule
changes), which the lead should hand to whoever owns the code change. The
ones found:

| Where | Now | Becomes |
| --- | --- | --- |
| `rules/claims.ts` `not_claimed` | `` `task_claim` to take it. `` | `` `board claim KEY --minutes N` to take it. `` |
| `rules/claims.ts` `claim_held` | `` Wait for it, or `task_extend` it if the claim is yours. `` | `` Wait for it, or `board extend` it if the claim is yours. `` |
| `rules/claims.ts` `not_ready` (three) | `` `task_read` lists both / them ``; `` `task_update` its status to ready first `` | `` `board show KEY` lists …``; `` `board edit KEY --status ready` first `` |
| `rules/claims.ts` holder mismatch | `` Re-read the claim with `task_read`; pass the holder it names. `` | `` Re-read the claim with `board show KEY`; pass the holder it names as `--holder`. `` |
| `rules/tasks.ts` `not_found` | `` `task_list` finds tasks ``; `` `board_status` lists the milestones `` | `` `board ls --contains TEXT` finds tasks ``; `` `board milestone ls` lists the milestones `` |
| `rules/questions.ts` (three) | `` `question_list` ``, `` Reopen it with task_update first `` | `` `board questions` ``, `` `board questions --state to_validate` ``, `` Reopen it with `board edit KEY --status ready` first `` |
| `rules/chain.ts` `has_tasks` | `` Move its tasks out with task_update milestone: none first. `` | `` Move its tasks out with `board edit KEY --milestone none` first. `` |
| `rules/projects.ts` `no_project` | `` Pass `project` with one of the keys above `` | `` Pass `-p KEY` with one of the keys above `` |
| actor `board` (data's §3) | — | `` Pass `--actor` with your own name. `` |
| `board sql`'s refusal text | names `task_update, task_claim, question_answer` | names `board edit, board claim, board answer` |

A test that no `next` string contains `task_`, `question_`, `milestone_` or
`board_status` keeps them from coming back.

### `details.field` names the flag as typed

Settled with the lead: **`details.field` is the spelling the agent typed**,
not the old input name. A flag is its long name without the dashes
(`waits-add`, `waits-remove`, `holder`, `dir`); a positional argument is its
synopsis name in upper case (`KEY`, `QID`, `N`, `NAME`), so the two cannot be
mistaken for each other. The messages and `next` texts that quote a field
use the same spelling with dashes (`` Use a task of BRD in `--waits-add`. ``,
`` Give `N` or `--text`. ``, `` Pass `-p` with the milestone's project. ``).

Options were (a) keep the snake-case input name and have the skill teach
the mapping, or (b) the flag (picked). With the CLI the only interface, (a)
names something the agent never typed, and the mapping is not even
mechanical in two places: `project add/edit` take `--dir` for the field
`directory`, and `answer` takes the positional `N` for `choice`.

Where it is done: in `rules/` and `board.ts`, where `invalid(field, …)`,
`relatedTask(…, field)` and the cycle and conflict checks already pass the
string. Only those strings change; `Board`'s input objects keep their
snake-case property names (`waits_add`), since they are TypeScript, not
surface. The values that change:

| Now | Becomes | From |
| --- | --- | --- |
| `waits_add`, `waits_remove` | `waits-add`, `waits-remove` | `edit` |
| `waits` | `waits` | `add` (unchanged) |
| `directory` | `dir` | `project add/edit`'s `--dir` (`project_exists` too) |
| `directory` | `directory` | `claim`'s `--directory` (unchanged: the flag is spelt in full there) |
| `key` | `KEY` | `project add/edit` (`project_exists`) |
| `choice` | `N` | `answer` |
| `project` | `project` | `-p, --project` (unchanged) |
| `parent`, `milestone`, `name`, `before`, `after`, `title`, `recommended`, `to`, `changed`, `ran`, `unchecked`, `actor`, `holder` | unchanged | already the flag's name |

What it breaks: nothing at run time. The error schema types `field` as a
plain string, and nothing in `src/` reads it back (checked: `watch`'s
`derive` reads event `data` fields, a different thing). The tests that
expect `field: "waits_add"` or `"directory"` change with it. One coupling is
accepted: `rules/` now speaks the CLI's vocabulary, which "rules know
nothing of cliffy" did not forbid (no cliffy import), and there is no second
interface left to speak another. Event `data` keeps its snake-case keys: it
is the log's catalog, not input.

## 6. actor and the pin

### The actor — **Owner**

The facts that decide it:

- **An environment is inherited, and chord's agents share one.** chord is a
  process the person starts from a shell; every agent session it starts, and
  every shell those sessions run, inherits that environment. A
  `BOARD_ACTOR` set in the person's profile (`export BOARD_ACTOR=owner`, as
  data's option (a) suggests for the person) reaches every agent, and an
  agent that forgets `--actor` writes as the owner, silently: the exact
  failure decision 14's "no default for `as`" exists to stop. chord cannot
  set a different variable per agent without a change to chord, a non-goal
  (runtime confirmed).
- **Agent shells do not keep exports.** An agent's shell tool runs each
  command in a fresh shell (runtime measured it under chord: an `export`
  does not reach the next call), so "set `BOARD_ACTOR` once per session" is not something
  an agent can do itself; it would retype it per command, which is `--actor`
  with worse spelling.
- **`BOARD_ACTOR` and `BOARD_PROJECT` are already taken**: `watch --exec`
  sets them in its child's environment to the *event's* actor and project
  (`src/watch/exec.ts`). If board also read them, a notifier that calls
  `board comment …` would write as whoever caused the event. Choosing the
  environment means renaming those to `BOARD_EVENT_ACTOR` /
  `BOARD_EVENT_PROJECT` first.
- cliffy 1.3.1's `.env("BOARD_ACTOR=…", { prefix: "BOARD_" })` maps the
  variable onto `--actor`, the flag winning and an empty value reading as
  unset (measured by data and by me); but `required: true` on it demands the
  variable even when `--actor` is given (data), so "one of the two required"
  is a check in the action, a `ValidationError` (64).

Options:

- **(a) `--actor NAME` required on every write; no environment variable; no
  default** (recommended). Missing is cliffy's own `required: true`:
  `board: usage: Missing required option "--actor".`, exit 64. Every name in
  the log was typed by the one who acted, in the command itself, where it
  shows in the agent's transcript. The person types `--actor owner` (or
  keeps a shell alias for it). No inheritance, no collision, no action
  check.
- (b) `BOARD_ACTOR` only, set once per session. Fails on the two first
  facts: shared by every agent of a chord, not settable by an agent's shell
  tool.
- (c) Both, the flag winning, one required (data's surface). Convenient for
  the person and for scripts; carries the inheritance hazard whenever the
  variable is set anywhere above an agent, and needs the exec rename and an
  action check. If the owner prefers it, the skill must still teach
  `--actor` on every command and say that an inherited `BOARD_ACTOR` is not
  the agent's name.
- (d) Missing means `owner`, as the CLI does today. An agent's forgotten
  flag is recorded as the person. Rejected by data and by me.

**Recommendation: (a).** It costs a dozen characters per write and makes the
wrong answer impossible rather than unlikely.

`board answer` gets **`--as owner|delegate` required**, no default, as data
proposes: when `main` answers through the CLI, the default `owner` the
command has today would record main's answer as the owner's. The person's
own answer becomes `board answer Q7 2 --as owner --actor owner`. Longer than
today, and honest; the README shows it.

### The project

`board mcp --project KEY` (the pin) goes with `board mcp`. Recommendation:
**`-p KEY` only, no `BOARD_PROJECT`.**

- Each agent's shell runs in its own working directory (its worktree, for a
  team run), and resolution from the cwd and git (decision 24) finds the
  project per call, exactly as a server found it from its start directory.
  The pin existed for MCP clients that start servers somewhere else; a shell
  command runs where the agent is.
- An agent working outside the repository passes `-p KEY`.
- `BOARD_PROJECT` has the same two problems as `BOARD_ACTOR` (inherited by
  everything below; already set by `watch --exec` to the event's project).
- Resolution order becomes: key or question id → `-p` → the cwd → git →
  `no_project`. The `no_project` text says `-p` instead of `project`.

If the owner wants a pin back, cliffy's `.env("BOARD_PROJECT=<KEY:project>")`
does it with the flag winning and the type checking the variable (measured:
a malformed value is `Environment variable "BOARD_PROJECT" must be …`, a
`ValidationError`, even when `-p` is given, which is cliffy's choice to
accept), after renaming `watch --exec`'s variable.

## 7. `board skill`

### What it is and how it stays true

`board skill` prints one text on stdout and exits 0; it stores nothing and
opens no board (it works before `board project add`). No argument: the text
is short enough to read whole (about 220 lines), every role needs the model
and the errors, and a role argument would be one more thing to get wrong
when a lead starts acting as main. No `--json`.

Two parts, following `../quarry/src/guide.ts`'s split:

1. **Prose, typed** (`src/skill.ts`): the model, the flows, quoting, and what
   to do per error code. Nobody can generate it.
2. **The command index, generated** from the cliffy tree: one line per leaf
   command with the description its `Command` already carries
   (`getCommands()` walked from `buildCli`'s root, as quarry walks its tree),
   so a description corrected in `src/cli/` is corrected here. `help`,
   `upgrade` and `skill` itself are left out of the index.

Three tests keep it in step:

- **Every command line in the prose parses.** Each fenced line starting
  `board ` is split with a shell-word splitter and parsed against a tree built
  with every action replaced by a no-op (cliffy's `.action()` overridden per
  leaf in the test's own build, or the `Deps` stubbed so the actions never
  open a board); a line that fails parse fails the test. This checks command
  names, flag names, required flags and types at once, which a name-only
  check would not. If no maintained shell-word splitter fits (to try:
  `shell-quote` 1.8, `string-argv` 0.3), the fallback is the weaker check
  quarry has: every `board <path>` exists in the tree and every `--flag`
  after it is an option of that command.
- **Every error code is in the prose's error table**: the enum from
  `src/schemas.ts` against the table's first column, so a new code fails
  until its advice is written.
- **The index names only existing commands** (it is generated, so this is
  the generator's test).

### The text

The index at the end is shown as the generator would print it from the
descriptions this draft proposes.

````markdown
# Working on a board

board is the task board your team shares. It is one SQLite file on this
machine with every project's tasks in it, and you read and write it by running
`board` in your shell. It is memory and rules, not an engine: nothing runs
because of the board. `main`, the session in front of the person, decides
what happens next; leads and members do the work and write down what they did.

## The model in a paragraph

A project is one repository, with a key such as `BRD`; its tasks are `BRD-1`,
`BRD-2`, …. A task has a status: `backlog`, `ready`, `active` (someone holds
it), `done`, `cancelled`, and `blocked`, which nobody sets: a task is blocked
while a question on it is open. A task is *ready* when its status is `ready`,
no question on it is open, and every task it waits for is done or cancelled.
To work on a task you **claim** it for a number of minutes you choose; the
claim is a lease that ends on its own unless you **extend** it, and when it
ends the task is ready for someone else. Milestones are an ordered chain per
project; the earliest open one is *current*, and `board next` prefers it.
Every write is an event with an id, and the log is the task's story.

## Before anything

- **Every write takes `--actor` with your own name** (`main`, `@lead`,
  `@tester`: the name your team uses for you). There is no default, and no
  variable sets it for you. Never write as `owner`: that name is the person.
  `board` is reserved.
- **The project comes from your working directory** (or its git repository,
  worktrees included). Outside it, pass `-p KEY`. A task key or a question id
  names its own project, so `board show APP-3` works from anywhere.
- If board says `no_project`, do not pick a key and do not run
  `board project add`: the key is the person's choice. Tell whoever you
  report to.
- `board COMMAND --help` shows every flag of a command. Add `--json` to
  `status`, `ls`, `show`, `next`, `questions` or any write for its exact
  answer as one JSON object on stdout. Elsewhere it differs:
  `milestone ls --json` and `sql --json` print an array, `watch --json` one
  object per line; `skill`, `help` and `upgrade` take no `--json`.

## Passing text

Every title, body, comment and answer is a flag value. For one line without a
single quote, use single quotes:

```sh
board comment BRD-14 --actor @lead --text 'Tests pass on arm64.'
```

For anything longer, or with quotes, `$`, backticks or backslashes, use a
quoted heredoc inside `"$(…)"`. Nothing inside it is expanded:

```sh
board add --actor @lead --parent BRD-12 --title 'Claim error lacks the holder' --body "$(cat <<'EOF'
`board extend` on a lapsed claim says not_claimed but not who held it.
Seen in test/claims.test.ts.
EOF
)"
```

Never put text you did not write yourself inside plain double quotes. An empty
value (`--text ''`) counts as not given. To empty a body, use
`board edit KEY --actor NAME --no-body`.

## Main: choosing and handing out work

```sh
board status                              # the project, the current milestone, live claims, questions
board next                                # the ready task to start next, and why nothing is ready
board claim BRD-14 --actor main --holder @lead --minutes 90 --directory /work/brd-wt --branch feat/watch
```

Claim **for** the lead you start: `--holder` is the lead's name, `--actor` is
yours. Size `--minutes` from the team's estimate (1 to 1440); there is no
default. Then start the team with the key in its job. When the lead reports:

```sh
board show BRD-14                         # the task, its claim, its questions, its events
board edit BRD-14 --actor main --status done      # close it; this drops the claim
board edit BRD-14 --actor main --status ready     # or send it back; this drops the claim too
```

`done` is refused while a question is open. `cancelled` withdraws open
questions. Only you close tasks: a lead reports, main decides.

To plan: `board add --actor main --title '…' --milestone v2` files work, with
`--status backlog` for work not to start yet; `board milestone add v2 --actor main
--delivers '…'` extends the chain. A dead run's task is freed with
`board release BRD-14 --actor main --holder @lead`, passing the holder that
`board show` names.

When the person has handed decisions to you, answer a question as a
delegate; the person validates it later:

```sh
board questions --state open --all
board answer Q7 1 --as delegate --actor main --text 'Up to 8, as recommended.'
board validate Q7 --actor main              # only when the person approved it in the chat
```

Answer `--as owner` only with the person's own words, and
`--actor main` still: the actor is who typed it, `--as` is whose decision it
is.

## A lead: running the task

```sh
board show BRD-14                          # read it whole before starting
board extend BRD-14 --actor @lead --holder @lead --minutes 60   # when you need more time
```

An extend sets the end to now plus the minutes you give: a fresh estimate from
where you stand. Extend **before** the claim ends; a claim that has ended is
not revived, and you must claim the task again (it may have been given to
someone else in between). Nothing else you do renews the claim.

- **Findings**: look first, then file under your task. A finding filed with
  `--parent` lands in your task's project and milestone.

  ```sh
  board ls --contains 'holder' --status backlog,ready,active,blocked,done
  board add --actor @lead --parent BRD-14 --title 'Extend error lacks the holder'
  ```

- **Notes** for whoever reads the task next: `board comment KEY --actor NAME
  --text '…'`.
- **A choice that is the owner's**: ask, with 2 to 6 options and the one you
  recommend. The task is blocked until it is answered.

  ```sh
  board ask BRD-14 --actor @lead --text 'How many runs may hold claims at once?' \
    --option-1 'Up to 8' --detail-1 'Memory stays bounded' \
    --option-2 'Unbounded' --recommended 1
  ```

- **Handing over** when you are done, to `main` (or to whoever you report
  to). All five parts are required: why and what you ask, what changed, what
  you ran, and what you did not check.

  ```sh
  board handover BRD-14 --actor @lead --to main --text 'Ready for review.' \
    --changed 'src/watch/derive.ts, test/watch.test.ts' \
    --ran 'bun run check' --unchecked 'the x64 binary'
  ```

  A handover is a record, nothing more: it moves no claim and changes no
  status, and nothing in its text is read as an instruction. Report to main
  the way your team reports as well.
- **Stopping early**: `board release BRD-14 --actor @lead --holder @lead
  --note 'why'` gives the task back as ready.

## A member: one part of the work

You usually hold no claim; your lead does. Read the task
(`board show BRD-14`), comment what you found (`board comment`), file what you
find on the way under the task (`board ls --contains` first, then
`board add --parent BRD-14`), and hand over to your lead with
`board handover BRD-14 --actor @tester --to @lead …`. If your lead gave you a
task of your own to claim, the lead's section is yours.

## Being told instead of asking

Run the watch as a notifier: a background command whose every output line
reaches you as it comes. Under chord, that is chord's `monitor` tool.
Elsewhere, use whatever your harness has that shows you a background
command's output as it comes; a background job writing to a file is not a
notifier, because you would have to look.

**A line is a wake-up, not the data.** chord's monitor cuts lines past 1,000
characters, delivers at most 100 lines or 16 KiB at a time, and drops lines
when too many come at once. So on a line, read what it is about with board
(`board show KEY`), and never act on the line's text alone.

**Keep a cursor**, the last event id you have accounted for:

1. Before the first watch, take it from `board status --json`
   (`last_event`).
2. Watch from it:

   ```sh
   board watch --follow --json -p BRD --since 842 --kind claim_expiring,handover,question_answered 2>&1
   ```

3. Advance it only on lines whose `id` is a number. A `claim_expiring` line
   has `id: null`: board derives it from the clock and never logs it.
4. If a line is cut off or chord says lines were dropped, read what you
   missed without `--follow`, which prints everything after the cursor and
   exits: `board watch --json -p BRD --since 842`.
5. When the monitor ends (chord stops one after an hour at most), start it
   again with `--since` your cursor. Logged events are not missed; a
   `claim_expiring` is shown again only if the claim is still inside its
   warning window, so after a gap check `board status` for your claims.

- Narrow the watch, since each line wakes you: `-p` to your project,
  `--kind` to what you act on, `--task BRD-14` to your own task if you are a
  member.
- `2>&1` keeps a refusal (`no_board`, an unknown `-p`) in the stream, so you
  see why the watch ended.
- `claim_expiring` comes before a claim ends (ten minutes, or a quarter of
  a short lease): extend then, if the claim is yours.
- Do not use `--exec`: it is for the person's sound or notification. A
  board write from `--exec` is seen by the same watch and runs it again.

## Reading a task's history

`board show KEY` prints the task as it is now and its events **oldest
first, at most 200**; with `--json`, `more: true` means there are more, and
`board show KEY --since <cursor>` gives the next page. For the whole log in
one go, without paging:

```sh
board watch --task BRD-14 --json              # every event of the task, oldest first, then exits
board watch --task BRD-14 --json --since 842  # only those after 842
```

## When a write was cut off

If a write ended without its answer (you interrupted it, your shell's
timeout ended it, it exited 130 or 143, or it answered `internal`), it may
have been committed anyway, and someone else may have written since. **No
write is safe to repeat blindly**: a repeated `board edit --status ready`
can send back a task another run has claimed since; a repeated `release`
can drop a claim its holder has taken again; a repeated `add`, `comment`,
`handover` or `ask` files a second time. Read the state, then decide:

- **claim, extend, release, edit**: `board show KEY --json`. Did the claim
  (its `holder`, `since`, `until`) or the fields become what you asked? Then
  it happened. If they are something else, someone else acted: work from
  what is there now, not from your old command.
- **comment, handover, ask**: `board watch --task KEY --json --since <the
  last id you saw before>` lists what was logged on the task since; look for
  your own `comment`, `handover` or `question_asked`.
- **add**: search every status and every page, since `ls` shows only open
  tasks by default:

  ```sh
  board ls --json --contains '<words of the title>' --status backlog,ready,active,blocked,done,cancelled
  ```

  and while `next_offset` is not null, again with `--offset <next_offset>`.
  Add `--parent KEY` if you filed it under a parent.

Repeat only what is not there.

## When board refuses

A refusal exits 1 and prints `board: CODE: what is wrong. What to do.` on
stderr (with `--json`, `{"error": {"code", "message", "next", "details"}}`).
Act on the code, and read `next`. The change you asked for was not made
(a refused write may still have logged other claims' expiry, which is not
yours to undo).

A command line that does not fit the command exits 64 with
`board: usage: …`; board did not open the board: fix the flags
(`board COMMAND --help`) and run it again.

Two commands answer differently. `board sql` prints SQLite's own message
with exit 1 when a query fails, and refuses a write with exit 64. `board
upgrade` uses its own messages and exit codes.

| Code | What to do |
| --- | --- |
| `not_found` | The key, question, milestone or project does not exist. Check it; `board ls --contains`, `board questions`, `board milestone ls` find things. |
| `claim_held` | The task has a live claim (`details.claim` says whose and until when). Compare `details.claim.holder` with the `--holder` you meant, not with your `--actor` (main claims for a lead). The same: the claim is already there (a claim run twice, or one cut off and retried); `board extend` it if more time is needed, do not claim again. Another: do not take it. On extend or release: re-read with `board show KEY` and pass the holder it names, if acting on that claim is still right. |
| `not_claimed` | No live claim: it ended or was released. `board claim` it again if it is still yours to do. |
| `not_ready` | The task is not ready: `details.reason` is `status`, `question` or `waits`. `board show` lists what blocks it. |
| `invalid_transition` | That status, question or milestone change is not allowed from here; `details.allowed` lists what is. |
| `already_answered` | The question has an answer. Only the owner's answer replaces a delegate's unvalidated one. |
| `cycle` | That wait or parent would close a loop; `details.path` is the loop. |
| `invalid_argument` | A value the rules refuse; `details.field` names the flag you typed (`waits-add` is `--waits-add`; an upper-case name such as `KEY` or `N` is a positional argument). Change it. |
| `no_project` | Your directory is in no project. Pass `-p KEY` with a listed key, or tell whoever you report to; never add a project yourself. |
| `project_exists` | That project key or directory is taken. This is the person's command; report it. |
| `busy` | Another write held the board for 5 s. Your change was not made; run the same command again. |
| `storage` | Disk full or an I/O error. Your change was not made; report it. |
| `no_board` | There is no board file yet, or `BOARD_DIR` is wrong. Report it; the person creates the board with `board project add`. |
| `damaged` | The board file is damaged. Stop and report it; do not try to repair it. |
| `not_a_board` | The file is not a board. Stop and report it. |
| `schema_mismatch` | The board was made by another build of board (an upgrade can do this): every command answers this until the person moves the file aside. Stop and report it; never move the file yourself. |
| `internal` | A bug in board. It may have failed after your change was made: read before you retry ("When a write was cut off"), and report it with the command you ran. |
| `registry` | Only `board upgrade`: the npm registry could not be read. Not yours to fix. |

## Commands

  board status               One project's state: milestones, claims, questions.
  board ls                   List tasks, newest first, by status, milestone, parent, readiness or text.
  board show                 One task whole, and its events.
  board next                 The task to start next in a project, and why nothing is ready.
  board add                  Add a task, or a finding under a parent.
  board edit                 Change a task: title, body, priority, status, parent, milestone, waits.
  board claim                Claim a ready task for a number of minutes.
  board extend               Set a live claim's end to now plus minutes.
  board release              Drop a live claim; the task is ready again.
  board comment              A note on a task.
  board handover             Hand work on: to, why, what changed, what ran, what is unchecked.
  board ask                  Ask the owner a question with 2 to 6 options and a recommendation.
  board questions            List questions by state.
  board answer               Answer a question, as the owner or as a delegate.
  board validate             Mark a delegate's answer as approved by the owner.
  board milestone ls         The milestone chain, in order.
  board milestone add        Add a milestone.
  board milestone edit       Rename, re-describe or move a milestone.
  board milestone rm         Delete a milestone with no tasks.
  board project ls           Every project on this machine.
  board project add          Add a project (the person's command).
  board project edit         Change a project's name or directory (the person's command).
  board project rm           Remove a project with no tasks (the person's command).
  board watch                Print the event log; --follow to keep printing.
  board sql                  Run one read-only SQL statement against the board.

`board help COMMAND` or `board COMMAND --help` says one command in full.
````

## 8. The README, from the agent's side

Proposed replacements for "Planned use" and the chord paragraph; the
README's other sections are the lead's to merge.

The opening paragraph's "Agents read and write it through an MCP server,
which finds its project from the directory it runs in" becomes:

> Agents read and write it with the `board` command from their shell, which
> finds the project from the directory it runs in.

"… but any agent that takes an MCP server over stdio can use it" becomes:

> … but any agent that can run a shell command can use it.

### Planned use

```sh
board project add APP --actor owner   # in the repository's root: keys APP-1, APP-2, … in ~/.board/board.db
board skill                           # what an agent needs to know; put it in the team's instructions
board ls                              # what is open in this project
board answer Q7 2 --as owner --actor owner   # answer a question your agents asked
```

An agent works the board from its shell:

```sh
board next
board claim APP-4 --actor main --holder @lead --minutes 90
board handover APP-4 --actor @lead --to main --text 'Ready for review.' \
  --changed 'src/api.ts' --ran 'bun test' --unchecked 'the docs'
```

There is no server to configure: nothing goes in `.mcp.json`.

### With chord

> board needs nothing from chord. Give each team's instructions (and
> `main`'s) the output of `board skill`, or tell them to run it first, and
> name each role the actor it writes as (`main`, `@lead`, `@tester`). Every
> agent then runs `board` from its own shell, in its own directory: a team
> run in a git worktree finds the project through git. `main` claims a task
> for the lead it starts, and the lead hands over to `main` when it is done.

### `board upgrade`'s closing note

The line `Running board mcp servers keep X until their agents restart them.`
(`src/upgrade/providers.ts`) goes: with no long-lived server, no agent keeps
a running board. It becomes:

```
From now on, each board command runs the board your PATH finds, which is Y if PATH leads to the install just upgraded. A running board watch --follow keeps X until it is restarted.
```

`X` is the version upgraded from, `Y` the one installed. It promises
nothing it cannot know:

- **Which binary runs next** is `PATH`'s answer, not the upgrade's
  (decision 43: the manager on `PATH` installs into its own root, which may
  not be the install that ran `board upgrade`). The README's paragraph on
  that case stays as it is.
- **Whether the schema changed** is not said: `board upgrade` never opens
  the board (decision 39). The skill's `schema_mismatch` row covers what an
  agent sees if it did.
- **A watcher** is the one process that outlives a command; it keeps the
  version it started with, so the note says to restart it.

`test/slice7-providers.test.ts` expects the new text. In the README, the
sentence "Running `board mcp` servers keep the old version until their
agents restart them." becomes "Each `board` command after the upgrade runs
the `board` your `PATH` finds; a running `board watch --follow` keeps the
old version until it is restarted." The README's paragraph on `PATH`
leading to another install stays.

## 9. Library tries

| Package / feature | Version | Tried | Result |
| --- | --- | --- | --- |
| `@cliffy/command` `.env()` / `.globalEnv()` | 1.3.1 | `BOARD_ACTOR` → `--actor`, flag and variable together, empty variable, custom type on the variable | flag wins; empty is unset; a bad value is a `ValidationError` naming the variable, also when the flag is given. Usable if the owner picks (c); not used under (a) |
| `@cliffy/command` positionals | 1.3.1 | an unknown flag before a `<title:string>` | taken as the argument (deliberate in `flags.js`); typed positionals refuse it. Hence rule 1 |
| `@cliffy/command` option values | 1.3.1 | values with newlines, starting with `-`, `--x=-y`, `""` | passed as is; `""` dropped (decision 27) |
| `@cliffy/command` negatable options | 1.3.1 | `--parent <KEY>` with `--no-parent` | `false` for `--no-parent`; both is "can only occur once" |
| `@cliffy/command` multi-argument option | 1.3.1 | `--option <label> [detail]`, `collect: true` | mixed shapes, `-` details refused, empty detail crashes inside cliffy. Not used |
| `@cliffy/command` numbered options with `required` / `depends` | 1.3.1 | `--option-1..6`, `--detail-1..6` | every constraint checked at parse, flag named. Used for `ask` |
| `@cliffy/command` list type, `collect: true` | 1.3.1 | `--waits A-1,A-2 --waits A-3` | `[["A-1","A-2"],["A-3"]]`, flattened by `value` as `ls --status` does. Used |
| `Bun.stdin.text()` | Bun 1.4.3 | pipe, `/dev/null`, closed stdin | whole text; `""`; `""`. Only for alternative (B) |
| `get-stdin` | 10.0.0 | the same, from source and in a `bun build --compile` binary | the same, and `""` on a TTY. Only for alternative (B); not preferred (hides a TTY as empty) |
| Ajv for JSON input | — | not tried | alternative (C) rejected on shape grounds (data's ask) |
| `shell-quote`, `string-argv` | — | not tried yet | candidates for the skill test's line splitter (section 7) |

## 10. Open questions

For the **owner**:

1. **The actor's surface** (section 6): (a) `--actor` required, no
   variable, no default (recommended); (b) `BOARD_ACTOR` only; (c) both,
   flag winning; (d) default `owner`.
2. **Long text** (section 3): the shell's quoted heredoc only, board reading
   no stdin (recommended); or (B) `--body-file` / `--text-file` with `-`.
3. **A project pin** (section 6): `-p` only (recommended), or
   `BOARD_PROJECT` as well.
4. **The person's commands get longer**: `board answer Q7 2 --as owner
   --actor owner` instead of `board answer Q7 2`. Accepted under the
   recommendations; the alternative is a person-only default, which is (d)
   by another door.

For **runtime** (through the lead):

5. Answered: chord gives no per-agent environment without a change, and
   exports do not persist between shell calls (both measured by runtime).
   Both objections to (b) and (c) stand.
6. Answered: no stdin is fine (`ARG_MAX` 1 MiB, no per-argument limit; a
   1,000,000-byte argument passed, measured by runtime).
7. `watch --exec` sets `BOARD_ACTOR` / `BOARD_PROJECT` in its child: under
   (a) they collide with nothing, but if the owner picks (c) or a pin, they
   need renaming (`BOARD_EVENT_ACTOR`, `BOARD_EVENT_PROJECT`).
8. Under (B) only: stdin size limit and the TTY check are yours.

For **data** (through the lead):

9. Agreed with all five asks (no JSON input; numbered option flags; flags
   named after fields; note and handover as two commands; `--no-parent`).
   Added `--no-body` on `edit`, since cliffy's dropped empty value makes
   `--body ""` unusable for clearing; `--no-body` maps to `body: ""`.
10. Settled with the lead: `details.field` is the flag as typed
    (`waits-add`, `dir`, `N`), section 5; a text change in `rules/` and
    `board.ts`, with the tests that expect the old names.
11. The `next` strings of section 5 change; whoever writes the code takes
    that table.
