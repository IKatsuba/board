import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import type { Deps } from "../src/cli/io.ts";
import { runCli } from "../src/cli/root.ts";
import { boardEnv, type Env } from "../src/env.ts";
import type { GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { defs, errorShape, outputs } from "../src/schemas.ts";
import { Store } from "../src/store/store.ts";
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

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "board-slice8-output-")));
	const repo = join(dir, "repo");
	mkdirSync(repo);
	const env = boardEnv({ BOARD_DIR: join(dir, "board") }) as Env;
	const clock = new FakeClock();
	const run = async (argv: string[], overrides: Partial<Deps> = {}) => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await runCli(argv, {
			io: { out: (t) => out.push(t), err: (t) => err.push(t) },
			env,
			clock,
			runner,
			cwd: repo,
			colors: false,
			exitCode: 0,
			...overrides,
		});
		return { code, out, err };
	};
	const json = async (command: keyof typeof outputs, argv: string[]) => {
		const result = await run([...argv, "--json"]);
		expect(result.code).toBe(0);
		expect(result.err).toEqual([]);
		expect(result.out).toHaveLength(1);
		expect(result.out[0]).not.toContain("\n");
		const value = JSON.parse(result.out[0] as string);
		expectValid(outputs[command], value);
		return value;
	};
	const seed = async (fn: (board: Board, place: Place) => Promise<void>) => {
		const board = new Board(await Store.open(env, clock));
		try {
			await fn(board, new Place(repo, runner));
		} finally {
			await board.close();
		}
	};
	return {
		dir,
		repo,
		env,
		clock,
		run,
		json,
		seed,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("project and milestone JSON outputs preserve their shapes and human writes use stdout", async () => {
	const f = fixture();
	try {
		const added = await f.json("project add", [
			"project",
			"add",
			"t",
			"--name",
			"Original",
			"--actor",
			"owner",
		]);
		expect(added).toMatchObject({
			key: "T",
			name: "Original",
			directory: f.repo,
		});
		const edited = await f.json("project edit", [
			"project",
			"edit",
			"t",
			"--name",
			"Renamed",
			"--actor",
			"owner",
		]);
		expect(edited).toEqual({ ...added, name: "Renamed" });
		const projects = await f.json("project ls", ["project", "ls"]);
		expect(projects).toMatchObject({
			here: "T",
			projects: [{ project: edited, open: 0, closed: 0, current: null }],
		});
		const first = await f.json("milestone add", [
			"milestone",
			"add",
			"v1",
			"--actor",
			"@lead",
			"--delivers",
			"First",
		]);
		expect(first).toMatchObject({
			project: "T",
			chain: ["v1"],
			milestone: { name: "v1", position: 1, status: "current" },
		});
		const moved = await f.json("milestone edit", [
			"milestone",
			"edit",
			"v1",
			"--actor",
			"@lead",
			"--name",
			"v2",
			"--delivers",
			"Second",
		]);
		expect(moved).toMatchObject({
			chain: ["v2"],
			changed: ["name", "delivers"],
		});
		const noop = await f.json("milestone edit", [
			"milestone",
			"edit",
			"v2",
			"--actor",
			"@lead",
			"--delivers",
			"Second",
		]);
		expect(noop).toMatchObject({ changed: [], events: [] });
		for (const argv of [
			["milestone", "--json"],
			["milestone", "ls", "--json"],
		]) {
			const result = await f.run(argv);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.out[0] as string)).toEqual([moved.milestone]);
			expectValid(
				{ type: "array", items: { $ref: "#/$defs/Milestone" }, $defs: defs },
				JSON.parse(result.out[0] as string),
			);
		}
		const removed = await f.json("milestone rm", [
			"milestone",
			"rm",
			"v2",
			"--actor",
			"@lead",
		]);
		expect(removed).toMatchObject({ project: "T", deleted: "v2", chain: [] });
		const humanAdd = await f.run([
			"milestone",
			"add",
			"human",
			"--delivers",
			"Readable",
			"--actor",
			"@lead",
		]);
		expect(humanAdd).toMatchObject({
			code: 0,
			out: ["T: milestone human added at 1 of 1"],
			err: [],
		});
		expect(
			await f.run([
				"milestone",
				"edit",
				"human",
				"--delivers",
				"Readable",
				"--actor",
				"@lead",
			]),
		).toMatchObject({
			code: 0,
			out: ["T: milestone human: nothing to change"],
			err: [],
		});
		expect(
			await f.run(["milestone", "rm", "human", "--actor", "@lead"]),
		).toMatchObject({
			code: 0,
			out: ["T: milestone human deleted; 0 left"],
			err: [],
		});
		expect(
			await f.json("project rm", ["project", "rm", "T", "--actor", "owner"]),
		).toEqual(edited);
		expect((await f.json("project ls", ["project", "ls"])).projects).toEqual(
			[],
		);
	} finally {
		f.cleanup();
	}
});

