# `board upgrade`: runtime

Draft by `runtime` for the brief in `brief.md`. It answers the brief's
runtime questions (processes and file replacement, spawning, network,
testability, module placement) and the two open questions every draft states.
Every claim about cliffy cites the TypeScript source shipped in
`node_modules`; `@jsr/cliffy__upgrade` is abbreviated `upgrade/` and
`@cliffy/command/upgrade` is abbreviated `command/upgrade/`. Everything run is
listed in "What was run", at the end.

## Summary

- `board upgrade` is one `UpgradeCommand` built with `standalone: false`,
  with one `NpmProvider` subclass per manager whose `upgrade()` spawns that
  manager. cliffy then never reaches its binary path or its runtime path
  (`upgrade/upgrade.ts:89-108`); both are wrong for board.
- The installed binary's file is never written in place by npm 11.6.2,
  bun 1.4.3, pnpm 10.33.0, pnpm 12.11.2 or yarn 1.22.22. Each puts the new
  binary in a new inode (npm, bun: rename the old package aside, then delete
  it; yarn: unlink and write anew; pnpm 10: a new versioned directory, the
  old one kept; pnpm 12: a new global directory, the old one deleted). A
  running `board upgrade` and every running
  `board mcp` and `board watch` keep running on the old inode, and their
  embedded files stay readable. Probed with signed hardened-runtime binaries
  in temporary prefixes, below. A write in place is what kills: a running
  hardened binary overwritten with `cat` died with `SIGKILL` (137) at its
  next page-in. So board itself must never copy over a binary, which the
  owner's direction already rules out.
- Spawn with `Bun.spawn`, all three stdio inherited, the environment passed
  through unchanged, **no timeout**, and no signal handler of board's. Ctrl-C
  reaches the shim, board and the manager together, as the terminal sends it
  to the foreground group; the manager handles it as it would if typed
  alone. Two consequences are the owner's call (Q3): the shim and board die
  at once, so with npm the prompt comes back while npm is still rolling back
  (more than 13 s with `board` missing from `bin/`, then 0.0.1 intact); and
  pnpm 10 interrupted leaves board uninstalled.
- The only network access of board's own is `NpmProvider.getVersions`, an
  unbounded `fetch` of `https://registry.npmjs.org/@chorded/board`. Offline it
  fails fast (DNS 78 ms, refused 0 ms); a silent network hangs for Bun's own
  limit, measured at 360 s. With `upgrade` mounted, `checkVersion` makes
  `board --help`, `board <any> -h` and `board --version` do that fetch, wait
  as long, and fail when it fails (Q1, Q2).
- Tests never reach the registry, a real manager or a global install.
  Detection and argv building are pure functions with tables. The
  providers' `upgrade()` runs against fake manager scripts on a temporary
  `PATH`. The command runs in a subprocess through a test helper that builds
  the real CLI with an injected `execPath`, environment and, for registry
  cases, providers whose public `getVersions` answers canned versions; so
  cliffy's `process.exit` ends a child process, not the test runner, and no
  global is stubbed. The one path with no version listing at all is
  `--force` with an exact `--version`.
- Code: `src/upgrade/` (detect, argv, providers, spawn), one adapter file
  `src/cli/upgrade.ts`.

## 1. The process tree and file replacement

### The tree

```
shell ─ node  ~/…/bin/board (the shim, spawnSync, stdio inherited)
         └─ board  …/@chorded/board-darwin-<arch>/bin/board  (Bun, compiled)
              └─ npm | bun | pnpm | yarn  (Bun.spawn, stdio inherited)
                   └─ the manager's own children (tar, git, lifecycle sh …)
```

All in the terminal's foreground process group: the shim does not detach
(`npm/board/bin/board.js`, `spawnSync` with `stdio: "inherit"`), and
`Bun.spawn` without `detached` does not either. The shim is blocked in
`spawnSync`; it has read its script and holds no file of the package open.
The binary holds its own inode mapped (`lsof` shows it as `txt`). data found
that in a compiled Bun binary `process.execPath` is already the real path
(`/tmp` comes back as `/private/tmp`), whether started directly, through a
symlink, or through the shim; the probe agrees.

### What each manager does to the files

