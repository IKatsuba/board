import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/cli/io.ts";
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
let clock: FakeClock;

function deps(cwd = join(dir, "app")): Deps {
	return {
		io: { out: (t) => out.push(t), err: (t) => err.push(t) },
		env: boardEnv({ BOARD_DIR: join(dir, "b") }),
		clock,
		runner: notARepo,
		cwd,
		colors: false,
		exitCode: 0,
	};
}

async function run(...argv: string[]) {
	out = [];
	err = [];
	return runCli(argv, deps());
}

/** Runs a write with --json and answers its parsed object, checked against its schema. */
async function json(command: keyof typeof outputs, ...argv: string[]) {
	expect(await run(...argv, "--json")).toBe(0);
	expect(err).toEqual([]);
	expect(out).toHaveLength(1);
	const value = JSON.parse(out[0] as string);
	expectValid(outputs[command], value);
	return value;
}

/** Runs a write without --json and answers its one line. */
async function line(...argv: string[]) {
	expect(await run(...argv)).toBe(0);
	expect(err).toEqual([]);
	expect(out).toHaveLength(1);
	return out[0] as string;
}

async function refused(code: string, ...argv: string[]) {
	expect(await run(...argv)).toBe(1);
	expect(out).toEqual([]);
	expect(err).toHaveLength(1);
	expect(err[0]).toStartWith(`board: ${code}: `);
	expect(await run(...argv, "--json")).toBe(1);
	expect(out).toEqual([]);
	const body = JSON.parse(err[0] as string);
	expectValid(errorShape, body);
	expect(body.error.code).toBe(code);
	return body.error;
}