test("read outputs agree on effective status, paging, escaping and literal contains filters", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", "--actor", "owner"]);
		await f.seed(async (board, place) => {
			await board.taskAdd(place, {
				actor: "seed",
				title: "Literal 100%\u001b[31m",
				body: "Body 😀\nline",
			});
			await board.taskAdd(place, { actor: "seed", title: "Question" });
			await board.taskClaim({ actor: "seed", key: "T-1", minutes: 1 });
			await board.questionAsk({
				actor: "seed",
				key: "T-2",
				text: "Which?",
				options: [{ label: "One" }, { label: "Two" }],
				recommended: 2,
			});
		});
		f.clock.advance(1);
		const state = await f.json("status", ["status"]);
		expect(state).toMatchObject({
			counts: { ready: 1, blocked: 1, active: 0 },
			claims: [],
			questions: { open: 1, to_validate: 0 },
		});
		const page = await f.json("ls", ["ls", "--limit", "1"]);
		expect(page).toMatchObject({
			project: "T",
			total: 2,
			next_offset: 1,
			tasks: [{ key: "T-2", status: "blocked" }],
		});
		const last = await f.json("ls", ["ls", "--limit", "1", "--offset", "1"]);
		expect(last).toMatchObject({
			total: 2,
			next_offset: null,
			tasks: [{ key: "T-1", holder: null, status: "ready" }],
		});
		const human = await f.run(["ls", "--limit", "1"]);
		expect(human.err).toEqual(["1 of 2 tasks in T; next page: --offset 1"]);
		const literal = await f.json("ls", ["ls", "--contains", "100%", "--all"]);
		expect(literal).toMatchObject({
			project: "*",
			total: 1,
			tasks: [{ key: "T-1" }],
		});
		const shown = await f.json("show", ["show", "t-1"]);
		expect(shown.task).toMatchObject({
			key: "T-1",
			title: "Literal 100%\u001b[31m",
			body: "Body 😀\nline",
			claim: null,
			status: "ready",
		});
		expect(shown.events.map((event: { kind: string }) => event.kind)).toEqual([
			"task_added",
			"claimed",
		]);
		const empty = await f.json("show", [
			"show",
			"T-1",
			"--since",
			String(shown.cursor),
		]);
		expect(empty).toMatchObject({
			events: [],
			cursor: shown.cursor,
			more: false,
		});
		const humanShown = await f.run(["show", "T-1"]);
		expect(humanShown.out.join("\n")).toContain("\\u001b[31m");
		expect(humanShown.out.join("\n")).not.toContain("\u001b");
		const next = await f.json("next", ["next"]);
		expect(next).toMatchObject({
			task: { key: "T-1", status: "ready" },
			from: "unassigned",
			waiting: { blocked: 1 },
		});
		const questions = await f.json("questions", ["questions", "--all"]);
		expect(questions).toMatchObject({
			project: "*",
			questions: [{ id: "Q1", answer: null, validated: null }],
		});
	} finally {
		f.cleanup();
	}
});

