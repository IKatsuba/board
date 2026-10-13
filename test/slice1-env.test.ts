import { expect, test } from "bun:test";
import { stamp } from "../src/clock.ts";
import { boardEnv, missingBoard } from "../src/env.ts";
import { errorText, Refusal, refuse } from "../src/errors.ts";

test("configuration errors omit file rather than inventing a board path", () => {
	for (const vars of [
		{ BOARD_DIR: "~/board", HOME: "/home/example" },
		{ BOARD_DIR: " ", HOME: "/home/example" },
		{ BOARD_DIR: "", HOME: "" },
		{},
	]) {
		const result = boardEnv(vars);
		expect("code" in result).toBe(true);
		if (!("code" in result)) throw new Error("Expected configuration refusal");
		expect(result.code).toBe("no_board");
		expect(Object.keys(result.details)).toEqual(["reason"]);
		expect(result.message.length).toBeGreaterThan(0);
		expect(result.next.length).toBeGreaterThan(0);
	}
});

test("explicit absolute BOARD_DIR takes precedence without HOME", () => {
	expect(boardEnv({ BOARD_DIR: "/scratch/board", HOME: "" })).toEqual({
		dir: "/scratch/board",
		file: "/scratch/board/board.db",
		boardDirSet: true,
	});
	expect(boardEnv({ BOARD_DIR: "/", HOME: "/home/example" })).toEqual({
		dir: "/",
		file: "/board.db",
		boardDirSet: true,
	});
});

test("environment resolution reads only its argument and leaves it unchanged", () => {
	const vars = Object.freeze({ HOME: "/home/example", BOARD_DIR: "" });
	expect(boardEnv(vars)).toMatchObject({
		file: "/home/example/.board/board.db",
		boardDirSet: false,
	});
	expect(vars).toEqual({ HOME: "/home/example", BOARD_DIR: "" });
});

test("timestamps preserve milliseconds and convert offsets to UTC", () => {
	expect(stamp(new Date("2026-10-13T14:30:00.007+02:00"))).toBe(
		"2026-10-13T12:30:00.007Z",
	);
	expect(stamp(new Date("2026-10-13T12:30:00Z"))).toBe(
		"2026-10-13T12:30:00.000Z",
	);
});

test("a refusal preserves its structured body and joins message with next", () => {
	const error = missingBoard({
		dir: "/scratch/board",
		file: "/scratch/board/board.db",
		boardDirSet: true,
	});
	expect(errorText(error)).toBe(
		`board: ${error.code}: ${error.message} ${error.next}`,
	);
	try {
		refuse(error);
	} catch (caught) {
		expect(caught).toBeInstanceOf(Refusal);
		if (!(caught instanceof Refusal)) throw caught;
		expect(caught.error).toBe(error);
		expect(caught.message).toBe(error.message);
		return;
	}
	throw new Error("refuse returned instead of throwing");
});
