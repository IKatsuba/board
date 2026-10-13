import { isAbsolute, join } from "node:path";
import type { BoardError } from "./errors.ts";

/** Where the board file is, and whether BOARD_DIR chose it. */
export type Env = { dir: string; file: string; boardDirSet: boolean };

/**
 * BOARD_DIR, else ~/.board. A relative BOARD_DIR is refused because it would
 * resolve against each process's cwd, so every session would open a
 * different file without a word ("~/x" in a JSON config is expanded by no
 * one). An empty value counts as unset.
 */
export function boardEnv(
	vars: Record<string, string | undefined>,
): Env | BoardError {
	const boardDir = vars.BOARD_DIR || undefined;
	if (boardDir !== undefined) {
		if (!isAbsolute(boardDir)) {
			return {
				code: "no_board",
				message: `BOARD_DIR must be an absolute path, got "${boardDir}".`,
				next: "Set BOARD_DIR to an absolute path where board is started, or unset it for ~/.board.",
				details: { reason: "board_dir_relative" },
			};
		}
		return {
			dir: boardDir,
			file: join(boardDir, "board.db"),
			boardDirSet: true,
		};
	}
	const home = vars.HOME || undefined;
	if (home === undefined) {
		return {
			code: "no_board",
			message:
				"Neither BOARD_DIR nor HOME is set, so board cannot tell where the board is.",
			next: "Set BOARD_DIR to an absolute path.",
			details: { reason: "no_home" },
		};
	}
	const dir = join(home, ".board");
	return { dir, file: join(dir, "board.db"), boardDirSet: false };
}

/** `no_board` for a board file that is not there (or holds no schema). */
export function missingBoard(env: Env): BoardError {
	return env.boardDirSet
		? {
				code: "no_board",
				message: `No board at ${env.file} (BOARD_DIR names ${env.dir}).`,
				next: "Check BOARD_DIR, or `board project add KEY` in a project's directory to create a board there.",
				details: { file: env.file, reason: "missing" },
			}
		: {
				code: "no_board",
				message: `No board at ${env.file} (BOARD_DIR is not set).`,
				next: "`board project add KEY` in a project's directory creates it.",
				details: { file: env.file, reason: "missing" },
			};
}
