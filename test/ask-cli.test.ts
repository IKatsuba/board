import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/root.ts";
import { boardEnv } from "../src/env.ts";
import type { GitRun, GitRunner } from "../src/place/git.ts";
import { errorShape, outputs } from "../src/schemas.ts";
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

async function run(...argv: string[]) {
	out = [];
	err = [];
	return runCli(argv, {
		io: { out: (t) => out.push(t), err: (t) => err.push(t) },
		env: boardEnv({ BOARD_DIR: join(dir, "b") }),
		clock: new FakeClock(),
		runner: notARepo,
		cwd: join(dir, "app"),
		colors: false,
		exitCode: 0,
	});
}

const A = ["--actor", "@lead"];
const two = ["--option-1", "Up to 8", "--option-2", "Unbounded"];

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-ask-")));
	mkdirSync(join(dir, "app"));
	expect(await run("project", "add", "APP", "--actor", "owner")).toBe(0);
	for (const title of ["one", "two"]) {
		expect(await run("add", ...A, "--title", title)).toBe(0);
	}
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ask", () => {
	test("options pair with their details by number; the task is blocked", async () => {
		expect(
			await run(
				"ask",
				"APP-1",
				...A,
				"--text",
				"How many runs may hold claims at once?",
				"--option-1",
				"Up to 8",
				"--detail-1",
				"Memory stays bounded",
				"--option-3",
				"Exactly 1",
				"--option-2",
				"Unbounded",
				"--detail-3",
				"-starts with a dash",
				"--recommended",
				"1",
				"--json",
			),
		).toBe(0);
		expect(err).toEqual([]);
		const asked = JSON.parse(out[0] as string);
		expectValid(outputs.ask, asked);
		expect(asked.question).toMatchObject({
			id: "Q1",
			key: "APP-1",
			recommended: 1,
			asked_by: "@lead",
			status: "open",
			options: [
				{ label: "Up to 8", detail: "Memory stays bounded" },
				{ label: "Unbounded", detail: null },
				{ label: "Exactly 1", detail: "-starts with a dash" },
			],
		});
		expect(asked.task).toMatchObject({ key: "APP-1", status: "blocked" });
		expect(
			await run(
				"ask",
				"app-2",
				...A,
				"--text",
				"Which?",
				...two,
				"--recommended",
				"2",
			),
		).toBe(0);
		expect(out).toEqual([
			"Q2 asked on APP-2; APP-2 is blocked until it is answered",
		]);
	});

	test("refusals: --recommended past the options, a closed task, an unknown key", async () => {
		const past = [
			"ask",
			"APP-1",
			...A,
			"--text",
			"?",
			...two,
			"--recommended",
			"3",
		];
		expect(await run(...past)).toBe(1);
		expect(err[0]).toStartWith("board: invalid_argument: --recommended is 3");
		expect(await run(...past, "--json")).toBe(1);
		const refused = JSON.parse(err[0] as string);
		expectValid(errorShape, refused);
		expect(refused.error.details).toEqual({ field: "recommended" });

		expect(await run("edit", "APP-2", ...A, "--status", "done")).toBe(0);
		expect(
			await run(
				"ask",
				"APP-2",
				...A,
				"--text",
				"?",
				...two,
				"--recommended",
				"1",
			),
		).toBe(1);
		expect(err[0]).toStartWith("board: invalid_transition: ");
		expect(
			await run(
				"ask",
				"APP-9",
				...A,
				"--text",
				"?",
				...two,
				"--recommended",
				"1",
			),
		).toBe(1);
		expect(err[0]).toStartWith("board: not_found: ");
	});
});

