# Draft (data): install layouts, detection, versions, the board file

Answers the brief's "data" questions for `board upgrade`. Every claim about
cliffy cites `node_modules/@jsr/cliffy__upgrade/…` (written `upgrade/…`) or
`node_modules/@cliffy/command/…` (written `command/…`) at file:line, 1.3.1.
Every layout claim was probed (see "What was run"), except where it says
"not probed".

## 1. Install layouts per manager

`@chorded/board` is not on npm yet (`registry.npmjs.org/@chorded/board`
answers 404), so the probes used `@biomejs/biome` 2.5.14 and 2.5.15. It has
the same shape as ours: a Node shim in the main package that
`require.resolve`s `@biomejs/cli-darwin-arm64/biome` from an exact-version
`optionalDependency`. Each manager installed it globally under a temporary
prefix and a scratch `HOME`. Then the platform binary was overwritten with a
`bun build --compile` probe that prints `process.execPath`, its `realpath`
and `Bun.isStandaloneExecutable`, and the shim was run through the
manager's bin entry.

**`process.execPath` in a compiled Bun binary is already the real path.**
Started directly, through a symlink, through `PATH`, or by the Node shim, it
printed the symlink-resolved path (`/tmp/…` came back `/private/tmp/…`), equal
to `realpathSync(process.execPath)`. Detection still calls `realpath` once,
so it does not depend on that.

Below, `<plat>` is `board-darwin-arm64` or `board-darwin-x64`; the paths are
the binary's real path with `@biomejs/cli-…/biome` translated to
`@chorded/<plat>/bin/board`.

| Manager | Bin entry on `PATH` | Real path of the binary |
| --- | --- | --- |
| npm 11.6.2 | `$PREFIX/bin/board` → symlink to the shim | `$PREFIX/lib/node_modules/@chorded/board/node_modules/@chorded/<plat>/bin/board` (nested under the main package) |
| bun 1.4.3 | `$BUN_INSTALL/bin/board` → symlink to the shim | `$BUN_INSTALL/install/global/node_modules/@chorded/<plat>/bin/board` (hoisted; `BUN_INSTALL` defaults to `~/.bun`) |
| pnpm 12.11.2 | `$PNPM_HOME/bin/board`, a `/bin/sh` script, not a symlink | `$PNPM_HOME/global/v11/<hash>-<n>/node_modules/.pnpm/@chorded+<plat>@<version>/node_modules/@chorded/<plat>/bin/board` (`PNPM_HOME` defaults to `~/Library/pnpm`) |
| yarn classic 1.22.22 | `$(yarn global bin)/board` → symlink into `<global-folder>/node_modules/.bin` | `<global-folder>/node_modules/@chorded/<plat>/bin/board`; the default global folder is `~/.config/yarn/global` (`$XDG_CONFIG_HOME/yarn/global` when set) |
| yarn berry 4.18.1 | none | none: `yarn global` does not exist (it parses as `yarn run global` and fails "No project found") |

Prefix variants, all of which leave npm's layout as it is under another
`$PREFIX`:

- `npm config prefix` / `npm_config_prefix`: probed (`/tmp/upg/npm-prefix`).
- nvm: `$PREFIX` is `~/.nvm/versions/node/v<X>/`. Not probed.
- Homebrew's Node: `$PREFIX` is `/opt/homebrew` (arm64) or `/usr/local`
  (x64). Not probed.
- fnm: the `PATH` entry is a per-shell symlink under
  `fnm_multishells`, and `realpath` resolves it to
  `<fnm dir>/node-versions/v<X>/installation/lib/node_modules/…`, so npm's
  marker still holds. Not probed (fnm is not installed here).
- Volta: `volta install @chorded/board` (and `npm i -g` when Volta's `npm`
  shim intercepts it) installs into
  `~/.volta/tools/image/packages/@chorded/board/lib/node_modules/@chorded/board/node_modules/@chorded/<plat>/bin/board`,
  and the `board` on `PATH` is Volta's own shim. That is npm's marker, so
  detection says `npm`, and `npm install -g` run under Volta is intercepted
  by Volta, which is the right outcome. Not probed (Volta is not installed
  here; installing it touches the shell profile).

What a pnpm and a bun upgrade do to the path (2.5.14 → 2.5.15, probed):

