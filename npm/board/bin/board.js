#!/usr/bin/env node
// The `board` command npm installs: it runs the binary of this machine's
// platform package with the same arguments and stdio, and leaves as the
// binary left. A Node script, because npm runs `bin` with the user's Node
// and the user need not have Bun.

const { spawn } = require("node:child_process");

const platform = `@chorded/board-${process.platform}-${process.arch}`;
let binary;
try {
	binary = require.resolve(`${platform}/bin/board`);
} catch {
	process.stderr.write(
		`board: no ${platform} is installed. board runs on macOS, arm64 and x64; reinstall @chorded/board on one of those, with optional dependencies.\n`,
	);
	process.exit(1);
}

// spawn, not spawnSync: a blocked event loop cannot forward a signal, and a
// SIGTERM to this process alone would leave the binary running.
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of forwarded) {
	process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
	process.stderr.write(`board: ${binary} did not start: ${error.message}\n`);
	process.exit(1);
});
child.on("exit", (status, signal) => {
	if (signal) {
		// Re-raise the child's signal, so a command ended by Ctrl-C still ends
		// by SIGINT (130) as seen from the shell; the handler goes first, or
		// it would catch the signal again.
		for (const name of forwarded) process.removeAllListeners(name);
		process.kill(process.pid, signal);
		return;
	}
	process.exit(status ?? 1);
});
