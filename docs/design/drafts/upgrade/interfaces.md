# Interfaces: `board upgrade`

Draft by interfaces for the brief in `brief.md`, revised once after the
critic's review. Every claim about cliffy cites a file under
`node_modules/@cliffy/command/` (the `@jsr/cliffy__command` 1.3.1 package) or
`node_modules/@jsr/cliffy__upgrade/` (1.3.1), by the `.ts` source beside the
`.js` that runs, or its `_dist/*.d.ts` where the types matter; line numbers
are those files'.

## What was run

All probes under `/tmp`, nothing installed globally, nothing under `src/`,
`test/`, `tool/` or `prisma/` touched.

- `/tmp/upgrade-probe/probe.ts`, run with `bun` 1.4.3: a root `Command` built
  as `src/cli/root.ts` builds it (`name("board")`, `version`, `throwErrors()`,
  `noExit()`, `HelpCommand().global()`, one plain subcommand `ls`) plus
  `.command("upgrade", new UpgradeCommand({ provider, standalone: false }))`,
  where `provider` is four instances of a subclass of `NpmProvider` whose
  `upgrade()` prints the options it receives and the specifier, and
  optionally throws. It catches a `ValidationError` as `runCli` does (exit
  64) and reports anything else as thrown. Run against `@chorded/board` (not
  yet on the registry: `npm view` answers E404) and against `is-number`
  (published, latest 7.0.0) with the root at 6.0.0 and 7.0.0: help, version,
  upgrade, `-v`, `-f`, unknown version, already latest, bad `-r`, a failing
  hook, provider order, and `-l` against the unpublished package.
- `/tmp/tsc-probe`: board's `tsconfig.json` (strict, `noImplicitOverride`)
  over one file, with board's `node_modules` linked in, run with board's
  `tsc` 7.0.2 `--noEmit`. A subclass declaring
  `protected override readonly delegateLatestResolution = false` fails with
  TS2416 ("Type 'false' is not assignable to type 'true'", since
  `_dist/provider/npm.d.ts:10` types it as the literal `true`). The design
  below (overrides of `name`, `resolveVersion`, `getVersions`,
  `hasRequiredPermissions`, `upgrade`, passed to `new UpgradeCommand({ …,
  standalone: false, spinner: false })`) compiles with exit 0, no casts, no
  `ts-ignore`.
- Real managers on throwaway prefixes, to see what each records:
  `npm install --global --prefix /tmp/mgr/npm 'is-number@*'`,
  `BUN_INSTALL=/tmp/mgr/bun bun add --global 'is-number@*'` (and `@latest`
  into a second prefix), `yarn global add 'is-number@*' --global-folder
  /tmp/mgr/yarn/global --prefix /tmp/mgr/yarn` (yarn 1.22.22). Then, after
  data's finding, an upgrade under bun: `BUN_INSTALL=/tmp/mgr2/bun bun add
  -g is-number@6.0.0`, then `@*` (stays 6.0.0, "done", records `"*"`), then
  `@7.0.0` (installs 7.0.0, records `"7.0.0"`). pnpm was not run: the `pnpm`
  on this machine is a corepack shim that would download a pnpm first.
- The global-root queries, read-only: `npm root -g` (with and without
  `--prefix /tmp/mgr/npm`), `BUN_INSTALL=/tmp/mgr2/bun bun pm bin -g` and
  `bun pm -g ls`, `yarn global dir` (with and without `--global-folder`).
- `bun -e` spawning a command that is not on `PATH`, to see how `Bun.spawn`
  fails.

## Summary of answers

1. `board upgrade` is cliffy's `UpgradeCommand`, mounted as is with
   `standalone: false` and `spinner: false`. It shows `-r/--registry`,
   `-l/--list-versions`, `--version`, `-f/--force` and `-v/--verbose`;
   `-o/--output` is absent because no provider supports binary upgrades, and
   `--no-spinner` is hidden.
2. One subclass of `NpmProvider` per manager (`npm`, `bun`, `pnpm`, `yarn`),
   sharing a base `NpmManagerProvider`. It overrides `name`, `upgrade()`, the
   public `resolveVersion()` (so `latest` becomes the exact
   `dist-tags.latest` before any manager runs: `bun add -g pkg@*` does not
   upgrade an existing install), the public `getVersions()` (only to turn a
   registry failure into board's refusal), and, if the owner takes V1,
   `hasRequiredPermissions()`. The detected manager goes first in the
   `provider` array; that is what makes it `-r`'s default.
3. Output: cliffy's logger for its own lines, the manager's output
   inherited, no spinner, and on failure one line after the manager's output
   naming the manager, its argv and its exit status. Exit codes: 0 upgraded
   or already current, 1 every failure, 64 a usage error caught by parse.
   `-l` failing goes through board's refusal path (`board: …`, 1).
4. The version check makes every `--help`, `board help` and `board
   --version` fail today, and fetch the registry once board is published.
   It has to go; the smallest documented means is V1 (owner's call).
5. No supported installation identified: refuse, whatever `-r` says, with
   the manual command per manager. `-r` naming another manager than the
   detected one: see "`-r` and `isOutdated`" in section 5 (owner's call).

## 1. The command line

```
board upgrade [-r|--registry npm|bun|pnpm|yarn] [--version VERSION] [-f|--force]
              [-v|--verbose]
