import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/cli/io.ts";
import { runCli } from "../src/cli/root.ts";
import { boardEnv } from "../src/env.ts";
import type { GitRunner } from "../src/place/git.ts";
import { errorShape, outputs } from "../src/schemas.ts";
import { FakeClock } from "./helpers/clock.ts";
import { expectValid } from "./helpers/schema.ts";

const runner: GitRunner = {
	commonDir: async () => ({
		kind: "exit",
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository",
	}),
};
const a = ["--actor", "@lead"];
const two = ["--option-1", "One", "--option-2", "Two"];
function fixture() {
	const dir = realpathSync(
		mkdtempSync(join(tmpdir(), "board-slice8-questions-")),
	);
	const repo = join(dir, "repo");
	mkdirSync(repo);
	const clock = new FakeClock();
	const env = boardEnv({ BOARD_DIR: join(dir, "board") });
	const run = async (argv: string[], cwd = repo) => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await runCli(argv, {
			io: { out: (t) => out.push(t), err: (t) => err.push(t) },
			env,
			clock,
			runner,
			cwd,
			colors: false,
			exitCode: 0,
		});
		return { code, out, err };
	};
	const json = async (
		name: keyof typeof outputs,
		argv: string[],
		cwd = repo,
	) => {
		const r = await run([...argv, "--json"], cwd);
		expect(r).toMatchObject({ code: 0, err: [] });
		expect(r.out).toHaveLength(1);
		const value = JSON.parse(r.out[0] as string);
		expectValid(outputs[name], value);
		return value;
	};
	const refusal = async (code: string, argv: string[]) => {
		const human = await run(argv);
		expect(human).toMatchObject({ code: 1, out: [] });
		expect(human.err).toHaveLength(1);
		expect(human.err[0]).toStartWith(`board: ${code}: `);
		const json = await run([...argv, "--json"]);
		expect(json).toMatchObject({ code: 1, out: [] });
		expect(json.err).toHaveLength(1);
		const value = JSON.parse(json.err[0] as string);
		expectValid(errorShape, value);
		expect(value.error.code).toBe(code);
		return value.error;
	};
	return {
		dir,
		repo,
		env,
		clock,
		run,
		json,
		refusal,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("all six numbered options preserve maximum labels and details regardless of flag order", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", ...a]);
		await f.json("add", ["add", ...a, "--title", "Question"]);
		const text = "😀".repeat(2000);
		const options = Array.from({ length: 6 }, (_, i) => ({
			label: String(i + 1) + "😀".repeat(79),
			detail: i % 2 === 0 ? "🌿".repeat(500) : null,
		}));
		const flags = options.flatMap((option, i) => [
			`--option-${i + 1}`,
			option.label,
			...(option.detail === null ? [] : [`--detail-${i + 1}`, option.detail]),
		]);
		const pairs: string[][] = [];
		for (let i = 0; i < flags.length; i += 2)
			pairs.unshift(flags.slice(i, i + 2));
		const asked = await f.json(
			"ask",
			[
				"ask",
				"t-1",
				...a,
				"--text",
				text,
				"--recommended",
				"6",
				...pairs.flat(),
			],
			f.dir,
		);
		expect(asked.question).toMatchObject({
			id: "Q1",
			key: "T-1",
			text,
			options,
			recommended: 6,
			asked_by: "@lead",
			answer: null,
			validated: null,
		});
		expect(asked.task.status).toBe("blocked");
		const answered = await f.json(
			"answer",
			[
				"answer",
				"q1",
				"6",
				"--text",
				text,
				"--as",
				"delegate",
				"--actor",
				"@main",
			],
			f.dir,
		);
		expect(answered.question.answer).toMatchObject({
			choice: 6,
			text,
			as: "delegate",
			by: "@main",
		});
		const show = await f.json("show", ["show", "T-1"]);
		expect(show.events.at(-1).data).toEqual({
			question: "Q1",
			choice: 6,
			text,
			as: "delegate",
			overrides: null,
		});
		const validated = await f.json("validate", [
			"validate",
			"Q1",
			"--actor",
			"person",
		]);
		expect(validated.question.validated).toMatchObject({ by: "person" });
	} finally {
		f.cleanup();
	}
});

