# v1: interfaces

The surfaces of board v1: the MCP tools an agent calls and the CLI a person
runs. Written against the brief (`brief.md`), including its "Resolutions after
review"; the owner's decisions there are fixed. This is the revised draft: the
schemas below are normative, and examples are illustrations only. Where a
shape still depends on data or runtime, it is marked **[data]** or
**[runtime]** and collected at the end.

## What was tried

All in throwaway projects outside the repository, on Dart 3.12.2, macOS arm64,
with `args` 2.7.0, `mcp_dart` 2.4.2 and `dart_console` 5.1.0 (each the latest
on pub.dev at the time).

**`package:mcp_dart`.** A server with tools registered through `registerTool`,
input and output schemas given as JSON maps (`JsonSchema.fromJson`) and
`ToolAnnotations`; a `McpClient` calling it over two `IOStreamTransport`s
joined by `StreamController`s in one process, as the package's
`example/iostream-client-server` does. Findings:

- `listTools` returns both schemas and the annotations as given.
- **Input** is validated before the callback runs. Enforced: `required`,
  `pattern`, `enum`, `minimum`/`maximum`, `minLength`, `minProperties`,
  `additionalProperties: false`, `if`/`then`/`else`, `not`. A refusal is the
  package's: on the current protocol (2026-07-28) `isError: true` with one text
  line and no `structuredContent`, e.g. `Invalid arguments for tool
  'task_claim': JsonSchemaValidationException: Required property is missing:
  minutes (at )`; on older protocols a JSON-RPC `-32602` (read in
  `mcp_server.dart`, not exercised). `not` and `if`/`then`/`else` refuse with
  weaker messages that name no field (`Value matches the disallowed schema`).
  This shape is the one accepted exception to board's error shape
  (resolution 12).