Probed with real managers into temporary prefixes under `/tmp`, from a local
registry (below), with a stand-in for board: a `bun build --compile` binary
with a 2 MB embedded file, signed ad hoc with `--options runtime` (hardened
runtime, `codesign --verify --strict` passes), packaged exactly as board is
(main package with the repository's shim, exact-version
`optionalDependencies` on two platform packages). 0.0.1 is installed, one
copy is started through the shim as a long-running server (as `board mcp`
is), and a second copy, started through the shim, spawns the manager to
install 0.0.2, then reads its embedded file and runs code it had not run
before.

| Manager | Binary after the upgrade | The old binary's file | Running `board upgrade` | A running server | New file |
| --- | --- | --- | --- | --- | --- |
| npm 11.6.2 (`--prefix`) | same path, new inode | package dir renamed to `@scope/.board-<rand>`, then deleted | finished, exit 0, embedded file read | alive, embedded file read | `codesign --verify --strict` ok |
| bun 1.4.3 (`BUN_INSTALL`) | same path, new inode | renamed to `install/global/node_modules/.old-<hex>`, then deleted | same | same | ok |
| pnpm 10.33.0 (`PNPM_HOME`) | new path, `global/5/.pnpm/<name>@0.0.2/…` | left in place (old version directory kept) | same | same | ok |
| pnpm 12.11.2 (`PNPM_HOME`, the native `pnpm-native` executable) | new path, a new `global/v11/<hash>-0/` directory | its whole `global/v11/<hash>-0/` directory deleted | same | same (running an unlinked file) | ok |
| yarn 1.22.22 (`--prefix`, `--global-folder`) | same path, new inode | unlinked | same | same | ok |

data's probe with `@biomejs/biome` agrees for npm, yarn and pnpm 12.11.2.
Whatever the manager, the old inode is never written. data also found that
`bun add -g pkg@*` does not upgrade at all when the lockfile already
satisfies `*`; the lead's decision to resolve `latest` to an exact version
(§3) settles that for the argv.

The contrast, also probed: the same running binary with its file
overwritten in place (`cat new > old`, same inode) died by `SIGKILL` (wait
status 137) at its next page-in, with no output. That is the hardened
runtime's code-signing check on a page whose bytes changed. Nothing in this
design writes a binary; the rule is recorded so a later "self-update without
a package manager" knows the swap must be a rename.

### Consequences

- **The running `board upgrade` is safe.** After the manager exits, board
  runs only cliffy's success or failure message and exits; it does not
  re-open `process.execPath` by path. If anything did, it would reach the
  new file (npm, bun, yarn), the old one (pnpm 10) or nothing (pnpm 12), never
  a half-written one. Nothing in the design may read back from
  `process.execPath` after the install, since its answer depends on the
  manager.
- **The waiting shim is safe.** Node has its script in memory; the new
  `bin/board.js` (npm, bun: replaced by rename) is read by the next `board`
  only.
- **Running servers keep the old version** until their agent restarts them.
  That mixes versions on one board file; what that means for the schema is
  `data`'s question (decision 10). Runtime adds only: nothing can be done
  from `board upgrade` to those processes; it does not know them.
- **pnpm 10 leaves the old version on disk** until a prune. Harmless.
- **Two `board upgrade`s at once** run two managers on one prefix. npm, bun
  and yarn have no global lock; the outcome is whatever the manager does.
  Not handled; this is not a real case for a person's machine.

## 2. Spawning

Inside `upgrade(options)` of each provider (`upgrade/provider.ts:169`,
called at `upgrade/upgrade.ts:97-98` because the command passes
`standalone: false`, `command/upgrade/upgrade_command.ts:165,188`).

- **`Bun.spawn`**, as `ProcessGitRunner` already does (`src/place/`). It
  works in a compiled binary (the probe spawned all four managers from one).
  The argv is built by a pure function (§4) and starts with the manager's
  command name; `Bun.spawn` resolves it on `PATH`. A missing manager makes
  `Bun.spawn` throw synchronously (`ENOENT`); the provider catches that and
  throws an `Error` that names the manager and says how it was chosen
  (detected from the path, or `-r`). Resolving with `Bun.which` first gives
  the same result with one more branch; not needed.