board upgrade -l|--list-versions [-r …]
```

What cliffy builds (`upgrade/upgrade_command.ts`):

| option | source | notes for board |
| --- | --- | --- |
| `-r, --registry <name:provider>` | :104-113 | an `EnumType` of the providers' `name`s (:103, :263-265); default `providers[0].name` when not standalone (:108-109, :251-261, :241-245); shown because there are more than one (:110) |
| `-l, --list-versions` | :114-127 | lists the versions of `@chorded/board`, marking the running one with `*`, then `exit(0)` (:124) |
| `--version <version>` | :128-132 | default `latest`; type `string`, so any text passes parse and is checked by `isOutdated` |
| `-f, --force` | :133-136 | skips `isOutdated` entirely (`upgrade.ts:65-69`), so also its "version not found" check |
| `-v, --verbose` | :137-140 | turns on `logger.log` (`upgrade/logger.ts:22-24`) and full error objects (:193-195) |
| `-o, --output <path>` | :141-148 | absent: `enabled` only when a provider supports binary upgrades |
| `--no-spinner` | :149-151 | hidden, since the constructor gets `spinner: false` |

The help, as the probe printed it (`board upgrade --help`, with the
version hint removed, see section 4, and `--no-spinner` hidden):

```
Usage:   board upgrade
Version: 0.1.0

Description:

  Upgrade board executable to latest or given version.

Options:

  -h, --help                      - Show this help.
  -r, --registry       <name>     - The registry name from which to upgrade.               (Default: "npm", Values: "npm", "bun", "pnpm", "yarn")
  -l, --list-versions             - Show available versions.
  --version            <version>  - The version to upgrade to.                             (Default: "latest")
  -f, --force                     - Replace current installation even if not out-of-date.
  -v, --verbose                   - Log verbose output.

Commands:

  help  [command]  - Show this help or the help of a sub-command.
```

The `(Default: …)` shows the detected manager, since the default is read
from the array's first element when help is drawn.

Beside the root:

- `board --version` / `-V` is the root's version option (not global,
  `command.ts:2579-2603`); `board upgrade --version X` is the upgrade's own
  option. They do not collide: `board upgrade -V` is an unknown option,
  usage error, 64.
- `noGlobals()` (:102) keeps the root's global options out of `upgrade`, but
  the `help` command passes through it (`command.ts:3486-3488` exempts a
  command named `help`), so `board upgrade help` and `board help upgrade`
  both work, and `-h` is the upgrade's own.
- The description wording ("Upgrade board executable…") and "registry" for
  what is a package manager are cliffy's. Changing them is possible with a
  documented call on the returned command (`.description(…)`), but the
  option text of `-r` is not; I would leave both as cliffy has them.
- No MCP tool. Upgrading is a person's act and it replaces the binary the
  agents' MCP servers run; agents get nothing new.

Dependencies: board imports `UpgradeCommand` from `@cliffy/command/upgrade`
and `NpmProvider` from `@cliffy/upgrade/provider/npm`, which needs
`"@cliffy/upgrade": "npm:@jsr/cliffy__upgrade@1.3.1"` in `package.json`
(today it is only a transitive dependency). The re-export
`@cliffy/command/upgrade/provider/npm` is deprecated "and will be removed in
2.0" (`upgrade/provider/npm.ts:6`).

## 2. The providers

### The classes

Names follow runtime's module layout (`runtime.md` §5:
`src/upgrade/providers.ts`, `installArgv`, `runManager`).

```ts
const PACKAGE = "@chorded/board";