describe("answer", () => {
	beforeEach(async () => {
		expect(
			await run(
				"ask",
				"APP-1",
				...A,
				"--text",
				"?",
				...two,
				"--recommended",
				"1",
			),
		).toBe(0);
	});

	test("N, --text, or both; N past the options is the rules' invalid_argument", async () => {
		expect(
			await run(
				"answer",
				"Q1",
				"3",
				"--as",
				"owner",
				"--actor",
				"owner",
				"--json",
			),
		).toBe(1);
		expect(JSON.parse(err[0] as string).error).toMatchObject({
			code: "invalid_argument",
			details: { field: "N" },
		});
		expect(
			await run(
				"answer",
				"Q1",
				"--text",
				"In words.",
				"--as",
				"delegate",
				"--actor",
				"main",
			),
		).toBe(0);
		expect(out[0]).toStartWith("Q1 answered by main as delegate: In words.;");
	});
});

describe("Inputs for ask and answer: 64, never JSON, nothing written", () => {
	const at = (n: number) => "😀".repeat(n);
	const ask = (...extra: string[]) => [
		"ask",
		"APP-1",
		...A,
		"--text",
		"?",
		"--recommended",
		"1",
		...extra,
	];

	const limits: [string[], string[]][] = [
		[
			["ask", "APP-1", ...A, "--text", at(2000), ...two, "--recommended", "1"],
			["ask", "APP-1", ...A, "--text", at(2001), ...two, "--recommended", "1"],
		],
		[
			ask("--option-1", at(80), "--option-2", "b"),
			ask("--option-1", at(81), "--option-2", "b"),
		],
		[ask(...two, "--detail-2", at(500)), ask(...two, "--detail-2", at(501))],
		[
			["ask", "APP-1", ...A, "--text", "?", ...two, "--recommended", "6"],
			["ask", "APP-1", ...A, "--text", "?", ...two, "--recommended", "7"],
		],
		[
			["answer", "Q1", "--text", at(2000), "--as", "owner", "--actor", "owner"],
			["answer", "Q1", "--text", at(2001), "--as", "owner", "--actor", "owner"],
		],
		[
			["answer", "Q1", "6", "--as", "owner", "--actor", "owner"],
			["answer", "Q1", "7", "--as", "owner", "--actor", "owner"],
		],
	];

	const shapes: string[][] = [
		ask("--option-1", "a"),
		ask("--option-2", "b"),
		ask(...two, "--option-4", "d"),
		ask(...two, "--detail-3", "x"),
		ask(...two, "--option-7", "g"),
		["ask", "APP-1", ...A, ...two, "--recommended", "1"],
		["ask", "APP-1", ...A, "--text", "?", ...two],
		["ask", "APP-1", ...A, "--text", "?", ...two, "--recommended", "0"],
		["ask", "APP-1", "--text", "?", ...two, "--recommended", "1"],
		[
			"ask",
			"APP-1",
			...A,
			"--text",
			"?",
			"--option",
			"a",
			"--recommended",
			"1",
		],
		["answer", "Q1", "--as", "owner", "--actor", "owner"],
		["answer", "Q1", "0", "--as", "owner", "--actor", "owner"],
		["answer", "Q1", "1", "--as", "nobody", "--actor", "owner"],
		["answer", "Q1", "1", "--actor", "owner"],
		["answer", "Q1", "1", "--as", "owner"],
	];

	test("one past each limit is 64; at the limit it reaches the board", async () => {
		expect(
			await run(
				"ask",
				"APP-2",
				...A,
				"--text",
				"?",
				...two,
				"--recommended",
				"1",
			),
		).toBe(0);
		for (const [ok, past] of limits) {
			expect(await run(...ok)).not.toBe(64);
			expect(await run(...past, "--json")).toBe(64);
			expect(out).toEqual([]);
			expect(err).toHaveLength(1);
			expect(err[0]).toStartWith("board: usage: ");
		}
	});

	test("a command line that does not fit is 64 and appends no event", async () => {
		expect(await run("status", "--json")).toBe(0);
		const last = JSON.parse(out[0] as string).last_event;
		for (const argv of shapes) {
			expect(await run(...argv, "--json")).toBe(64);
			expect(out).toEqual([]);
			expect(err).toHaveLength(1);
			expect(err[0]).toStartWith("board: usage: ");
		}
		expect(await run("status", "--json")).toBe(0);
		expect(JSON.parse(out[0] as string).last_event).toBe(last);
	});
});
