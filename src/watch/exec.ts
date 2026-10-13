import { jsonLine, summary, type WatchLine } from "./derive.ts";

/** How long output already in the pipes is read once the command exits. */
const AFTER_EXIT = 100;

/** Where a command's output and its failures go: the watcher's stderr. */
export type Sink = (chunk: Uint8Array | string) => void;

/** What a person's notifier gets besides the line's JSON on stdin. */
export function execEnvironment(line: WatchLine): Record<string, string> {
	return {
		BOARD_EVENT_ID: line.id === null ? "" : String(line.id),
		BOARD_EVENT_KIND: line.kind,
		BOARD_EVENT_AT: line.at,
		BOARD_PROJECT: line.project ?? "",
		BOARD_TASK: line.task ?? "",
		BOARD_ACTOR: line.actor,
		BOARD_SUMMARY: summary(line.kind, line.data),
	};
}

/**
 * Runs `command` through `sh -c` for one line and waits for it: the line's
 * JSON on stdin, the BOARD_* environment, its output to `sink`, never into
 * the stream. Past `timeoutSeconds` it gets SIGTERM, then SIGKILL 2 s later.
 * A failure is one line on `sink`, and the stream goes on.
 */
export async function runExec(
	command: string,
	line: WatchLine,
	timeoutSeconds: number,
	sink: Sink,
	/** The environment board was started with, which the command inherits. */
	inherited: Readonly<Record<string, string | undefined>>,
): Promise<void> {
	const child = Bun.spawn(["sh", "-c", command], {
		stdin: new TextEncoder().encode(`${jsonLine(line)}\n`),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...inherited, ...execEnvironment(line) },
	});
	let timedOut = false;
	let kill: ReturnType<typeof setTimeout> | undefined;
	const term = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
	}, timeoutSeconds * 1_000);
	const readers = [child.stdout.getReader(), child.stderr.getReader()];
	const forwarded = Promise.all(
		readers.map(async (reader) => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				sink(value);
			}
		}),
	);
	const code = await child.exited;
	clearTimeout(term);
	clearTimeout(kill);
	// The command is done when its process is: a process it left behind may
	// hold the pipes open, so what is already in them is read for a moment
	// and the rest is not waited for.
	await Promise.race([forwarded, Bun.sleep(AFTER_EXIT)]);
	await Promise.all(readers.map((reader) => reader.cancel()));
	await forwarded.catch(() => {});
	const which = line.id === null ? `the derived ${line.kind}` : `#${line.id}`;
	if (timedOut) {
		sink(
			`board: --exec did not finish in ${timeoutSeconds} s for ${which}; stopped (${child.signalCode})\n`,
		);
	} else if (code !== 0) {
		sink(`board: --exec exited ${child.signalCode ?? code} for ${which}\n`);
	}
}