- **Which manager (critic #2).** The manager found on `PATH` is not
  necessarily the one that owns this install: with nvm, `npm` on `PATH`
  belongs to the Node version selected now while board may sit in another
  version's prefix; a custom `npm config prefix` or `PNPM_HOME` differs
  between shells; pnpm 10 and pnpm 12 keep different global directories
  (`global/5` and `global/v11`). The install then succeeds somewhere else
  and the board that runs stays old. `interfaces` proposes a pre-check; its
  run-time cost is in "The pre-check's cost" below, and the choice is the
  owner's.
- **stdio inherited** (`stdin`, `stdout`, `stderr`). The person sees the
  manager's own progress and errors as they would typing the command; a
  manager that asks something (an OTP, a `--force` prompt) can be answered;
  and Ctrl-C needs no forwarding (§2, signals). Piping, as cliffy's own
  `BunRuntime` does (`upgrade/runtime/bun_runtime.ts:27-32`), hides the
  progress and turns a manager prompt into a hang. cliffy's spinner writes
  `\r\x1b[K` and a frame to stdout every 75 ms
  (`command/upgrade/spinner.ts:210-234`) and would interleave with the
  manager's output; the spinner is stopped only around cliffy's own log
  lines (`command/upgrade/logger.ts:16-18`). So the command is built with
  `spinner: false` (a documented option,
  `command/upgrade/upgrade_command.ts:22,80,167`). `interfaces` owns the
  flag's appearance.
- **Environment: passed through unchanged** (`process.env`). The manager
  needs its own configuration (`npm_config_*`, `.npmrc` through `HOME`,
  `BUN_INSTALL`, `PNPM_HOME`, proxies, `NODE_EXTRA_CA_CERTS`) exactly as the
  person has it. board's own variables (`BOARD_DIR`) are harmless to a
  manager. The env reaches the provider as a constructor parameter from
  `main.ts`, the only reader of the environment (Module layout).
- **No timeout.** An install downloads a 33 MB tarball on whatever network
  the person has; any bound is either too short for a slow link or too long
  to help. The person is at the terminal and has Ctrl-C; an agent that runs
  `board upgrade` has its own tool timeout. A timeout of ours would also have
  to choose a signal, and the probe shows why that is bad: npm interrupted
  mid-install restores the old version only if allowed to finish its
  rollback. During the rollback the probe saw `bin/board` and the package
  renamed aside (`bin/.board-<rand>`, `@scope/.board-<rand>`); a `SIGKILL`
  at that moment (not probed) would leave them so, a broken install. If the
  owner wants a bound anyway, it should be `SIGTERM` and then wait without
  limit, never `SIGKILL`.
- **Signals.** board installs no handler, as every CLI command
  ("Runtime" in `docs/design.md`). Ctrl-C at the terminal sends `SIGINT` to
  the whole foreground group. Probed with npm, the stand-in board in its own
  process group and `SIGINT` sent to the group 6 s into a slow download:

  | Process | Outcome |
  | --- | --- |
  | shim (Node in `spawnSync`, no listener) | killed by `SIGINT` at once; the shell sees 130 |
  | board | killed by `SIGINT` at once |
  | npm | kept running more than 13 s, then printed `npm error signal SIGINT` after the prompt had returned, and restored 0.0.1 intact |

  During those seconds `bin/board` did not exist. The install was right once
  npm exited. bun, yarn and pnpm 12 stop at once and keep the old version;
  pnpm 10 stops at once and leaves board uninstalled (below). Every one of those is
  what the same Ctrl-C does to the manager typed by hand. Changing it needs
  the shim, which `board watch` also goes through; it is the owner's call
  (Q3).
- **Exit codes.** Manager exit 0: the provider returns, cliffy logs success
  (`upgrade/upgrade.ts:120-135`), the action returns, the root's `.noExit()`
  path returns 0. Manager non-zero, or killed by a signal while board lives
  (someone `kill`s the manager alone): the provider throws an `Error` whose
  message names the manager, its argv and its status or signal; `upgrade()`
  logs "Failed to upgrade …" and rethrows (`upgrade/upgrade.ts:109-117`);
  `UpgradeCommand` logs the message and calls cliffy's `exit(1)`
  (`command/upgrade/upgrade_command.ts:192-197`), which is
  `process.exit(1)` (`@jsr/cliffy__internal/runtime/exit.ts:9-16`). So every
  failure is 1, matching board's "refused" (1), and the manager's output has
  already been seen on the inherited stderr. Ctrl-C: board dies by `SIGINT`,
  the shim re-raises nothing because it died first, the shell sees 130.

### Ctrl-C, other managers

The same probe, `SIGINT` to the group 6 s into the slow download:

| Manager | Manager after `SIGINT` | The install afterwards |
| --- | --- | --- |
| npm 11.6.2 | ran on more than 13 s, then `npm error signal SIGINT` | 0.0.1, intact; `bin/board` absent meanwhile |
| bun 1.4.3 | gone within 0.2 s | 0.0.1, intact |
| yarn 1.22.22 | gone within 0.2 s | 0.0.1, intact |
| pnpm 10.33.0 | gone within 0.2 s | **board uninstalled**: `global/5/node_modules/@probe` and the `board` bin gone, while `global/5/package.json` still lists 0.0.1 (seen twice, in two separate runs) |
| pnpm 12.11.2 | gone within 0.2 s | 0.0.1, intact; a half-made new `global/v11/<hash>-0/` directory left beside it |

In every case the shim and board died by `SIGINT` at once and the shell saw
130. The pnpm 10 outcome is pnpm's own: the same Ctrl-C on `pnpm add -g`
typed by hand does the same. The way back is to run the install again
(`pnpm add -g @chorded/board`), which a dead board cannot print.

### The pre-check's cost

If the owner takes `interfaces`' pre-check (ask the manager on `PATH` where
its global install lives and compare with the detected path before
installing), at run time it is one more spawn before the install, with
stdout piped (board must read the answer) and stderr inherited:

| Query (warm, measured in temporary prefixes) | Time |
| --- | --- |
| `npm root -g` (npm 11.6.2, a Node script) | 106–223 ms |
| `pnpm root -g` (pnpm 10.33.0, Node) | 155–158 ms |
| `pnpm root -g` (pnpm 12.11.2, native) | 17–19 ms |
| `yarn global dir` (yarn 1.22.22, Node) | 92–97 ms |
| `bun pm bin -g` (bun 1.4.3) | 15–16 ms |
| any of them through corepack's shim, first call | 3.4 s; corepack may also download the manager and prompt for it on first use |

Its failure modes, each of which must turn into a refusal that says what
was asked and what came back, before anything is installed:

- **The manager is missing** from `PATH`: the same `ENOENT` the install
  would meet, only earlier.
- **The query fails where the install would also fail.** pnpm 10 and 12 both
  refuse `root -g` with `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH` when
  `$PNPM_HOME` (pnpm 12: `$PNPM_HOME/bin`) is not on `PATH`; `add -g` refuses
  the same way.
- **The query fails where the install would succeed.** `bun pm bin -g`
  exits 1 ("No package.json was found") in a `BUN_INSTALL` that has never
  had a global install. With board installed by bun the file exists, so this
  reaches only `-r bun` on a machine where bun installed nothing.
- **The answer's shape differs per manager and version**: npm answers
  `<prefix>/lib/node_modules`, pnpm 10 `…/global/5/node_modules`, pnpm 12
  `…/global/v11`, yarn the global folder, bun a bin directory. Comparing it
  with the detected path is `data`'s table again, one more thing to keep per
  manager version.
