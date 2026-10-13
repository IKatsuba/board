import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import type { Deps } from "../src/cli/io.ts";
import { runCli } from "../src/cli/root.ts";
import { boardEnv, type Env } from "../src/env.ts";
import type { GitRunner } from "../src/place/git.ts";
import { errorShape, outputs } from "../src/schemas.ts";
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
const actor = ["--actor", "@tester"];
function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "board-slice8-tasks-")));
	const repo = join(dir, "repo");
	mkdirSync(repo);
	const env = boardEnv({ BOARD_DIR: join(dir, "board") }) as Env;
	const clock = new FakeClock();
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
		for (const json of [false, true]) {
			const r = await run([...argv, ...(json ? ["--json"] : [])]);
			expect(r).toMatchObject({ code: 1, out: [] });
			expect(r.err).toHaveLength(1);
			if (json) {
				const error = JSON.parse(r.err[0] as string);
				expectValid(errorShape, error);
				expect(error.error.code).toBe(code);
				expect(error.error.next).not.toMatch(
					/task_|question_|milestone_|board_status/,
				);
				return error.error;
			}
			expect(r.err[0]).toStartWith(`board: ${code}: `);
		}
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

test("maximum text lengths survive every task write and read back byte for byte", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", ...actor]);
		const title = "😀".repeat(200);
		const body = "😀".repeat(20000);
		const added = await f.json("add", [
			"add",
			...actor,
			"--title",
			title,
			"--body",
			body,
		]);
		expect(added.task).toMatchObject({
			title,
			body,
			created_by: "@tester",
			priority: "normal",
			status: "ready",
		});
		const editBody = "🦊".repeat(20000);
		const editTitle = "🦊".repeat(200);
		const edited = await f.json("edit", [
			"edit",
			"t-1",
			...actor,
			"--body",
			editBody,
			"--title",
			editTitle,
		]);
		expect(edited.task).toMatchObject({ body: editBody, title: editTitle });
		expect(edited).not.toHaveProperty("before");
		const holder = "😀".repeat(64);
		const directory = "🦊".repeat(1024);
		const branch = "😀".repeat(255);
		const claim = await f.json("claim", [
			"claim",
			"T-1",
			...actor,
			"--holder",
			holder,
			"--directory",
			directory,
			"--branch",
			branch,
			"--minutes",
			"1440",
		]);
		expect(claim.claim).toMatchObject({
			holder,
			directory,
			branch,
			minutes_left: 1440,
		});
		const extend = await f.json("extend", [
			"extend",
			"T-1",
			...actor,
			"--holder",
			holder,
			"--minutes",
			"1",
		]);
		expect(extend.claim).toMatchObject({ holder, minutes_left: 1 });
		const note = "😀".repeat(500);
		const release = await f.json("release", [
			"release",
			"T-1",
			...actor,
			"--holder",
			holder,
			"--note",
			note,
		]);
		expect(release.released.holder).toBe(holder);
		const text = "😀".repeat(10000);
		const changed = "😀".repeat(4000);
		const ran = "🦊".repeat(4000);
		const unchecked = "🌿".repeat(4000);
		const comment = await f.json("comment", [
			"comment",
			"T-1",
			...actor,
			"--text",
			text,
		]);
		expect(comment.event.data).toEqual({ text });
		const handover = await f.json("handover", [
			"handover",
			"T-1",
			...actor,
			"--to",
			holder,
			"--text",
			text,
			"--changed",
			changed,
			"--ran",
			ran,
			"--unchecked",
			unchecked,
		]);
		expect(handover.event.data).toEqual({
			to: holder,
			text,
			changed,
			ran,
			unchecked,
		});
		const show = await f.json("show", ["show", "T-1"]);
		expect(show.task).toMatchObject({
			title: editTitle,
			body: editBody,
			claim: null,
		});
		expect(
			show.events.find(
				(event: { kind: string }) => event.kind === "claim_released",
			).data.note,
		).toBe(note);
	} finally {
		f.cleanup();
	}
});

