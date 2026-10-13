import { describe, expect, test } from "bun:test";
import { boardEnv, missingBoard } from "../src/env.ts";

describe("boardEnv", () => {
	test("unset BOARD_DIR is ~/.board/board.db", () => {
		expect(boardEnv({ HOME: "/Users/me" })).toEqual({
			dir: "/Users/me/.board",
			file: "/Users/me/.board/board.db",
			boardDirSet: false,
		});
	});

	test("an empty BOARD_DIR counts as unset", () => {
		expect(boardEnv({ BOARD_DIR: "", HOME: "/Users/me" })).toEqual({
			dir: "/Users/me/.board",
			file: "/Users/me/.board/board.db",
			boardDirSet: false,
		});
	});

	test("an absolute BOARD_DIR names the directory", () => {
		expect(boardEnv({ BOARD_DIR: "/srv/b", HOME: "/Users/me" })).toEqual({
			dir: "/srv/b",
			file: "/srv/b/board.db",
			boardDirSet: true,
		});
	});

	test.each(["rel/dir", "./b", "~/x"])("BOARD_DIR %p is refused", (dir) => {
		const got = boardEnv({ BOARD_DIR: dir, HOME: "/Users/me" });
		expect(got).toMatchObject({
			code: "no_board",
			details: { reason: "board_dir_relative" },
		});
		expect("message" in got && got.message).toContain(`"${dir}"`);
	});

	test("no HOME and no BOARD_DIR", () => {
		expect(boardEnv({})).toMatchObject({
			code: "no_board",
			details: { reason: "no_home" },
		});
		expect(boardEnv({ HOME: "" })).toMatchObject({
			details: { reason: "no_home" },
		});
	});

	test("no HOME is fine when BOARD_DIR is set", () => {
		expect(boardEnv({ BOARD_DIR: "/srv/b" })).toMatchObject({
			file: "/srv/b/board.db",
		});
	});
});

describe("missingBoard", () => {
	test("names the file and whether BOARD_DIR set it", () => {
		const set = missingBoard({
			dir: "/srv/b",
			file: "/srv/b/board.db",
			boardDirSet: true,
		});
		expect(set.message).toBe(
			"No board at /srv/b/board.db (BOARD_DIR names /srv/b).",
		);
		expect(set.details).toEqual({ file: "/srv/b/board.db", reason: "missing" });
		const unset = missingBoard({
			dir: "/Users/me/.board",
			file: "/Users/me/.board/board.db",
			boardDirSet: false,
		});
		expect(unset.message).toContain("(BOARD_DIR is not set)");
		expect(unset.next).toContain("board project add KEY");
	});
});
