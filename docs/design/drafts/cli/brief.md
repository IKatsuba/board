# Brief: board without MCP, agents on the CLI

## The problem

v1 is built: `board mcp` serves seventeen tools over stdio
(`@modelcontextprotocol/server` 2.3.1, `src/mcp/server.ts`), and the CLI is
for a person checking in. The owner's direction: "MCP is not needed here at
all; teach agents to do everything through the CLI." So:

- `board mcp`, `src/mcp/`, `@modelcontextprotocol/server` and
  `@modelcontextprotocol/client`, and the MCP parts of `docs/design.md` and
  `docs/decisions.md` go.
- Every operation a tool offered becomes a CLI command an agent runs from its
  shell. The CLI stops being "for a person, never needed for the work".
- `board skill` prints the text that teaches an agent how (stdout only,
  stores nothing).

The design to change is `docs/design.md` (sections "Which project a call is
about", "`.mcp.json`", "The MCP server", "The CLI", "Runtime", "Module
layout", "Tests", "How it runs with chord", "Not in scope", Appendix B) and
decisions 1, 2, 13, 18, 24 (the pin), and any other entry that names a tool.
Read `README.md`, `docs/design.md`, `docs/decisions.md`, `CLAUDE.md`, and the
code under `src/cli/`, `src/board.ts`, `src/schemas.ts`, `src/mcp/server.ts`
and `test/` as it is: the design describes what is built.

## Constraints

- **Rules, store and concurrency stay as they are.** `rules/`, `board.ts`,
  `store/`, the schema (Appendix A), the 17 error codes (+ `registry`), the
  expiry sweep on every write, `watch`, `sql`, `upgrade`. Each CLI call is
  one short process with one connection, as the CLI already is.
- **Appendix B's output schemas become the CLI's JSON contract.** `--json`
  on a command prints what the old tool's `structuredContent` was. Shapes may
  change where the CLI needs it (no release yet, no compatibility owed), but
  say why each change is made.
- **The one rule** (CLAUDE.md): take a library before writing one. cliffy
  stays the CLI. Input that the MCP SDK validated (Ajv over the input
  schemas) is now cliffy's to parse; if something cliffy does not do is
  needed (validating a JSON argument, reading stdin), look for a package
  first and record what was tried. Do not write a workaround around a package
  on your own call: bring it to the lead with options.
- No change to `src/`, `test/`, `tool/`, `docs/plan.md`. Drafts only.
- Everything in English; no private paths in the drafts.

## Non-goals

- A daemon, a socket, a long-lived server of any kind in place of MCP.
- Changing the rules of claims, readiness, questions, milestones.
- Task writes "for people": the CLI's writes now exist for agents; a person
  can run them too, and that is fine, but nothing is designed for a person
  beyond what exists (`status`, `ls`, `show`, `answer`, `validate`, …).
- Teaching chord anything (no change to chord's code).
- Storing the guide anywhere (no file written, no row).

## Who answers what

### interfaces (`interfaces.md`)

1. **The command tree.** Every operation of the 17 tools as a command: names,
   positional arguments, flags, short flags, which existing commands stay as
   they are (`status`, `ls`, `show`, `next`, `questions`, `answer`,
   `validate`, `milestone …`) and which are renamed or regrouped (for
   instance a `task` group: `task add/update/claim/extend/release/comment`,
   `question ask/answer/validate/list`). Keep the existing names where they
   fit; justify every rename. One full synopsis, as "The CLI" has now.
2. **Every tool input mapped to a flag or argument**, including the awkward
   ones: `waits_add` / `waits_remove`, `milestone: none`, `parent` set and
   cleared, `task_comment` kind `note` vs `handover` with `to`, `text`,
   `changed`, `ran`, `unchecked` (lists?), question `options` as
   `{label, detail?}` 2–6 with `recommended`, `task_read`'s `since` /
   `cursor` paging, `task_list`'s paging, claim `directory` / `branch`.
3. **Long text.** How an agent passes a body, a comment, a handover's fields,
   a question's text and options safely through a shell: inline flag, `-` for
   stdin, `@file` or `--*-file`, JSON on stdin for a whole input object.
   Quoting rules the guide teaches (single quotes, heredoc). What happens
   with stdin on a TTY, empty input, a trailing newline.
4. **Output.** Human form per command (one line for writes, tables for
   lists), `--json` per command = the old structuredContent. Where `--json`
   goes (stdout), where an error goes under `--json` and without it.
5. **Errors for an agent.** The 17 codes: stderr text, exit codes (one code
   for every refusal, as now, or a code per error class?), the error object
   under `--json`. Usage errors (cliffy `ValidationError`, exit 64) take the
   place of the SDK's `Input validation error`: say how an agent tells them
   apart and what it sees. An agent must act without parsing prose.
6. **actor and the pin, the surface.** Options: (a) `--actor` on every write;
   (b) `BOARD_ACTOR` set once per session; (c) both, the flag winning; and
   what a missing actor does (refuse with which code; or default to
   `owner`, as the CLI does now). The project pin becomes `BOARD_PROJECT`
   and/or `-p`. Recommend one; the lead takes the actor to the owner.
7. **`board skill`.** What it covers (the model in a paragraph; flows for
   `main`, a lead, a member: `next`, `claim` with an estimated lease,
   `extend` / `release`, comment and handover, `ask` when a choice is the
   owner's, `ls --contains` before filing, `watch --follow` in the
   background for `claim_expiring`; errors and what to do per code). How it
   stays in step with the commands: generated from the cliffy tree (as
   `../quarry/src/guide.ts` walks quarry's CLI) or written text with a test
   that every command and flag it names exists. Whether it takes an argument
   (a role, a topic). **Write the text itself** in the draft.
8. The README's "Planned use" and the chord section, from the agent's side.

### data (`data.md`)

1. **Appendix B after MCP.** Input schemas: removed, or kept as the contract
   cliffy's parse must produce (and then validated by what, if anything)?
   Output schemas: kept as the JSON contract; how a test holds `--json` to
   them now that no SDK validates output at run time (Ajv directly in tests?
   at run time?). Whether `json-schema-to-ts` and `src/schemas.ts` stay.
   Which shapes change for the CLI and why.
2. **Validation that moves.** Every check the SDK's Ajv made on input
   (patterns, ranges, enums, `if/then/else`, `not`, `anyOf`,
   `minProperties`, `uniqueItems`): list each, and say where it lives now
   (cliffy type, `Board`/rules, or gone because the CLI shape cannot express
   the bad input). Which error code each produces (usage 64 or
   `invalid_argument`). Decision 13's exception goes; say what replaces it.
3. **actor in the data.** The event's `actor`, `created_by`, `asked_by`,
   claim `holder`: what changes when the actor comes from a flag or the
   environment, and the reserved `board`. The `owner` actor the CLI writes as
   today: does it stay a default, and what does `answered_as` / `as: owner`
   mean when anyone can run `board answer`?
4. **Per-call cost on the store.** Each call opens the file, checks
   `application_id` / `user_version`, runs pragmas, and (writes) sweeps.
   Anything in "File and connections" or "Every operation" that assumed a
   long-lived connection (prepared statements, the per-process cache, the
   retried `no_board`) and now reads differently.
5. Decisions to replace or amend on the data side.

### runtime (`runtime.md`)

1. **Start-up cost per call.** Measure the compiled binary (`bun run
   build:arm64` writes `build/`, which is allowed; do not change sources):
   `board --version`, a read (`board ls --json`) and a write (an `add` +
   `claim` against a temp `BOARD_DIR`), wall time over many runs, cold and
   warm, through the npm shim and direct. Say whether it matters for an
   agent's loop and what, if anything, to do about it (Prisma client start,
   lazy imports).
2. **Process model.** One process per call: the busy wait and Ctrl-C (the
   CLI already has a rule), git resolution per call (no long-lived cwd, no
   shared pending git; cost when the cwd misses), stdin reading (EOF, TTY,
   size limit), SIGPIPE when stdout is closed, exit codes as the shell sees
   them. The failure table, re-read without `board mcp`.
3. **`watch --follow` in the background** as the agent's notifier: how an
   agent runs it (`&`, chord's background shell), what it should and should
   not do with `--exec`.
4. **Module layout** after `src/mcp/` goes, and dependencies removed
   (`package.json`), including what the build and `tool/release.sh` smoke test
   lose (the stdio smoke test becomes a CLI smoke test).
5. **The test plan.** CLI tests replace the in-process MCP client tests: what
   each MCP test becomes, how a test runs a command (in process with
   `.noExit()` and injected sinks and stdin, as now), the binary smoke test.
   A test that keeps `board skill` in step with the commands.
6. **The chord section**: agents call board from their shell; nothing in
   `.mcp.json`; how `BOARD_ACTOR` / `BOARD_PROJECT` (if chosen) get into an
   agent's environment without a change to chord (team file instructions?
   chord's agent env?). Say what you can verify about chord.
7. Decisions to replace or amend on the runtime side.

## For everyone

- Write only your own draft. Questions for another architect go through the
  lead.
- Each choice: the options, the pick, why. Library tries: name, version,
  what was tried, what happened.
- Mark anything that is the owner's to decide as **Owner** with the options
  and your recommendation. The actor shape is expected to be one.