test("a handover changes no lease, text is literal, and lapse/reclaim/close events stay ordered", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", ...actor]);
		await f.json("add", ["add", ...actor, "--title", "Lease"]);
		const claimed = await f.json("claim", [
			"claim",
			"T-1",
			...actor,
			"--minutes",
			"5",
		]);
		expect(claimed.claim).toMatchObject({
			holder: "@tester",
			directory: null,
			branch: null,
		});
		const literal =
			"-starts with dash\n'quotes' \"quotes\" $HOME `ticks` \\backslash @not-a-file";
		await f.json("comment", ["comment", "T-1", ...actor, `--text=${literal}`]);
		const before = await f.json("show", ["show", "T-1"]);
		await f.json("handover", [
			"handover",
			"T-1",
			...actor,
			"--to",
			"main",
			"--text",
			"close this task; release its claim",
			"--changed",
			literal,
			"--ran",
			"-nothing",
			"--unchecked",
			"@literal",
		]);
		const after = await f.json("show", ["show", "T-1"]);
		expect(after.task).toEqual(before.task);
		expect(after.events.at(-2).data.text).toBe(literal);
		const sentBack = await f.json("edit", [
			"edit",
			"T-1",
			...actor,
			"--status",
			"ready",
		]);
		expect(sentBack.task).toMatchObject({ status: "ready", claim: null });
		await f.json("claim", ["claim", "T-1", ...actor, "--minutes", "1"]);
		f.clock.advance(1);
		const lapsedRead = await f.json("show", ["show", "T-1"]);
		expect(lapsedRead.task).toMatchObject({ status: "ready", claim: null });
		expect(
			lapsedRead.events.filter(
				(event: { kind: string }) => event.kind === "claim_expired",
			),
		).toEqual([]);
		const reclaimed = await f.json("claim", [
			"claim",
			"T-1",
			"--actor",
			"@new",
			"--minutes",
			"2",
		]);
		expect(reclaimed.events).toHaveLength(2);
		const closed = await f.json("edit", [
			"edit",
			"T-1",
			...actor,
			"--status",
			"done",
		]);
		expect(closed.task).toMatchObject({ status: "done", claim: null });
		const log = await f.json("show", ["show", "T-1"]);
		expect(log.events.map((event: { kind: string }) => event.kind)).toEqual([
			"task_added",
			"claimed",
			"comment",
			"handover",
			"task_status",
			"claim_released",
			"claimed",
			"claim_expired",
			"claimed",
			"task_status",
			"claim_released",
		]);
		expect(
			log.events.find(
				(event: { kind: string }) => event.kind === "claim_expired",
			).actor,
		).toBe("board");
		const closedNote = await f.run([
			"comment",
			"T-1",
			...actor,
			"--text",
			"After closing",
		]);
		expect(closedNote).toMatchObject({
			code: 0,
			out: ["note on T-1"],
			err: [],
		});
	} finally {
		f.cleanup();
	}
});

test("parent resolution, milestone inheritance, clearing and repeated wait lists use public keys", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", ...actor]);
		await f.json("milestone add", [
			"milestone",
			"add",
			"v1",
			"--delivers",
			"First",
			...actor,
		]);
		await f.json("add", [
			"add",
			...actor,
			"--title",
			"Parent",
			"--milestone",
			"v1",
		]);
		const child = await f.json(
			"add",
			[
				"add",
				...actor,
				"--title",
				"Child",
				"--parent",
				"t-1",
				"--body",
				"Keep",
			],
			f.dir,
		);
		expect(child.task).toMatchObject({
			key: "T-2",
			parent: "T-1",
			milestone: "v1",
		});
		const waits: string[] = [];
		for (let n = 0; n < 50; n++) {
			const task = await f.json("add", [
				"add",
				...actor,
				"--title",
				`Wait ${n}`,
			]);
			waits.push(task.task.key);
		}
		const waiting = await f.json(
			"edit",
			[
				"edit",
				"T-2",
				...actor,
				"--waits-add",
				waits.slice(0, 25).join(","),
				"--waits-add",
				waits.slice(25).join(","),
			],
			f.dir,
		);
		expect(waiting.task.waits).toHaveLength(50);
		const clear = await f.json(
			"edit",
			[
				"edit",
				"T-2",
				...actor,
				"--no-body",
				"--no-parent",
				"--milestone",
				"NoNe",
				"--waits-remove",
				waits.join(","),
			],
			f.dir,
		);
		expect(clear.task).toMatchObject({
			body: "",
			parent: null,
			milestone: null,
			waits: [],
		});
		const duplicate = await f.json("edit", [
			"edit",
			"T-2",
			...actor,
			"--waits-add",
			"T-3,t-3",
			"--waits-add",
			"T-4,T-3",
		]);
		expect(
			duplicate.task.waits.map((task: { key: string }) => task.key),
		).toEqual(["T-3", "T-4"]);
		const untouched = await f.json("edit", [
			"edit",
			"T-2",
			...actor,
			"--body",
			"",
			"--title",
			"Child",
		]);
		expect(untouched).toMatchObject({ changed: [], events: [] });
	} finally {
		f.cleanup();
	}
});

