import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import type { Deps } from "../src/cli/io.ts";
import { runCli } from "../src/cli/root.ts";
import { boardEnv, type Env } from "../src/env.ts";
import { Refusal } from "../src/errors.ts";
import type { GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { Store } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";

const runner: GitRunner = {
	commonDir: async () => ({
		kind: "exit",
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository",
	}),
};
const writes = [
	["project", "add", "T"],
	["project", "edit", "T", "--name", "Renamed"],
	["project", "rm", "T"],
	["milestone", "add", "v1", "--delivers", "First"],
	["milestone", "edit", "v1", "--delivers", "Second"],
	["milestone", "rm", "v1"],
	["answer", "Q1", "1", "--as", "delegate"],
	["validate", "Q1"],
];

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "board-slice8-actor-")));
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
	const query = (sql: string) => {
		const db = new Database(env.file, { readonly: true });
		try {
			return db.query(sql).all();
		} finally {
			db.close();
		}
	};
	return {
		dir,
		repo,
		env,
		clock,
		run,
		query,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("every existing write rejects missing, empty and 65-code-point actors before opening", async () => {
	for (const command of writes) {
		for (const flags of [[], ["--actor", ""], ["--actor", "😀".repeat(65)]]) {
			const out: string[] = [];
			const err: string[] = [];
			const deps: Deps = {
				io: { out: (t) => out.push(t), err: (t) => err.push(t) },
				get env(): Deps["env"] {
					throw new Error("Usage opened storage");
				},
				clock: {
					now: () => {
						throw new Error("Usage read time");
					},
				},
				runner: {
					commonDir: async () => {
						throw new Error("Usage ran git");
					},
				},
				cwd: "/unused",
				colors: false,
				exitCode: 0,
			};
			expect(await runCli([...command, ...flags], deps)).toBe(64);
			expect(out).toEqual([]);
			expect(err).toHaveLength(1);
			expect(err[0]).toContain("--actor");
		}
	}
});

test("64 astral code points are accepted and the typed actor is recorded on every existing write", async () => {
	const f = fixture();
	const actor = "😀".repeat(64);
	try {
		expect((await f.run(["project", "add", "T", "--actor", actor])).code).toBe(
			0,
		);
		expect(
			(
				await f.run([
					"project",
					"edit",
					"T",
					"--name",
					"Renamed",
					"--actor",
					actor,
				])
			).code,
		).toBe(0);
		for (const command of writes.slice(3, 6))
			expect((await f.run([...command, "--actor", actor])).code).toBe(0);
		const board = new Board(await Store.open(f.env, f.clock));
		try {
			await board.taskAdd(new Place(f.repo, runner), {
				actor: "seed",
				title: "Question target",
			});
			await board.questionAsk({
				actor: "seed",
				key: "T-1",
				text: "Which?",
				options: [{ label: "A" }, { label: "B" }],
				recommended: 1,
			});
		} finally {
			await board.close();
		}
		expect(
			(await f.run([...(writes[6] as string[]), "--actor", actor], f.dir)).code,
		).toBe(0);
		expect(
			(await f.run([...(writes[7] as string[]), "--actor", actor], f.dir)).code,
		).toBe(0);
		expect(
			f.query(
				"SELECT kind, actor FROM event WHERE actor != 'seed' ORDER BY id",
			),
		).toEqual([
			{ kind: "board_created", actor },
			{ kind: "project_added", actor },
			{ kind: "project_edited", actor },
			{ kind: "milestone_added", actor },
			{ kind: "milestone_edited", actor },
			{ kind: "milestone_deleted", actor },
			{ kind: "question_answered", actor },
			{ kind: "question_validated", actor },
		]);
		const empty = join(f.dir, "empty");
		mkdirSync(empty);
		expect(
			(
				await f.run([
					"project",
					"add",
					"E",
					"--dir",
					empty,
					"--actor",
					"  @é\n ",
				])
			).code,
		).toBe(0);
		expect(
			f
				.query(
					"SELECT actor FROM event WHERE kind = 'project_added' ORDER BY id",
				)
				.at(-1),
		).toEqual({ actor: "  @é\n " });
		expect((await f.run(["project", "rm", "E", "--actor", actor])).code).toBe(
			0,
		);
		expect(
			f.query("SELECT actor FROM event WHERE kind = 'project_removed'"),
		).toEqual([{ actor }]);
	} finally {
		f.cleanup();
	}
});

test("reserved actors refuse every Board write without changing the requested state", async () => {
	const f = fixture();
	let board: Board | undefined;
	try {
		expect(
			(await f.run(["project", "add", "T", "--actor", "owner"])).code,
		).toBe(0);
		board = new Board(await Store.open(f.env, f.clock));
		const b = board;
		const place = new Place(f.repo, runner);
		await b.taskAdd(place, { actor: "seed", title: "Task" });
		await b.milestoneAdd(place, {
			actor: "seed",
			name: "v1",
			delivers: "First",
		});
		await b.taskClaim({ actor: "seed", key: "T-1", minutes: 5 });
		const asked = await b.questionAsk({
			actor: "seed",
			key: "T-1",
			text: "Which?",
			options: [{ label: "A" }, { label: "B" }],
			recommended: 1,
		});
		await b.questionAnswer({
			actor: "seed",
			question: asked.question.id,
			choice: 1,
			as: "delegate",
		});
		const snapshot = () =>
			["project", "task", "claim", "question", "milestone", "event"].map(
				(table) => f.query(`SELECT * FROM ${table} ORDER BY 1`),
			);
		const before = snapshot();
		const calls = [
			() => b.taskAdd(place, { actor: "board", title: "Refused" }),
			() => b.taskUpdate({ actor: "board", key: "T-1", title: "Refused" }),
			() => b.taskClaim({ actor: "board", key: "T-1", minutes: 5 }),
			() =>
				b.taskExtend({
					actor: "board",
					key: "T-1",
					holder: "seed",
					minutes: 9,
				}),
			() => b.taskRelease({ actor: "board", key: "T-1", holder: "seed" }),
			() =>
				b.taskComment({
					actor: "board",
					key: "T-1",
					kind: "note",
					text: "Refused",
				}),
			() =>
				b.taskComment({
					actor: "board",
					key: "T-1",
					kind: "handover",
					to: "main",
					text: "Refused",
					changed: "None",
					ran: "None",
					unchecked: "All",
				}),
			() =>
				b.questionAsk({
					actor: "board",
					key: "T-1",
					text: "Refused",
					options: [{ label: "A" }, { label: "B" }],
					recommended: 1,
				}),
			() =>
				b.questionAnswer({
					actor: "board",
					question: asked.question.id,
					choice: 2,
					as: "owner",
				}),
			() => b.questionValidate({ actor: "board", question: asked.question.id }),
			() =>
				b.milestoneAdd(place, {
					actor: "board",
					name: "v2",
					delivers: "Refused",
				}),
			() =>
				b.milestoneUpdate(place, {
					actor: "board",
					milestone: "v1",
					delivers: "Refused",
				}),
			() => b.milestoneDelete(place, { actor: "board", milestone: "v1" }),
		];
		for (const call of calls) {
			try {
				await call();
				throw new Error("Expected reserved actor refusal");
			} catch (error) {
				expect(error).toBeInstanceOf(Refusal);
				if (!(error instanceof Refusal)) throw error;
				expect(error.error).toMatchObject({
					code: "invalid_argument",
					details: { field: "actor" },
				});
				expect(error.error.next).toContain("--actor");
			}
			expect(snapshot()).toEqual(before);
		}
	} finally {
		await board?.close();
		f.cleanup();
	}
});

test("a reserved actor refusal commits the expiry sweep once with board as its actor", async () => {
	const f = fixture();
	try {
		expect(
			(await f.run(["project", "add", "T", "--actor", "owner"])).code,
		).toBe(0);
		const board = new Board(await Store.open(f.env, f.clock));
		try {
			await board.taskAdd(new Place(f.repo, runner), {
				actor: "seed",
				title: "Lapsed",
			});
			await board.taskClaim({ actor: "seed", key: "T-1", minutes: 1 });
		} finally {
			await board.close();
		}
		f.clock.advance(1);
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await f.run([
				"project",
				"edit",
				"T",
				"--name",
				"Refused",
				"--actor",
				"board",
				"--json",
			]);
			expect(result.code).toBe(1);
			expect(result.out).toEqual([]);
			expect(JSON.parse(result.err[0] as string)).toMatchObject({
				error: { code: "invalid_argument", details: { field: "actor" } },
			});
		}
		expect(
			f.query("SELECT kind, actor FROM event WHERE kind = 'claim_expired'"),
		).toEqual([{ kind: "claim_expired", actor: "board" }]);
		expect(f.query("SELECT name FROM project")).toEqual([{ name: "repo" }]);
		expect(f.query("SELECT * FROM claim")).toEqual([]);
		expect(
			f.query("SELECT * FROM event WHERE kind = 'project_edited'"),
		).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test.skipIf(!process.env.BOARD_BIN)(
	"compiled project writes require and record their supplied actor",
	() => {
		const f = fixture();
		try {
			const run = (...argv: string[]) =>
				Bun.spawnSync([process.env.BOARD_BIN as string, ...argv], {
					cwd: f.repo,
					env: {
						...process.env,
						BOARD_DIR: f.env.dir,
						BOARD_ACTOR: "ignored",
						BOARD_PROJECT: "IGNORED",
					},
					stdin: "ignore",
				});
			const missing = run("project", "add", "T");
			expect(missing.exitCode).toBe(64);
			expect(missing.stdout.toString()).toBe("");
			expect(missing.stderr.toString()).toContain("--actor");
			const added = run("project", "add", "T", "--actor", "@binary", "--json");
			expect(added.exitCode).toBe(0);
			expect(JSON.parse(added.stdout.toString()).key).toBe("T");
			const reserved = run(
				"project",
				"edit",
				"T",
				"--name",
				"Refused",
				"--actor",
				"board",
				"--json",
			);
			expect(reserved.exitCode).toBe(1);
			expect(reserved.stdout.toString()).toBe("");
			expect(JSON.parse(reserved.stderr.toString())).toMatchObject({
				error: { code: "invalid_argument", details: { field: "actor" } },
			});
			expect(f.query("SELECT kind, actor FROM event ORDER BY id")).toEqual([
				{ kind: "board_created", actor: "@binary" },
				{ kind: "project_added", actor: "@binary" },
			]);
		} finally {
			f.cleanup();
		}
	},
);
