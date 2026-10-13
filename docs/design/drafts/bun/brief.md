# Brief: board on Bun, TypeScript and Prisma 7

## The problem

The Dart implementation was deleted (commit 9d30b3c). The owner moves board to
Bun and TypeScript, with Prisma 7 as the ORM over SQLite. The design in
`docs/design.md` stays: every owner decision in `docs/decisions.md` (actor,
one tool set, claims with team-set leases and `task_extend`, watch with
`claim_expiring`, read-only `board sql`, no FTS, no pause, one board per
machine at `~/.board` with `BOARD_DIR`, projects from cwd then git, a required
key, macOS only arm64 and x64, npm only as `@chorded/board` with per-platform
packages, Developer ID signing and notarisation by a local release script,
`roost-notary`, team `YQ8ZD2KZ3T`, `dev.katsuba.board`, x64 a known risk, WAL
set before the creating transaction of `project add`) holds unless Bun or
Prisma 7 makes it impossible.

What changes is every place the design names Dart, its packages or its
toolchain: storage access, transactions, the MCP server, the CLI, tables,
tests, module layout, build, signing and release. Read the team file's Dart
names (`package:sqlite3`, `mcp_dart`, `args`, `dart build cli`) as "the
stack's equivalent".

## Constraints

- Bun (1.4.3 on this machine) and TypeScript. One binary per platform from
  `bun build --compile`, darwin-arm64 and darwin-x64, no runtime the user must
  install.
- Prisma 7 as the ORM over SQLite, with a driver adapter (no Rust query
  engine). The owner named Prisma: if it cannot carry a requirement, that is
  the owner's question, with options, not a workaround of ours.
- The storage rules stay: WAL, `foreign_keys = ON`, `busy_timeout = 5000`,
  `synchronous = FULL`, every write one `BEGIN IMMEDIATE` (no deferred write
  upgraded), `SAVEPOINT op` so a refused operation keeps its sweep,
  `application_id` / `user_version`, `STRICT` tables, `CHECK`s, composite
  foreign keys, the append-only `event` trigger, `DELETE … RETURNING`, `now`
  sampled after the lock. Several `board mcp` processes on one file.
- `board sql`: one statement, SQLite's own read-only judgement (read-only
  open + `sqlite3_stmt_readonly` + no tail), temp views for `-p`, no parser of
  ours.
- `board watch` polls `PRAGMA data_version` on a read-only connection.
- The tool shapes (Appendix B) and the CLI surface do not change, except
  where a library forces it; such a change is named and justified.
- The project's one rule: take a library before writing one; every package
  named is tried on this machine, and the decision entry names what was tried
  (package and version). No workaround around a package on our own call.