test("question writes emit only their JSON shape and an owner override drops validation", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", "--actor", "owner"]);
		await f.seed(async (board, place) => {
			await board.taskAdd(place, { actor: "seed", title: "Questions" });
			for (let n = 0; n < 2; n++)
				await board.questionAsk({
					actor: "seed",
					key: "T-1",
					text: "Which?",
					options: [{ label: "One" }, { label: "Two" }],
					recommended: 2,
				});
		});
		const delegate = await f.json("answer", [
			"answer",
			"q1",
			"2",
			"--text",
			"Reason 😀\nnext",
			"--as",
			"delegate",
			"--actor",
			"@main",
		]);
		expect(delegate.question.answer).toMatchObject({
			choice: 2,
			text: "Reason 😀\nnext",
			by: "@main",
			as: "delegate",
		});
		expect(delegate.task.status).toBe("blocked");
		const override = await f.json("answer", [
			"answer",
			"Q1",
			"1",
			"--as",
			"owner",
			"--actor",
			"human",
		]);
		expect(override.question).toMatchObject({
			answer: { choice: 1, as: "owner", by: "human" },
			validated: null,
		});
		expect(override).not.toHaveProperty("overrode");
		const show = await f.json("show", ["show", "T-1"]);
		expect(show.events.at(-1).data.overrides).toEqual(delegate.question.answer);
		const answered = await f.run([
			"answer",
			"Q2",
			"--text",
			"Chosen",
			"--as",
			"delegate",
			"--actor",
			"@main",
		]);
		expect(answered).toMatchObject({
			code: 0,
			out: [
				"Q2 answered by @main as delegate: Chosen; T-1 unblocked; waits for the owner to validate",
			],
			err: [],
		});
		const validated = await f.json("validate", [
			"validate",
			"q2",
			"--actor",
			"human",
		]);
		expect(validated.question.validated).toMatchObject({ by: "human" });
		expect(
			(await f.json("questions", ["questions", "--state", "to_validate"]))
				.questions,
		).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test("existing command refusals have one code line or one schema-valid JSON error on stderr", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", "--actor", "owner"]);
		await f.seed(async (board, place) => {
			await board.taskAdd(place, { actor: "seed", title: "Question" });
			await board.questionAsk({
				actor: "seed",
				key: "T-1",
				text: "Which?",
				options: [{ label: "One" }, { label: "Two" }],
				recommended: 1,
			});
			await board.questionAnswer({
				actor: "seed",
				question: "Q1",
				choice: 1,
				as: "owner",
			});
		});
		const cases: [string[], string, Partial<Deps>?][] = [
			[["show", "T-99"], "not_found"],
			[["project", "add", "T", "--actor", "owner"], "project_exists"],
			[
				["project", "edit", "T", "--name", "Refused", "--actor", "board"],
				"invalid_argument",
			],
			[["project", "rm", "T", "--actor", "owner"], "invalid_transition"],
			[
				["answer", "Q1", "1", "--as", "delegate", "--actor", "@main"],
				"already_answered",
			],
			[["status"], "no_project", { cwd: f.dir }],
			[
				["project", "ls"],
				"internal",
				{
					cwd: f.dir,
					runner: {
						commonDir: async () => {
							throw new Error("Injected git failure");
						},
					},
				},
			],
		];
		for (const [argv, code, deps] of cases) {
			const json = await f.run([...argv, "--json"], deps);
			expect(json).toMatchObject({ code: 1, out: [] });
			expect(json.err).toHaveLength(1);
			expect(json.err[0]).not.toContain("\n");
			const refused = JSON.parse(json.err[0] as string);
			expectValid(errorShape, refused);
			expect(refused.error.code).toBe(code);
			expect(refused.error.next).not.toMatch(
				/task_|question_|milestone_|board_status/,
			);
			const human = await f.run(argv, deps);
			expect(human).toMatchObject({ code: 1, out: [] });
			expect(human.err).toHaveLength(1);
			expect(human.err[0]).toStartWith(`board: ${code}: `);
		}
	} finally {
		f.cleanup();
	}
});