/** Upgrades board through the package manager that installed it globally. */
abstract class NpmManagerProvider extends NpmProvider {
	abstract override readonly name: Manager;   // "npm" | "bun" | "pnpm" | "yarn"
	constructor(readonly detected: Manager | undefined, private readonly spawn: Spawn) {
		super({ package: PACKAGE });
	}
	// An exact version for every manager: bun leaves an installed board alone under `@*`.
	override async resolveVersion(name: string, version: string): Promise<string> {
		return version === "latest" ? (await this.getVersions(name)).latest : version;
	}
	// The listing is NpmProvider's; only its failure becomes board's refusal (section 3).
	override async getVersions(name: string): Promise<Versions> {
		try {
			return await super.getVersions(name);
		} catch (error) {
			throw new Refusal(registryError(error));
		}
	}
	override async upgrade(options: ProviderUpgradeOptions): Promise<void> {
		// 1. refuse when no supported installation was identified (section 5)
		// 2. argv = installArgv(this.name, options.to)
		// 3. this.logger.log("$ " + argv.join(" "))       (shown under -v)
		// 4. runManager(argv): inherited stdio; reject naming manager, argv and status or signal
	}
}
class NpmManager extends NpmManagerProvider { override readonly name = "npm"; }
// … BunManager, PnpmManager, YarnManager
```

- `name`: `NpmProvider` declares it as `string` (`_dist/provider/npm.d.ts:9`);
  each subclass narrows it. Each name is one value of `-r`.
- `resolveVersion(name, version)` is public and documented ("Resolve the
  requested target version to an installable version",
  `provider.ts:178-193`). `upgrade()` calls it before the hook
  (`upgrade.ts:83`), so the hook always receives an exact version, and the
  success and failure messages name it. The override answers what the base
  `Provider` answers when resolution is not delegated
  (`provider.ts:188-191`); `delegateLatestResolution` itself stays `true`
  and untouched, since narrowing it fails `tsc` (see "What was run"). With
  `to` exact, `resolveSpecifierVersion` has nothing to map
  (`provider.ts:208-212`).
- `getVersions(name)` is public and abstract in `Provider`
  (`provider.ts:163`); the override keeps `NpmProvider`'s listing as it is
  and changes only what a failure throws. `Refusal` and `registryError` are
  board's (`src/errors.ts`); see section 3 for why and for the new code.
- `upgrade()` is the documented hook: `upgrade()` calls it when not
  standalone, the provider supports script upgrades and the hook exists
  (`upgrade.ts:89-99`). `standalone: false` in the constructor options makes
  that path certain (`upgrade_command.ts:165`, :188); without it,
  `isStandalone()` is `Bun.isStandaloneExecutable` and the run goes to
  `upgradeBinary`, which `NpmProvider` refuses (`upgrade.ts:139-147`).
- Everything else is `NpmProvider`'s: the version listing from
  `registry.npmjs.org/@chorded/board` (`provider/npm.ts:40-59`; the package
  name comes from `package`, not from the command name "board",
  :21-33, :74-78) and `isOutdated` with its messages (`provider.ts:214-261`).
- The hook receives `{ name: "board", to, from, force?, verbose?,
  standalone: false }` (from the probe) and logs through `this.logger`,
  which `upgrade()` has set to the command's logger (`upgrade.ts:61-63`;
  `logger` is protected, `provider.ts:117`).
- `installArgv(manager, version)` is a pure function, unit-tested; spawning
  is runtime's (`runManager`). The `Spawn` dependency is how a test puts a
  fake manager in.

### The argv

`installArgv(manager, version)` builds `${PACKAGE}@${version}`, the same
constant the providers pass to `NpmProvider`, so one name serves the listing
and the install.

| manager | argv (`board upgrade` with latest 0.2.0, or `--version 0.2.0`) |
| --- | --- |
| npm | `npm install --global @chorded/board@0.2.0` |
| bun | `bun add --global @chorded/board@0.2.0` |
| pnpm | `pnpm add --global @chorded/board@0.2.0` |
| yarn (classic) | `yarn global add @chorded/board@0.2.0` |

Why not cliffy's default `*` (delegated resolution, `provider/npm.ts:15`,
`provider.ts:208-212`): bun treats `@*` as already satisfied by whatever is
installed. It changes nothing and exits 0, so board would report
"Successfully upgraded … to latest" when nothing moved. data found this with
`@biomejs/biome` and I reproduced it with `is-number` 6.0.0 → `@*` (see "What
was run"). npm 11.6.2, pnpm 12.11.2 and yarn 1.22.22 did upgrade under `@*`
in data's probe. An exact version moves all four. The cost is that a
manager's min-release-age policy can no longer pick an older version for
`latest` (`provider.ts:120-127`). A too-new version then fails in the
manager, with the manager's message, instead of quietly being stepped down.
It also costs a second `getVersions` fetch, since `isOutdated` and
`resolveVersion` each make one.

- The manager is the name looked up on `PATH`, never `process.execPath`
  (inside the binary that is board itself; cliffy's Bun runtime does exactly
  that, `runtime/bun_runtime.ts:18-20`, which is why that path is not used).
- No `--force`, unlike cliffy's Node runtime (`node_runtime.ts:21`): npm's
  `--force` also overrides its conflict and engine checks, and the same
  package owns the `board` bin, so nothing needs overriding. No `--silent`:
  the output is inherited, and the person should see the manager's progress.
- What gets recorded (probed): an exact version is written as is into bun's
  and yarn's global `package.json`, e.g. `"@chorded/board": "7.0.0"`, so the
  record is pinned. npm keeps no spec for a global install. A pinned record
  means a later `bun update -g` will not move board. `board upgrade` is the
  way to upgrade, and it always names the next exact version, so the pin is
  harmless and says exactly what is installed.
- yarn berry has no global install; if `yarn` on `PATH` is berry,
  `yarn global add` fails with berry's own message on the inherited stderr.
  Detection never picks yarn for a berry install, since there is none
  (data's question 1).
- Which install the manager on `PATH` writes to: open question Q3.
- Another manager: Volta (`volta install @chorded/board@1.2.3`) is the only
  one worth considering, and only if data finds its layout detectable; it is
  one more row in this table. Deno, `npx` and `bunx` are not installs.

### The default

`-r`'s default is `providers[0].name` when not standalone
(`upgrade_command.ts:108-109`, :251-261, :241-245). Ordering the array is the
only means the constructor offers; it is not called out in cliffy's docs as
"the way to choose the default", but it is what the code does and it is
plain constructor input, not a workaround. So: `[detected, …the rest in the
fixed order npm, bun, pnpm, yarn]`, and the fixed order alone when nothing
is detected.

Detection runs when the CLI is built, on the real path of the running
executable. To keep `src/main.ts` the only reader of the process, that path
comes in through `Deps` (realpath'd at the entry, as `cwd` is today), and
detection is data's pure function over it.

## 3. Output and exit codes

The contract is runtime's (`runtime.md` §2): `Bun.spawn` with all three
stdio inherited, no timeout, no signal handler, `spinner: false`. What
follows is what the person sees under it.

### What the person sees

Upgrading: cliffy prints nothing before the manager without `-v`
(`logger.log` is verbose only, `upgrade/logger.ts:22-24`); the manager's own
output follows, then cliffy's success line (`upgrade.ts:120-135`):

```
$ board upgrade

