# board

A local task board for coding agents, not for people.

board keeps the work of agent teams in one SQLite file per machine, with every project in it: the tasks, what each waits for, who holds it, every handover, every question for the owner and the answer it got. Agents read and write it with the `board` command from their shell, which finds the project from the directory it runs in; the session that drives the team (chord's `main`) reads it to decide what comes next. There is no daemon and no web UI: board is memory, not an engine.

It is built to sit beside [chord](https://github.com/IKatsuba/chord), a terminal client for agents that speak the Agent Client Protocol, but any agent that can run a shell command can use it.

## Status

v1 is built, with the CLI as its whole interface; `docs/design.md` is the design.

## Planned use

```sh
board project add APP --actor owner          # in the repository's root: keys APP-1, APP-2, … in ~/.board/board.db
board skill                                  # what an agent needs to know; put it in the team's instructions
board ls                                     # what is open in this project
board answer Q7 2 --as owner --actor owner   # answer a question your agents asked
```

An agent works the board from its shell, naming itself on every write:

```sh
board next
board claim APP-4 --actor main --holder @lead --minutes 90
board handover APP-4 --actor @lead --to main --text 'Ready for review.' \
  --changed 'src/api.ts' --ran 'bun test' --unchecked 'the docs'
```

There is no server to configure: nothing goes in `.mcp.json`.

With chord, board needs nothing from chord. Give each team's instructions (and `main`'s) the output of `board skill`, or tell them to run it first, and name each role the actor it writes as (`main`, `@lead`, `@tester`). Every agent runs `board` from its own shell, in its own directory; a team run in a git worktree finds the project through git. `main` claims a task for the lead it starts, and the lead hands over to `main` when it is done.

## Planned install

macOS only, arm64 and x64, through npm:

```sh
npm install -g @chorded/board
```

The main package pulls in the package for your platform (`@chorded/board-darwin-arm64` or `@chorded/board-darwin-x64`), which holds one binary built with `bun build --compile`. It uses the SQLite that macOS ships and needs macOS 13 or newer. It is signed with a Developer ID and notarised; on first run, Gatekeeper checks the notarisation online.

`board upgrade` installs the latest version (or `--version VERSION`) through the manager that installed board globally: npm, bun, pnpm or yarn classic. It runs that manager as you would, the one your `PATH` finds now. If `PATH` leads to another install than the board you ran (two nvm Nodes, a custom npm `prefix` in one shell, pnpm 10 against 12, another `BUN_INSTALL`), the upgrade goes to that manager's install and the running board stays as it is. Each `board` command after the upgrade runs the `board` your `PATH` finds; a running `board watch --follow` keeps the old version until it is restarted.

If an upgrade is interrupted and `board` is gone (pnpm 10 uninstalls it when stopped midway), install it again with the same manager:

```sh
npm install -g @chorded/board
bun add -g @chorded/board
pnpm add -g @chorded/board
yarn global add @chorded/board
```
