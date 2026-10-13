# Draft: data, for board without MCP

Owner of this file: `data`. It answers the brief's data questions 1–5. Rules,
store, schema (Appendix A), concurrency, the 17 codes (+ `registry`), the
sweep, `watch` and `sql` stay as built; nothing here changes a table, a
trigger, an event kind or a transaction boundary. What changes is who checks
input, what Appendix B is for, where the actor comes from, and which
paragraphs assumed a long-lived `board mcp`.

Measured on: Bun 1.4.3, macOS SQLite 3.51.0, Ajv 8.20.0 (already in
`node_modules` through `@modelcontextprotocol/*` and `@prisma/streams-local`),
`@cliffy/command` 1.3.1, `json-schema-to-ts` 3.1.1. Scratch scripts ran from a
temp directory against the repository's `node_modules` and `src/schemas.ts`;
nothing in the repository was changed.

## 1. Appendix B after MCP

### Input schemas: removed

Today the input schemas exist for one consumer, the SDK's Ajv, which ran them
before a handler. With the SDK gone nothing runs them, and a JSON Schema that
nothing runs drifts from the parse that replaces it. So:

- **Appendix B loses every `// input` block** and the input-only `$defs`
  (`Actor`, `ProjectKeyIn`, `ProjectScope`, `KeyIn`, `QuestionIdIn`,
  `MilestoneRef`, `Minutes`).
- **The input contract is the `Board` method signatures**, which already
  exist as hand-written TypeScript in `rules/` (`TaskAddInput`,
  `TaskUpdateInput`, `ClaimInput`, `ExtendInput`, `ReleaseInput`,
  `CommentInput`, `AskInput`, `AnswerInput`, `MilestoneAddInput`, …). Only
  `src/mcp/server.ts` uses `ToolInput<N>`; it goes with the server.
- **The input formats become a table of argument types** in "The CLI"
  (section 2 below gives it): each is a cliffy `Type`, as `src/cli/types.ts`
  already does for keys, project keys, milestone names and question ids.
  Those classes become the one source of the patterns; today they duplicate
  `defs`.