test("each numbered dependency and length error is usage before storage opens", async () => {
	const base = ["ask", "T-1", ...a, "--text", "Which?", "--recommended", "1"];
	const cases: string[][] = [
		[...base, "--option-1", "One"],
		[...base, "--option-2", "Two"],
		[...base, ...two, "--option-7", "Seven"],
		[...base, ...two, "--recommended", "2"],
		["ask", ...a, "--text", "Typo", "--recommended", "1", ...two],
		["answer", "Q1", "--text", "", "--as", "owner", ...a],
		["answer", "Q1", "--text", "😀".repeat(2001), "--as", "owner", ...a],
	];
	for (let n = 1; n <= 6; n++) {
		const prior = Array.from({ length: Math.max(2, n) }, (_, i) => [
			`--option-${i + 1}`,
			`Option ${i + 1}`,
		]).flat();
		cases.push([...base, ...prior, `--detail-${n}`, "😀".repeat(501)]);
		cases.push([
			...base,
			...prior.filter(
				(_, i) =>
					i !== prior.indexOf(`--option-${n}`) &&
					i !== prior.indexOf(`--option-${n}`) + 1,
			),
			`--detail-${n}`,
			"Needs its label",
		]);
		const over = [...prior];
		over[over.indexOf(`--option-${n}`) + 1] = "😀".repeat(81);
		cases.push([...base, ...over]);
		if (n >= 4) cases.push([...base, ...two, `--option-${n}`, "Gap"]);
	}
	for (const argv of cases) {
		const out: string[] = [];
		const err: string[] = [];
		const deps: Deps = {
			io: { out: (t) => out.push(t), err: (t) => err.push(t) },
			get env(): Deps["env"] {
				throw new Error("Usage opened the board");
			},
			clock: new FakeClock(),
			runner,
			cwd: "/unused",
			colors: false,
			exitCode: 0,
		};
		expect(await runCli([...argv, "--json"], deps)).toBe(64);
		expect(out).toEqual([]);
		expect(err).toHaveLength(1);
		expect(err[0]).toStartWith("board: usage: ");
		expect(() => JSON.parse(err[0] as string)).toThrow();
	}
});

test("questions block until the last answer while claims survive and delegate decisions await validation", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", ...a]);
		await f.json("add", ["add", ...a, "--title", "Two questions"]);
		const claim = await f.json("claim", [
			"claim",
			"T-1",
			...a,
			"--minutes",
			"30",
		]);
		for (let n = 0; n < 2; n++)
			await f.json("ask", [
				"ask",
				"T-1",
				...a,
				"--text",
				"Which?",
				...two,
				"--recommended",
				"1",
			]);
		const blocked = await f.json("show", ["show", "T-1"]);
		expect(blocked.task).toMatchObject({
			status: "blocked",
			claim: claim.claim,
		});
		const first = await f.json("answer", [
			"answer",
			"Q1",
			"1",
			"--as",
			"delegate",
			"--actor",
			"@main",
		]);
		expect(first.task.status).toBe("blocked");
		const second = await f.json("answer", [
			"answer",
			"Q2",
			"--text",
			"-literal $HOME `ticks`\n@not-a-file",
			"--as",
			"delegate",
			"--actor",
			"@main",
		]);
		expect(second.question.answer.choice).toBeNull();
		expect(second.task.status).toBe("active");
		const waiting = await f.json("questions", [
			"questions",
			"--state",
			"to_validate",
		]);
		expect(
			waiting.questions.map((question: { id: string }) => question.id),
		).toEqual(["Q1", "Q2"]);
		await f.json("answer", [
			"answer",
			"Q1",
			"2",
			"--as",
			"owner",
			"--actor",
			"person",
		]);
		await f.json("validate", ["validate", "Q2", "--actor", "person"]);
		expect(
			(await f.json("questions", ["questions", "--state", "to_validate"]))
				.questions,
		).toEqual([]);
		await f.refusal("invalid_transition", [
			"validate",
			"Q1",
			"--actor",
			"person",
		]);
		await f.refusal("already_answered", [
			"answer",
			"Q2",
			"2",
			"--as",
			"owner",
			"--actor",
			"person",
		]);
	} finally {
		f.cleanup();
	}
});

