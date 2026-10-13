import { statSync } from "node:fs";
import { type BoardError, Refusal } from "../errors.ts";

/** File system codes that mean the board directory cannot be made or written. */
const FILE_SYSTEM = new Set([
	"EACCES",
	"EPERM",
	"EROFS",
	"ENOSPC",
	"EDQUOT",
	"EIO",
	"ENOTDIR",
	"EEXIST",
]);

/** What a database or file system failure means to the caller; null when it is board's bug. */
export function outcome(error: unknown): BoardError | null {
	if (error instanceof Refusal) return error.error;
	const e = error as {
		code?: unknown;
		message?: unknown;
		meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
	} | null;
	if (e === null || typeof e !== "object") return null;
	// Prisma's maxWait or timeout: kept as a defensive case, since the busy
	// wait blocks the event loop and these timers cannot fire during it.
	if (e.code === "P2028") return busy();
	const original = e.meta?.driverAdapterError?.cause?.originalCode;
	// The adapter maps SQLITE_BUSY to P2010 / P1008 and rethrows the rest
	// with SQLite's own code.
	const code =
		typeof original === "string"
			? original
			: typeof e.code === "string"
				? e.code
				: "";
	const sqlite = lastLine(e.message);
	if (code.startsWith("SQLITE_BUSY")) return busy();
	if (
		FILE_SYSTEM.has(code) ||
		code.startsWith("SQLITE_FULL") ||
		code.startsWith("SQLITE_IOERR") ||
		code.startsWith("SQLITE_READONLY") ||
		code.startsWith("SQLITE_CANTOPEN") ||
		code.startsWith("SQLITE_PERM")
	) {
		return {
			code: "storage",
			message: `The board could not be written or read: ${sqlite}.`,
			next: "Nothing was changed. Free disk space or fix the file's permissions, then retry.",
			details: { sqlite },
		};
	}
	if (code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB")) {
		return damaged(sqlite);
	}
	return null;
}

/**
 * Turns a database failure into a Refusal and leaves any other exception as
 * it is, for the adapters' one wrapper to answer `internal`.
 */
export function rethrow(error: unknown): never {
	const mapped = outcome(error);
	if (mapped !== null && !(error instanceof Refusal)) throw new Refusal(mapped);
	throw error;
}

export function busy(): BoardError {
	return {
		code: "busy",
		message:
			"The board is busy: another process held its write lock past the 5 s busy timeout.",
		next: "Retry; nothing was changed.",
		details: {},
	};
}

const recovery =
	"stop the agents, move board.db and its board.db-wal and board.db-shm aside, then run `board project add KEY`";

export function damaged(sqlite: string): BoardError {
	return {
		code: "damaged",
		message: `The board file is damaged: ${sqlite}.`,
		next: `board does not repair it: ${recovery}.`,
		details: { sqlite },
	};
}

export function notABoard(file: string): BoardError {
	return {
		code: "not_a_board",
		message: `${file} is a SQLite file but not a board.`,
		next: `Move it aside: ${recovery}.`,
		details: {},
	};
}

export function schemaMismatch(
	file: string,
	from: number,
	to: number,
): BoardError {
	return {
		code: "schema_mismatch",
		message: `${file} is a board of schema version ${from}; this board reads version ${to}.`,
		next: `There are no migrations before the first release: after the owner agrees, ${recovery}.`,
		details: { from: String(from), to: String(to) },
	};
}

function lastLine(message: unknown): string {
	const lines = String(message ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1) ?? "unknown error";
}

/**
 * Whether the board file is there. Only "no such file" means missing: a
 * file or directory board may not read is storage, with its message, not
 * no_board.
 */
export function boardFileExists(file: string): boolean {
	try {
		statSync(file);
		return true;
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		rethrow(error);
	}
}