const A = ["--actor", "main"];

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-task-writes-")));
	mkdirSync(join(dir, "app"));
	mkdirSync(join(dir, "other"));
	clock = new FakeClock("2026-10-12T14:03:00.000Z");
	expect(await run("project", "add", "APP", "--actor", "owner")).toBe(0);
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
	expect(await run("milestone", "add", "v1", ...A, "--delivers", "x")).toBe(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("add", () => {
	test("a task and a finding: the line and --json agree", async () => {
		const first = await json(
			"add",
			"add",
			...A,
			"--title",
			"Watch tool",
			"--milestone",
			"v1",
		);
		expect(first.task).toMatchObject({
			key: "APP-1",
			title: "Watch tool",
			milestone: "v1",
			status: "ready",
			priority: "normal",
			body: "",
			created_by: "main",
		});
		expect(
			await line(
				"add",
				"--actor",
				"@lead",
				"--parent",
				"app-1",
				"--title",
				"Claim error lacks the holder",
			),
		).toBe(
			'added APP-2 "Claim error lacks the holder" (v1, under APP-1, ready)',
		);
		const third = await json(
			"add",
			"add",
			...A,
			"--title",
			"Bump deps",
			"--status",
			"backlog",
			"--priority",
			"low",
			"--waits",
			"APP-1",
			"--waits",
			"APP-2,APP-1",
			"-p",
			"app",
		);
		expect(third.task).toMatchObject({
			status: "backlog",
			priority: "low",
			milestone: null,
			waits: [{ key: "APP-1" }, { key: "APP-2" }],
		});
	});

	test("refusals: another project's parent or wait, unknown keys, a blank title", async () => {
		await line("add", ...A, "--title", "one");
		expect(
			(
				await refused(
					"invalid_argument",
					"add",
					...A,
					"--title",
					"t",
					"-p",
					"OTH",
					"--parent",
					"APP-1",
				)
			).details,
		).toEqual({ field: "parent" });
		expect(
			(
				await refused(
					"invalid_argument",
					"add",
					...A,
					"--title",
					"t",
					"--waits",
					"OTH-1",
				)
			).details,
		).toMatchObject({ field: "waits" });
		await refused(
			"not_found",
			"add",
			...A,
			"--title",
			"t",
			"--parent",
			"APP-9",
		);
		await refused(
			"not_found",
			"add",
			...A,
			"--title",
			"t",
			"--milestone",
			"v9",
		);
		await refused("invalid_argument", "add", ...A, "--title", "   ");
		await refused(
			"invalid_argument",
			"add",
			"--actor",
			"board",
			"--title",
			"t",
		);
	});
});

describe("edit", () => {
	beforeEach(async () => {
		for (const title of ["one", "two", "three"]) {
			await line("add", ...A, "--title", title);
		}
	});

	test("every field; --no-body and --no-parent clear; nothing changed is changed: []", async () => {
		const edited = await json(
			"edit",
			"edit",
			"APP-1",
			...A,
			"--title",
			"One",
			"--body",
			"text",
			"--priority",
			"high",
			"--parent",
			"APP-2",
			"--milestone",
			"v1",
			"--waits-add",
			"APP-3",
			"--status",
			"backlog",
		);
		expect(edited.changed).toEqual([
			"title",
			"body",
			"priority",
			"parent",
			"milestone",
			"waits",
			"status",
		]);
		expect(edited.task).toMatchObject({
			title: "One",
			body: "text",
			parent: "APP-2",
			milestone: "v1",
			status: "backlog",
			waits: [{ key: "APP-3" }],
		});
		expect(
			await line(
				"edit",
				"APP-1",
				...A,
				"--status",
				"ready",
				"--milestone",
				"none",
			),
		).toBe("APP-1: status backlog → ready, milestone v1 → none");
		const cleared = await json(
			"edit",
			"edit",
			"APP-1",
			...A,
			"--no-body",
			"--no-parent",
			"--waits-remove",
			"APP-3",
		);
		expect(cleared.task).toMatchObject({ body: "", parent: null, waits: [] });
		const same = await json("edit", "edit", "APP-1", ...A, "--title", "One");
		expect(same).toMatchObject({ changed: [], events: [] });
		expect(await line("edit", "APP-1", ...A, "--title", "One")).toBe(
			"APP-1: nothing to change",
		);
	});

	test("refusals: a loop, both lists, another project, a transition", async () => {
		await line("edit", "APP-2", ...A, "--waits-add", "APP-1");
		expect(
			(await refused("cycle", "edit", "APP-1", ...A, "--waits-add", "APP-2"))
				.details,
		).toEqual({ path: ["APP-1", "APP-2", "APP-1"] });
		expect(
			(
				await refused(
					"invalid_argument",
					"edit",
					"APP-1",
					...A,
					"--waits-add",
					"APP-3",
					"--waits-remove",
					"APP-3",
				)
			).details,
		).toEqual({ field: "waits-add" });
		expect(
			(
				await refused(
					"invalid_argument",
					"edit",
					"APP-1",
					...A,
					"--parent",
					"OTH-1",
				)
			).details,
		).toEqual({ field: "parent" });
	});
});

describe("claim, extend, release", () => {
	beforeEach(async () => {
		await line("add", ...A, "--title", "Watch tool");
		await line("add", ...A, "--title", "Later", "--status", "backlog");
	});

	test("the lease: claim for another holder, extend from now, release", async () => {
		const claimed = await json(
			"claim",
			"claim",
			"APP-1",
			...A,
			"--holder",
			"@lead",
			"--minutes",
			"90",
			"--directory",
			"/work/app-wt",
			"--branch",
			"feat/watch",
		);
		expect(claimed.claim).toMatchObject({
			holder: "@lead",
			since: "2026-10-12T14:03:00.000Z",
			until: "2026-10-12T15:33:00.000Z",
			minutes_left: 90,
			directory: "/work/app-wt",
			branch: "feat/watch",
		});
		expect(claimed.task).toMatchObject({ status: "active", holder: "@lead" });
		clock.advance(30);
		expect(
			await line(
				"extend",
				"APP-1",
				"--actor",
				"@lead",
				"--holder",
				"@lead",
				"--minutes",
				"60",
			),
		).toBe(
			"APP-1 held by @lead until 2026-10-12T15:33:00.000Z (60 min from now)",
		);
		const extended = await json(
			"extend",
			"extend",
			"APP-1",
			"--actor",
			"@lead",
			"--holder",
			"@lead",
			"--minutes",
			"70",
		);
		expect(extended.claim.until).toBe("2026-10-12T15:43:00.000Z");
		const released = await json(
			"release",
			"release",
			"APP-1",
			...A,
			"--holder",
			"@lead",
			"--note",
			"dead run",
		);
		expect(released).toMatchObject({
			task: { status: "ready", holder: null },
			released: { holder: "@lead" },
		});
		expect(await line("claim", "APP-1", ...A, "--minutes", "5")).toBe(
			"APP-1 claimed by main until 2026-10-12T14:38:00.000Z (5 min)",
		);
		expect(await line("release", "APP-1", ...A, "--holder", "main")).toBe(
			"APP-1 released by main (held by main since 2026-10-12T14:33:00.000Z)",
		);
	});

	test("refusals: held, not claimed, not ready, the wrong holder", async () => {
		await line("claim", "APP-1", ...A, "--holder", "@lead", "--minutes", "60");
		const held = await refused(
			"claim_held",
			"claim",
			"APP-1",
			"--actor",
			"@dev",
			"--minutes",
			"60",
		);
		expect(held.details.claim).toMatchObject({ holder: "@lead" });
		expect(held.next).toContain("board extend");
		await refused(
			"claim_held",
			"extend",
			"APP-1",
			...A,
			"--holder",
			"@x",
			"--minutes",
			"5",
		);
		await refused("claim_held", "release", "APP-1", ...A, "--holder", "@x");
		await refused("not_claimed", "release", "APP-2", ...A, "--holder", "main");
		expect(
			(await refused("not_ready", "claim", "APP-2", ...A, "--minutes", "5"))
				.details,
		).toMatchObject({ reason: "status" });
		await refused("not_found", "claim", "APP-9", ...A, "--minutes", "5");
		await refused("not_found", "claim", "ZZ-1", ...A, "--minutes", "5");
		clock.advance(61);
		await refused(
			"not_claimed",
			"extend",
			"APP-1",
			"--actor",
			"@lead",
			"--holder",
			"@lead",
			"--minutes",
			"5",
		);
	});
});

describe("comment and handover", () => {
	test("a note and a handover: the event, on any task, closed included", async () => {
		await line("add", ...A, "--title", "Watch tool");
		const note = await json(
			"comment",
			"comment",
			"APP-1",
			"--actor",
			"@lead",
			"--text",
			"Tests pass on arm64.",
		);
		expect(note.event).toMatchObject({
			kind: "comment",
			actor: "@lead",
			project: "APP",
			task: "APP-1",
			data: { text: "Tests pass on arm64." },
		});
		expect(
			await line("comment", "app-1", ...A, "--text", "-starts with a dash"),
		).toBe("note on APP-1");
		const handover = await json(
			"handover",
			"handover",
			"APP-1",
			"--actor",
			"@lead",
			"--to",
			"main",
			"--text",
			"Ready for review.",
			"--changed",
			"src/watch/derive.ts",
			"--ran",
			"bun run check",
			"--unchecked",
			"the x64 binary",
		);
		expect(handover.event).toMatchObject({
			kind: "handover",
			data: {
				to: "main",
				text: "Ready for review.",
				changed: "src/watch/derive.ts",
				ran: "bun run check",
				unchecked: "the x64 binary",
			},
		});
		await line("edit", "APP-1", ...A, "--status", "done");
		expect(
			await line(
				"handover",
				"APP-1",
				"--actor",
				"@lead",
				"--to",
				"main",
				"--text",
				"t",
				"--changed",
				"c",
				"--ran",
				"r",
				"--unchecked",
				"u",
			),
		).toBe("handover on APP-1 from @lead to main");
		await refused("not_found", "comment", "APP-9", ...A, "--text", "x");
	});

	test("a body of 20,000 astral code points is one argument and reads back equal", async () => {
		const body = "😀".repeat(20_000);
		await line("add", ...A, "--title", "Big", "--body", body);
		expect(await run("show", "APP-1", "--json")).toBe(0);
		expect(JSON.parse(out[0] as string).task.body).toBe(body);
	});
});

describe("Inputs: every check is cliffy's, exit 64, never JSON, nothing written", () => {
	const at = (n: number) => "😀".repeat(n);
	const keys = (n: number) =>
		Array.from({ length: n }, (_, i) => `APP-${i + 1}`).join(",");
	const handover = (over: Record<string, string>) => {
		const parts = {
			to: "main",
			text: "t",
			changed: "c",
			ran: "r",
			unchecked: "u",
			...over,
		};
		return [
			"handover",
			"APP-1",
			...A,
			...Object.entries(parts).flatMap(([k, v]) => [`--${k}`, v]),
		];
	};

	// Each pair: the line at the limit (not a usage error) and one past it.
	const limits: [string[], string[]][] = [
		[
			["add", "--actor", at(64), "--title", "t"],
			["add", "--actor", at(65), "--title", "t"],
		],
		[
			["add", ...A, "--title", at(200)],
			["add", ...A, "--title", at(201)],
		],
		[
			["add", ...A, "--title", "t", "--body", at(20_000)],
			["add", ...A, "--title", "t", "--body", at(20_001)],
		],
		[
			["add", ...A, "--title", "t", "--waits", keys(50)],
			["add", ...A, "--title", "t", "--waits", keys(50), "--waits", "APP-51"],
		],
		[
			["edit", "APP-1", ...A, "--waits-add", keys(50)],
			["edit", "APP-1", ...A, "--waits-add", keys(51)],
		],
		[
			["edit", "APP-1", ...A, "--waits-remove", keys(50)],
			["edit", "APP-1", ...A, "--waits-remove", keys(51)],
		],
		[
			["claim", "APP-1", ...A, "--minutes", "1440"],
			["claim", "APP-1", ...A, "--minutes", "1441"],
		],
		[
			["claim", "APP-1", ...A, "--minutes", "1"],
			["claim", "APP-1", ...A, "--minutes", "0"],
		],
		[
			["claim", "APP-1", ...A, "--minutes", "5", "--holder", at(64)],
			["claim", "APP-1", ...A, "--minutes", "5", "--holder", at(65)],
		],
		[
			["claim", "APP-1", ...A, "--minutes", "5", "--directory", at(1024)],
			["claim", "APP-1", ...A, "--minutes", "5", "--directory", at(1025)],
		],
		[
			["claim", "APP-1", ...A, "--minutes", "5", "--branch", at(255)],
			["claim", "APP-1", ...A, "--minutes", "5", "--branch", at(256)],
		],
		[
			["extend", "APP-1", ...A, "--holder", at(64), "--minutes", "5"],
			["extend", "APP-1", ...A, "--holder", at(65), "--minutes", "5"],
		],
		[
			["release", "APP-1", ...A, "--holder", "main", "--note", at(500)],
			["release", "APP-1", ...A, "--holder", "main", "--note", at(501)],
		],
		[
			["comment", "APP-1", ...A, "--text", at(10_000)],
			["comment", "APP-1", ...A, "--text", at(10_001)],
		],
		[handover({ to: at(64) }), handover({ to: at(65) })],
		[handover({ text: at(10_000) }), handover({ text: at(10_001) })],
		[handover({ changed: at(4000) }), handover({ changed: at(4001) })],
		[handover({ ran: at(4000) }), handover({ ran: at(4001) })],
		[handover({ unchecked: at(4000) }), handover({ unchecked: at(4001) })],
	];

	const shapes: string[][] = [
		["add", ...A],
		["add", "--title", "t"],
		["add", ...A, "--title", ""],
		["add", ...A, "--title", "t", "--priority", "soon"],
		["add", ...A, "--title", "t", "--status", "done"],
		["add", ...A, "--title", "t", "--parent", "nope"],
		["add", ...A, "--title", "t", "--milestone", "bad name"],
		["add", ...A, "--tex", "x"],
		["edit", "APP-1", ...A],
		["edit", "APP-1", ...A, "--body", ""],
		["edit", "APP-1", ...A, "--status", "active"],
		["edit", "APP-1", ...A, "--status", "blocked"],
		["edit", "APP-1", ...A, "--parent", "APP-2", "--no-parent"],
		["edit", "APP-1", ...A, "--body", "x", "--no-body"],
		["edit", "APP-1", ...A, "-p", "APP", "--title", "x"],
		["edit", "--title", "x", ...A],
		["claim", "APP-1", ...A],
		["claim", "APP-1", ...A, "--minutes", "1.5"],
		["claim", "APP-1", "--minutes", "5"],
		["extend", "APP-1", ...A, "--minutes", "5"],
		["extend", "APP-1", ...A, "--holder", "main"],
		["release", "APP-1", ...A],
		["comment", "APP-1", ...A],
		["comment", "APP-1", ...A, "--text", "x", "--to", "main"],
		[
			"handover",
			"APP-1",
			...A,
			"--to",
			"main",
			"--text",
			"t",
			"--changed",
			"c",
			"--ran",
			"r",
		],
	];

	test("one past each limit is 64; at the limit it reaches the board", async () => {
		await line("add", ...A, "--title", "one");
		for (const [ok, past] of limits) {
			expect(await run(...ok)).not.toBe(64);
			for (const argv of [past, [...past, "--json"]]) {
				expect(await run(...argv)).toBe(64);
				expect(out).toEqual([]);
				expect(err).toHaveLength(1);
				expect(err[0]).toStartWith("board: usage: ");
			}
		}
	});

	test("a command line that does not fit is 64 and appends no event", async () => {
		await line("add", ...A, "--title", "one");
		await line("add", ...A, "--title", "two");
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
