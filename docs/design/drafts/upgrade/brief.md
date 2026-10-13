# Brief: `board upgrade`

## The problem

board is installed through npm as `@chorded/board`, a Node shim
(`bin/board.js`) with exact-version `optionalDependencies` on
`@chorded/board-darwin-arm64` and `@chorded/board-darwin-x64`, each holding
one signed `bun build --compile` binary (decision 21, "Build and
distribution" in `docs/design.md`). A person who wants a newer board today
has to remember which package manager installed it and how that manager
installs globally. The owner wants a `board upgrade` command that does it for
them.

The owner's direction:

- Build it on `@cliffy/command/upgrade` (`UpgradeCommand`) and
  `@cliffy/upgrade` 1.3.1, both already in `node_modules` (under
  `node_modules/@cliffy/command/upgrade/` and `node_modules/@jsr/cliffy__upgrade/`).
- One upgrade provider per package manager: npm, bun, pnpm, yarn at least
  (say if another is worth it). Each extends `NpmProvider`, keeps its version
  listing, and in `upgrade(options)` runs its own manager to install
  `@chorded/board` at the target version globally, so the manager's records
  stay right and nothing swaps the binary behind its back.
- The default provider is the manager that installed this board, detected
  from the binary's real path; `-r/--registry` picks one by hand.

The rest of `docs/design.md` stays as it is. This adds one section.

## What the lead read in cliffy 1.3.1 (verify each; do not take on trust)

- `upgrade()` (`@jsr/cliffy__upgrade/upgrade.ts`) checks `isOutdated` unless
  `--force`, resolves the version, then: `standalone` (default
  `isStandalone()`, which is `Bun.isStandaloneExecutable` and so true for
  board) goes to `upgradeBinary`, which `NpmProvider` refuses
  (`supportsBinaryUpgrade` false). With `standalone: false` it calls the
  provider's `upgrade?(options)` if present, else the runtime path, whose Bun
  runtime spawns `process.execPath install …`; in a compiled binary that is
  board itself, so the runtime path is wrong for us.
- `UpgradeCommand({ provider: [...], standalone })` gives `-r, --registry`
  (an `EnumType` of provider names; default: the first provider unless
  standalone finds a binary-capable one), `-l, --list-versions`,
  `--version <version>` (default `latest`), `-f, --force`, `-v, --verbose`,
  `-o, --output` (only when a provider supports binary upgrades),
  `--no-spinner`. It uses `.noGlobals()`. On failure it logs and calls
  cliffy's internal `exit(1)` (that is `process.exit`, ignoring the root's
  `.noExit()`); `--list-versions` calls `exit(0)`.
- `NpmProvider` fetches `https://registry.npmjs.org/<name>` with the global
  `fetch` (the URL is a private field), sets `delegateLatestResolution`, so
  `resolveVersion("latest")` stays `latest` and `getRegistryUrl` maps it to
  `npm:@scope/name@*`; `resolveSpecifierVersion` is protected.
- `checkVersion` (`@cliffy/command/upgrade/_check_version.ts`) runs from the
  root's long `--version` and from **every** `-h/--help` action once a
  command named `upgrade` exists: it fetches the latest version from the
  registry. `hasRequiredPermissions` is true outside Deno. A fetch failure
  throws.
- board's root (`src/cli/root.ts`) uses `.throwErrors().noExit()` and maps
  a `ValidationError` to `board: <message>`, exit 64; refusals exit 1.
- The installed `board` is the Node shim; it `require.resolve`s the platform
  package and `spawnSync`s the binary. So the binary's `process.execPath`
  is inside the platform package, and the shim, a Node process, is waiting
  on it during an upgrade.

## Constraints

- CLAUDE.md's one rule: cliffy's pieces first. Anything around them that is
  not a documented extension point (constructor options, the provider's
  `upgrade?()` hook, subclassing `NpmProvider`, protected members) is a
  question for main with options, not a workaround of ours. Examples that
  would need asking: monkey-patching `fetch`, overriding `exit`, replacing
  `checkVersion`, reaching private fields.
- macOS 13+, arm64 and x64; the binary is signed with hardened runtime and
  must not be modified in place while it runs (a code-signed page whose file
  changes underneath gets the process killed); npm installs set no
  quarantine.
- Tests (`bun test`) never reach the real registry, never install globally,
  never run a real package manager. Pure logic (detection, command building)
  is unit-tested; spawning is tested against a fake manager on `PATH`.
- No code in this run. Nobody touches `src/`, `test/`, `tool/`, `prisma/` or
  `docs/plan.md`; the mvp team is building slice 6 there now.
- English everywhere; no private paths in the docs (write `~`, `$PREFIX`).

## Non-goals

- Self-update without a package manager (binary swap, GitHub release assets,
  `--output`).
- Homebrew, tarballs, Linux, Windows.
- Automatic or background update checks beyond what cliffy's version check
  does (and whether to keep that is a question below).