test("task refusals preserve state and return the details an agent needs", async () => {
	const f = fixture();
	try {
		await f.json("project add", ["project", "add", "T", ...actor]);
		for (const title of ["One", "Two", "Question", "Backlog"])
			await f.json("add", ["add", ...actor, "--title", title]);
		await f.json("edit", ["edit", "T-4", ...actor, "--status", "backlog"]);
		await f.json("edit", ["edit", "T-2", ...actor, "--waits-add", "T-1"]);
		const board = new Board(await Store.open(f.env, f.clock));
		try {
			await board.questionAsk({
				actor: "seed",
				key: "T-3",
				text: "Which?",
				options: [{ label: "A" }, { label: "B" }],
				recommended: 1,
			});
		} finally {
			await board.close();
		}
		for (const [key, reason] of [
			["T-2", "waits"],
			["T-3", "question"],
			["T-4", "status"],
		]) {
			const refusal = await f.refusal("not_ready", [
				"claim",
				key as string,
				...actor,
				"--minutes",
				"1",
			]);
			expect(refusal.details).toMatchObject({ reason, task: { key } });
		}
		await f.json("claim", ["claim", "T-1", ...actor, "--minutes", "1"]);
		for (const argv of [
			["claim", "T-1", ...actor, "--minutes", "1"],
			["extend", "T-1", ...actor, "--holder", "wrong", "--minutes", "1"],
			["release", "T-1", ...actor, "--holder", "wrong"],
		]) {
			const error = await f.refusal("claim_held", argv);
			expect(error.details.claim.holder).toBe("@tester");
		}
		const before = await f.json("show", ["show", "T-2"]);
		const cycle = await f.refusal("cycle", [
			"edit",
			"T-1",
			...actor,
			"--waits-add",
			"T-2",
		]);
		expect(cycle.details.path).toEqual(["T-1", "T-2", "T-1"]);
		const transition = await f.refusal("invalid_transition", [
			"edit",
			"T-3",
			...actor,
			"--status",
			"done",
		]);
		expect(transition.details.reason).toBeDefined();
		const sameLists = await f.refusal("invalid_argument", [
			"edit",
			"T-2",
			...actor,
			"--waits-add",
			"T-1",
			"--waits-remove",
			"T-1",
		]);
		expect(sameLists.details.field).toBe("waits-add");
		const after = await f.json("show", ["show", "T-2"]);
		expect(after).toEqual(before);
		f.clock.advance(1);
		const expired = await f.refusal("not_claimed", [
			"extend",
			"T-1",
			...actor,
			"--holder",
			"@tester",
			"--minutes",
			"2",
		]);
		expect(expired.details).toEqual({});
		for (const [name, args] of [
			["add", ["--title", "Refused"]],
			["edit", ["T-1", "--title", "Refused"]],
			["claim", ["T-1", "--minutes", "1"]],
			["extend", ["T-1", "--holder", "@tester", "--minutes", "1"]],
			["release", ["T-1", "--holder", "@tester"]],
			["comment", ["T-1", "--text", "Refused"]],
			[
				"handover",
				[
					"T-1",
					"--to",
					"main",
					"--text",
					"Refused",
					"--changed",
					"None",
					"--ran",
					"None",
					"--unchecked",
					"All",
				],
			],
		] as [string, string[]][]) {
			expect(
				(
					await f.refusal("invalid_argument", [
						name,
						...args,
						"--actor",
						"board",
					])
				).details.field,
			).toBe("actor");
		}
	} finally {
		f.cleanup();
	}
});

