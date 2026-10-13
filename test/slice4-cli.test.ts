import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@cliffy/command";
import { Board } from "../src/board.ts";
import type { Deps } from "../src/cli/io.ts";
import { buildCli } from "../src/cli/root.ts";
import { SystemClock } from "../src/clock.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { outputs } from "../src/schemas.ts";
import { Store } from "../src/store/store.ts";
import { expectValid } from "./helpers/schema.ts";

test("question commands refuse unsupported actor and scope switches before storage", async () => {
	const out: string[] = [];
	const err: string[] = [];
	const deps: Deps = {
		io: { out: (text) => out.push(text), err: (text) => err.push(text) },
		env: {
			code: "no_board",
			message: "Must not be reached",
			next: "",
			details: { reason: "no_home" },
		},
		clock: SystemClock,
		runner: {
			async commonDir() {
				throw new Error("Unexpected git");
			},
		},
		cwd: "/nowhere",
		colors: false,
		exitCode: 0,
	};
	for (const args of [
		["answer", "--actor", "owner", "Q1", "1"],
		["answer", "--actor", "owner", "--as", "someone", "Q1", "1"],
		["validate", "Q1"],
		["answer", "--actor", "owner", "--as", "owner", "Q1", "1", "--yaml"],
		["validate", "--actor", "owner", "Q1", "--force"],
		["questions", "-p", "*"],
		[
			"answer",
			"--actor",
			"owner",
			"--as",
			"owner",
			"Q1",
			"--text",
			"😀".repeat(2001),
		],
	])
		await expect(buildCli(deps).noExit().parse(args)).rejects.toBeInstanceOf(
			ValidationError,
		);
	expect(out).toEqual([]);
	expect(err).toEqual([]);
});

test("source question output escapes every human field and preserves JSON; --task resolves across cwd projects", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice4-cli-");
	const env = {
		dir: join(dir, "board"),
		file: join(dir, "board", "board.db"),
		boardDirSet: true,
	};
	const runner = {
		async commonDir() {
			throw new Error("Explicit key should avoid git");
		},
	};
	const ctx = new Place(dir, runner);
	const main = join(import.meta.dir, "..", "src", "main.ts");
	const source = (...args: string[]) => {
		const r = Bun.spawnSync([process.execPath, main, ...args], {
			cwd: dir,
			env: { ...process.env, BOARD_DIR: env.dir },
		});
		return {
			code: r.exitCode,
			out: r.stdout.toString(),
			err: r.stderr.toString(),
		};
	};
	const control = "\u001b\u009b";
	const text = "😀".repeat(1998) + control;
	try {
		await Store.create(env, SystemClock, "owner", async (tx, now) => {
			await addProject(tx, now, "owner", {
				key: "A",
				name: "A",
				directory: dir,
			});
			await addProject(tx, now, "owner", {
				key: "B",
				name: "B",
				directory: "/other",
			});
		});
		const board = new Board(await Store.open(env, SystemClock));
		try {
			for (const project of ["A", "B"])
				await board.taskAdd(ctx, { actor: "tester", project, title: "Task" });
			for (const key of ["A-1", "B-1"])
				await board.questionAsk({
					actor: `asker${control}`,
					key,
					text: `Question${control}`,
					options: [{ label: `Chosen${control}` }, { label: "Other" }],
					recommended: 1,
				});
			await board.questionAnswer({
				actor: `delegate${control}`,
				question: "Q2",
				choice: 1,
				text: `Delegate text${control}`,
				as: "delegate",
			});
		} finally {
			await board.close();
		}
		const pending = source(
			"questions",
			"--all",
			"--state",
			"to_validate",
			"--json",
		);
		expect(pending.code).toBe(0);
		expect(pending.err).toBe("");
		expectValid(outputs.questions, JSON.parse(pending.out));
		expect(JSON.parse(pending.out)).toMatchObject({
			project: "*",
			questions: [
				{
					id: "Q2",
					key: "B-1",
					asked_by: `asker${control}`,
					answer: { by: `delegate${control}`, text: `Delegate text${control}` },
				},
			],
		});
		const byTask = source(
			"questions",
			"--task",
			"b-1",
			"--state",
			"all",
			"--json",
		);
		expect(byTask.code).toBe(0);
		expect(JSON.parse(byTask.out)).toMatchObject({
			project: "B",
			questions: [{ id: "Q2" }],
		});
		const human = source("questions", "--all", "--state", "all");
		expect(human.code).toBe(0);
		for (const field of [
			"asker",
			"Question",
			"Chosen",
			"Delegate text",
			"delegate",
		])
			expect(human.out).toContain(`${field}\\u001b\\u009b`);
		for (const stream of [human.out, human.err]) {
			expect(stream).not.toContain("\u001b");
			expect(stream).not.toContain("\u009b");
		}
		const answered = source(
			"answer",
			"q1",
			"1",
			"--text",
			text,
			"--as",
			"owner",
			"--actor",
			"owner",
		);
		expect(answered.code).toBe(0);
		expect(answered.err).toBe("");
		expect(answered.out).toContain("Chosen\\u001b\\u009b");
		expect(answered.out).toContain(`${"😀".repeat(1998)}\\u001b\\u009b`);
		expect(answered.out).not.toContain("\u001b");
		expect(answered.out).not.toContain("\u009b");
		expect(
			JSON.parse(
				source("questions", "--task", "A-1", "--state", "answered", "--json")
					.out,
			).questions[0].answer,
		).toMatchObject({ choice: 1, text, as: "owner", by: "owner" });
		expect(source("validate", "q2", "--actor", "owner")).toEqual({
			code: 0,
			out: "Q2 validated\n",
			err: "",
		});
		expect(
			JSON.parse(
				source("questions", "--all", "--state", "to_validate", "--json").out,
			),
		).toEqual({ project: "*", questions: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