- Upgrading the database: there are no migrations before the first release
  (decision 10); what upgrade does about a schema change is a question, not
  a migration design.
- Downgrade protection beyond what cliffy and the manager do.

## Who answers what

Each architect writes only its own draft in this directory. Cite cliffy's
file and line for every claim about its behaviour, and say what you ran.
Probes go under `/tmp` or a scratch `BOARD_DIR`, never a global install on
this machine: use a temporary prefix (`npm --prefix`, `npm_config_prefix`,
`BUN_INSTALL`, `PNPM_HOME`, yarn's `--global-folder`) if you try a real
manager, and say so.

### data (`data.md`): install layouts and versions

1. For each manager (npm, bun, pnpm, yarn classic, yarn berry), where does
   a global install of `@chorded/board` put the shim and the platform
   binary, and what does the binary's real path (`realpath` of
   `process.execPath`) look like, including custom prefixes (`npm config
   prefix`, nvm, Homebrew's Node, Volta, fnm, `BUN_INSTALL`, `PNPM_HOME`)?
   Which path markers tell the managers apart reliably, and which cases are
   ambiguous? Does yarn berry have a global install at all? Is any other
   manager worth a provider (Volta, `deno install`, `npx`/`bunx` caches)?
2. The detection rule as data: an ordered table of markers to provider
   names, a pure function over one path. What it answers when none matches:
   a binary copied by hand, a development build in `build/`, `bun
   src/main.ts`, a local (not global) `node_modules` install, `npx`.
3. Versions: does `NpmProvider.getVersions("board")` reach
   `@chorded/board` (the package name, not the command name), and is the
   `@chorded/board` version list the right one given the per-platform
   packages are published first (decision 25's publish order, a run stopped
   between publishes)? Where does the current version come from (`pkg.version`
   in the binary) and can it disagree with what the manager has recorded?
   What about a user whose npm config points at another registry or a
   mirror: listing from npmjs.org while the manager installs from the
   mirror?
4. The board file across an upgrade: old MCP servers still running the old
   binary while the new one is installed; a version whose `user_version`
   differs (decision 10). What `board upgrade` should say, if anything.
   Recommend; if it is the owner's call, say so with options.

### interfaces (`interfaces.md`): the command and the providers

1. The command line: which of `UpgradeCommand`'s options appear and how
   (`-r` values and their names, `--version`, `-l`, `-f`, `-v`, the spinner),
   help text, and how it sits beside board's root (`--version` of the root
   versus `upgrade --version`, `.noGlobals()`, `HelpCommand`).
2. The provider classes: one per manager, what each overrides
   (`name`, `upgrade()`, anything else), the exact argv per manager for a
   global install at a version and at `latest` (with `delegateLatestResolution`
   in mind), and how the detected provider becomes the default (`-r`'s
   default is the first provider: is ordering the array the documented way?).
3. Output and exit codes: what the person sees before, during and after
   (cliffy's logger and spinner versus the manager's own output: inherited,
   piped, shown on failure only), how a manager's failure, a missing
   manager on `PATH`, an unknown version, "already latest", and offline are
   reported, and their exit codes against board's convention (0, 1, 64),
   given that `UpgradeCommand` calls `process.exit` itself.
4. The version check: `board --version` and every `--help` would fetch from
   the registry once `upgrade` is mounted. Keep, keep with a bound, or
   avoid, and through which documented means. If no documented means fits,
   that is a question for main with options.
5. What happens when detection finds no manager: refuse with what to do,
   or fall back to one; and when `-r` names a manager other than the
   detected one (two installs on one machine).

### runtime (`runtime.md`): processes, failure, tests

1. The process tree during an upgrade: shim (Node) → board binary → the
   manager (Node or Bun). How each manager replaces files on macOS (new
   inode by rename, or write in place) for the shim and the binary, and
   whether the running board or the waiting shim can be killed or confused
   by it under hardened runtime. Probe it with a temporary prefix.
2. Spawning: `Bun.spawn` or `node:child_process` inside the compiled binary,
   stdio (inherit vs pipe), the environment passed, the timeout and what
   happens at it (kill the manager? which signal?), Ctrl-C during the
   install, and exit code mapping.
3. Network: is a registry check needed before spawning (cliffy's
   `isOutdated` already fetches unless `--force`); how offline and a slow
   registry are reported, and with what bound on `fetch`.
4. Testability: how detection is a pure function with a test table; how
   spawning is tested with a fake manager script on a temporary `PATH`; how
   the registry is kept out of tests (an injectable fetch, a provider
   subclass, a local HTTP server) using only documented extension points;
   and how to test a command that calls `process.exit` (subprocess, or
   something else). Where tests live, following "Tests" in
   `docs/design.md`.
5. Where the code lives, following "Module layout" in `docs/design.md`.

## Open questions every draft should state its answer to

- Which cliffy behaviours, if any, do not fit board without a non-documented
  workaround? List each with options for main.
- What is the smallest design that meets the owner's direction?
