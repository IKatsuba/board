import { ValidationError } from "@cliffy/command";
import { Table } from "@cliffy/table";
import { Board } from "../board.ts";
import type { Clock } from "../clock.ts";
import type { Env } from "../env.ts";
import {
	type BoardError,
	errorText,
	internalError,
	Refusal,
} from "../errors.ts";
import type { GitRunner } from "../place/git.ts";
import { Place } from "../place/place.ts";
import { Store } from "../store/store.ts";
import type { Manager } from "../upgrade/detect.ts";
import type { NpmManagerProvider } from "../upgrade/providers.ts";
import { shown } from "../visible.ts";

export { shown };

/** Where the CLI writes: data to `out`, notes and errors to `err`. */
export interface Io {
	out(text: string): void;
	err(text: string): void;
	/** Raw bytes to stderr, such as a --exec command's output; err by default. */
	errRaw?(chunk: Uint8Array | string): void;
}

/** What the entry point gives the CLI, so tests run it in process. */
export interface Deps {
	io: Io;
	/** The board's location, or why BOARD_DIR / HOME give none. */
	env: Env | BoardError;
	clock: Clock;
	runner: GitRunner;
	/** The process's cwd, a real path. */
	cwd: string;
	/** Help is coloured only on a terminal. */
	colors: boolean;
	/** Set by a command a rule or the database refused. */
	exitCode: number;
	/** The environment board was started with, for --exec to inherit. */
	environment?: Readonly<Record<string, string | undefined>>;
	/** The running binary's real path and the providers `board upgrade` picks from. */
	upgrade?: {
		execPath: string;
		providers: Record<Manager, NpmManagerProvider>;
	};
}

/** The env, or the configuration error as a refusal. */
export function envOf(deps: Deps): Env {
	if ("code" in deps.env) throw new Refusal(deps.env);
	return deps.env;
}

/** Where a command looks for its project: its own cwd, then git. */
export function placeOf(deps: Deps): Place {
	return new Place(deps.cwd, deps.runner);
}

/** Opens the board for one command, and closes it after. */
export async function withBoard<T>(
	deps: Deps,
	fn: (board: Board) => Promise<T>,
): Promise<T> {
	const board = new Board(await Store.open(envOf(deps), deps.clock));
	try {
		return await fn(board);
	} finally {
		await board.close();
	}
}

/**
 * Runs a command's work: a refusal, or any exception in board's own code
 * as `internal`, is printed on stderr (the error object under --json) and
 * sets exit 1.
 */
export async function refusing(
	deps: Deps,
	json: boolean | undefined,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		await fn();
	} catch (error) {
		// A usage error found while running is still a usage error, 64.
		if (error instanceof ValidationError) throw error;
		const refused =
			error instanceof Refusal ? error.error : internalError(error);
		deps.io.err(
			json === true
				? JSON.stringify({ error: refused })
				: shown(errorText(refused)),
		);
		deps.exitCode = 1;
	}
}

/**
 * A borderless table; it counts terminal cells, so wide characters align.
 * Every cell is shown, not sent.
 */
export function table(header: string[] | null, rows: string[][]): string {
	const t = new Table()
		.body(rows.map((row) => row.map(shown)))
		.border(false)
		.padding(2)
		.indent(0);
	if (header !== null) t.header(header.map(shown));
	return t.toString();
}

/** A range checked at parse, as cliffy's `value` hook does. */
export function inRange(name: string, min: number, max = Infinity) {
	return (n: number): number => {
		if (n < min || n > max) {
			const range = max === Infinity ? `at least ${min}` : `${min} to ${max}`;
			throw new ValidationError(`${name} is ${range}, got ${n}.`);
		}
		return n;
	};
}

/**
 * A text length checked at parse, as the tool's schema checks it: JSON
 * Schema counts code points, not UTF-16 units.
 */
export function lengthIn(name: string, min: number, max: number) {
	return (text: string): string => {
		const length = [...text].length;
		if (length < min || length > max) {
			throw new ValidationError(
				`${name} is ${min} to ${max} characters, got ${length}.`,
			);
		}
		return text;
	};
}

/**
 * `--actor`, on every write: required, with no default and no variable
 * (decision 1); the name `board` is refused by the rules, not here.
 */
export const ACTOR = {
	required: true,
	value: lengthIn("--actor", 1, 64),
} as const;
export const ACTOR_HELP = "Who writes: your own name, 1 to 64 characters.";

/**
 * A write's answer on stdout: under --json the one object (Appendix B's
 * output for the command), otherwise its one line.
 */
export function answer(
	deps: Deps,
	json: boolean | undefined,
	value: unknown,
	line: string,
): void {
	deps.io.out(json === true ? JSON.stringify(value) : shown(line));
}