- npm and yarn classic: the path stays the same and the file is a new inode.
- pnpm: the install moves to a new `global/v11/<hash>-<n>` directory, and
  the old one is deleted. The real path changes on every upgrade, so a
  running old binary is executing a file that has been unlinked. That
  belongs to runtime; here it only means detection must not expect a stable
  path.
- bun: `bun add -g @biomejs/biome@*` with 2.5.14 installed **does not
  upgrade**: `*` is already satisfied by the global lockfile
  (`$BUN_INSTALL/install/global/package.json` keeps `"*"`, and
  `cli-darwin-arm64` stays 2.5.14). `--latest` doesn't change that, and
  `bun update -g` says "no changes". `@latest` and an exact version do
  upgrade (and downgrade). This collides with cliffy's mapping of
  `latest` to `*` (section 3).

Other managers and launchers:

- **`deno install -g npm:@chorded/board`** (Deno 2.9.7, probed with
  `DENO_INSTALL_ROOT`) writes `$DENO_INSTALL_ROOT/bin/board`, a `sh` script
  that runs `deno run … 'npm:@chorded/board@<spec>'`, and the binary sits
  at `$DENO_INSTALL_ROOT/bin/.board/node_modules/.deno/@chorded+<plat>@<version>/node_modules/@chorded/<plat>/bin/board`.
  The shim's `require.resolve` works under Deno. It is detectable
  (`/bin/.board/node_modules/.deno/`), but upgrading means rewriting the
  install's pinned specifier (`deno install -g -f`). **Not worth a provider
  in v1** (the README tells people to use npm, and nobody has asked for it);
  if it is wanted, it is a fifth provider later, with the same shape.
- **npx**: the binary is at `~/.npm/_npx/<hash>/node_modules/@chorded/<plat>/bin/board`
  (probed with `npm_config_cache`). **bunx**: it is at
  `$TMPDIR/bunx-<uid>-@chorded/board@<spec>/node_modules/@chorded/<plat>/bin/board`
  (probed). Both are caches that the next `npx`/`bunx` call refreshes or
  replaces. No provider: there is nothing installed to upgrade.
- Volta is an npm layout (above), not a provider of its own.

**A path names a manager, not the install the manager on `PATH` will
write.** There are several ways the two can differ:

- Two npms: nvm's Node A against Node B, Homebrew's against nvm's, or a
  custom `prefix` in one shell and not another.
- Two pnpm majors: `global/5` for pnpm 10 and older against `global/v11`
  for pnpm 11 and newer.
- A `BUN_INSTALL` or yarn `global-folder` that differs from the one board
  was installed under.

In each case `npm i -g` (or the others) succeeds into another root, and
the running board is not upgraded. Each manager can print its global root,
so a pre-check can compare it with the binary's real path before
spawning:

| Manager | Command | Prints (probed) | The binary is this install when its real path starts with |
| --- | --- | --- | --- |
| npm | `npm root -g` | `$PREFIX/lib/node_modules` | `realpath(<printed>)/@chorded/board/node_modules/@chorded/` |
| pnpm | `pnpm root -g` | `$PNPM_HOME/global/v11` (pnpm 12.11.2) | `realpath(<printed>)/` (pnpm 11+ adds one `<hash>-<n>` directory below it; an older pnpm prints `…/global/5/node_modules`, not probed) |
| yarn classic | `yarn global dir` | the global folder (`~/.config/yarn/global` by default) | `realpath(<printed>)/node_modules/@chorded/` |
| bun | none prints the root. `bun pm bin -g` prints `$BUN_INSTALL/bin`; `bun pm ls -g`'s first line is `<root> node_modules (N installed)`, human output | `$BUN_INSTALL/bin` | `realpath(<bin>/..)/install/global/node_modules/@chorded/`, a derivation that is wrong when bun's `globalDir` is configured apart from `BUN_INSTALL` |

npm, pnpm and yarn give a direct answer. Bun doesn't, so its check is
either derived from `bun pm bin -g` (stated as such) or left out for bun.
Whether to run the pre-check at all, and what to do on a mismatch (refuse,
and name both paths), belongs to interfaces and runtime. Data's view:
refuse on a mismatch, because an upgrade that succeeds into another root
is the one failure the person can't see.

## 2. Detection as data