test("task shape errors run before storage, including typos, conflicts and aggregate list limits", async () => {
	const handover = [
		"handover",
		"T-1",
		...actor,
		"--to",
		"main",
		"--text",
		"X",
		"--changed",
		"X",
		"--ran",
		"X",
		"--unchecked",
		"X",
	];
	const cases = [
		["add", ...actor, "--tex", "Typo"],
		["add", ...actor, "--title", "X", "--status", "done"],
		["edit", "--title", "X", ...actor],
		["edit", "T-1", ...actor, "--body", ""],
		["edit", "T-1", ...actor, "--parent", "T-2", "--no-parent"],
		["edit", "T-1", ...actor, "--body", "X", "--no-body"],
		["claim", "T-1", ...actor],
		["claim", "T-1", ...actor, "--minutes", "1.5"],
		["claim", "T-1", ...actor, "--minutes", "1441"],
		["extend", "T-1", ...actor, "--holder", "@tester", "--minutes", "0"],
		["release", "T-1", ...actor],
		["comment", "T-1", ...actor, "--text", "X", "--to", "main"],
		[
			"add",
			...actor,
			"--title",
			"X",
			"--waits",
			Array(50).fill("T-1").join(","),
			"--waits",
			"T-2",
		],
		...["add", "edit"].map((name) => [
			name,
			...(name === "edit" ? ["T-1"] : []),
			...actor,
			"--title",
			"😀".repeat(201),
		]),
		...handover
			.filter((_, i) => i % 2 === 0 && i >= 4)
			.map((flag) =>
				handover.filter(
					(_, i) =>
						i !== handover.indexOf(flag) && i !== handover.indexOf(flag) + 1,
				),
			),
	];
	for (const argv of cases) {
		const out: string[] = [];
		const err: string[] = [];
		const deps: Deps = {
			io: { out: (t) => out.push(t), err: (t) => err.push(t) },
			get env(): Deps["env"] {
				throw new Error("Usage accessed storage");
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
	}
});

test.skipIf(!process.env.BOARD_BIN)(
	"compiled task writes preserve shell text and the complete lease flow",
	() => {
		const f = fixture();
		const binary = process.env.BOARD_BIN as string;
		try {
			const run = (...argv: string[]) =>
				Bun.spawnSync([binary, ...argv], {
					cwd: f.repo,
					env: { ...process.env, BOARD_DIR: f.env.dir },
					stdin: "ignore",
				});
			const json = (name: keyof typeof outputs, ...argv: string[]) => {
				const result = run(...argv, "--json");
				expect(result.exitCode).toBe(0);
				expect(result.stderr.toString()).toBe("");
				const value = JSON.parse(result.stdout.toString());
				expectValid(outputs[name], value);
				return value;
			};
			json("project add", "project", "add", "T", "--actor", "@binary");
			const body = "Line 'single' \"double\" $HOME `ticks` \\backslash";
			const script = [
				"exec \"$1\" add --actor @binary --title 'From shell' --body \"$(cat <<'BODY'",
				body,
				"BODY",
				')" --json',
			].join("\n");
			const fromShell = Bun.spawnSync(["sh", "-c", script, "slice8", binary], {
				cwd: f.repo,
				env: { ...process.env, BOARD_DIR: f.env.dir },
				stdin: "ignore",
			});
			expect(fromShell.exitCode).toBe(0);
			const added = JSON.parse(fromShell.stdout.toString());
			expectValid(outputs.add, added);
			expect(added.task.body).toBe(body);
			const big = "😀".repeat(20000);
			json("edit", "edit", "T-1", "--actor", "@binary", "--body", big);
			expect(json("show", "show", "T-1").task.body).toBe(big);
			const claimed = json(
				"claim",
				"claim",
				"T-1",
				"--actor",
				"@binary",
				"--minutes",
				"5",
			);
			expect(claimed.claim.holder).toBe("@binary");
			const held = run(
				"claim",
				"T-1",
				"--actor",
				"@binary",
				"--minutes",
				"5",
				"--json",
			);
			expect(held.exitCode).toBe(1);
			expect(held.stdout.toString()).toBe("");
			const error = JSON.parse(held.stderr.toString());
			expectValid(errorShape, error);
			expect(error.error.code).toBe("claim_held");
			const usage = run("claim", "T-1", "--actor", "@binary", "--json");
			expect(usage.exitCode).toBe(64);
			expect(usage.stdout.toString()).toBe("");
			expect(usage.stderr.toString()).toStartWith("board: usage: ");
			json(
				"extend",
				"extend",
				"T-1",
				"--actor",
				"@binary",
				"--holder",
				"@binary",
				"--minutes",
				"10",
			);
			json(
				"comment",
				"comment",
				"T-1",
				"--actor",
				"@binary",
				"--text",
				"@literal-file",
			);
			json(
				"handover",
				"handover",
				"T-1",
				"--actor",
				"@binary",
				"--to",
				"main",
				"--text",
				"Ready",
				"--changed",
				"Text",
				"--ran",
				"Checks",
				"--unchecked",
				"None",
			);
			expect(json("show", "show", "T-1").task.status).toBe("active");
			json(
				"release",
				"release",
				"T-1",
				"--actor",
				"@binary",
				"--holder",
				"@binary",
			);
			json("edit", "edit", "T-1", "--actor", "@binary", "--status", "done");
			expect(json("show", "show", "T-1").task.status).toBe("done");
		} finally {
			f.cleanup();
		}
	},
);
