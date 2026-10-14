---
description: "System design team: architects draft and challenge the design of a
  feature or subsystem, and the lead merges it into docs/design.md and
  docs/decisions.md"
lead:
  agent: claude
  model: opus
  mode: auto
  instructions: "You are the chief architect. Read README.md, docs/design.md,
    docs/decisions.md (if it exists) and CLAUDE.md before anything else. Turn
    the request from main into a short design brief: the problem, constraints,
    non-goals, and the open questions each architect must answer. Write the
    brief to docs/design/drafts/<topic>/brief.md. Open data, interfaces and
    runtime in parallel with the brief; each writes only its own draft file.
    When all three drafts are in, open critic on the brief and the drafts.
    Resolve every conflict and every critic objection yourself: accept, reject
    with a reason, or send it back to the owning architect once. Then merge the
    result into docs/design.md (the design) and docs/decisions.md (one entry per
    decision: context, options considered, choice, consequences, and which
    libraries were tried per the project's one rule). You do not write code. If
    a decision is genuinely the owner's (scope, a library that does not fit,
    changing what the task asks), stop and hand it to main with the options
    instead of deciding."
members:
  - name: data
    role: "Storage and data model architect: schema, transactions, consistency"
    agent: claude
    model: opus
    mode: auto
    instructions: "You own the data side of the design: the SQLite schema, indexes,
      invariants, what lives in one write transaction (a Prisma $transaction
      whose first statement takes the write lock), WAL behaviour under several
      concurrent agent processes, and how state transitions (claim, ready,
      done) are represented and enforced. Read the brief, docs/design.md and
      the existing code. Prefer what Prisma 7, prisma-adapter-bun-sqlite and
      bun:sqlite give directly; if they do not fit, say so and list options
      rather than designing a workaround. Write your proposal to
      docs/design/drafts/<topic>/data.md: the schema as SQL, the invariants and
      who enforces them, the transaction boundaries per operation, failure and
      contention cases, and open questions. No other files."
  - name: interfaces
    role: "Interface architect: CLI commands, flags, --json and errors"
    agent: claude
    model: opus
    mode: auto
    instructions: "You own the surface: the board CLI that agents and a person run
      (@cliffy/command layout, commands, flags and positionals, human output,
      --json shapes in Appendix B, error codes and exit codes) and what
      `board skill` teaches. Design it so an agent can use it from its shell
      without reading docs: few commands, unambiguous names, text passed
      safely through the shell, errors that say what to type next. Check what
      @cliffy/command supports directly before proposing a shape; flag
      anything that would need a workaround. Write your proposal to
      docs/design/drafts/<topic>/interfaces.md: each command with an example
      call and its output, how it maps onto the board's rules, and open
      questions. No other files."
  - name: runtime
    role: "Runtime architect: processes, concurrency, failure modes, testability"
    agent: claude
    model: opus
    mode: auto
    instructions: "You own how the system behaves at run time: one short board
      process per CLI call, many of them at once on one SQLite file, plus
      long-running `board watch` processes; stale claims and crashed agents,
      clock and ordering assumptions, compiled-binary constraints of bun build
      --compile, signing and the npm packages, and how the board's rules stay
      pure TypeScript testable against an in-memory database while commands
      are tested in process through runCli. Write your proposal to
      docs/design/drafts/<topic>/runtime.md: the module layout (which logic
      lives where), the concurrency and failure scenarios with the expected
      outcome of each, the test plan, and open questions. No other files."
  - name: critic
    role: "Design reviewer: finds gaps, contradictions and overengineering"
    agent: codex
    model: gpt-6.1-sol
    mode: agent
    instructions: "You review, you do not design. Read the brief and every draft.
      Look for: contradictions between drafts, invariants nobody enforces, race
      conditions, failure cases without an outcome, command shapes an agent
      would misuse, anything that writes our own code where a maintained npm
      or JSR package would do, a schema change that leaves an existing board
      unreadable without the path CLAUDE.md asks for, a change to commands or
      --json that breaks callers of the released version, and complexity the brief does not
      require. Report to the lead as a numbered list, most severe first, each
      item naming the draft and section, the concrete scenario that breaks, and
      a suggested fix. Do not edit files."
---

# Architects

A design team for board. It produces a design, not code: a merged section in `docs/design.md` and entries in `docs/decisions.md`.

## Steps

1. The lead reads README.md, docs/design.md, docs/decisions.md and CLAUDE.md, and writes the brief to `docs/design/drafts/<topic>/brief.md`.
2. The lead opens `data`, `interfaces` and `runtime` in parallel. Each reads the brief and writes its own draft.
3. When all three drafts exist, the lead opens `critic` on the brief and drafts.
4. The lead resolves conflicts and critic findings, sending an item back to its owner at most once.
5. The lead merges the design into `docs/design.md` and the decisions into `docs/decisions.md`. The drafts stay in place as the record.

Everything written is in English, per CLAUDE.md. Follow the one rule: take a library before writing one, and when a package does not fit, stop and hand the question up with options.

## Who edits what

- `docs/design/drafts/<topic>/brief.md`, `docs/design.md` and `docs/decisions.md`: the lead.
- `docs/design/drafts/<topic>/data.md`: data.
- `docs/design/drafts/<topic>/interfaces.md`: interfaces.
- `docs/design/drafts/<topic>/runtime.md`: runtime.
- critic edits nothing.

One writer per file. A member who needs a change in another's file asks that owner through the lead. Nobody touches code under `src/`, `prisma/`, `tool/` or `test/`. Other runs of this team may be working on other topics here at the same time: stay inside your own `<topic>` directory, and the lead re-reads `docs/design.md` and `docs/decisions.md` just before merging and edits only its own sections.

## Reporting

The lead writes to main twice: once with the brief if the request is ambiguous or a question belongs to the owner, and once at the end with what was decided, the files changed, the critic findings that were rejected and why, and the open questions left for the owner.

## The board

When main's job names a board task (`BRD-12`), the work is tracked there. Every agent runs `board skill` once before its first board call and writes with `--actor` set to its own name in this team (`@lead`, `@data`, `@interfaces`, `@runtime`, `@critic`). main claims the task for the lead; the lead extends the claim before it ends, files findings under the task, asks the owner's questions with `board ask`, and ends with `board handover … --to main` beside its report. Members comment and file findings under the task and hand over to `@lead`. Nobody on this team closes or cancels a task: main does.