- Tests never reach a real agent; the MCP server is tested in process.
- Nothing is committed. Nobody writes code under `src/`, `bin/`, `test/`;
  throwaway probes live under `/tmp` or `docs/design/drafts/bun/probes/` (not
  in the repository's code tree), and are named in the draft.

## Non-goals

- Changing the model, the tools, the rules, or any owner decision.
- Linux, Windows, Homebrew, tarballs, migrations, reading old formats.
- Running notarisation (signing is verified; `notarytool` is not run).

## Who answers what

Each architect writes only `docs/design/drafts/bun/<name>.md`, with evidence
(commands run, versions, outputs that matter). Where an answer needs a probe
another architect also needs, say so in the draft; the lead reconciles.

### data (storage)

1. **Adapter.** Which Prisma 7 driver adapter for SQLite under Bun:
   `@prisma/adapter-better-sqlite3` (native addon: does it load in Bun, and in
   a compiled binary?), `@prisma/adapter-libsql`, a maintained `bun:sqlite`
   adapter if one exists. Try each that is plausible; give versions.
2. **BEGIN IMMEDIATE.** Can Prisma's interactive `$transaction` begin
   `IMMEDIATE` with the chosen adapter? If not, what is the minimal way that
   fits the one rule (an adapter option, a raw `BEGIN IMMEDIATE` on a pinned
   connection, the adapter used below Prisma)? Read `../quarry/src/db.ts`
   (libsql adapter, its notes on `ROLLBACK`, `busy_timeout` blocking the
   event loop, a poisoned connection after a timeout) before deciding. Show,
   with two processes on one file: the lock is taken at `BEGIN`, the second
   writer waits out `busy_timeout` and gets a recognisable busy error,
   `SAVEPOINT` / `ROLLBACK TO` works inside, the sweep commits under a refused
   op, and a connection is usable after a busy failure.
3. **Pragmas.** How `foreign_keys`, `busy_timeout`, `synchronous`,
   `journal_mode = WAL` (outside a transaction, before `project add`'s
   transaction), `application_id`, `user_version` are set per connection, and
   whether the adapter pools connections (one connection per process is the
   design).
4. **Schema without migrations.** How the schema becomes the database: `prisma
   db push` at run time is not available in a single binary; generated SQL
   embedded in the binary as quarry's `migrations.gen.ts` does; or
   hand-written DDL (Appendix A) with Prisma's schema introspected or kept in
   step by a test. Can Prisma's schema express `STRICT`, `CHECK`, composite
   foreign keys onto `UNIQUE (project_id, id)`, the trigger, `COLLATE
   NOCASE`? Where it cannot, say which of these the design keeps and how the
   two sources are kept in step (one source of truth). What the query layer
   uses: Prisma's model API, `$queryRaw` / TypedSQL, or a mix, and why.
5. **`board sql` and watch.** The read-only connection: through Prisma, or
   `bun:sqlite` (`readonly: true`) directly, and whether it exposes
   `sqlite3_stmt_readonly` and a no-tail check. Which SQLite version each
   path links (bundled vs system), and whether two SQLite libraries in one
   process on one WAL file is safe (POSIX lock hazard quarry measured in
   `holdsQuarry`).

### interfaces (MCP and CLI)

1. **MCP.** `@modelcontextprotocol/sdk` (version) with the stdio transport:
   input validation (zod or JSON Schema; how a schema refusal looks), output
   schemas validated on success, `isError` results, annotations, the
   `milestone: "none"` case of decision 7, and the in-process transport for
   tests (`InMemoryTransport` or equivalent). Does decision 13's shape (board's
   errors in one shape, the package's validation refusals as they are) still
   hold? Do Appendix B's schemas survive as they are?
2. **CLI.** A library (e.g. `commander`, `yargs`, `citty`, `cac`) or Bun's own
   `util.parseArgs`: nested commands (`project add`, `milestone edit`),
   comma-split repeatable options, allowed values, per-command `-p`, exit 64
   on usage errors, `board help [COMMAND]`. Try the candidates; name what was
   tried.
3. **Tables.** What prints `ls`, `status`, `project ls`, `sql` tables (a
   package, or a few lines, with the reason), and whether it counts terminal
   cells.
4. Any change to the tool or CLI surface a package forces, with the reason.

### runtime (processes, tests, build, release)

1. **Single binary.** `bun build --compile` of a probe that uses Prisma 7 with
   the chosen adapter (coordinate with data: try at least the adapter data
   leads with), for `bun-darwin-arm64` and `bun-darwin-x64`: does it build,
   run, open a WAL file, run through a symlink and as a copy? x64 under
   Rosetta. Size. Is Prisma's query compiler (WASM) embedded and loaded?
2. **Signing.** A Bun-compiled binary with `codesign --options runtime`: ad
   hoc first, then the owner's Developer ID if it is in the keychain (team
   `YQ8ZD2KZ3T`; do not notarise). Which entitlements it needs
   (`allow-jit`, `allow-unsigned-executable-memory`, …): run it with and
   without each. Can a Bun binary be signed at all after `--compile` (does
   it carry an appended payload that breaks `codesign --verify --strict`)?
3. **Event loop.** `busy_timeout` blocks the thread in a synchronous driver:
   what that means for one `board mcp` serving one agent, for `board watch`
   timers, and for the stdin-closed exit. Serialisation of two requests from
   one agent inside one transaction (Dart had a synchronous callback; with
   async Prisma, how is interleaving prevented?).
4. **Tests.** `bun test` for rules (in-memory or temp-file SQLite), store
   (two processes racing; Bun's `Worker` or `Bun.spawn`), MCP in process,
   watch with an injected clock, the built-binary smoke test.
5. **Release.** `tool/release.sh` reworked for Bun: version source
   (`package.json`), checks (`tsc --noEmit`, a formatter and linter — which;
   `bun test`), both builds from one arm64 Mac, sign, self-test, notarise,
   npm packages. The npm layout stays esbuild-like; the shim stays a Node
   `spawnSync` script (or say why not). What moves to `package.json`.
6. Module layout under `src/` (and the entry point), replacing the Dart one.

## Open questions already known to be the owner's

None yet. Any finding that Bun or Prisma 7 cannot meet a constraint above is
brought to the lead at once, with options; the lead takes it to the owner.