test("missing, damaged, foreign and wrong-version files produce schema-valid refusals without repair", async () => {
	for (const code of [
		"no_board",
		"damaged",
		"not_a_board",
		"schema_mismatch",
	] as const) {
		const f = fixture();
		try {
			if (code === "damaged") {
				mkdirSync(f.env.dir);
				writeFileSync(f.env.file, "This is not SQLite");
			}
			if (code === "not_a_board") {
				mkdirSync(f.env.dir);
				const db = new Database(f.env.file);
				db.exec("CREATE TABLE foreign_data(value TEXT)");
				db.close();
			}
			if (code === "schema_mismatch") {
				await f.json("project add", [
					"project",
					"add",
					"T",
					"--actor",
					"owner",
				]);
				const db = new Database(f.env.file);
				db.exec("PRAGMA user_version = 999");
				db.close();
			}
			for (const json of [false, true]) {
				const result = await f.run(["status", ...(json ? ["--json"] : [])]);
				expect(result).toMatchObject({ code: 1, out: [] });
				expect(result.err).toHaveLength(1);
				if (json) {
					const refused = JSON.parse(result.err[0] as string);
					expectValid(errorShape, refused);
					expect(refused.error.code).toBe(code);
				} else expect(result.err[0]).toStartWith(`board: ${code}: `);
			}
			if (code === "no_board") expect(existsSync(f.env.dir)).toBe(false);
		} finally {
			f.cleanup();
		}
	}
});

test("JSON usage errors never open the board or sweep its lapsed claims", async () => {
	const f = fixture();
	try {
		const cases = [
			["ls", "-p", "T", "--all"],
			["ls", "--limit", "201"],
			["show", "--typo", "T-1"],
			["answer", "Q1", "--actor", "@main", "--as", "owner"],
			["milestone", "edit", "v1", "--actor", "@main"],
			["project", "add", "T"],
		];
		for (const argv of cases) {
			const result = await f.run([...argv, "--json"]);
			expect(result).toMatchObject({ code: 64, out: [] });
			expect(result.err).toHaveLength(1);
			expect(result.err[0]).toStartWith("board: usage: ");
			expect(() => JSON.parse(result.err[0] as string)).toThrow();
			expect(existsSync(f.env.dir)).toBe(false);
		}
		await f.json("project add", ["project", "add", "T", "--actor", "owner"]);
		await f.seed(async (board, place) => {
			await board.taskAdd(place, { actor: "seed", title: "Lapsed" });
			await board.taskClaim({ actor: "seed", key: "T-1", minutes: 1 });
		});
		f.clock.advance(1);
		const before = await f.json("status", ["status"]);
		for (const argv of cases)
			expect((await f.run([...argv, "--json"])).code).toBe(64);
		const after = await f.json("status", ["status"]);
		expect(after.last_event).toBe(before.last_event);
		const shown = await f.json("show", ["show", "T-1"]);
		expect(shown.events.map((event: { kind: string }) => event.kind)).toEqual([
			"task_added",
			"claimed",
		]);
	} finally {
		f.cleanup();
	}
});

test("a storage refusal preserves the same error channel and schema", async () => {
	const f = fixture();
	try {
		writeFileSync(f.env.dir, "A file cannot be a board directory");
		for (const json of [false, true]) {
			const result = await f.run([
				"project",
				"add",
				"T",
				"--actor",
				"owner",
				...(json ? ["--json"] : []),
			]);
			expect(result).toMatchObject({ code: 1, out: [] });
			expect(result.err).toHaveLength(1);
			if (json) {
				const error = JSON.parse(result.err[0] as string);
				expectValid(errorShape, error);
				expect(error.error.code).toBe("storage");
			} else expect(result.err[0]).toStartWith("board: storage: ");
		}
	} finally {
		f.cleanup();
	}
});