test("question refusals distinguish numeric shape from rules and preserve machine-wide ids", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", ...a]);
		await f.json("add", ["add", ...a, "--title", "Question"]);
		const ask = ["ask", "T-1", ...a, "--text", "Which?", ...two];
		const recommended = await f.refusal("invalid_argument", [
			...ask,
			"--recommended",
			"3",
		]);
		expect(recommended.details.field).toBe("recommended");
		const q = await f.json("ask", [...ask, "--recommended", "1"]);
		expect(q.question.id).toBe("Q1");
		const past = await f.refusal("invalid_argument", [
			"answer",
			"Q1",
			"3",
			"--as",
			"owner",
			...a,
		]);
		expect(past.details.field).toBe("N");
		await f.json("edit", ["edit", "T-1", ...a, "--status", "cancelled"]);
		await f.refusal("invalid_transition", [
			"answer",
			"Q1",
			"1",
			"--as",
			"owner",
			...a,
		]);
		await f.refusal("invalid_transition", [...ask, "--recommended", "1"]);
		await f.refusal("not_found", [
			"ask",
			"T-99",
			...a,
			"--text",
			"Which?",
			...two,
			"--recommended",
			"1",
		]);
		await f.refusal("invalid_argument", [
			"ask",
			"T-1",
			"--actor",
			"board",
			"--text",
			"Which?",
			...two,
			"--recommended",
			"1",
		]);
		const other = join(f.dir, "other");
		mkdirSync(other);
		await f.json("project add", ["project", "add", "O", ...a, "--dir", other]);
		await f.json("add", ["add", ...a, "--title", "Other", "-p", "O"]);
		const q2 = await f.json("ask", [
			"ask",
			"O-1",
			...a,
			"--text",
			"Which?",
			...two,
			"--recommended",
			"1",
		]);
		expect(q2.question.id).toBe("Q2");
		const all = await f.json("questions", [
			"questions",
			"--all",
			"--state",
			"all",
		]);
		expect(
			all.questions.map((question: { id: string }) => question.id),
		).toEqual(["Q1", "Q2"]);
	} finally {
		f.cleanup();
	}
});

test.skipIf(!process.env.BOARD_BIN)(
	"compiled numbered options and question decisions round trip without stdin",
	() => {
		const f = fixture();
		try {
			const run = (...argv: string[]) =>
				Bun.spawnSync([process.env.BOARD_BIN as string, ...argv], {
					cwd: f.repo,
					env: { ...process.env, BOARD_DIR: join(f.dir, "board") },
					stdin: "ignore",
				});
			const json = (name: keyof typeof outputs, ...argv: string[]) => {
				const r = run(...argv, "--json");
				expect(r.exitCode).toBe(0);
				expect(r.stderr.toString()).toBe("");
				const value = JSON.parse(r.stdout.toString());
				expectValid(outputs[name], value);
				return value;
			};
			json("project add", "project", "add", "T", ...a);
			json("add", "add", ...a, "--title", "Question");
			const ask = [
				"ask",
				"T-1",
				...a,
				"--text",
				"Which?",
				...two,
				"--option-3",
				"Three",
				"--detail-3",
				"-literal\n$HOME",
				"--option-4",
				"Four",
				"--option-5",
				"Five",
				"--option-6",
				"Six",
				"--recommended",
				"6",
			];
			const q = json("ask", ...ask);
			expect(q.question.options[2]).toEqual({
				label: "Three",
				detail: "-literal\n$HOME",
			});
			expect(q.question.options).toHaveLength(6);
			const usage = run("answer", "Q1", "--as", "owner", ...a, "--json");
			expect(usage.exitCode).toBe(64);
			expect(usage.stdout.toString()).toBe("");
			expect(usage.stderr.toString()).toStartWith("board: usage: ");
			json("answer", "answer", "Q1", "6", "--as", "delegate", ...a);
			json("validate", "validate", "Q1", ...a);
			expect(json("show", "show", "T-1").task.status).toBe("ready");
		} finally {
			f.cleanup();
		}
	},
);