The exception, if interfaces choose it: **a whole input object as JSON** (on
stdin, or JSON in a flag such as a question's options). JSON needs a schema
check at run time, and cliffy has none for a JSON value. Tried for that case:

| Tried | Result |
| --- | --- |
| `ajv/dist/2020` (Ajv 8.20.0) directly, `strict: true` | refuses to compile `task_comment`'s input: `strictRequired`, "required property "to" is not defined at "#/then"" |
| the same, `strict: false` (what the SDK effectively ran) | all 36 schemas compile (17 in, 17 out, error, project list) in 128 ms; every keyword the SDK checked is checked, with `instancePath`, `keyword`, `params` per error |
| cost per call, from source | `import` of Ajv 22–46 ms, then 17–24 ms to compile one input schema, 19–23 ms for the options array alone |
| `ajv/dist/standalone` (precompiled validators) | 816 KB of generated code for the 34 tool schemas, with CommonJS `require("ajv/dist/runtime/…")` inside an ESM file; would need a generation step and a check that `bun build --compile` bundles it. Not pursued |

So JSON input costs about 40–70 ms of Ajv per call (runtime measures it in
the binary). **Recommendation: no JSON input object; flags, with long text
from stdin or a file per field** (interfaces' question 3), so Ajv never ships
in the binary. If the owner wants JSON input anyway, Ajv at run time over the
one schema the command takes, its refusals as usage errors (exit 64) naming
`instancePath` and `keyword`; that is the package as it is, with no wrapper.
Question options, the one nested input, fit flags if interfaces find a shape
(for instance a repeatable `--option LABEL` with a positional `--detail` per
option, or one `--option`/`--detail` pair per index); a delimiter inside one
argument (`LABEL::DETAIL`) would be a parser of ours and is not proposed.

### Output schemas: kept, as the `--json` contract

- **Kept in `src/schemas.ts`** as `as const` objects with the shared `$defs`
  (`Time`, `ProjectKey`, `Key`, `QuestionId`, `MilestoneName`, `Status`,
  `Priority`, `EventId`, `Events`, `Project`, `TaskRef`, `TaskSummary`,
  `Task`, `Claim`, `Option`, `Answer`, `Question`, `Milestone`, `Place`,
  `Event`, `Kind`), `errorShape` and `projectList`. `tools.<name>.output`
  becomes `outputs.<command>`, keyed by the command interfaces name (one
  entry per command that has `--json`, the old tool's output as it is).
- **`json-schema-to-ts` 3.1.1 stays**: `Task`, `Claim`, `Question`, `Event`,
  `Kind`, `Status`, `ErrorBody` and the rest are used across `rules/`,
  `text.ts`, `errors.ts` and `cli/`. `ToolInput` goes; `ToolOutput` becomes
  the output type per command.
- **Validated in tests, not at run time.** The tests that call
  `fromJsonSchema(…)["~standard"].validate` from `@modelcontextprotocol/server`
  (`slice1-mcp`, `slice2-cli`, `slice3-cli`, `slice4-cli`, `slice6-binary`,
  `slice7-providers`, `mcp*`) switch to Ajv 8.20.0 directly
  (`new Ajv2020({ allErrors: true, strict: false })`), added as a direct
  `devDependency` (it stays installed today only by accident of two other
  packages). Tests hold:
  - every output schema and `errorShape` compile;
  - every command with `--json`, on each scenario its CLI test already runs,
    prints one JSON document that its schema accepts (the in-process runner
    with injected sinks, as now);
  - every refusal printed under `--json` fits `errorShape`, one per code;
  - every command that has `--json` has an `outputs` entry, and no entry is
    without a command (so a renamed command cannot leave a dead schema).
- **Why not at run time.** The SDK validated after the handler, which for a
  write is after the commit: an `Output validation error` told the agent
  "failed" about a change that had happened. Doing the same in the CLI would
  keep that lie, add Ajv's 40–70 ms to every call, and catch nothing a test
  over the same shapes does not. An output mismatch stays a bug in board.

### Shapes that change, and why

| Change | Why |
| --- | --- |
| No input schemas in Appendix B | nothing runs them (above) |
| `tools.<tool>.output` → `outputs.<command>`; the per-tool headings of Appendix B become per-command | the CLI is the interface |
| `board answer --json` and `board validate --json` print `question_answer` / `question_validate`'s output | they had no `--json`; agents now run them |
| `next` texts that name tools (`task_list`, `task_extend`, `board_status`, `question_list`, `task_update`, `task_claim`) name commands | an agent copies `next`; strings only, not shapes |
| Appendix B's intro and "Conventions": "the SDK validates every successful result" → "the tests validate every `--json` output"; the `Input validation error` / `Output validation error` paragraph goes | no SDK |

Nothing else changes. Every output field keeps its name and meaning;
`task_list.project` still answers `"*"` under `--all`; `Events` on every
write is still every id the write appended. `details.field` keeps the
`Board` input names (`waits_add`, `parent`, `recommended`, `actor`, …):
`rules/` knows nothing of flags. **Ask to interfaces:** spell each flag as
its field in kebab case (`waits_add` → `--waits-add`), so `field` maps to the
flag with no table; where a field is positional (`key`, `question`), the
guide says so.

The error object is unchanged, and no `usage` code is added: the 17 codes
(+ `registry`) are board's refusals, and a usage error is cliffy's (section 2).

## 2. Validation that moves

### The rule

- **The shape of one value** (pattern, enum, integer and range, length) is
  checked at parse by a cliffy `Type` or an option's `value`, throwing
  cliffy's `ValidationError`: usage, exit 64, nothing opened. This is what
  `src/cli/types.ts` (`PatternType`), `EnumType`, `inRange` and `lengthIn`
  already do for the person's commands.
- **Which flags go together** is checked at parse by cliffy's `conflicts`,
  `depends` and `required`, or made unexpressible by the command's shape, or,
  for "at least one of" (which cliffy has no option for), by a check at the
  top of the action throwing `ValidationError`, as `board answer` already
  does for `N` / `--text`. Exit 64.
- **Everything the rules check stays where it is** and keeps its code
  (`invalid_argument`, `not_found`, `cycle`, …). Nothing moves out of
  `rules/`, and nothing the parse checks is checked again in `rules/`.

Decision 13's split holds with a new owner: what does not fit the command's
shape is refused by the parsing library before board runs (was the SDK, now
cliffy, exit 64, text); what fits and breaks a rule is board's refusal (exit
1, the error object). The Appendix A `CHECK`s stay the backstop; a value that
reaches one past the parse is a bug in board, and `internal` is the honest
answer. That is why every length below must be checked at parse: several
existed only in Ajv, with no rule and no `CHECK` behind them (marked †).

### Every check Ajv made, and where it lives now

"Parse" means a cliffy `Type` / `value` / option constraint (exit 64);
"shape" means the command's form cannot express the bad input; "rules" means
unchanged code in `rules/` (exit 1).

| Tool: input check (Ajv) | Now | Code |
| --- | --- | --- |
| every tool: `additionalProperties: false` | shape: cliffy refuses an unknown option or extra argument | 64 |
| every write: `actor` required | parse: the actor from `--actor` or `BOARD_ACTOR` (section 3); missing is a check in the action | 64 |
| every write: `actor` 1–64 † (max) | parse: `lengthIn(1, 64)` on the actor type, for the flag and the env alike | 64 |
| every write: actor `board` | rules: `checkActor` (unchanged) | `invalid_argument`, `field: actor` |
| `project`: `ProjectKeyIn` pattern | parse: `projectType` (exists) | 64 |
| `project: "*"` (`task_list`, `question_list`) | shape: `--all`, `conflicts` with `-p` (exists) | 64 |
| key / `parent` / waits: `KeyIn` pattern | parse: `keyType` (exists) | 64 |
| question id: `QuestionIdIn` | parse: `questionType` (exists) | 64 |
| milestone names, `before`, `after`: `MilestoneName` | parse: `milestoneType` (exists) | 64 |
| `milestone` in `task_list` / `task_add` / `task_update`: `MilestoneRef` (`none` allowed) | parse: `milestoneType`; `none` is the store's (unchanged) | 64 |
| `milestone: none` as a new name | rules: `checkName` | `invalid_argument` |
| `status`, `priority`, `kind`, `as`, `state`: `enum` | parse: `EnumType` | 64 |
| `task_list.status`: `minItems 1`, `uniqueItems` | parse: list type; duplicates are harmless (a filter) and need no refusal | 64 / none |
| `task_list.contains`: 1–200 | parse: `lengthIn(1, 200)`; empty means no filter (decision 27, CLI as built) | 64 |
| `task_list.limit` 1–200, `offset` ≥ 0, `task_read.since` ≥ 0 | parse: `inRange` (exists) | 64 |
| `task_add.title`, `task_update.title`: 1–200 | parse: `lengthIn(1, 200)`; whitespace-only stays rules | 64 / `invalid_argument` |
| `body` ≤ 20000 † | parse: `lengthIn(0, 20000)` | 64 |
| `task_add.status`: `backlog`/`ready`; `task_update.status`: no `active`/`blocked` | parse: `EnumType` per command | 64 |
| `waits`: `maxItems 50` †, `uniqueItems` | parse: the list's `value` checks the count; duplicates are folded by rules (`new Set`, as now) | 64 / none |
| `waits_add` / `waits_remove`: `minItems 1`, `maxItems 50` †, `uniqueItems` | parse, as `waits` | 64 |
| same key in `waits_add` and `waits_remove`; a task waiting on itself | rules (unchanged) | `invalid_argument` |
| `parent: null` on `task_update` | shape: a separate flag (interfaces': for instance `--no-parent`, which cliffy offers as a negatable option) | — |
| `task_update`: `minProperties: 3` (something to change) | action check: no field flag given → `ValidationError` | 64 |
| `task_claim.minutes`: `Minutes` 1–1440 | parse: `inRange(1, 1440)` on an `integer`; rules' `checkMinutes` stays behind it | 64 |
| `task_claim.holder`, `task_extend.holder`, `task_release.holder`: 1–64 † | parse: the actor type | 64 |
| `task_claim.directory` 1–1024 †, `branch` 1–255 † | parse: `lengthIn` | 64 |
| `task_release.note` 1–500 † | parse: `lengthIn` | 64 |
| `task_comment.kind` | shape: two commands, a note and a handover (requested from interfaces) | — |
| `task_comment.text` 1–10000 † | parse: `lengthIn` | 64 |
| `task_comment` `if handover then required to, changed, ran, unchecked` | shape: the handover command marks the four `required: true`; rules' check stays behind it | 64 |
| `task_comment` `else not anyOf(to, changed, ran, unchecked)` | shape: the note command has no such options (today rules would silently drop them) | 64 |
| `to` 1–64 †, `changed` / `ran` / `unchecked` 1–4000 † | parse: actor type, `lengthIn` | 64 |
| `question_ask.text` 1–2000 † | parse: `lengthIn` | 64 |
| `question_ask.options`: 2–6 | parse: the count; rules check it too (unchanged) | 64 |
| option `label` 1–80 †, `detail` 1–500 †, no extra keys | parse, per interfaces' option shape | 64 |
| `question_ask.recommended`: 1–6 | parse: `inRange(1, 6)`; past the given options stays rules | 64 / `invalid_argument` |
| `question_answer`: `anyOf choice, text` | action check (exists in `board answer`); rules' check stays behind it | 64 |
| `question_answer.choice` 1–6; past the options | parse `inRange(1, 6)` (exists); past the options stays rules | 64 / `invalid_argument` |
| `question_answer.text` 1–2000 | parse: `lengthIn` (exists) | 64 |
| `question_answer.as` required, enum | parse: `--as` with `required: true` and an `EnumType` (section 3) | 64 |
| `milestone_add.delivers`, `milestone_update.delivers` 1–500 | parse: `lengthIn` (exists) | 64 |
| `milestone_add` / `_update`: `not required [before, after]` | parse: `conflicts` (exists) | 64 |
| `milestone_update`: `anyOf name, delivers, before, after` | action check | 64 |
| a move relative to itself; a taken name | rules (unchanged) | `invalid_argument` |

Lengths count code points (`[...text].length`, as `lengthIn` does), the unit
JSON Schema counted; a test pins one astral character as length 1.

Long text from stdin or a file (interfaces' question 3) is checked by the same
`lengthIn` after it is read, so a body from a heredoc and one from a flag
meet the same limit. An empty stdin for a field with minimum 1 is a usage
error, not an empty value.

### What replaces decision 13's exception

"Arguments that do not fit a tool's input schema are refused by the SDK, text
only" becomes: **arguments that do not fit a command are refused by cliffy:
`board: <message>` on stderr, exit 64, never JSON, nothing opened**. An agent
tells the two apart by the exit code alone: 64 is "fix the command line",
1 is a refusal with `{error: {code, …}}` (on stderr under `--json`).
Whether a usage error should also print a JSON object under `--json` is
interfaces' question 5; from the data side the answer is no new code in the
error enum, since a usage error never reaches board.

## 3. actor in the data

### What is recorded, unchanged

The actor is one trusted string (decision 1), wherever it comes from:

| Where | What it holds |
| --- | --- |
| `event.actor` | the caller, on every event but `claim_expired` (actor `board`) |
| `claim_expired.data.by` | the caller whose write swept it ("noticed by") |
| `task.created_by`, `milestone.created_by` | the caller |
| `claim.holder` | `holder`, defaulting to the caller |
| `question.asked_by`, `answered_by`, `validated_by` | the caller |
| `handover.data.to` | `to`, an actor-shaped string |

Nothing is normalised (no case folding, no `@` added); two spellings are two
actors, as today. `board` stays reserved, refused by `checkActor` in `rules/`
as `invalid_argument` with `field: actor`, so `BOARD_ACTOR=board` gets the
same answer as `--actor board`. Its `next` says "set `BOARD_ACTOR` or pass
`--actor` with your own name" (a text change).

The surface (flag, environment, both) is interfaces'. One library finding for
it: cliffy 1.3.1's `.env("BOARD_ACTOR=<name:string>", …, { prefix:
"BOARD_" })` maps the variable onto the `--actor` option, and the flag wins
when both are given (measured). An empty `BOARD_ACTOR` reads as unset, which
matches the design's rule for `BOARD_DIR`. But `{ required: true }` demands
the variable even when `--actor` is given (measured:
`MissingRequiredEnvVarError` with `--actor x`), so "flag or environment,
one required" is the env declared optional plus a check in the action. Its
error is a `ValidationError`, so the root's catch maps it to 64. Note that
cliffy reads `process.env` itself, while the design says only `src/main.ts`
reads the environment; either `main.ts` passes the variable in as an argument
default, or the design's rule names cliffy's `.env` as the second reader.
That is runtime's and interfaces' call.

### `owner`, and a missing actor

Today `OWNER = "owner"` is written by every CLI write, because only the
person ran the CLI. Now agents do, so an actor left out would write the
owner's name into the log, which is exactly what decision 14's "`as` has no
default" was there to stop.

**Owner: what a missing actor does.**

- (a) **Refused, exit 64**: "no actor: pass `--actor NAME` or set
  `BOARD_ACTOR`". A person puts `export BOARD_ACTOR=owner` in their shell
  profile once. Every name in the log was given by someone.
- (b) Defaults to `owner`, as the CLI does now. An agent whose environment
  lacks the variable writes as the owner, silently.
- (c) Defaults to `owner` on the person's commands (`project …`, `answer`,
  `validate`) and refused on the rest. Two rules for one argument.

**Recommendation: (a).** The log's value is who did what; a default that
names the person is the one wrong answer that looks right. A usage error and
not `invalid_argument`: a missing argument is the parse's, as `required` was
the SDK's.

`project add`, `edit` and `rm` take the actor like every write (today they
hard-code `OWNER`), so `project_added.actor` is whoever ran it. `OWNER` leaves
`board.ts`. `owner` stays an ordinary name, not reserved: the person is
whoever writes as `owner`, as before.

### `answered_as` when anyone can run `board answer`

The meaning does not change: `answered_by` is who recorded the answer,
`answered_as` is whose decision the caller says it is, trusted like the
actor. `main` relaying the person's words from the chat window records
`actor: main, as: owner`; `main` deciding on its own records `as: delegate`,
which stays on the to-validate list.

What changes is the default. `board answer` sends `as: owner` because only
the person ran it; an agent running it would record the owner's decision by
leaving out an argument, which decision 14 forbids.

**Owner: `as` on `board answer`.**

- (a) **`--as owner|delegate` required, no default**, on every answer, the
  person's included (`board answer Q7 2 --as owner`).
- (b) `as` defaults to `owner` when the actor is `owner`, and is required
  otherwise.
- (c) Keep the default `owner`.

**Recommendation: (a).** (b) gives the actor string a meaning board otherwise
never reads (decision 4 rejected matching actor strings for the same reason),
and (c) is the hole decision 14 closed. The owner's override of a delegate
(`as: owner` over an unvalidated delegate answer) is unchanged.

`board validate` records `validated_by` = the actor; anyone may validate
(decision 2), as now.

## 4. Per-call cost on the store

What every call does, in order (unchanged code, now once per process):

1. `statSync` of `board.db` (missing → `no_board`); construct `PrismaClient`
   with the adapter; `$connect()`.
2. `PRAGMA synchronous = FULL`; `count(*)` of `sqlite_master` (empty →
   `no_board`); `PRAGMA application_id` (`not_a_board`); `PRAGMA
   user_version` (`schema_mismatch`).
3. One `$transaction`: for a write, the lock statement, `now`,
   `user_version` again, resolution (git outside, at most one retry), the
   machine-wide sweep, `SAVEPOINT op`, the change; for a read, `now`,
   `user_version`, the reads.
4. `$disconnect()`; the process exits.

The pragmas and checks are microseconds against a local file; the start-up of
the process and of the Prisma client is runtime's measurement. The second
`user_version` read is kept: it is the one under the lock.

**Closing is cheap.** A connection that closes last on a WAL file checkpoints
it. macOS's SQLite keeps the `-wal` file (truncated to 0 bytes) rather than
deleting it, so the next process does not recreate it. Measured with
`bun:sqlite` on 3.51.0, one process per write: a one-row write then close
took 0.65–0.82 ms to close; closing after a 200-row backlog, 12 ms; with
another connection open (a `watch`), 0.04 ms, since the closer is not last.
No setting changes; a process killed before closing leaves the checkpoint to
the next one, which SQLite handles.

**What assumed a long-lived process, and now reads differently:**

| Where | Today | After |
| --- | --- | --- |
| "File and connections": "`board mcp` opens it once and keeps it" / "started before the file exists starts anyway and retries the open on each call" | the retried `no_board` | goes. Every call opens fresh, so a board created after the agent started is simply there on its next call |
| `Board`'s constructor taking `() => Promise<Store>`, with `opening` / `closed` | the lazy, retried open for `board mcp` | goes; `Board` takes a `Store`, as `withBoard` already gives it |
| "Every operation", the `Store` paragraph: "two requests from one agent, which the MCP SDK runs concurrently, never interleave" | the reason for one client in `Store` | reason rewritten: a call's two attempts (`withGit`) and the tests' concurrent `Board` calls. The rule stays: only `Store` holds the client |
| "Prisma's timers do not bound a wait": writes queued in one process each wait their own 5 s, the n-th after about 5n s | one server, many queued writes | goes. One write per process, so n agents' writes wait their 5 s side by side and each answers `busy` after about 5 s. The failure-table row goes with it |
| Run time: "a `board mcp` captures its working directory once, at start" | cwd captured per server | the cwd of each call's own process; the "cwd deleted after the server started" row becomes runtime's (a shell in a deleted directory) |
| "Concurrent calls share one pending git" | many calls in one server | one call per process; nothing to share (runtime decides whether `Place` keeps the code) |
| `Store.write`'s `maxWait: 30_000` | a queue of transactions in one process | harmless; one transaction per process never waits for another of its own |
| Prepared statements, caches | none of board's own | nothing changes |
| README: "Running `board mcp` servers keep the old version until their agents restart them" | a running server outlives an upgrade | every call runs the installed binary. A build with another `user_version` turns every agent's next call into `schema_mismatch` at once. Before the first release that is the documented path (stop the agents, move the file, `project add`); the guide and `board upgrade`'s notes should say so |

Contention is unchanged: the same writes, now each in its own process, which
is the case "Runtime" already measured (10 processes × 100 writes, 1,000 of
1,000 committed in 1.35 s). Ctrl-C or an agent's shell timeout killing a call
mid-wait writes nothing and holds no lock, as for the CLI today.

## 5. Decisions to replace or amend (data side)

- **1. The actor is a trusted argument.** Context: the CLI, not `.mcp.json`.
  Consequences: "The CLI writes as `owner`" replaced by the owner's choice on
  a missing actor (section 3); `board` stays reserved, refused by the rules
  wherever the actor came from. Option (b) of the old entry (the agent's name
  in the environment) is now partly what `BOARD_ACTOR` is, with no change to
  chord.
- **11. Concurrency settings.** Drop the consequence "writes queued in one
  process … the n-th after about 5n s"; keep the rest.
- **13. One error shape** is rewritten: "One error shape; usage errors are
  cliffy's". The exception becomes cliffy's `ValidationError`, exit 64, text
  on stderr. `Output validation error` goes. Libraries: Ajv 8.20.0 used
  directly in tests (`ajv/dist/2020`, `strict: false`, since strict mode
  refuses `then.required` of properties declared at the top level), all
  output schemas compiling unedited; tried at run time and not taken (40–70 ms
  a call); `ajv/dist/standalone` tried and not taken (816 KB generated, CJS
  requires in ESM, a build step); `json-schema-to-ts` 3.1.1 kept for types.
- **14. Questions.** Add: `as` is required on `board answer` too (if the
  owner takes 3(a)); the CLI's `as: owner` default goes.
- **New: Appendix B is output only.** Context: the SDK was the only consumer
  of the input schemas. Choice: input schemas removed; inputs are the `Board`
  types and the CLI's argument types; outputs kept and validated by tests.
  Options weighed: keep the input schemas and run Ajv on the parsed input at
  run time (one shape for every error, 40–70 ms a call, two sources of the
  same limits); keep them as documentation only (drifts).
- **18. The CLI is cliffy.** Amend "Consequences" with the validation rule of
  section 2 (one value: a `Type`; flags together: `conflicts` / `depends` /
  `required` or an action check; all exit 64) and the `.env` finding.

Not changed: 5, 10, 11's core, 12, 15, 16, 26–31 (no store, schema or event
change).

## Open questions

- **Owner:** a missing actor (section 3): (a) refused, recommended; (b)
  `owner`; (c) `owner` on the person's commands only.
- **Owner:** `as` on `board answer` (section 3): (a) required, recommended;
  (b) defaulted from the actor `owner`; (c) default `owner`.
- **Interfaces:** no whole-object JSON input (section 1), so Ajv stays out
  of the binary; a flag shape for question options that needs no delimiter
  parser.
- **Interfaces:** flags named as their fields in kebab case, so
  `details.field` maps to a flag; the comment as two commands (note,
  handover); a negatable `--no-parent` or equivalent for `parent: null`.
- **Runtime:** who reads `BOARD_ACTOR` (cliffy's `.env` or `main.ts`); an
  agent's environment inherited by the processes it starts (a member started
  from a lead's shell would write as the lead; board cannot tell).
- **Runtime:** the start-up cost of the Prisma client per call, the one cost
  this draft does not measure.