changed 2 packages in 3s
Successfully upgraded board from version 0.1.0 to 0.2.0! (https://npmjs.org/package/@chorded/board/v/0.2.0)
```

With `-v` (`upgrade.ts:70-86`, plus the hook's `$` line before the
manager runs):

```
$ board upgrade -v
Upgrading board to the latest version
Upgrading board:
  - current version: 0.1.0
  - target version: 0.2.0
$ npm install --global @chorded/board@0.2.0

changed 2 packages in 3s
Successfully upgraded board from version 0.1.0 to 0.2.0! (https://npmjs.org/package/@chorded/board/v/0.2.0)
```

Already current (`provider.ts:242-258`, a warning, then exit 0, no
manager run):

```
$ board upgrade
You're already using the latest available version 0.2.0 of board.
$ board upgrade --version 0.1.0
You're already using version 0.1.0 of board.
```

Unknown version (`provider.ts:225-240`), exit 1:

```
$ board upgrade --version 9.9.9
The provided version 9.9.9 is not found. The latest version is 0.2.0.

    Visit https://npmjs.org/package/@chorded/board for available releases or run again with the -l or --list-versions command.
```

The manager failing: its own output first, on the inherited streams; then
cliffy's line (`upgrade.ts:109-117`), then the hook's error message, logged
by the command before `exit(1)` (`upgrade_command.ts:192-197`):

```
$ board upgrade
npm error code EACCES
npm error syscall mkdir
…
Failed to upgrade board from version 0.1.0 to 0.2.0.
npm install --global @chorded/board@0.2.0 exited with status 243.
```

Killed by a signal while board lives, the last line names the signal
instead (`… was ended by SIGTERM.`). Ctrl-C ends board too (runtime §2), so
none of these lines appear then.

The manager missing (`Bun.spawn` throws `ENOENT` synchronously, "Executable
not found in $PATH: \"pnpm\""; the hook turns that into board's own
sentence), exit 1:

```
$ board upgrade -r pnpm
Failed to upgrade board from version 0.1.0 to 0.2.0.
pnpm is not on PATH. Install pnpm, or upgrade board with the manager that installed it (detected: npm).
```

Offline, or the registry answering not-OK, during an upgrade:
`NpmProvider.getVersions` throws (`provider/npm.ts:46-50`; offline,
`fetch`'s own rejection). The override rethrows it as a `Refusal`, the
command logs its message and exits 1:

```
$ board upgrade
board could not read the versions of @chorded/board from registry.npmjs.org: couldn't fetch the latest version - try again after sometime.
```

### `-l` and the completion lookup: outside the action's catch

- `-l`'s action calls `registry.listVersions(…)` (`upgrade_command.ts:119-125`),
  which calls `getVersions` (`provider.ts:281-287`). That action is an
  option action, run by `parseCommand` (`command.ts:2453-2457`) inside its
  `try`; its `catch` is `handleError` (`command.ts:2466-2467`,
  :2842-2850), which wraps only usage errors as `ValidationError` and
  rethrows the rest under `throwErrors` (`command.ts:2868-2869`). The
  failure leaves `parse`; `runCli` rethrows anything not a
  `ValidationError` (`src/cli/root.ts`); `src/main.ts` prints the error
  object with its stack, then `board: board failed inside: Error: couldn't
  fetch the latest version - try again after sometime Report it; nothing was
  changed.`, and exit 1. Seen in the probe: `upgrade -l` against the
  unpublished package threw out of `parse`.
- The completion lookup (`this.complete("version", () =>
  this.getAllVersions())`, `upgrade_command.ts:204-206, :209-220`) is
  called only by cliffy's completions command
  (`completions/complete.ts`), which board does not mount; it is
  unreachable today. If it were mounted, the same path as `-l` would apply.
- Proposal, documented means only: the `getVersions` override above throws
  board's `Refusal`, and `runCli` maps a `Refusal` the way the commands'
  `refusing` does (`src/cli/io.ts`): `board: <message> <next>` on stderr,
  return 1. Then:

  ```
  $ board upgrade -l
  board: board could not read the versions of @chorded/board from registry.npmjs.org: couldn't fetch the latest version - try again after sometime. Check the network and try again; nothing was changed.
  ```

  and inside the action the same `Refusal`'s message is what cliffy logs
  before `exit(1)` (above). The two paths differ only in the `board:`
  prefix and the `next` sentence, since the action logs `error.message`
  (`upgrade_command.ts:193-195`).
- What it needs on board's side, for the lead and Appendix B: a code for
  it in `BoardError` (say `registry`, details `{ reason }`), `registryError`
  beside `internalError` in `src/errors.ts`, and the `Refusal` branch in
  `runCli`. No cliffy behaviour is reached around. If the lead would rather
  not add a code, `internal` fits less well ("Report it" is wrong advice
  for an offline machine) but needs nothing new.

### Streams and colour

- No spinner: `spinner: false` (`upgrade_command.ts:80`, :167). cliffy's
  spinner writes frames to stdout (`internal/runtime/write_sync.ts`,
  `upgrade/spinner.ts:208-235`) and would interleave with the inherited
  manager output (runtime §2).
- `logger.info` (success) goes to stdout, `warn`/`error` to stderr
  (`upgrade/logger.ts:12-28`, through `console`). Board's rule is notes to
  stderr; the success line on stdout is cliffy's and harmless, as `upgrade`
  has no data output. Accept.
- Colour: cliffy colours through `@std/fmt/colors`, which is on unless
  `Deno.noColor` (`@jsr/std__fmt/colors.ts:57-77`); under Bun the messages
  carry ANSI codes even when piped and even with `NO_COLOR=1` (seen in the
  probe). That breaks board's "coloured only on a terminal". The documented
  switch is `setColorEnabled(false)` (`colors.ts:99`), global to the one
  `@jsr/std__fmt` 1.0.10 copy cliffy imports. Open question Q4.

### Exit codes

| case | where | code |
| --- | --- | --- |
| upgraded | action returns; `runCli` answers `deps.exitCode` | 0 |
| already current | `isOutdated` false, `upgrade()` returns (`upgrade.ts:65-69`) | 0 |
| `-l` | `exit(0)` (`upgrade_command.ts:124`) | 0 |
| `-l` with the registry unreachable | `Refusal` out of `parse`, mapped by `runCli` | 1 |
| unknown `-r` value, `--version` without a value, unknown option | `ValidationError` from parse, `runCli` prints `board: …` | 64 |
| unknown version, offline, registry error, manager missing, manager failed or signalled, no supported installation | `logger.error` then `exit(1)` (`upgrade_command.ts:192-197`) | 1 |
| Ctrl-C during the install | board dies by `SIGINT` (runtime §2) | 130 |

`exit` is `process.exit` (`internal/runtime/exit.ts`), so `.noExit()` on the
root does not hold for the two paths above that exit. The codes still fit
board's convention (1 refused, 64 usage), with one wrinkle: an unknown
`--version` is a usage mistake by board's lights but exits 1, because
cliffy finds it after parse. I would accept both rather than reach around
the action. Consequence for tests (runtime's): a failing `board upgrade`,
and a successful `-l`, must run in a subprocess, since `process.exit` would
end `bun test`; a failing `-l` returns through `runCli` and can be tested in
process.

Usage errors print one line, never the help: confirmed, `-r nope` gives
`board: Option "--registry" must be of type "provider", but got "nope".
Expected values: "npm", "bun", "pnpm", "yarn"` and 64.

## 4. The version check

What happens once a command named `upgrade` is mounted:

- `checkVersion` runs from the root's long `--version`
  (`command.ts:2590-2596`), from the `-h/--help` action of **every** command
  (`command.ts:2611-2620`; each command registers its own help option),
  and from `HelpCommand` (`help/help_command.ts:30`). It looks the command
  up by name (`upgrade/_check_version.ts:8`), skips only if listing is
  unsupported (:14-16) or `hasRequiredPermissions()` is false (:18-21),
  then fetches the latest version (:22) and appends a hint to the version
  string (:28-31).
- A failed fetch is not caught. In the probe, with `@chorded/board` not yet
  on the registry, `board --help`, `board ls --help`, `board help`,
  `board --version` and `board upgrade --help` all threw `couldn't fetch the
  latest version` out of `parse`; `runCli` rethrows anything not a
  `ValidationError`, so `src/main.ts` would print a stack and exit 1. Offline
  after publishing is the same. Online, every help costs a registry
  round-trip with no bound, and every CLI test that asks for help would
  reach the registry, which CLAUDE.md forbids. (With the `getVersions`
  override of section 3 the failure would become a `Refusal`, so help would
  print `board: …` and exit 1 instead of a stack: still a failing help.)

So "keep" is not possible, and "keep with a bound" is not reachable through
a documented means: the fetch is inside `NpmProvider.getVersions`, and
bounding it means replacing that fetch — rewriting the listing the owner
asked to keep, and it would also bound or swallow the failures the upgrade
itself must report. Options for the owner:

- **V1 (recommended).** The providers override `hasRequiredPermissions()`
  to answer `false`. `checkVersion` then returns before fetching
  (`_check_version.ts:18-21`) for all three entry points. In 1.3.1 nothing
  else reads it: the only callers are `_check_version.ts:18` and
  `UpgradeCommand.hasRequiredPermissions` (`upgrade_command.ts:222-224`),
  itself called only by `checkVersion`; the upgrade path never asks
  (`upgrade.ts`). One line, in a class board already subclasses, through a
  public abstract method of `Provider` (`provider.ts:161`). Cost: the method
  means "the runtime has the permission", and board answers "do not check";
  a later cliffy that consults it before upgrading would make `board
  upgrade` refuse. A test through a fake provider and fake manager would
  catch that on the version bump. The "new version available" hint is gone
  everywhere.
- **V2.** Replace the help and version actions through documented methods:
  `.versionOption("-V, --version", …, { action })` on the root,
  `.helpOption("-h, --help", …, { global: true, action })` on the root,
  every group (`project`, `milestone`) and the `UpgradeCommand` (each
  command registers its own help option, `command.ts:2606-2627`), and a
  board `help` command instead of `HelpCommand`. Same effect as V1, all
  documented, but it re-implements cliffy's three actions (and cannot call
  their private `exit`, harmless under `noExit`) and has to be repeated on
  every command added later. Much more surface for the same result.
- **V3.** Ask cliffy upstream for a switch (an `UpgradeCommand` option such
  as `versionCheck: false`, or a caught and bounded fetch), and take V1
  until it ships.
- **V4.** Keep the check and accept that help and `--version` fail offline
  and before the first publish, and that tests must stub the network. Not
  recommended; listed for completeness.

Mounting the command under another name with `upgrade` as an alias does not
help: `getCommand` finds aliases too (`command.ts:3391-3396`).

## 5. No supported installation, and `-r` against detection

### No supported installation identified

When detection (data's function over the real path) answers no manager —
a binary copied by hand, `build/`, `bun src/main.ts`, a local
`node_modules` install, `npx`, but also layouts board does not recognise
although a manager made them — every provider's `upgrade()` refuses,
whatever `-r` says. The message states what board could not do, not how
board got there:

```
$ board upgrade
Failed to upgrade board from version 0.1.0 to 0.2.0.
board cannot identify a supported global installation from this executable path: ~/src/board/build/darwin-arm64/board. If a package manager installed it, upgrade with that manager: npm install --global @chorded/board@0.2.0, bun add --global @chorded/board@0.2.0, pnpm add --global @chorded/board@0.2.0, or yarn global add @chorded/board@0.2.0. Not recognised: yarn with a custom --global-folder, npm link, and copies outside a manager's global directory.
```

The path is the real path, with the home directory shown as `~`. The
version in the commands is the resolved one. The list of unrecognised
layouts is data's (its question 2) and is kept beside the marker table, so
the message and the table change together.

Exit 1. Reasons: running a manager then would install a second board
somewhere else and leave the one that ran untouched, which is not an
upgrade; and the hook cannot tell `-r npm` typed by hand from `-r`'s
default, since the action receives only the chosen provider
(`upgrade_command.ts:153-156`, :111), so "allow it only with an explicit
`-r`" is not reachable without reading raw arguments. `-l` still works.
"Already current" is answered before the refusal, because `isOutdated` runs
first (`upgrade.ts:65-69`); that is true of the running board and harmless.

### `-r` and `isOutdated`: for the record

`isOutdated` compares the target against the **running** binary's version
(`upgrade_command.ts:164`, `upgrade.ts:65-69`, `provider.ts:242-258`) before
the hook runs. With two installs, `-r <other manager>` asks about an install
whose version cliffy never sees:

- the running board (npm) is at 0.2.0, the bun install at 0.1.0:
  `board upgrade -r bun` prints "You're already using the latest available
  version 0.2.0 of board." and never runs bun;
- the running board is at 0.1.0, the bun install at 0.2.0: `board upgrade -r
  bun` runs `bun add --global @chorded/board@0.2.0` and reports "upgraded
  from 0.1.0", which is neither install's before-and-after.

Options, none of which redesigns cliffy:

1. Keep `-r` and document `-f` for it: `board upgrade -r bun -f` skips
   `isOutdated` (`upgrade.ts:65-67`) and always runs the manager. The
   messages stay about the running board.
2. Mount only the detected provider. `-r` is then hidden (`:110`, fewer
   than two providers) and the case cannot arise; the four providers remain
   for detection to pick from. When nothing is detected one provider is
   still needed (`upgrade_command.ts:90-92`): npm, whose hook refuses as
   above. This departs from the owner's "`-r` picks one by hand".
3. Keep `-r` and refuse `-r` ≠ detected inside the hook. The hook runs only
   when `isOutdated` said yes, so the first case above still answers
   "already latest" without a refusal; only the second is caught.

Recommendation: **2**. In this design `-r` has no sound use left: with no
installation identified the hook refuses whatever `-r` says, and with one
identified `-r` can only point at a different install, where cliffy's
version comparison and messages are about the wrong binary. If the owner
keeps `-r`, then 1, with the warning line from the hook ("This board was
installed by npm; bun upgrades its own global install, not the board you
ran."). With Q3's option (c) taken, option 3 comes for free, since the
global-root check refuses an install that does not hold the running binary.

## Open questions every draft states

**Cliffy behaviours that do not fit without a non-documented workaround:**

1. The version check (section 4): owner picks V1, V2, V3 or V4. V1
   recommended.
2. `process.exit` inside `UpgradeCommand` (`upgrade_command.ts:124`, :197)
   ignores `.noExit()`. Options: (a) accept, exit 1 matches board's
   convention, failures tested in a subprocess (recommended); (b) subclass
   `UpgradeCommand` and replace its action — not a documented extension
   point, and it would re-implement the whole command.
3. An unknown `--version` exits 1, not 64 (section 3). Options: (a) accept
   (recommended); (b) validate the version in an option `value` — not
   possible without redefining cliffy's option.
4. `isOutdated` judges the running binary, not the install `-r` names
   (section 5). Options 1-3 there; recommend 2.

Settled within documented means, listed so they are not mistaken for
workarounds: cliffy's delegated `latest` (`*`) does not upgrade under bun,
answered by overriding the public `resolveVersion` (narrowing the protected
`delegateLatestResolution` fails `tsc`); a failing `-l` leaving the action's
catch, answered by overriding the public `getVersions` to throw board's
`Refusal` and mapping it in `runCli`.

**The smallest design that meets the owner's direction:**
`src/upgrade/providers.ts` with `NpmManagerProvider extends NpmProvider`
(`resolveVersion`, `getVersions`, `upgrade()`, and `hasRequiredPermissions()`
under V1) and one subclass per manager setting `name`; the pure
`installArgv(manager, version)`; and
`upgradeCommand(deps) = new UpgradeCommand({ provider: ordered(detect(realExecPath)), standalone: false, spinner: false })`,
mounted in `buildCli` as `.command("upgrade", upgradeCommand(deps))`. Plus
the `@cliffy/upgrade` dependency, the real exec path in `Deps`, data's
detection function, runtime's `runManager`, and on board's side the
`registry` refusal code with its `runCli` branch.

## Questions for the owner

- **Q1.** The version check: V1, V2, V3 or V4 (section 4). Recommend V1.
- **Q2.** No supported installation identified: refuse whatever `-r` says
  (recommended), or fall back to npm, or refuse only by default (needs
  reading raw arguments; not documented).
- **Q3.** Which install the manager writes to. The manager on `PATH`
  installs into its own global directory, which need not hold the running
  board (two nvm Nodes, an npm `prefix` setting, a `--prefix` install; on
  the probing machine `npm root -g` answered a directory outside the Node
  that ran it, because of an npm `prefix` setting). Options:
  - (a) run the manager as it is on `PATH`, no check (smallest);
  - (b) pass the install root derived from the real path to the manager
    (`npm --prefix`, `BUN_INSTALL`, yarn `--prefix`/`--global-folder`,
    pnpm `--global-dir`);
  - (c) a pre-check inside `upgrade()`, before the install: ask the manager
    for its global package directory and refuse, naming both paths, when
    the running binary's real path is not under it. The queries, each one
    read-only and quick:

    | manager | command | answers (probed) |
    | --- | --- | --- |
    | npm | `npm root -g` | `$PREFIX/lib/node_modules` |
    | bun | `bun pm bin -g` | `$BUN_INSTALL/bin`; there is no command that prints the global `node_modules` alone: `bun pm -g ls` prints it as the first word of its first line (`$BUN_INSTALL/install/global node_modules (1 installed)`), which is listing output, not an interface |
    | pnpm | `pnpm root -g` | pnpm's global `node_modules` (from pnpm's docs; not run here) |
    | yarn | `yarn global dir` | the global folder; packages are under its `node_modules` |

    For bun the check would have to derive `install/global/node_modules`
    from `bun pm bin -g`'s parent (wrong under `BUN_INSTALL_GLOBAL_DIR`) or
    read `bun pm -g ls`'s first line; both are guesses at bun's layout, so
    bun would either skip the check or refuse only on a clear mismatch.
    The check also answers section 5's option 3.

  Recommend (c) for npm, pnpm and yarn and (a) for bun, unless data finds
  the mismatch rare, in which case (a) throughout.
- **Q4.** Colour: call `setColorEnabled(deps.colors)` from `@std/fmt/colors`
  at the entry (documented std API, needs `@std/fmt` as a dependency at the
  version cliffy uses so it is the same module), or accept ANSI codes in
  `board upgrade`'s output when piped.
- **Q5.** `-r` and `isOutdated` (section 5): options 1-3; recommend 2.
- **Q6.** Volta as a fifth provider, if data finds it detectable.
