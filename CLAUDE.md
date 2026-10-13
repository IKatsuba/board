# CLAUDE.md

This file provides guidance to Claude Code and any other agent working in this
repository. It is binding.

## What this is

board is a local task board for coding agents: one SQLite file per machine,
holding every project, read and written by agents and by a person through
the `board` CLI; `board skill` prints the guide that teaches an agent. `README.md` is the pitch and `docs/design.md` is the
design. Read both before the first change.

The repository is public-ready from the first commit: everything in it —
code, comments, docs, commit messages, test names — is in English, and
nothing in it names a private path, a key, or a person's machine.

board has had no release: the database schema and the tools' shapes change
freely, with no migration and no reading of old formats, until the first
release.

## The one rule

**Take a library before writing one.** Before writing a parser, a protocol
helper or a storage layer, look for a maintained npm (or JSR) package that
works under Bun and inside a `bun build --compile` binary, try it, and say in
the handover what you tried. Writing our own is the answer only when the
package is shown not to fit, and that finding goes into `docs/decisions.md`.

When a package does not do directly what the task asks, do not write a
workaround around it on your own call: no rewriting its input, no guessing at
ambiguous input, no patching its behaviour. Stop and hand the owner the
question with the options, including changing what the task asks so the
package fits as it is.

## Stack

- Bun 1.4 or newer and TypeScript, built with `bun build --compile` into one
  file per platform. macOS 13 or newer only, arm64 and x64, both built on an
  arm64 Mac.
- Signed with a Developer ID (hardened runtime, `allow-jit`), notarised, and
  published by `tool/release.sh` on the owner's Mac; CI only runs the checks
  and tests.
- Distributed through npm only: `@chorded/board` and one package per
  platform (`@chorded/board-darwin-arm64`, `@chorded/board-darwin-x64`), as
  esbuild does it. The command is `board`.
- `@cliffy/command` for the command line, `@cliffy/table` for tables (from
  JSR, through `npm.jsr.io`).
- Prisma 7 with `prisma-adapter-bun-sqlite` for storage, over the system
  SQLite, in WAL mode. Every write is one Prisma `$transaction` whose first
  statement takes the write lock (`UPDATE project SET id = id WHERE 0`); only
  `Store` touches the client. Appendix A of `docs/design.md`, as
  `src/store/ddl.ts`, is the schema; `prisma/schema.prisma` is pulled from it.
  `board watch` and `board sql` read through `bun:sqlite` directly.
- `bun test` for tests; `tsc --noEmit` and Biome for types, format and lint.

## Commands

```sh
bun install
bun run gen                         # schema.db, schema.prisma, the client and TypedSQL
bun src/main.ts <command>           # run from source (after gen)
bun run test                        # gen, then every test
bun run check                       # gen, schema.prisma unchanged, tsc, biome ci, bun test
bunx biome format --write .         # layout
bun run build:arm64                 # build/darwin-arm64/board
bun run build:x64                   # build/darwin-x64/board, cross-compiled
sh tool/release.sh --dry-run        # the owner's release, short of publishing
```

`bun run check` passes before every commit.

## How code is written

- **Logic lives where a test reaches it.** The board's rules (what a claim
  allows, when a task is ready, what a refusal keeps) are pure TypeScript
  over the store, tested against an in-memory database, not through the CLI.
- **Tests never reach a real agent.** Commands are tested in process
  through `runCli` with injected sinks; concurrency across spawned
  processes; `--json` against Appendix B's output schemas with Ajv.
- **Comments say why, not what.** A doc comment on a type says what it is for.
- **Commit messages carry no trailers** — nothing after the body.
  Conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`) with a scope
  where it helps.