One pure function, `detectManager(realPath: string): Detected`, over the
binary's real path (`realpathSync(process.execPath)`, taken by the caller,
which is the only part that touches the file system). The table is
ordered: the first row whose pattern matches wins. Every manager row
contains `@chorded/board-darwin-`, so a Bun or Node that happens to live
under a global `node_modules` (`bun src/main.ts`, `npm i -g bun`) never
matches.

| # | Pattern (on `/`-separated real path) | Answer |
| --- | --- | --- |
| 1 | `/_npx/[^/]+/node_modules/@chorded/board-darwin-` | none: `npx` |
| 2 | `/bunx-[^/]+/node_modules/@chorded/board-darwin-` | none: `bunx` |
| 3 | `/install/global/node_modules/@chorded/board-darwin-` | `bun` |
| 4 | `/global/[^/]+/(?:[^/]+/)?node_modules/\.pnpm/@chorded\+board-darwin-` | `pnpm` (`global/5/…` before pnpm 11, `global/v11/<dir>/…` from 11) |
| 5 | `/yarn/global/node_modules/@chorded/board-darwin-` | `yarn` |
| 6 | `/lib/node_modules/@chorded/board/node_modules/@chorded/board-darwin-` | `npm` (any prefix: nvm, Homebrew, fnm, Volta) |
| 7 | anything else | none: cannot identify a supported global installation |

Rows 1–2 come first because they are ephemeral, which is a stronger fact
than any layout. Rows 3–6 do not overlap: each needs a segment that the
others' layouts never have (`install/global`, `.pnpm` under `global/`,
`yarn/global`, `lib/node_modules/@chorded/board/node_modules`). A local
pnpm project (`<proj>/node_modules/.pnpm/…`) lacks `global/` and falls to
row 7.

Row 7 means "cannot identify a supported global installation". It does
**not** mean "not installed by a manager": several manager installs land
there. So the message names the path and the supported layouts, and never
says board was installed by hand. What lands in row 7:

- Not installed by a manager:
  - a binary copied by hand, or a development build
    (`build/darwin-arm64/board`);
  - `bun src/main.ts`: `execPath` is Bun itself, and
    `isStandaloneExecutable` is false.
- Installed by a manager, in a layout v1 does not upgrade:
  - a local install in a project's `node_modules` (any manager, hoisted or
    `.pnpm`);
  - yarn classic with a custom `global-folder` (indistinguishable from a
    local install by path, since row 5 needs the default folder name);
  - pnpm with a custom `global-dir` (no `/global/` segment);
  - bun with `globalDir` (`bunfig.toml` or `BUN_INSTALL_GLOBAL_DIR`) set
    away from `install/global`. Not probed;
  - npm with `--install-strategy=linked` (`node_modules/.store/…`). Not
    probed;
  - `deno install -g` (`bin/.board/node_modules/.deno/…`), which has no
    provider (section 1);
  - anything Homebrew or a tarball might add later (non-goals).

Rows 1–2 (npx, bunx) are none as well, for a different reason: nothing is
installed to upgrade.

**Recommendation for none:** detection answers `{ manager: undefined,
path, why: "npx" | "bunx" | "unsupported" }`. It never guesses a manager, since
guessing would run a global install the person did not make and leave two
boards on `PATH`. How that reaches the command line (refuse, or let an
explicit `-r` through) is interfaces' item 5. The constraint from cliffy:
`-r`'s default is `providers[0]` once `standalone` is false
(`command/upgrade/upgrade_command.ts:107-109, 241-261`), and the option's
`value` handler only gets the name. So the command cannot tell an explicit
`-r npm` from the default without something outside the documented
options. If interfaces chooses "refuse unless `-r` is explicit", that is a
question for main (see "Cliffy fit" below).

Tests: one table of real paths per row, taken from this draft's probes
(with `~` and `$PREFIX` written out as fixed strings), plus the row 7 cases.
No file system access.

## 3. Versions

**The package name.** `UpgradeCommand` calls `getVersions(name)` and
`listVersions(name, …)` with the root command's name, `board`
(`command/upgrade/upgrade_command.ts:120-123, 216-218, 236-238`).
`NpmProvider` built with `{ package: "@chorded/board" }` splits it into
scope and name (`upgrade/provider/npm.ts:23-29`), and `#getPackageName`
ignores the argument when a name is set (`npm.ts:74-78`). It fetches
`new URL("@chorded/board", "https://registry.npmjs.org/")` =
`https://registry.npmjs.org/@chorded/board` (`npm.ts:43-45`, checked with
`deno eval`). The registry answers an unescaped scoped name (200 for
`@biomejs/biome`). So yes, it reaches `@chorded/board`, as long as every
provider is constructed with `package: "@chorded/board"`.

