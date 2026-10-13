import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import type { Deps } from "../src/cli/io.ts";
import { buildCli, runCli } from "../src/cli/root.ts";
import { boardEnv, type Env } from "../src/env.ts";
import type { GitRun, GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { errorShape, outputs } from "../src/schemas.ts";
import { Store } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";
import { expectValid } from "./helpers/schema.ts";

const notARepo: GitRunner = {
	commonDir: async (): Promise<GitRun> => ({
		kind: "exit",
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository\n",
	}),
};

let dir: string;
let out: string[];
let err: string[];
const clock = new FakeClock();

function deps(): Deps {
	return {
		io: { out: (t) => out.push(t), err: (t) => err.push(t) },
		env: boardEnv({ BOARD_DIR: join(dir, "b") }),
		clock,
		runner: notARepo,
		cwd: join(dir, "app"),
		colors: false,
		exitCode: 0,
	};
}

/** Runs one command line with fresh sinks. */
async function run(...argv: string[]) {
	out = [];
	err = [];
	return runCli(argv, deps());
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-output-")));
	mkdirSync(join(dir, "app"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every command under the root and its path, as typed after `board`. */
type Node = ReturnType<ReturnType<typeof buildCli>["getCommands"]>[number];

function commands(
	command: Node,
	path: string[] = [],
): { path: string; command: Node }[] {
	return command.getCommands().flatMap((child) => {
		const at = [...path, child.getName()];
		return [{ path: at.join(" "), command: child }, ...commands(child, at)];
	});
}

describe("the --json contract", () => {
	// The exceptions as built ("Output"): an array, rows, a stream.
	const exceptions = ["milestone", "milestone ls", "sql", "watch"];

	test("every command with --json has a schema, and no schema is without a command", () => {
		const withJson = commands(buildCli(deps()))
			.filter(({ command }) => command.getOption("json") !== undefined)
			.map(({ path }) => path)
			.filter((path) => !exceptions.includes(path));
		expect(withJson.sort()).toEqual(Object.keys(outputs).sort());
	});

	test("the writes that gained --json print one object their schema accepts; the line agrees", async () => {
		expect(
			await run("project", "add", "APP", "--actor", "owner", "--json"),
		).toBe(0);
		expect(out).toHaveLength(1);
		expectValid(outputs["project add"], JSON.parse(out[0] as string));

		expect(
			await run(
				"milestone",
				"add",
				"v1",
				"--actor",
				"main",
				"--delivers",
				"x",
				"--json",
			),
		).toBe(0);
		const added = JSON.parse(out[0] as string);
		expectValid(outputs["milestone add"], added);
		expect(
			await run("milestone", "add", "v2", "--actor", "main", "--delivers", "y"),
		).toBe(0);
		expect(out).toEqual(["APP: milestone v2 added at 2 of 2"]);
		expect(err).toEqual([]);

		expect(
			await run(
				"milestone",
				"edit",
				"v2",
				"--actor",
				"main",
				"--before",
				"v1",
				"--json",
			),
		).toBe(0);
		const edited = JSON.parse(out[0] as string);
		expectValid(outputs["milestone edit"], edited);
		expect(edited).toMatchObject({
			changed: ["position"],
			chain: ["v2", "v1"],
		});
		expect(
			await run("milestone", "edit", "v2", "--actor", "main", "--after", "v1"),
		).toBe(0);
		expect(out).toEqual(["APP: milestone v2, moved after v1"]);

		expect(
			await run("milestone", "rm", "v2", "--actor", "main", "--json"),
		).toBe(0);
		expectValid(outputs["milestone rm"], JSON.parse(out[0] as string));
		expect(await run("milestone", "rm", "v1", "--actor", "main")).toBe(0);
		expect(out).toEqual(["APP: milestone v1 deleted; 0 left"]);

		const env = boardEnv({ BOARD_DIR: join(dir, "b") }) as Env;
		const board = new Board(await Store.open(env, clock));
		try {
			const place = new Place(join(dir, "app"), notARepo);
			await board.taskAdd(place, { actor: "main", title: "t" });
			for (const n of [1, 2]) {
				await board.questionAsk({
					actor: "@lead",
					key: "APP-1",
					text: `Question ${n}?`,
					options: [{ label: "a" }, { label: "b" }],
					recommended: 1,
				});
			}
		} finally {
			await board.close();
		}
		expect(
			await run(
				"answer",
				"Q1",
				"2",
				"--as",
				"delegate",
				"--actor",
				"main",
				"--json",
			),
		).toBe(0);
		const answered = JSON.parse(out[0] as string);
		expectValid(outputs.answer, answered);
		expect(answered.question.answer).toMatchObject({
			choice: 2,
			as: "delegate",
			by: "main",
		});
		expect(
			await run(
				"answer",
				"Q2",
				"--text",
				"both",
				"--as",
				"delegate",
				"--actor",
				"main",
			),
		).toBe(0);
		expect(out).toEqual([
			"Q2 answered by main as delegate: both; APP-1 unblocked; waits for the owner to validate",
		]);
		expect(await run("validate", "Q1", "--actor", "owner", "--json")).toBe(0);
		const validated = JSON.parse(out[0] as string);
		expectValid(outputs.validate, validated);
		expect(validated.question.validated).toMatchObject({ by: "owner" });
		expect(await run("validate", "Q2", "--actor", "owner")).toBe(0);
		expect(out).toEqual(["Q2 validated"]);

		mkdirSync(join(dir, "other"));
		expect(
			await run(
				"project",
				"add",
				"OTH",
				"--actor",
				"owner",
				"--dir",
				join(dir, "other"),
			),
		).toBe(0);
		expect(
			await run("project", "rm", "OTH", "--actor", "owner", "--json"),
		).toBe(0);
		const removed = JSON.parse(out[0] as string);
		expectValid(outputs["project rm"], removed);
		expect(removed).toMatchObject({
			key: "OTH",
			directory: join(dir, "other"),
		});
		expect(err).toEqual([]);
	});
});

describe("refusals and usage", () => {
	test("a refusal is `board: <code>: <message> <next>`, or the error object under --json; stdout stays empty", async () => {
		expect(await run("status")).toBe(1);
		expect(out).toEqual([]);
		expect(err).toHaveLength(1);
		expect(err[0]).toStartWith(
			`board: no_board: No board at ${join(dir, "b", "board.db")}`,
		);

		expect(await run("project", "add", "APP", "--actor", "owner")).toBe(0);
		for (const argv of [
			["milestone", "rm", "v9", "--actor", "main"],
			["validate", "Q9", "--actor", "main"],
			["project", "rm", "ZZZ", "--actor", "owner"],
			["answer", "Q9", "1", "--as", "owner", "--actor", "owner"],
		]) {
			expect(await run(...argv)).toBe(1);
			expect(out).toEqual([]);
			expect(err).toHaveLength(1);
			expect(err[0]).toMatch(/^board: not_found: No /);

			expect(await run(...argv, "--json")).toBe(1);
			expect(out).toEqual([]);
			expect(err).toHaveLength(1);
			const refused = JSON.parse(err[0] as string);
			expectValid(errorShape, refused);
			expect(refused.error.code).toBe("not_found");
		}
	});

	test("a usage error is `board: usage: …`, exit 64, never JSON, and opens nothing", async () => {
		for (const argv of [
			["milestone", "add", "v1", "--actor", "main", "--json"],
			["project", "rm", "APP", "--json"],
			["validate", "Q1", "--actor", "main", "--json", "--force"],
			["answer", "Q1", "--as", "owner", "--actor", "owner", "--json"],
		]) {
			expect(await run(...argv)).toBe(64);
			expect(out).toEqual([]);
			expect(err).toHaveLength(1);
			expect(err[0]).toStartWith("board: usage: ");
			expect(() => JSON.parse(err[0] as string)).toThrow();
		}
		expect(err[0]).toBe(
			"board: usage: Give the option's number N, --text, or both.",
		);
		expect(await run("status")).toBe(1);
		expect(err[0]).toStartWith("board: no_board: ");
	});
});

test("ls's paging note names the flag for the next page", async () => {
	expect(await run("project", "add", "APP", "--actor", "owner")).toBe(0);
	const env = boardEnv({ BOARD_DIR: join(dir, "b") }) as Env;
	const board = new Board(await Store.open(env, clock));
	try {
		for (const title of ["one", "two", "three"]) {
			await board.taskAdd(new Place(join(dir, "app"), notARepo), {
				actor: "main",
				title,
			});
		}
	} finally {
		await board.close();
	}
	expect(await run("ls", "--limit", "2")).toBe(0);
	expect(err).toEqual(["2 of 3 tasks in APP; next page: --offset 2"]);
	expect(await run("ls", "--limit", "2", "--offset", "2")).toBe(0);
	expect(err).toEqual(["1 of 3 tasks in APP"]);
});