- **It hangs** (corepack's prompt, a manager waiting on something). Unlike
  the install, the query changes nothing, so it can be bounded safely: 10 s,
  then `SIGTERM`, refused as "could not ask <manager> where it installs".
  stdin inherited, so a corepack prompt can still be answered within the
  bound.

So the price is 15–220 ms on every upgrade (seconds on a corepack first
call), one more piped spawn with a timeout to test, and a second per-manager
table. What it buys is a refusal instead of an install that lands
elsewhere.

## 3. Network

- **What fetches.** `NpmProvider.getVersions` does
  `fetch(new URL("@chorded/board", "https://registry.npmjs.org/"))` with no
  signal and no headers (`upgrade/provider/npm.ts:40-58`); the URL is a
  private field (`:17`). It is reached from:
  1. `isOutdated`, unless `--force` (`upgrade/upgrade.ts:65-69`,
     `upgrade/provider.ts:214-219`);
  2. `resolveVersion`, always called (`upgrade/upgrade.ts:83`). In cliffy's
     `NpmProvider` it does not fetch, because `delegateLatestResolution` is
     true (`upgrade/provider/npm.ts:15`, `upgrade/provider.ts:187-193`).
     The lead has decided that our providers resolve `latest` to an exact
     version by overriding the public `resolveVersion` (overriding
     `delegateLatestResolution` fails `tsc`: it is typed as the literal
     `true`). So for us `resolveVersion("latest")` calls `getVersions`, and
     an exact version passes through without fetching;
  3. `-l, --list-versions` (`command/upgrade/upgrade_command.ts:119-125`);
  4. shell completion of `--version` (`:204-206`);
  5. `checkVersion`, from the root's long `--version`
     (`@cliffy/command/command.ts:2590-2596`) and from **every** `-h` and
     `--help`, short or long, at any level, because the help option is
     global (`command.ts:2610-2622`) and from `board help`
     (`@cliffy/command/help/help_command.ts:30`). It uses the **first**
     provider (`command/upgrade/upgrade_command.ts:230-240`, `getProvider()`
     with no name at `:241-248`), and skips only when
     `hasRequiredPermissions()` is false (`_check_version.ts:18-21`), which
     outside Deno is always true (`@jsr/cliffy__internal/runtime/has_permission.ts:14-25`,
     `upgrade/provider/npm.ts:36-38`).
- **Which invocations fetch**, with `latest` resolved by our override:

  | Invocation | `isOutdated` | `resolveVersion` | Fetches |
  | --- | --- | --- | --- |
  | `board upgrade` (`--version latest`) | yes | yes | twice |
  | `board upgrade --version 1.2.3` | yes | no | once |
  | `board upgrade --force` (latest) | skipped | yes | once |
  | `board upgrade --force --version 1.2.3` | skipped | no | **never** |
  | `board upgrade -l` | n/a | n/a | once, then `exit(0)` |
  | `board --help`, `-h` anywhere, `board help`, `board --version` | n/a | n/a | once through `checkVersion`, unless Q1 removes it |

  `--force` with an exact version is the only fetch-free way to reach the
  provider's `upgrade()`. The two fetches of the plain case are cliffy's
  flow (`upgrade/upgrade.ts:68,83`), not cached between them; one more
  request of a small packument, accepted.
- **Is a check needed before spawning?** No. The manager resolves the version
  itself and fails on an unknown one. `isOutdated` adds two things: "already
  latest" without running the manager (`upgrade/provider.ts:243-258`), and a
  clear "version not found" before the manager's own message (`:226-240`).
  Both are worth one request; `--force` skips it. Keep cliffy's flow as is.
- **Offline and slow, measured with Bun 1.4.3's `fetch` called as
  `NpmProvider` calls it:**

  | Situation | Outcome |
  | --- | --- |
  | no DNS | `TypeError` `ENOTFOUND`, 78 ms |
  | connection refused | `TypeError` `ECONNREFUSED` "Unable to connect. Is the computer able to access the url?", 0 ms |
  | a server that accepts and never answers | `TimeoutError` "The operation timed out.", after 360 s (Bun's own limit) |
  | registry answers non-2xx | `Error("couldn't fetch the latest version - try again after sometime")` (`upgrade/provider/npm.ts:46-50`) |

  In `board upgrade` these reach `UpgradeCommand`'s catch: one line on
  stderr, exit 1. Correct as it is.
- **The bound.** The only documented way to bound it is a provider subclass
  overriding `getVersions(name)` (public, `upgrade/provider.ts:163`) to race
  `super.getVersions(name)` against a timer. The `fetch` is not aborted (the
  signal cannot be passed through the private URL), but board exits right
  after, so nothing is left behind. 10 s is the proposal. Whether overriding
  a public method to wrap `super` counts as "subclassing `NpmProvider`" or as
  a workaround is the owner's call (Q2).
- **`--help` and `--version` go to the network.** With the command mounted,
  `board --help` offline throws the `TypeError` out of `parse`; `runCli`
  rethrows anything but a `ValidationError` (`src/cli/root.ts:52-53`) and
  `main.ts` prints it with its stack as an internal error, exit 1
  (`src/main.ts:26-30`). On a silent network `board --help` hangs as long as
  the fetch does. An agent reading `board --help` would meet both. This is
  the strongest runtime reason to avoid the check (Q1).

## 4. Testability

Following "Tests" in `docs/design.md`: logic where a test reaches it, no test
reaches the real registry, a real manager or a global install.

- **Detection, pure.** `detectManager(realExecPath: string): ManagerName |
  undefined` over `data`'s ordered marker table. A table-driven test: one
  row per layout `data` lists (npm prefix, nvm, Homebrew Node, Volta, bun,
  pnpm 10 and 12, yarn classic), plus `build/darwin-arm64/board`, a copy in
  `~/bin`, a local `node_modules` install, the `bun` executable itself (the
  `bun src/main.ts` case) and an `npx` cache, each with its expected answer.
  The input is `process.execPath`, which is already real (data), read once in
  `main.ts` and passed in.
- **Argv, pure.** `installArgv(manager, version): string[]` with a row per
  manager. It only ever receives an exact version (`latest` is resolved
  before it, §3); a test pins that no row ever produces `@*` or `@latest`,
  given data's finding that `bun add -g pkg@*` is a no-op.
- **Spawning, with a fake manager.** A test writes, in a temporary directory,
  executable `npm`, `bun`, `pnpm` and `yarn` shell scripts that append their
  argv and selected environment variables to a file, print a line on stdout
  and stderr, and exit with a status from the environment; `PATH` for the
  spawn is that directory alone. Through the provider's `upgrade()`, in
  process: the argv the manager received, the environment passed through, exit
  0 resolves, exit 3 rejects with a message naming the manager and 3, a
  manager killed by `SIGTERM` rejects naming the signal, a manager missing
  from `PATH` rejects naming it. The spawn's `PATH` and env come from the
  provider's constructor, so the test needs no `process.env` mutation.
- **The registry, through a documented seam.** `NpmProvider`'s URL is
  private and its `fetch` is the global one, so no local server can stand
  in. Instead, a test provider: a subclass of the production provider class
  for a manager that overrides only the public `getVersions(name)`
  (`upgrade/provider.ts:163`) to answer canned `{ latest, versions }` or to
  throw the error a test names (offline, timeout, non-2xx). Everything else
  (`isOutdated`, our `resolveVersion`, `upgrade()`, the spawn) is the
  production code. The real `getVersions` (the URL and the JSON shape) is
  not tested; it is cliffy's, and the only test that could reach it would
  reach npmjs.org. `spyOn(globalThis, "fetch")` stays a fallback only if a
  case cannot be expressed through `getVersions` (none is known).
- **The CLI, in a subprocess harness.** `UpgradeCommand` exits through
  cliffy's `exit` on failure and after `-l`
  (`command/upgrade/upgrade_command.ts:124,197`), past the root's
  `.noExit()`, so every command-level test runs in a child process. Running
  `bun src/main.ts upgrade …` is not enough: from source, `execPath` is the
  `bun` executable, detection finds no manager and the command refuses
  before any fake manager runs (critic #6). So:
  - `test/helpers/upgrade-cli.ts` is a test entry point beside the
    existing `holder.ts`. It builds `Deps` as `main.ts` does, except that
    `execPath`, `environment` and the providers come from its arguments: an
    install path to pretend to be (one of `data`'s layouts, under a temp
    directory), and optionally a JSON of canned versions, which makes it
    construct the test providers above instead of the production ones. Then
    it calls the same `runCli` and exits with its code. Production code has
    no branch for tests: `main.ts` passes the real values into the same
    `Deps` fields (§5).
  - The test spawns it with `Bun.spawn([process.execPath,
    "test/helpers/upgrade-cli.ts", <fake install path>, <versions json>,
    "upgrade", …])`, `PATH` set to a directory of fake managers alone and
    `HOME` to a temp directory.
  - Cases: the detected default for each manager layout (the fake manager
    records it ran, with which argv); `-r` naming another; exit 0; the
    manager's exit 3 → exit 1 with one line naming it; the manager missing →
    exit 1; "already latest" (canned `latest` equal to the version) → exit 0,
    no manager run; "version not found" → exit 1, no manager run; `-l` →
    exit 0 and the list; `getVersions` throwing (offline) → exit 1, one line;
    `--force --version <exact>` with no canned versions at all → the
    manager runs, proving that path needs no registry; Ctrl-C: a fake
    manager that sleeps, the helper started with `detached: true` so it
    leads its own group, `SIGINT` to the group → the helper ends by
    `SIGINT`, the fake manager too.
  - `bun src/main.ts upgrade` itself, once: no manager detected → the
    refusal and its exit code, nothing spawned.
- **The built binary.** The smoke test (`BOARD_BIN`) gains one line:
  `board upgrade --help` exits 0 and prints the options, which checks that
  the command is mounted and its imports survive `--compile`. It never
  upgrades and must not reach the registry, so it depends on Q1: if the
  version check stays, the line is `board upgrade --help` with the check
  removed by Q1 (a), or the line is dropped. There is no online smoke test.
- **Where tests live:** `test/upgrade-detect.test.ts` (tables),
  `test/upgrade-spawn.test.ts` (providers' `upgrade()` in process against
  fake managers), `test/upgrade-cli.test.ts` (the subprocess harness),
  `test/helpers/upgrade-cli.ts`, the smoke line in the existing binary
  test.

## 5. Module layout

```
src/upgrade/detect.ts     detectManager(realExecPath): the marker table and
                          the pure function (data's table)
src/upgrade/argv.ts       installArgv(manager, version): pure
src/upgrade/providers.ts  one NpmProvider subclass per manager setting
                          `name`; overrides resolveVersion (latest → exact)
                          and upgrade() (runs the spawn); constructed with
                          the environment; managerProviders(env) makes the
                          four
src/upgrade/spawn.ts      runManager(argv, env): Bun.spawn, stdio
                          inherited, no timeout; resolves on 0, rejects
                          with status or signal
src/cli/upgrade.ts        upgradeCommand(deps): new UpgradeCommand({
                          provider: deps.upgrade.providers ordered so the
                          one detectManager(deps.upgrade.execPath) names is
                          first, standalone: false, spinner: false })
src/main.ts               Deps.upgrade = { execPath: process.execPath,
                          providers: managerProviders(process.env) }
```

`src/upgrade/` knows nothing of the board, the store or MCP, and nothing of
cliffy's command; only `providers.ts` imports `@cliffy/upgrade`, and only
`src/cli/upgrade.ts` imports `@cliffy/command/upgrade`. `Deps.upgrade` is a
seam of the same kind as `Deps.runner` (`GitRunner`): `main.ts` fills it
with the real values, the test helper with a pretend path and, for registry
cases, test subclasses. No code path checks whether it is under test. The
MCP server is untouched: upgrading is not an agent tool.

Ordering the provider array so the detected one is first is how `-r`'s
default is chosen (`command/upgrade/upgrade_command.ts:107-109,251-261`:
with `standalone: false`, `selectProvider` returns `getProvider()`, the first
one). It also decides which provider `checkVersion` uses (`:230-248`); all
four fetch the same URL, so that is harmless. `interfaces` owns whether that
counts as documented.

## Open questions

### Which cliffy behaviours do not fit board without a non-documented workaround?

1. **Q1. `checkVersion` on every `--help` and on `--version`.** It fetches,
   unbounded, and its failure fails the help (§3). Documented means that
   avoid it, best first:
   a. Override `hasRequiredPermissions()` in our providers to return
      `false`. It is abstract on `Provider` (`upgrade/provider.ts:161`), so
      every provider implements it anyway, and its only caller is
      `checkVersion`, whose comment says a false answer skips the check
      (`_check_version.ts:18-21`). The meaning is stretched ("permission"
      for "we do not want this"), which is why it is a question.
   b. Keep the check and bound it with Q2's override; offline still turns
      `--help` into an internal error unless the override swallows the
      error, which changes `getVersions` for `board upgrade` too.
   c. Keep it as is: `board --help` needs the network.
   d. Do not mount the command under the name `upgrade` (`checkVersion`
      finds it by that name, `_check_version.ts:8`). Changes the owner's
      direction.
   Runtime recommends a.
2. **Q2. The unbounded `fetch`.** Override `getVersions` to race `super`
   with a 10 s timer (documented: a public method of the base class, the
   private URL untouched), or accept Bun's own limit.
3. **Q3. Ctrl-C during the install.** It reaches the manager as if typed
   by hand: npm rolls back but returns the prompt more than 13 s early;
   pnpm 10 leaves board uninstalled (§2). Not a cliffy misfit, but a choice
   only the owner can make:
   (a) Accept and document, with the reinstall line per manager in the
       README. Smallest; board is no safer than its manager.
   (b) The shim ignores `SIGINT` while its child runs and re-raises the
       child's signal after (listener removed first); `board upgrade`
       ignores `SIGINT` while the manager runs, then prints the reinstall
       line on a failure and exits 130. The prompt waits for the manager;
       the manager's outcome is unchanged. Touches `board watch`'s path.
   (c) As (b), and the manager is spawned in its own process group
       (`detached`), so Ctrl-C never reaches it: an install, once started,
       always completes or fails on its own. Ctrl-C then cannot cancel a
       stuck install (the person has `kill`).
   Runtime recommends (a) for the smallest design, and (c) if the owner
   weighs the pnpm outcome higher than cancelling.
4. **Q4. Testing past `process.exit` and the private registry URL.**
   Resolved without a workaround: command-level tests run in a subprocess
   harness, and the registry is replaced by test subclasses overriding the
   public `getVersions` (§4). No global is stubbed. Left only as a note: the
   real `getVersions` stays untested.
5. **Q5. The pre-check (critic #2).** Whether to ask the manager on `PATH`
   where it installs before installing; its run-time cost is in §2. The
   owner's call; runtime has no objection either way.

Not a cliffy misfit but a fact to record: cliffy's own runtime path would
spawn `process.execPath install …`, which in a compiled binary is board
itself (`upgrade/runtime/bun_runtime.ts:18-20`); `standalone: false` with a
provider `upgrade()` never reaches it (`upgrade/upgrade.ts:97-99`).

### What is the smallest design that meets the owner's direction?

One `UpgradeCommand` with `standalone: false` and `spinner: false`; four
small `NpmProvider` subclasses that set `name`, resolve `latest` to an exact
version in `resolveVersion`, and implement `upgrade()` by spawning
`installArgv(name, to)` with inherited stdio and no timeout; the detected
provider first in the array; Q1 (a) for the version check. No signal
handling, no check after the install, no bound on `fetch` beyond Bun's. The
pre-check (Q5) is an addition the owner may take. About 150 lines, three
test files and one test helper.

## What was run

All under `/tmp/board-upgrade-probe` and, for the second round,
`/tmp/board-upgrade-probe2` (both deleted afterwards); nothing installed
globally on this machine, no package installed from the real registry. The
one download from the real registry was pnpm 12.11.2 itself, fetched by
corepack into a temporary `COREPACK_HOME`, as `data` did. The first round's
pnpm 10 runs wrote registry metadata for `127.0.0.1` into the user's pnpm
cache (`~/Library/Caches/pnpm`); those entries were removed, and the second
round set `npm_config_cache_dir` and `XDG_CACHE_HOME` to temporary paths.

Every result in this draft is for these versions only: npm 11.6.2,
bun 1.4.3, pnpm 10.33.0, pnpm 12.11.2, yarn 1.22.22, Node 24.13.0,
macOS 26 on arm64.

- Two stand-in binaries, `bun build --compile --target=bun-darwin-arm64`
  (Bun 1.4.3), each embedding a 2 MB file, re-signed with `codesign --force
  -s - --options runtime`, `codesign --verify --strict` ok.
- Packages `@probe/board` (the repository's `npm/board/bin/board.js` with
  the scope changed), `@probe/board-darwin-arm64` and a dummy
  `@probe/board-darwin-x64`, 0.0.1 and 0.0.2, `npm pack`ed. (yarn classic
  fails the whole install when an optional platform package is missing from
  the registry; npm and bun only warn. Decision 25's publish order already
  covers that.)
- A local registry in Deno serving packuments and the tarballs on
  `127.0.0.1`, with a mode that streams the 32 MB tarball over 20 s.
- npm 11.6.2 (`--prefix`, `--cache`), bun 1.4.3 (`BUN_INSTALL`,
  `BUN_INSTALL_CACHE_DIR`), pnpm 10.33.0 from corepack's cache
  (`--global-dir`, `--global-bin-dir`, `--store-dir`; the prefix must be
  spelled as its real path, `/private/tmp`, or pnpm refuses with
  `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`), yarn 1.22.22 from corepack's cache
  (`--prefix`, `--global-folder`, `--cache-folder`); user config isolated
  with `NPM_CONFIG_USERCONFIG` and `XDG_CONFIG_HOME`.
- Per manager: install 0.0.1; start one copy through the shim as a server;
  have a second, through the shim, spawn the manager for 0.0.2 with
  inherited stdio; record inodes, `lsof`, `codesign --verify`, the version
  through the shim, the old server's liveness and its read of the embedded
  file after `SIGUSR1`.
- The in-place overwrite: a running copy, `cat` of the other version over
  its file, `SIGUSR1`: killed, status 137.
- Ctrl-C: the upgrade started in its own session with Python's
  `start_new_session`, `SIGINT` to the group at 6 s into the slow download,
  then the group and the prefix watched for 13 s and after.
- Bun's `fetch` against an unresolvable host, a refused port and a local
  listener that never answers, timed.
- Second round, pnpm 10.33.0 and pnpm 12.11.2 (`pnpm-native` from the
  corepack download), `PNPM_HOME` as the temporary prefix with its bin
  directory on `PATH`: the same signed fixture, replacement probe and Ctrl-C
  probe as the first round, rebuilt from scratch.
- The pre-check's queries (`npm root -g`, `pnpm root -g` for 10 and 12,
  `yarn global dir`, `bun pm bin -g`), each timed two or three times warm,
  and once through corepack's `pnpm` shim cold.