**Before the first publish** the URL answers 404, and `getVersions` throws
"couldn't fetch the latest version - try again after sometime"
(`npm.ts:46-50`). That reaches `upgrade`, `-l`, and the version check
(`command/upgrade/_check_version.ts:22`) until the first release. It's
harmless only if the version check is handled (interfaces' item 4).

**The main package's list is the right one.** Decision 25 publishes both
platform packages first and `@chorded/board` last (`tool/release.sh`'s
`packages` order; design "Build and distribution", step 11), and
`tool/npm-assemble.ts:23-33` stamps the one repository version into all
three. So every version in `@chorded/board`'s list has both platform
packages already published at the same version. A run stopped between
publishes leaves a platform version that `@chorded/board` does not list,
so it can't be chosen. Listing a platform package instead would offer
exactly those half-published versions. One gap remains, and no listing
closes it: optional dependencies. If the platform package can't be fetched
(a mirror that lags on it, or `omit=optional` in the person's config), npm
skips it, the install exits 0, and the next `board` prints the shim's "no
@chorded/board-darwin-… is installed" (`npm/board/bin/board.js:11-18`).
Recommendation: accept this for v1 and mention it in the failure text of
the shim, not in `upgrade`. A post-install check (run the new install's
binary with `--version`) is possible inside the provider's `upgrade()`, but
the new binary's path is the manager's business (pnpm moves it, see
section 1). It's an option, not part of the smallest design.

**`latest` versus `*`.** `NpmProvider` sets `delegateLatestResolution`
(`npm.ts:15`), so `resolveVersion("latest")` stays `latest`
(`upgrade/provider.ts:187-193`). `getRegistryUrl` maps it to
`npm:@chorded/board@*` (`npm.ts:68-72`, `provider.ts:208-212`), and the
success line says "to latest" (`upgrade/upgrade.ts:120-124`). Meanwhile
`isOutdated` compares against `dist-tags.latest` (`provider.ts:219-223`).
With bun, `@*` installs nothing new (section 1), so board would report a
successful upgrade that did not happen. Options:

- (a) **Recommended.** Each provider overrides the public
  `resolveVersion(name, version)` (`provider.ts:187`) so that `latest`
  returns `(await this.getVersions(name)).latest`, which is
  `dist-tags.latest` (`npm.ts:52-58`), and any other version passes through
  unchanged. `upgrade()` assigns the result to `options.to`
  (`upgrade.ts:83`), so every manager gets an exact version, and
  `resolveSpecifierVersion` passes it through (`provider.ts:208-212` only
  rewrites `latest`). The lines then say "from 0.1.0 to 0.2.0", and a
  mirror that lacks that version fails loudly instead of installing
  something older. Overriding `delegateLatestResolution` to `false`
  instead, as the first version of this draft said, doesn't type-check:
  `NpmProvider`'s declaration narrows it to the literal `true`
  (`_dist/provider/npm.d.ts:10`). Cost: a second registry fetch
  (`isOutdated` and `resolveVersion` each call `getVersions`, uncached),
  and a min-release-age policy refuses instead of downgrading. Neither
  matters for board.
- (b) Keep delegation, and have each provider's `upgrade()` turn `latest`
  into its own spelling (`@latest` for bun, `@*` or `@latest` for the
  rest). The lines keep saying "to latest", and what was installed is
  never shown.

**The current version** is `pkg.version`, the repository's `package.json`
bundled at build time (`src/cli/root.ts:3, 24`). `UpgradeCommand` reads it
through the parent's version handler (`this.getVersion()`,
`command/command.ts:2951-2958`). Because `npm-assemble.ts` writes the same
version into all three packages and the main package pins the platform
packages exactly, the running binary's version equals what the manager
recorded for `@chorded/board`. Ways they can still differ, none of which
needs handling:

- A development build reports the repository's version, but detection
  answers none.
- Two installs: detection follows the binary that is actually running, so
  `from` is right and the detected manager is the right *kind*. But the
  manager on `PATH` may write another root: another npm (nvm A against B,
  a custom prefix), another pnpm major, or another `BUN_INSTALL`. Then the
  install succeeds elsewhere, `from` describes a binary that was not
  touched, and the "successfully upgraded" line is false. The global-root
  pre-check in section 1 catches this for npm, pnpm and yarn, and for bun
  only by derivation. `-r` naming another manager on purpose upgrades
  that manager's install, with the same wrong "from"; that belongs to
  interfaces' item 5.
- `isOutdated`'s "already latest" compares strings
  (`provider.ts:243-258`) and returns false, and `upgrade()` then does
  nothing (`upgrade.ts:65-69`). That's right because the versions are the
  same string by construction.

**Another registry or a mirror.** `NpmProvider`'s registry is a private
field fixed to `https://registry.npmjs.org/` (`npm.ts:16-17`), with no
constructor option. The manager installs from the person's own
configuration (`.npmrc` `registry` or `@chorded:registry`, `bunfig.toml`,
pnpm's and yarn's `registry`). The effects:

- A mirror that lags: `isOutdated` accepts X from npmjs.org, and the
  manager fails "no matching version" (with option (a)) or installs the
  mirror's older latest (with `*`).
- npmjs.org blocked, mirror reachable: listing fails, so `upgrade` fails
  although the manager could install.

Options:

- (i) **Recommended for v1:** accept it and say in help that versions are
  listed from npmjs.org. board is published there only.
- (ii) Each provider overrides `getVersions` (public, abstract on
  `Provider`, `provider.ts:163`) to ask its own manager (`npm view
  @chorded/board versions dist-tags --json`, `pnpm view`, `yarn info`,
  `bun pm view`). That respects the person's registry and auth, but it
  replaces the listing the owner asked to keep, and it spawns the manager
  for `--help`'s version check too.

That's the owner's call; (i) unless mirrors are a real case.

## 4. The board file across an upgrade

**`board upgrade` never opens the board.** It needs no `BOARD_DIR`, no
`board.db`, no `Store`, and it writes no event. There's no transaction to
design. That's deliberate:

- It must work on a machine with no board yet.
- It must work on a board the running binary refuses with `schema_mismatch`.
  That's the one way out of a mismatch short of starting over: `board
  upgrade --version <old>` back to a binary that reads the file.
- Recording upgrades as events would need an open, and events are about
  projects (design "Events").

The invariant for the implementation: the `upgrade` command takes no
`Deps` that open the store, and a test runs it with `BOARD_DIR` pointing
at a missing directory.

**Old processes on the new install.** Each `board mcp` is a shim waiting
on a binary that started before the upgrade. It keeps that binary's code
until its agent restarts it (runtime covers what the manager does to the
file underneath). On the file:

- **Same `user_version`:** old and new processes share `board.db` under
  WAL exactly as two processes of one version do. Decision 11's lock
  statement and the per-transaction `user_version` check
  (`src/store/store.ts:143`) don't depend on the version. What can differ
  is behaviour: a rule or tool shape changed between versions, so for a
  while agents on one board answer by two rule sets. Before the first
  release that's accepted, as tool shapes change freely (CLAUDE.md).
- **Different `user_version`** (decision 10): the new binary refuses every
  command and tool with `schema_mismatch` ("…is a board of schema version
  1; this board reads version 2", `src/store/outcome.ts:101-112`). Old
  servers keep working on the old file until they restart, then refuse too.
  Nothing is corrupted, since nothing reads or rewrites another version's
  file. But the person learns about it only after the upgrade, and the
  only remedies are downgrading or the offline start-over (which loses the
  board's contents).

What `board upgrade` should say, options:

- (A) **Recommended:** after a successful upgrade, one line: running `board
  mcp` servers keep the old version until their agents restart them. No
  schema warning. A mismatch then shows on first use, with the existing
  `next`, and the downgrade above gets it back.
- (B) Warn before installing when the target's schema differs. The
  current binary can't know the target's `SCHEMA_VERSION`. It would have
  to be published (say a `"board": { "schema": 2 }` field in the
  main package's `package.json`, which the registry returns per version),
  release-time stamping added to `npm-assemble.ts`, and a fetch of ours,
  because `NpmProvider.getVersions` keeps only the version keys
  (`npm.ts:52-58`). That's more code around cliffy and a release change.
- (C) Add the downgrade (`board upgrade --version <previous>`) to
  `schema_mismatch`'s `next`. It's a small, separate change to existing
  text, and it pairs with (A).

The owner's call: (A), (A)+(C), or (B). Without a release there's no
"previous version" history to speak of, which argues for (A) now and (B)
or (C) when the first release fixes a schema.

Concurrency: two `board upgrade`s at once are two managers running global
installs at once. board adds no lock, since the managers own their records
(npm has no global-install lock). If board took a lock it would have to be
a file of its own outside the board, which is something we'd write and
nothing asks for.

## Cliffy fit (the first open question)

Seen from the data side, nothing needs a non-documented workaround if the
recommendations hold:

- Package name: a constructor option (`npm.ts:4-11`).
- Exact versions instead of `*`: overriding the public `resolveVersion`
  (`provider.ts:187`) in each provider subclass.
- Listing from npmjs.org only: accepted, not worked around.
- `upgrade()` per provider with `standalone: false`: the documented hook
  (`provider.ts:169`, `upgrade.ts:89-98`).

Two things would need main:

1. "Refuse when detection finds none unless `-r` is explicit". The command
   can't see whether `-r` was given (`upgrade_command.ts:104-113`). Options:
   (a) fall back to `npm` and say so; (b) refuse always when none matches,
   with the command to run by hand (no `-r` escape); (c) a first, placeholder
   provider whose `upgrade()` refuses, which gives a documented subclass but
   an odd `-r` value; (d) read `getRawArgs()` in a wrapping action, which is
   not documented for this. Interfaces owns the choice; data's view is (b),
   since it's the smallest and never guesses.
2. A mirror listing (option (ii) above), only if the owner wants it.

## The smallest design (the second open question)

- Four providers (`npm`, `bun`, `pnpm`, `yarn` for yarn classic), each
  `NpmProvider({ package: "@chorded/board" })` with
  `resolveVersion` turning `latest` into `dist-tags.latest`, and its own
  `upgrade()`. No yarn berry
  (no global install), no deno, npx, bunx or Volta provider.
- `detectManager(realPath)`: the seven-row table above, pure, tested by a
  table of paths. The detected provider goes first in the array; none is
  reported, never guessed.
- Versions from npmjs.org through `NpmProvider` as it is. The current
  version is `pkg.version`.
- No board access in `upgrade`; one line after success about running
  servers.

## What was run

All under `/tmp/upg` with a scratch `HOME` per manager and `env -i`; nothing
global on this machine was touched:

- `bun build --compile probe.ts`: a probe printing `execPath`, its
  `realpath`, `argv0` and `isStandaloneExecutable`, run directly, through a
  symlink, and through `PATH`.
- npm 11.6.2 (`npm_config_prefix`), bun 1.4.3 (`BUN_INSTALL`), pnpm 12.11.2
  through corepack (`PNPM_HOME`), yarn 1.22.22 (`--global-folder`,
  `--prefix`): a global install of `@biomejs/biome@2`, the probe swapped
  into the platform package, the shim run. Then `@2.5.14` followed by `@*`
  for each, with paths and inodes recorded. Then bun with `@latest`, exact
  versions, `bun update -g` and `--latest`.
- yarn 4.18.1 through corepack: `yarn global add` (doesn't exist).
- Deno 2.9.7: `deno install -g -A -n biome npm:@biomejs/biome@2` with
  `DENO_INSTALL_ROOT` and `DENO_DIR`, and the shim run.
- `npx -y @biomejs/biome@2` with `npm_config_cache`, and `bunx
  @biomejs/biome@2` with `TMPDIR` and `BUN_INSTALL_CACHE_DIR`.
- `curl` against `registry.npmjs.org` for `@chorded/board` (404, both
  spellings) and `@biomejs/biome` (200).
- `deno eval` of the URL `NpmProvider` builds.
- Global roots, in a second scratch directory: `npm root -g` and `npm prefix
  -g` under `npm_config_prefix`; `bun pm bin -g`, `bun pm ls -g` and `bun pm
  root -g` (not a command) under `BUN_INSTALL` after one `bun add -g`.
  `pnpm root -g` and `yarn global dir` come from the first round.

Not probed: nvm, Homebrew Node, fnm, Volta (their layouts are as these tools are known
to lay out, unverified, marked above), npm's linked install strategy, and the real
`@chorded/board` (unpublished).
