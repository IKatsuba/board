import { realpathSync } from "node:fs";
import { setColorEnabled } from "@jsr/std__fmt/colors";
import { runCli } from "./cli/root.ts";
import { SystemClock } from "./clock.ts";
import { boardEnv } from "./env.ts";
import { errorText, internalError } from "./errors.ts";
import { ProcessGitRunner } from "./place/git.ts";
import { managerProviders } from "./upgrade/providers.ts";

// Bun ignores SIGPIPE, so a reader that closed stdout (`board watch | head`)
// shows up as EPIPE: on the stream's error event, or thrown by write. Either
// way it is the end, quietly, with what a shell shows for SIGPIPE.
const CLOSED = 141;
const closed = (error: unknown) =>
	(error as { code?: unknown } | null)?.code === "EPIPE";
process.stdout.on("error", (error) => {
	if (closed(error)) process.exit(CLOSED);
	throw error;
});
function out(text: string): void {
	try {
		process.stdout.write(`${text}\n`);
	} catch (error) {
		if (closed(error)) process.exit(CLOSED);
		throw error;
	}
}

// The only reader of the environment and the cwd: everything else takes
// them as parameters. getcwd, never PWD: it is already the real path.
const deps = {
	io: {
		out,
		err: (text: string) => process.stderr.write(`${text}\n`),
		errRaw: (chunk: Uint8Array | string) => process.stderr.write(chunk),
	},
	env: boardEnv(process.env),
	clock: SystemClock,
	runner: new ProcessGitRunner(),
	cwd: process.cwd(),
	colors: process.stdout.isTTY === true,
	exitCode: 0,
	environment: process.env,
	upgrade: {
		// Already real in a compiled binary; realpath once anyway.
		execPath: realpathSync(process.execPath),
		providers: managerProviders(process.env),
	},
};

// cliffy colours through this copy of @std/fmt, on even when piped otherwise.
setColorEnabled(deps.colors);

try {
	process.exitCode = await runCli(process.argv.slice(2), deps);
} catch (error) {
	console.error(error);
	process.stderr.write(`${errorText(internalError(error))}\n`);
	process.exitCode = 1;
}