- **Output** of a successful result is validated against the output schema,
  with `$ref` into a local `$defs`, `oneOf`, `type: ["string", "null"]`,
  `pattern`, `minimum` and `additionalProperties: false` all enforced. A
  mismatch is logged on stderr and reaches the client as a JSON-RPC `-32603`
  error ("returned structured content that does not match its output
  schema"), not as a result. So the output schemas below are a contract the
  tests hold the server to: a mismatch is a bug, and it fails loudly.
- An `isError: true` result may carry `structuredContent`, and the client gets
  both; output validation is skipped for it, so the error object does not have
  to fit the tool's output schema.
- Logging goes to stderr and does not corrupt the stdio stream.
- There is no `InMemoryTransport`; `IOStreamTransport` over stream controllers
  is the in-process transport the tests use.

**`package:args`.** A `CommandRunner<int>` with commands, a nested command
(`milestone add`), a global option, flags with `abbr`, multi-options and
`allowed` values. Findings:

- Nested commands, `aliases`, `help` and per-command usage work as given.
- `addMultiOption` takes `--kind a --kind b` and `--kind a,b` alike.
- `allowed:` refuses an unknown value with a `UsageException` naming it.
- `mandatory: true` does not refuse at parse time in 2.7.0: it throws an
  `ArgumentError` when the option is read. Required options are therefore not
  declared `mandatory`; the command checks and calls `usageException(...)`,
  the package's API for this.
- Options are strings; numbers are parsed by the command and refused through
  `usageException`.
- An unquoted SQL query is split and globbed by the shell before `args` sees
  it, so `sql` takes exactly one positional argument.

So `package:args` covers the CLI as is (brief question 7).

**Table output: `package:dart_console`** (5.1.0, published 2026-06), its
`Table` class with `borderStyle = BorderStyle.none` and
`render(plainText: true)`. It compiles under `dart compile exe` (no build
hook) and prints no escape codes in plain-text mode. Findings:

- Columns are padded to the widest cell, separated by spaces; the header is
  the first row. That is the table `board ls`, `board status` and `board sql`
  need.
- Width is counted in characters, not terminal cells: `日本語` is padded as 3
  wide where a terminal shows 6, so a row with wide characters is misaligned
  after it.
- A cell with a newline becomes a multi-line row.
- The last column is padded with trailing spaces.

None of these is worth working around, and per the one rule they are not
mine to patch. See open question 8 for the options; the draft assumes
`dart_console` as is. `board watch` lines are tab-separated, not a table.

## Conventions

- **One shape per thing.** A task, claim, question, milestone, pause and event
  have one schema each (below), used by every tool that returns them and by the
  CLI's `--json`.
- **Public identifiers are strings.** Tasks `APP-12`, questions `Q7`,
  milestones by name. No tool takes or returns an internal row id. Keys and
  question ids are accepted in any case (`app-12`, `q7`) and returned in upper
  case **[data]**: data compares the prefix case-insensitively.
- **`actor`** is required on every write, 1–64 characters, trusted as given
  (owner decision 1). `board` is reserved for what the store does itself
  (`claim_expired`, derived lines) and is refused as `invalid_argument`. The
  CLI writes as `owner`.
- **Time** is one format everywhere, storage and every interface: UTC ISO
  8601 with milliseconds and `Z`, `2026-10-12T14:03:00.000Z`
  (resolution 17). Durations are whole minutes, 1–1440.
- **Status** in every answer and every filter is the effective status
  (resolutions 18, 19): `done`/`cancelled` as stored; else `blocked` with an
  open question; else `ready` for a task whose claim has expired; else the
  stored status. An expired claim is shown as no claim (`claim: null`,
  `holder: null`).
- **Priority** is `urgent`, `high`, `normal`, `low`, stored by data as 0–3.
- **`updated_at`** is the `at` of the task's latest event (resolution 18).
- **Every write answers with `events`**, the ids it appended, ascending; an
  update that changes nothing answers `events: []` and writes nothing.
- **Annotations.** Reads: `readOnlyHint: true, openWorldHint: false`. Writes:
  `readOnlyHint: false, destructiveHint: false, idempotentHint: false,
  openWorldHint: false`. `milestone_delete` is `destructiveHint: true`.

## Shared schemas

JSON Schema 2020-12. Each registered tool schema carries the `$defs` it
refers to, so `$ref: "#/$defs/…"` resolves inside it. Tried: the block below,
loaded as is into `task_read`'s output schema and `task_comment`'s input
schema, accepts a full `Task` and refuses one with a numeric `priority`; every
JSON block in this file parses. Every
object has `additionalProperties: false`, and every property is listed in
`required`: an output field that may be absent is `null`, never missing.

```json
{
  "$defs": {
    "Time": { "type": "string",
      "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" },
    "Actor": { "type": "string", "minLength": 1, "maxLength": 64 },
    "Key": { "type": "string", "pattern": "^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$" },
    "KeyIn": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9]{0,9}-[1-9][0-9]*$" },
    "QuestionId": { "type": "string", "pattern": "^Q[1-9][0-9]*$" },
    "QuestionIdIn": { "type": "string", "pattern": "^[Qq][1-9][0-9]*$" },
    "MilestoneName": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$" },
    "Status": { "enum": ["backlog", "ready", "active", "blocked", "done", "cancelled"] },
    "Priority": { "enum": ["urgent", "high", "normal", "low"] },
    "Minutes": { "type": "integer", "minimum": 1, "maximum": 1440 },
    "EventId": { "type": "integer", "minimum": 1 },
    "Events": { "type": "array", "items": { "$ref": "#/$defs/EventId" } },

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

    "Pause": {
      "type": "object", "additionalProperties": false,
      "required": ["by", "at", "why"],
      "properties": {
        "by": { "type": "string" },
        "at": { "$ref": "#/$defs/Time" },
        "why": { "type": "string" } } },

    "Event": {
      "type": "object", "additionalProperties": false,
      "required": ["id", "at", "actor", "kind", "task", "milestone", "data"],
      "properties": {
        "id": { "$ref": "#/$defs/EventId" },
        "at": { "$ref": "#/$defs/Time" },
        "actor": { "type": "string" },
        "kind": { "$ref": "#/$defs/Kind" },
        "task": { "oneOf": [{ "$ref": "#/$defs/Key" }, { "type": "null" }] },
        "milestone": { "type": ["string", "null"] },
        "data": { "type": "object" } } },

    "Kind": { "enum": [
      "board_created", "board_paused", "board_resumed",
      "task_added", "task_edited", "task_status", "task_moved", "waits_changed",
      "claimed", "claim_extended", "claim_released", "claim_expired",
      "comment", "handover",
      "question_asked", "question_answered", "question_validated", "question_withdrawn",
      "milestone_added", "milestone_edited", "milestone_reordered",
      "milestone_deleted", "milestone_done", "milestone_reopened"] }
  }
}
```

Notes:

- `TaskSummary` is what lists return; `Task` is the summary's fields plus the
  rest, written out in full because `additionalProperties: false` does not
  compose with `allOf`.
- `Claim.minutes_left` is whole minutes rounded up, so a live claim never
  shows 0 unless it has under a minute; a claim is only ever shown live.
- `Option.detail` and `Answer.text` are `null` when not given. An answer has
  `choice`, `text` or both; when only `choice` is given, `text` is `null`
  **[data]** (data stores `answer` as required text today).
- `Question.validated` is non-null only on an answer given `as: delegate`. An
  owner's override (below) leaves it null.
- `Milestone.tasks.left` is `total − done − cancelled`. `Place` is "milestone
  2 of 5, 3 left".
- `Event.data` is `{ "type": "object" }` on the wire; its shape per kind is
  the normative table under "Events". It is not a `oneOf` per kind on purpose:
  the log is read as stored, and one row written by an older build of the
  same schema version must not make every `task_read` fail output validation.

## Errors

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
          "not_found", "paused", "claim_held", "not_claimed", "not_ready",
          "invalid_transition", "already_answered", "cycle", "invalid_argument",
          "busy", "storage", "no_board", "damaged", "not_a_board",
          "schema_mismatch", "board_reset", "internal"] },
        "message": { "type": "string" },
        "next": { "type": "string" },
        "details": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "what": { "enum": ["task", "question", "milestone"] },
            "id": { "type": "string" },
            "field": { "type": "string" },
            "reason": { "type": "string" },
            "from": { "type": "string" },
            "to": { "type": "string" },
            "allowed": { "type": "array", "items": { "type": "string" } },
            "path": { "type": "array", "items": { "type": "string" } },
            "claim": { "$ref": "#/$defs/Claim" },
            "pause": { "$ref": "#/$defs/Pause" },
            "task": { "$ref": "#/$defs/TaskSummary" },
            "question": { "$ref": "#/$defs/Question" },
            "sqlite": { "type": "string" } } } } } }
}
```

The result is `isError: true`; the text line is `message` and `next` joined by
a space. `message` says what is wrong and names the thing; `next` says what to
do. `details` carries only the fields listed for the code below, and is `{}`
when there are none. A refusal changes nothing and appends no event.

| Code | When | `next` says | `details` |
| --- | --- | --- | --- |
| `not_found` | a key, question or milestone does not exist | check it; `task_list` / `question_list` / `board_status` to find it | `what`, `id` |
| `paused` | any write but `board_resume` while paused; `board_pause` on a paused board | wait for `board_resume`; reads still work | `pause` |
| `claim_held` | `task_claim` with a live claim (any holder); `task_extend` / `task_release` whose `holder` is not the live claim's | for a claim: wait or `task_extend` if it is yours; for extend/release: re-read the claim | `claim` |
| `not_claimed` | `task_extend` / `task_release` with no live claim (none, or expired) | `task_claim` to take it | — |
| `not_ready` | `task_claim` on a task that is not ready | the reason, and what would make it ready | `task`, `reason` (`status`, `question`, `waits`) |
| `invalid_transition` | a status, question or milestone change the rules do not allow (closing with an open question, `board_resume` when not paused, validating an owner's answer, deleting a milestone that has tasks, asking on a closed task, answering a withdrawn question) | what is allowed from here | `from`, `to`, `allowed`, `reason` |
| `already_answered` | answering a question that is answered and not overridable | `question_list`; the owner may override a delegate's unvalidated answer | `question` |
| `cycle` | a wait or a parent that would close a loop | the loop | `path` (keys) |
| `invalid_argument` | a value the schema allows and the rules do not: an FTS5 query SQLite rejects, the same key in `waits_add` and `waits_remove`, `choice` past the options, `recommended` past the options, a move relative to itself, a milestone name taken or `none`, the actor `board` | what to change | `field`, `sqlite` (FTS5) |
| `busy` | the write lock was not obtained within the busy timeout (5 s) **[runtime]** | retry; nothing was changed | — |
| `storage` | disk full, I/O error, read-only file **[runtime]** | SQLite's message; nothing was changed | `sqlite` |
| `no_board` | no `.board/board.db` from the working directory upward | `board init --prefix KEY` in the project's root | — |
| `damaged` | the file is not a database or is malformed | move `.board/board.db` aside, then `board init` | `sqlite` |
| `not_a_board` | a SQLite file that is not a board (`application_id`) | move it aside, then `board init` | — |
| `schema_mismatch` | a board from another build (`user_version`) | there are no migrations: `board init --force` starts over, after the owner agrees | `from`, `to` (versions) |
| `board_reset` | the board was reset (`init --force`) since this process attached | read again: the next call works on the new board | — |
| `internal` | an exception in board's own code; the transaction was rolled back | report it; nothing was changed | `reason` |

The one exception: arguments that do not fit a tool's input schema are refused
by `mcp_dart` before board runs, in the package's shape (text only, no
`structuredContent`; resolution 12). Each tool's description says so:
"A refusal without `structuredContent` means the arguments do not fit this
tool's schema; the text names the field."

## The MCP tools

Nineteen tools, `<thing>_<verb>`, so related tools sort together.

| Tool | Kind |
| --- | --- |
| `board_status`, `task_list`, `task_read`, `task_next`, `question_list` | read |
| `board_pause`, `board_resume` | write |
| `task_add`, `task_update`, `task_claim`, `task_extend`, `task_release`, `task_comment` | write |
| `question_ask`, `question_answer`, `question_validate` | write |
| `milestone_add`, `milestone_update`, `milestone_delete` | write |

Every tool can also answer `busy`, `storage`, `no_board`, `damaged`,
`not_a_board`, `schema_mismatch`, `board_reset` and `internal`; every write
can answer `paused`. These are not repeated per tool. Input schemas below omit
`"type": "object", "additionalProperties": false` and the `$defs`, which every
one has.

### `board_status`

Input: `{ "properties": {} }`.

Output:

```json
{ "required": ["paused", "counts", "milestones", "current", "claims", "questions", "last_event"],
  "properties": {
    "paused": { "oneOf": [{ "$ref": "#/$defs/Pause" }, { "type": "null" }] },
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

- `counts` are by effective status. `milestones` is the whole chain in order.
  `current` is null when no milestone is current (none, or all done).
- `claims` are the live ones, soonest to end first, with `directory` and
  `branch` as given; nothing is checked about them (owner decision 3).
- `last_event` is the newest event id, for `task_read.since` and
  `board watch --since`; 0 on an empty log.

Text: `milestone 2 of 5 (v1), 3 tasks left; 2 ready, 1 active, 1 blocked; 1 claim; 1 open question, 2 to validate`.
Paused, it starts `PAUSED by main at 2026-10-12T14:03:00.000Z: owner reviewing v1;`.

### `board_pause` / `board_resume`

```json
// board_pause input
{ "required": ["actor", "why"],
  "properties": { "actor": { "$ref": "#/$defs/Actor" },
                  "why": { "type": "string", "minLength": 1, "maxLength": 500 } } }
// board_pause output
{ "required": ["pause", "events"],
  "properties": { "pause": { "$ref": "#/$defs/Pause" }, "events": { "$ref": "#/$defs/Events" } } }

// board_resume input
{ "required": ["actor"], "properties": { "actor": { "$ref": "#/$defs/Actor" } } }
// board_resume output
{ "required": ["paused", "events"],
  "properties": { "paused": { "type": "null" }, "events": { "$ref": "#/$defs/Events" } } }
```

Refusals: `board_pause` on a paused board is `paused` with the pause in force;
`board_resume` on a board that is not paused is `invalid_transition`.
Events: `board_paused`, `board_resumed`. Text: `board paused: owner reviewing v1` / `board resumed`.

### `task_list`

```json
// input
{ "properties": {
    "status": { "type": "array", "minItems": 1, "uniqueItems": true,
                "items": { "$ref": "#/$defs/Status" } },
    "parent": { "$ref": "#/$defs/KeyIn" },
    "milestone": { "oneOf": [{ "$ref": "#/$defs/MilestoneName" }, { "const": "none" }] },
    "ready": { "type": "boolean" },
    "text": { "type": "string", "minLength": 1, "maxLength": 200 },
    "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
    "offset": { "type": "integer", "minimum": 0 } } }
// output
{ "required": ["tasks", "total", "next_offset"],
  "properties": {
    "tasks": { "type": "array", "items": { "$ref": "#/$defs/TaskSummary" } },
    "total": { "type": "integer", "minimum": 0 },
    "next_offset": { "type": ["integer", "null"], "minimum": 0 } } }
```

- `status` defaults to the open ones: `backlog`, `ready`, `active`,
  `blocked`. Filters are by effective status, so `["blocked"]` is "has an open
  question" and `["ready"]` includes tasks whose claim expired. `ready: true`
  keeps only tasks ready by the rule (status `ready`, no open question,
  nothing it waits for open), intersected with `status`.
- `milestone: "none"` is tasks in no milestone; `MilestoneName` matches
  `none` too, and the store refuses `none` as a name, so the two never meet.
- `limit` defaults to 50, `offset` to 0; `next_offset` is null on the last
  page; `total` counts every match.
- Without `text`, newest first (`id` descending). With `text`, best match
  first (`bm25(task_fts)`), then newest.
- `text` goes to FTS5 `MATCH` as given; a query SQLite rejects is
  `invalid_argument` with `field: "text"` and SQLite's message in `sqlite`.
  This waits on the owner (open question 2).

Text: `3 tasks` / `3 tasks matching "lease expiry"` / `50 of 120 tasks; next_offset 50`.

### `task_read`

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
most 200. `cursor` is the id of the last event in the page, or `since` when the
page is empty (resolution 8); `more` says call again with `since: cursor`. The
task's fields are always whole, so the current state never needs a replay.
Refusals: `not_found`.

Text: `APP-12 active, held by @lead until 2026-10-12T16:00:00.000Z; 2 events since 420`.

### `task_next`

```json
// input
{ "properties": { "milestone": { "$ref": "#/$defs/MilestoneName" } } }
// output
{ "required": ["task", "from", "milestone", "waiting"],
  "properties": {
    "task": { "oneOf": [{ "$ref": "#/$defs/TaskSummary" }, { "type": "null" }] },
    "from": { "enum": ["current", "unassigned", "later", "milestone", null] },
    "milestone": { "oneOf": [{ "$ref": "#/$defs/Place" }, { "type": "null" }] },
    "waiting": { "type": "object", "additionalProperties": false,
      "required": ["blocked", "active", "waits_open"],
      "properties": { "blocked": { "type": "integer", "minimum": 0 },
                      "active": { "type": "integer", "minimum": 0 },
                      "waits_open": { "type": "integer", "minimum": 0 } } } } }
```

Order (resolution 7): ready tasks of the current milestone, then ready tasks
in no milestone, then ready tasks of later milestones in chain order; within
each, priority then oldest. An empty or exhausted current milestone falls
through. `from` says which rule picked the task: `current`, `unassigned`,
`later`, or `milestone` when an explicit `milestone` was given, which
restricts the search to it with no fallback; `null` when `task` is null.
`milestone` is the current milestone's place, or the explicit one's; null when
there is none. `waiting` counts the open tasks in the searched scope that are
not ready, by reason.

`task_next` only reads: it claims nothing, two callers may get the same task,
and the second `task_claim` gets `claim_held`. Refusals: `not_found` for an
explicit milestone.

Text: `next: APP-14 "Watch tool" (current milestone v1)`; `next: APP-20 "Bump deps" (no milestone; v1 has nothing ready)`; `nothing ready: 1 blocked on a question, 1 active, 2 waiting on other tasks`.

### `task_add`

```json
// input
{ "required": ["actor", "title"],
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
    "body": { "type": "string", "maxLength": 20000 },
    "priority": { "$ref": "#/$defs/Priority" },
    "parent": { "$ref": "#/$defs/KeyIn" },
    "milestone": { "oneOf": [{ "$ref": "#/$defs/MilestoneName" }, { "const": "none" }] },
    "waits": { "type": "array", "uniqueItems": true, "maxItems": 50,
               "items": { "$ref": "#/$defs/KeyIn" } },
    "status": { "enum": ["backlog", "ready"] } } }
// output
{ "required": ["task", "events"],
  "properties": { "task": { "$ref": "#/$defs/Task" }, "events": { "$ref": "#/$defs/Events" } } }
```

- Defaults: `body` `""`, `priority` `normal`, `status` `ready`
  (resolution 19). No duplicate detection (owner decision 5).
- `milestone` omitted: the parent's milestone if `parent` is given, else none
  (resolution 6). `"none"` puts it in no milestone explicitly.
- A done milestone takes the task and reopens: `milestone_reopened` is among
  the `events`.
- Refusals: `not_found` (parent, a wait, the milestone); `invalid_argument`
  (a title that is only whitespace, which the schema cannot refuse). A new
  task cannot close a loop, so there is no `cycle` here.

Events: `task_added`, and `milestone_reopened` when it applies.
Text: `added APP-17 "Claim error lacks the holder" (v1, under APP-12, ready)`.

### `task_update`

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
    "milestone": { "oneOf": [{ "$ref": "#/$defs/MilestoneName" }, { "const": "none" }] },
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

- `status` cannot be `active` (only `task_claim` makes a task active) or
  `blocked` (implied by an open question). The transitions are data's table:
  `backlog` ↔ `ready`; an open task to `done` (refused with an open question)
  or `cancelled` (withdraws its open questions); a closed task back to
  `backlog` or `ready` (reopens its milestone if done). Anything else is
  `invalid_transition` with `allowed`.
- An active task set to `ready`, `backlog`, `done` or `cancelled` loses its
  claim in the same transaction, whoever holds it (resolution 3):
  `claim_released` with reason `sent_back` or `closed`.
- Waits are added and removed, never replaced, so two writers do not lose
  each other's edits. The same key in both lists, or the task's own key, is
  `invalid_argument`; a wait or parent that closes a loop is `cycle`.
- An update that changes nothing writes nothing: `changed: []`,
  `events: []` (resolution 19).
- Moving into a done milestone, or reopening a task of one, reopens it.

Events, in this order, those that apply: `task_edited`, `task_moved`,
`waits_changed`, `task_status`, `claim_released`, `question_withdrawn`,
`milestone_done`, `milestone_reopened`.
Text: `APP-17: status backlog → ready, milestone v1 → v2` / `APP-17: nothing to change`.

### `task_claim`

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
- Refusals: `not_found`; `claim_held` when a live claim exists, by anyone,
  the same holder included (`next`: `task_extend` if it is yours);
  `not_ready` with `reason` `status`, `question` or `waits`.

Events: `claimed` (plus any `claim_expired` the sweep writes).
Text: `APP-14 claimed by @lead until 2026-10-12T15:33:00.000Z (90 min)`.

### `task_extend`

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
with the live claim's (resolution 3): it is not a role check, it stops a
caller acting on a stale view. Anyone may call it.
Refusals: `not_found`; `not_claimed` (no live claim, or expired: it is
claimed again, not extended); `claim_held` when `holder` differs, with the
current claim. Events: `claim_extended`.
Text: `APP-14 held by @lead until 2026-10-12T16:40:00.000Z (60 min from now)`.

### `task_release`

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
goes into `claim_released.data.note` (resolution 11). Refusals as
`task_extend`. To close and release at once, `task_update status: done`.
Events: `claim_released` with reason `release`.
Text: `APP-14 released by main (held by @lead since 2026-10-12T14:03:00.000Z)`.

### `task_comment`

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
`unchecked` are what changed, what was run and what is not checked, as
`docs/design.md` lists them. A handover is an event and nothing more: it moves
no claim and changes no status, and nothing in `text` is read. Comments on
closed tasks are allowed. Refusals: `not_found`. Events: `comment` or
`handover`. Text: `note on APP-14` / `handover on APP-14 from @lead to main`.

### `question_ask`

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

`recommended` is 1-based into `options` (resolution 4); past the end is
`invalid_argument`. The task becomes `blocked` until its last open question is
answered or withdrawn. Ids are `Q<n>`, one sequence per board. Refusals:
`not_found`; `invalid_transition` on a closed task. Events: `question_asked`.
Text: `Q7 asked on APP-14; APP-14 is blocked until it is answered`.

### `question_answer`

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
- **The owner's override** (resolution 5): `as: owner` on a question answered
  `as: delegate` and not yet validated replaces the answer. The question then
  reads `answer.as: "owner"`, `validated: null`, and leaves the to-validate
  list; the `question_answered` event carries `overrides` with the previous
  answer.
- Otherwise an answered question is `already_answered` (an owner's answer, a
  validated delegate answer, or a delegate answering again); a withdrawn one
  is `invalid_transition`.

Events: `question_answered`. Text: `Q7 answered by main as delegate: up to 8 at once; APP-14 unblocked; waits for the owner to validate` / `Q7: the owner's answer replaces the delegate's`.

### `question_validate`

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

### `question_list`

```json
// input
{ "properties": {
    "state": { "enum": ["open", "to_validate", "answered", "withdrawn", "all"] },
    "key": { "$ref": "#/$defs/KeyIn" } } }
// output
{ "required": ["questions"],
  "properties": { "questions": { "type": "array", "items": { "$ref": "#/$defs/Question" } } } }
```

`state` defaults to `open`; `to_validate` is answered `as: delegate` and not
validated. Oldest asked first. Refusals: `not_found` for `key`.
Text: `2 questions to validate`.

### `milestone_add`

```json
// input
{ "required": ["actor", "name", "delivers"],
  "not": { "required": ["before", "after"] },
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "name": { "$ref": "#/$defs/MilestoneName" },
    "delivers": { "type": "string", "minLength": 1, "maxLength": 500 },
    "before": { "$ref": "#/$defs/MilestoneName" },
    "after": { "$ref": "#/$defs/MilestoneName" } } }
// output
{ "required": ["milestone", "chain", "events"],
  "properties": { "milestone": { "$ref": "#/$defs/Milestone" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Goes last unless `before` or `after` names a milestone. `name` is unique
case-insensitively; `none` (any case) and a taken name are `invalid_argument`.
A new milestone is empty, so if it lands before the current one it becomes
current, and `task_next` falls through it (resolution 7). Refusals:
`not_found` for `before`/`after`. Events: `milestone_added`, and
`milestone_reordered` when not last. Text: `milestone v2 added at 3 of 5`.

### `milestone_update`

```json
// input
{ "required": ["actor", "milestone"], "minProperties": 3,
  "not": { "required": ["before", "after"] },
  "properties": {
    "actor": { "$ref": "#/$defs/Actor" },
    "milestone": { "$ref": "#/$defs/MilestoneName" },
    "name": { "$ref": "#/$defs/MilestoneName" },
    "delivers": { "type": "string", "minLength": 1, "maxLength": 500 },
    "before": { "$ref": "#/$defs/MilestoneName" },
    "after": { "$ref": "#/$defs/MilestoneName" } } }
// output
{ "required": ["milestone", "chain", "changed", "events"],
  "properties": { "milestone": { "$ref": "#/$defs/Milestone" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "changed": { "type": "array", "uniqueItems": true,
                               "items": { "enum": ["name", "delivers", "position"] } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Rename, re-describe, and move relative to another milestone (resolution 20).
There is no status field: a milestone is done when all its tasks are closed
and reopens when a task comes in. A move relative to itself, a taken name or
`none` is `invalid_argument`; `not_found` for the milestone or the anchor.
No change: `changed: []`, `events: []`. Events: `milestone_edited` with
`{field: {from, to}}`, `milestone_reordered`.
Text: `milestone v2 → v1.1, moved before v3`.

### `milestone_delete`

```json
// input
{ "required": ["actor", "milestone"],
  "properties": { "actor": { "$ref": "#/$defs/Actor" },
                  "milestone": { "$ref": "#/$defs/MilestoneName" } } }
// output
{ "required": ["deleted", "chain", "events"],
  "properties": { "deleted": { "$ref": "#/$defs/MilestoneName" },
                  "chain": { "type": "array", "items": { "$ref": "#/$defs/MilestoneName" } },
                  "events": { "$ref": "#/$defs/Events" } } }
```

Only an empty milestone; one with tasks, cancelled ones included, is
`invalid_transition` with `reason: "has_tasks"` and `next`: move its tasks
out with `task_update milestone: none` first. Later milestones shift up.
Events: `milestone_deleted`. Text: `milestone v2 deleted; 4 left`.

## Events

data's kind names are the one catalog (resolution 11). The `data` of each
kind, normative for the log, `task_read` and `board watch`; references in
`data` are public identifiers (keys, `Q<n>`, milestone names, priority words),
so a line reads without joins **[data]**.

| Kind | `data` |
| --- | --- |
| `board_created` | `{prefix}` |
| `board_paused` | `{why}` |
| `board_resumed` | `{}` |
| `task_added` | `{title, body, status, priority, parent, milestone, waits: [key]}` |
| `task_edited` | `{<field>: {from, to}}` for each changed field of `title`, `body`, `priority`, `parent` |
| `task_status` | `{from, to}` (stored statuses) |
| `task_moved` | `{from, to}` (milestone names or null) |
| `waits_changed` | `{added: [key], removed: [key]}` |
| `claimed` | `{holder, since, until, directory, branch}` |
| `claim_extended` | `{holder, from, until}` |
| `claim_released` | `{holder, reason, note}`; `reason` `release`, `closed`, `sent_back`; `note` string or null |
| `claim_expired` | `{holder, since, until, by}`; actor `board`, `by` the actor whose write swept it |
| `comment` | `{text}` |
| `handover` | `{to, text, changed, ran, unchecked}` |
| `question_asked` | `{question, text, options: [{label, detail}], recommended}` |
| `question_answered` | `{question, choice, text, as, overrides}`; `overrides` is the replaced `Answer` or null |
| `question_validated` | `{question}` |
| `question_withdrawn` | `{question, why}` |
| `milestone_added` | `{name, delivers, position}` |
| `milestone_edited` | `{<field>: {from, to}}` for each changed field of `name`, `delivers` |
| `milestone_reordered` | `{order: [name]}` |
| `milestone_deleted` | `{name}` |
| `milestone_done` | `{name}` |
| `milestone_reopened` | `{name, by}`; `by` the key of the task that reopened it |

Claim operations do not also write `task_status`: `board watch --kind
task_status` does not show claims; "what started" is `--kind claimed`.

## The CLI

`package:args` `CommandRunner<int>`; the exit code is the command's return.
Every command but `init` finds `.board/board.db` from the working directory
upward. (A location override, `--board` / `BOARD_DB`, waits on the owner.)

| Exit | When |
| --- | --- |
| 0 | done |
| 1 | refused by a rule or by the database: any error code above |
| 64 | usage: unknown command or flag, bad value, missing argument; `board sql` refusing a write |
| 130 / 143 | `board watch` interrupted by `SIGINT` / `SIGTERM` |

Output rules, from quarry:

- Data on stdout; notes (`3 rows`, `12 tasks`) and errors on stderr, so
  stdout pipes clean.
- `--json` on a command that prints data prints exactly the
  `structuredContent` of the matching tool, one JSON document. An error under
  `--json` is the error object on stderr.
- Times are the one format, `2026-10-12T14:03:00.000Z`; claims add the
  remaining time (`in 47m`).
- Writes from the CLI are recorded with actor `owner`; answers as `owner`.
- Tables are `dart_console`'s `Table`, plain text, no border (see "What was
  tried").

### Commands

```
board init --prefix KEY [--force]
board mcp
board status [--json]
board ls [--status S,…] [--milestone NAME|none] [--parent KEY] [--ready]
         [--search QUERY] [--limit N] [--offset N] [--json]
board show KEY [--since ID] [--json]
board next [--milestone NAME] [--json]
board questions [--state open|to_validate|answered|withdrawn|all] [--task KEY] [--json]
board answer QID [N] [--text TEXT]
board validate QID
board pause WHY…
board resume
board milestone [ls] [--json]
board milestone add NAME --delivers TEXT [--before NAME | --after NAME]
board milestone edit NAME [--name NEW] [--delivers TEXT] [--before NAME | --after NAME]
board milestone rm NAME
board watch [-f|--follow] [--since ID] [--kind K,…] [--task KEY,…] [--json]
            [--expiring-within MINUTES] [--exec CMD] [--exec-timeout SECONDS]
board sql QUERY [--json]
board help [COMMAND]
```

| Command | Tool | Notes |
| --- | --- | --- |
| `status` | `board_status` | |
| `ls` | `task_list` | `--search` is `text`; `--status` with `allowed:` |
| `show` | `task_read` | events printed as `board watch` prints them |
| `next` | `task_next` | prints its text line |
| `questions` | `question_list` | |
| `answer` | `question_answer` | `as: owner`; `N` is `choice`; `--text` alone is a free answer; neither is a usage error |
| `validate` | `question_validate` | |
| `pause` / `resume` | `board_pause` / `board_resume` | `pause` takes the rest of the line as `why`; an empty reason is a usage error |
| `milestone ls` / `add` / `edit` / `rm` | `board_status.milestones` / `milestone_add` / `milestone_update` / `milestone_delete` | |

**`board init --prefix KEY [--force]`.** Always works on the working
directory: it creates `./.board/board.db` there, and a board found further up
is neither refused nor touched, so a nested project gets its own board
(resolution 14). `KEY` is `^[A-Z][A-Z0-9]{0,9}$`. On an existing board it
refuses without `--force`, naming it. `--force` resets the board in place and
never unlinks the file (resolution 16); on a file that is not a readable board
(`damaged`, `not_a_board`) it refuses and says to move the file aside.
`--prefix` is required here; that waits on the owner (open question 5).
Prints `board initialised at .board/board.db, keys APP-1, APP-2, …`.

**`board mcp`.** The server on stdin/stdout; no flags; logs on stderr. It
starts and lists its tools with no board present; every call then answers
`no_board` until `board init` runs **[runtime]**.

**`board status`.**

```
milestone 2 of 5  v1  The tools and the CLI.  3 tasks left (5 done, 1 cancelled of 9)
tasks             2 ready, 1 active, 1 blocked, 4 backlog, 11 done, 1 cancelled
questions         1 open, 2 to validate

claims
KEY     HOLDER  UNTIL                     LEFT    DIRECTORY      BRANCH
APP-12  @lead   2026-10-12T16:00:00.000Z  in 47m  /work/app-wt2  feat/claims
```

Paused, a first line `PAUSED by main at 2026-10-12T14:03:00.000Z: owner reviewing v1`.

**`board ls`.**

```
KEY     STATUS  PRI     MILESTONE  HOLDER  TITLE
APP-14  ready   high    v1         -       Watch tool
APP-12  active  normal  v1         @lead   Claim tools
```

**`board questions`.**

```
Q7  APP-14  open  asked by @lead at 2026-10-12T14:10:00.000Z
    Should --exec run commands concurrently?
    1. sequential: simple, can fall behind
    2. up to 8 at once: as quarry  (recommended)
```

**`board milestone`** (`ls`):

```
POS  NAME  STATUS   LEFT  DELIVERS
1    v0    done     0     Storage and rules.
2    v1    current  3     The tools and the CLI.
3    v2    planned  0     board watch and board sql.
```

### `board watch`

Modelled on `quarry watch` (`../quarry/src/cli.ts`, `src/commands/status.ts`,
`src/call.ts`); the loop is runtime's.

**What it prints.** Every event, oldest first, one line each. board's log has
no chatter, so the default is every kind. `--kind` and `--task` narrow; both
are repeatable and comma-separated (`addMultiOption`). `--kind` takes the
catalog plus `claim_expiring`, through `allowed:`, so a misspelt kind is a
usage error listing the kinds. An unknown `--task` key is `not_found`.

**Where it starts.** Without `--follow`, from the beginning (`--since 0`): a
one-shot watch reads history, and `board watch --task APP-4` is that task's
whole log. With `--follow`, from now; `--since ID` starts after ID in either
mode.

**The human line**, tab-separated as quarry's: time, `#id` (`-` for a derived
line), task (`-`), actor, kind, a summary written from `data`.

```
2026-10-12T14:03:00.000Z  #436  APP-14  main   claimed         @lead for 90 min, until 2026-10-12T15:33:00.000Z, feat/watch
2026-10-12T14:10:00.000Z  #443  APP-14  @lead  question_asked  Q7: Should --exec run commands concurrently?
2026-10-12T15:23:00.000Z  -     APP-14  board  claim_expiring  @lead's claim ends at 2026-10-12T15:33:00.000Z (in 10m)
```

**`--json`**, one object per line, flushed per line. Logged and derived lines
have one flat shape (resolution 22):

```json
{ "type": "object", "additionalProperties": false,
  "required": ["id", "derived", "at", "actor", "kind", "task", "milestone", "data"],
  "properties": {
    "id": { "type": ["integer", "null"], "minimum": 1 },
    "derived": { "type": "boolean" },
    "at": { "$ref": "#/$defs/Time" },
    "actor": { "type": "string" },
    "kind": { "oneOf": [{ "$ref": "#/$defs/Kind" }, { "const": "claim_expiring" }] },
    "task": { "oneOf": [{ "$ref": "#/$defs/Key" }, { "type": "null" }] },
    "milestone": { "type": ["string", "null"] },
    "data": { "type": "object" } } }
```

A logged line is the `Event` with `derived: false`. A derived line has
`id: null`, `derived: true`, `actor: "board"`, and is never written to the
log; each watcher derives its own. A consumer tracking the last id it saw
never advances onto a derived line.

```json
{"id":436,"derived":false,"at":"2026-10-12T14:03:00.000Z","actor":"main","kind":"claimed","task":"APP-14","milestone":"v1","data":{"holder":"@lead","since":"2026-10-12T14:03:00.000Z","until":"2026-10-12T15:33:00.000Z","directory":"/work/app-wt2","branch":"feat/watch"}}
{"id":null,"derived":true,"at":"2026-10-12T15:23:00.000Z","actor":"board","kind":"claim_expiring","task":"APP-14","milestone":"v1","data":{"holder":"@lead","until":"2026-10-12T15:33:00.000Z","minutes_left":10}}
```

**`claim_expiring`**, the one derived kind; `data` is
`{holder, until, minutes_left}`.

- Only under `--follow`: it is about now.
- Once per lease per watcher, when the claim's `until` comes within the
  threshold; on attach for claims already inside it. An extend is a new
  deadline and can warn again.
- The threshold is runtime's default, `min(10 minutes, a quarter of the
  lease)`; `--expiring-within MINUTES` (1–1440) replaces it with a fixed one.
- `--task` narrows it like any line; `--kind` selects it like any kind.
- Best effort while an `--exec` command runs (resolution 10).
- `claim_expired` is a logged event, written by whichever write sweeps it
  next; a watcher never writes.

No heartbeat (resolution 22): a stream that has gone quiet says nothing.

**`--exec CMD`** needs `--follow` (a one-shot `--exec` would call once per
line of history), else a usage error. For every line printed, in stream
order, one at a time, `CMD` runs through `sh -c` with:

- on stdin, the line's JSON (the object `--json` prints) and a newline;
- in the environment, all always set, empty where there is nothing:
  `BOARD_EVENT_ID` (empty on a derived line), `BOARD_EVENT_KIND`,
  `BOARD_EVENT_AT`, `BOARD_TASK`, `BOARD_ACTOR`, `BOARD_SUMMARY` (the human
  line's last field);
- its stdout and stderr copied to the watcher's stderr, never into the
  stream.

Runtime's policy (resolution 10): sequential, nothing dropped (while a command
runs the watcher does not read; the events wait in the database); a command
running past `--exec-timeout SECONDS` (1–3600, default 30) gets `SIGTERM`,
then `SIGKILL` 2 s later; a failing command is one line on stderr,
`--exec: exited 2: <command>`, and the stream goes on. The cursor advances
whether or not the command succeeded.

On `board_reset` the watcher prints one line on stderr and exits 1: its
cursor belongs to the old board (resolution 2).

```sh
board watch -f --kind handover,question_asked,claim_expiring \
  --exec 'terminal-notifier -title board -message "$BOARD_EVENT_KIND $BOARD_TASK"'
```

### `board sql`

Modelled on `quarry sql` (`../quarry/src/commands/sql.ts`), without its
statement scanner.

```sh
board sql "select (select prefix from board) || '-' || id as key, title from task where status = 'ready'"
board sql --json "select kind, count(*) as n from event group by kind order by n desc"
```

The query is the stored schema, not the tools' view: keys are not stored
(`id` is the `n` of `APP-n`), `blocked` is not a stored status, and an
expired claim is still a row until a write sweeps it.

**The boundary** (resolution 21). The query runs on a read-only connection
(`OpenMode.readOnly`) and only if SQLite marks the prepared statement
read-only (`isReadOnly`) or it is an `EXPLAIN`. That is the whole rule; there
is no parser of ours. In practice:

- Runs: `SELECT`, `WITH … SELECT`, `VALUES`, `EXPLAIN` of anything, `PRAGMA`
  reads SQLite marks read-only, and a bare `ATTACH`, which stays read-only
  because the connection is.
- Refused before anything runs: every statement SQLite does not mark
  read-only, `INSERT`/`UPDATE`/`DELETE`/DDL, `PRAGMA x = …`, `VACUUM`
  (including `VACUUM INTO`), `BEGIN`, and a few harmless reads SQLite marks as
  possibly writing, such as `PRAGMA journal_mode`.
- One statement per call: a second statement is a usage error, "one statement
  at a time"; a trailing `;` or comment is fine.
- No parameters: a `?` or `:name` is a usage error, "`board sql` takes no
  parameters; write the value into the query".
- A query that fails as SQL prints SQLite's own message, unwrapped, exit 1.

Exactly one positional argument; zero or more is a usage error saying
`quote the query: board sql "select …"`.

Output: a table with a header row, `NULL` for null so it differs from the
empty string, blobs as hex, then `2 rows` on stderr:

```
key     title
APP-14  Watch tool
APP-15  Lease expiry
```

`--json`: an array of objects, one per row, column names as keys, integers as
numbers, blobs as hex strings.

The refusal, exit 64:

```
board: `board sql` reads; it does not write. A change goes through the tool or command that owns it (task_update, task_claim, question_answer, board pause, …), so the board and its log move together. For what no command reaches, sqlite3 against .board/board.db is the last resort, and nothing checks what it does.
```

## How the tools map onto the rules

| Rule | Where it shows |
| --- | --- |
| Every write appends its events in its transaction | `events` in every write; `task_read.since` / `cursor`; `board watch` |
| A task is ready when … | `ready` on every task; effective `status`; `task_list.ready`; `task_next`; `not_ready` |
| A claim is a lease set by the claimer | `task_claim.minutes` required; `task_extend`; `task_release`; `holder` as compare-and-set |
| Expiry frees the task | expired claims read as absent; `claim_expired` in the log; `claim_expiring` derived by `watch` |
| Directory and branch are informational | in `Claim`, `board_status`, `board status`; never in a refusal |
| A question blocks its task | `question_ask` answers with the task `blocked`; the last answer unblocks |
| Delegate answers wait for validation | `as` required; `question_list` `to_validate`; `question_validate`; the owner's override |
| A pause refuses writes | `paused` on every write but `board_resume` |
| Milestones, the current one first | `Milestone.status`; `board_status.current`; `task_next.from`; findings take the parent's milestone; a done milestone reopens |
| No duplicate detection; FTS5 search | `task_add` adds; `task_list.text`, `board ls --search` |
| `sql` refuses writes | the boundary above |
| A reset is noticed | `board_reset` on the next call; `watch` exits |

## Assumptions on the other drafts

Most first-draft assumptions are now resolutions. What remains:

**On data:**

1. Event `data` uses public identifiers (keys, `Q<n>`, milestone names,
   priority words), as the table under "Events" shows; data's draft uses
   `n`, `answer` and `chosen` in question events and stores priority as an
   integer.
2. An answer may be a `choice` with no `text`; data's `answer` column is
   required text today.
3. `why` is required on a pause; data's `board_paused` allows null.
4. Question options are stored as `{label, detail}` objects (resolution 4);
   data's draft stores strings.
5. Keys and question ids are matched case-insensitively.
6. `milestone_add` with `before`/`after` writes `milestone_reordered` beside
   `milestone_added`.

**On runtime:** the `--exec` environment, `--exec-timeout` in seconds, the
interrupt exit codes, and `board mcp` starting without a board, as runtime's
draft describes them.

## Open questions

1. *Decided (resolution 12).* `mcp_dart`'s input-validation refusals keep the
   package's shape; board's own errors keep the one shape.
2. **Full-text queries in FTS5 syntax.** `text` goes to `MATCH` as given;
   `claim-expired` or an unbalanced `"` is an FTS5 syntax error, which board
   reports as `invalid_argument` with SQLite's message. Options: (a) keep it
   and say in the tool description "FTS5 syntax; quote phrases"; (b) have
   board quote every word, which is rewriting the input to the package and
   loses `OR`, `NEAR` and prefix `*`; (c) offer both, `text` raw and `words`
   quoted by board. Recommended: (a), with (c) if agents trip on it in use.
   (b) and (c) need the owner's word under the one rule.
3. **Pause and the owner's answers.** "Every write" refuses while paused,
   which includes `board answer` and `question_answer`, though answering is
   often what a pause is for. Options: (a) refuse them like any write;
   (b) let `question_answer`, `question_validate` and the CLI's `answer` and
   `validate` through. Recommended: (b), as an owner's decision.
4. **`question_validate` as a tool.** It lets main record the owner's
   approval given in the chat window; it also lets any agent mark a
   delegate's answer checked, since board checks no roles. Options: (a) the
   tool, trusted like every `actor`; (b) CLI only, so validation is always the
   person at a terminal. Recommended: (a), consistent with owner decision 2.
5. **`board init` without `--prefix`.** `docs/design.md` makes it optional.
   No default is not a guess (the directory's name may not fit the key
   pattern). Proposed: required. Alternative: a fixed default such as `TASK`.
6. **Handover moving the claim.** A handover is only an event here. Should a
   handover `to` an agent also move the claim's holder to it? Proposed: no;
   holders change through `task_release` and `task_claim`, which keeps one
   way to move a lease.
7. **No task writes in the CLI.** The CLI has no `add`, `update` or `release`;
   a person files work by asking main. If the owner wants to file from the
   terminal, `board add TITLE [--body] [--milestone] [--parent]` maps onto
   `task_add` with actor `owner` and needs nothing new.
8. **Table output.** `dart_console`'s `Table` (tried, above) fits except that
   it counts characters, not terminal cells, so a cell with wide characters
   misaligns the rest of its row, and a cell with a newline becomes several
   lines. Options: (a) take it as is; `--json` is the exact form;
   (b) write the padding ourselves, a few lines measuring display width,
   recorded in `docs/decisions.md`; (c) no tables: tab-separated rows, as
   `watch` prints, which align nowhere but parse everywhere. Recommended: (a).