test("a CLI process waiting past the lock timeout prints busy without appending an event", async () => {
	const f = fixture();
	let holder:
		| ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
		| undefined;
	try {
		await f.json("project add", ["project", "add", "T", "--actor", "owner"]);
		const before = await f.json("status", ["status"]);
		holder = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "helpers", "holder.ts"),
				"hold",
				f.env.file,
				"20000",
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		const reader = holder.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe(
			"held",
		);
		reader.releaseLock();
		for (const json of [false, true]) {
			const child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "..", "src", "main.ts"),
					"milestone",
					"add",
					"v1",
					"--delivers",
					"Refused",
					"--actor",
					"@lead",
					...(json ? ["--json"] : []),
				],
				{
					cwd: f.repo,
					env: { ...process.env, BOARD_DIR: f.env.dir },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			try {
				const [code, out, err] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(code).toBe(1);
				expect(out).toBe("");
				expect(err.trim().split("\n")).toHaveLength(1);
				if (json) {
					const error = JSON.parse(err);
					expectValid(errorShape, error);
					expect(error.error.code).toBe("busy");
				} else expect(err).toStartWith("board: busy: ");
			} finally {
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
			}
		}
		const after = await f.json("status", ["status"]);
		expect(after.last_event).toBe(before.last_event);
		expect(after.milestones).toEqual([]);
	} finally {
		if (holder) {
			if (holder.exitCode === null) holder.kill("SIGKILL");
			await holder.exited;
		}
		f.cleanup();
	}
}, 20000);

test.skipIf(!process.env.BOARD_BIN)(
	"compiled JSON writes and refusals keep the source output contract",
	() => {
		const f = fixture();
		try {
			const run = (...argv: string[]) =>
				Bun.spawnSync([process.env.BOARD_BIN as string, ...argv], {
					cwd: f.repo,
					env: { ...process.env, BOARD_DIR: f.env.dir },
					stdin: "ignore",
				});
			const cases: [keyof typeof outputs, string[]][] = [
				["project add", ["project", "add", "T", "--actor", "owner"]],
				[
					"project edit",
					["project", "edit", "T", "--actor", "owner", "--name", "Updated"],
				],
				["project ls", ["project", "ls"]],
				[
					"milestone add",
					["milestone", "add", "v1", "--actor", "@lead", "--delivers", "One"],
				],
				[
					"milestone edit",
					["milestone", "edit", "v1", "--actor", "@lead", "--delivers", "Two"],
				],
				["status", ["status"]],
				["ls", ["ls"]],
				["next", ["next"]],
				["questions", ["questions"]],
				["milestone rm", ["milestone", "rm", "v1", "--actor", "@lead"]],
				["project rm", ["project", "rm", "T", "--actor", "owner"]],
			];
			for (const [name, argv] of cases) {
				const result = run(...argv, "--json");
				expect(result.exitCode).toBe(0);
				expect(result.stderr.toString()).toBe("");
				const out = result.stdout.toString();
				expect(out.trim().split("\n")).toHaveLength(1);
				expectValid(outputs[name], JSON.parse(out));
			}
			for (const json of [false, true]) {
				const result = run("show", "T-1", ...(json ? ["--json"] : []));
				expect(result.exitCode).toBe(1);
				expect(result.stdout.toString()).toBe("");
				if (json) {
					const refused = JSON.parse(result.stderr.toString());
					expectValid(errorShape, refused);
					expect(refused.error.code).toBe("not_found");
				} else
					expect(result.stderr.toString()).toStartWith("board: not_found: ");
			}
			const usage = run(
				"answer",
				"Q1",
				"--actor",
				"@main",
				"--as",
				"owner",
				"--json",
			);
			expect(usage.exitCode).toBe(64);
			expect(usage.stdout.toString()).toBe("");
			expect(usage.stderr.toString()).toStartWith("board: usage: ");
		} finally {
			f.cleanup();
		}
	},
);
