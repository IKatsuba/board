import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { runCli } from "../src/cli/root.ts";
import { boardEnv } from "../src/env.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import type { GitRun, GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";

const notARepo: GitRunner = {
	commonDir: async (): Promise<GitRun> => ({
		kind: "exit",
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository\n",
	}),
};

async function refusal(promise: Promise<unknown>): Promise<BoardError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Refusal) return error.error;
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("the actor board on the project writes", () => {
	let dir: string;
	let env: { dir: string; file: string; boardDirSet: boolean };
	const clock = new FakeClock();

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "board-actor-")));
		env = {
			dir: join(dir, "b"),
			file: join(dir, "b", "board.db"),
			boardDirSet: true,
		};
		mkdirSync(join(dir, "app"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("project add, edit and rm refuse it, field actor, and write nothing", async () => {
		const add = (actor: string) =>
			projectAdd(env, clock, notARepo, dir, {
				actor,
				key: "APP",
				dir: join(dir, "app"),
			});
		const refused = await refusal(add("board"));
		expect(refused).toMatchObject({
			code: "invalid_argument",
			details: { field: "actor" },
		});
		expect(refused.next).toBe("Pass --actor with your own name.");
		await add("owner");
		const events = () => {
			const db = new Database(env.file, { readonly: true });
			try {
				return db
					.query("SELECT kind, actor FROM event ORDER BY id")
					.all()
					.map((e) => Object.values(e as object).join(" "));
			} finally {
				db.close();
			}
		};
		const board = new Board(await Store.open(env, clock));
		try {
			for (const write of [
				() =>
					board.projectEdit(notARepo, dir, {
						actor: "board",
						key: "APP",
						name: "renamed",
					}),
				() => board.projectRemove({ actor: "board", key: "APP" }),
			]) {
				expect(await refusal(write())).toMatchObject({
					code: "invalid_argument",
					details: { field: "actor" },
				});
			}
			await board.projectEdit(notARepo, dir, {
				actor: "@someone",
				key: "APP",
				name: "renamed",
			});
			expect(events()).toEqual([
				"board_created owner",
				"project_added owner",
				"project_edited @someone",
			]);
			await board.projectRemove({ actor: "@someone", key: "APP" });
			// The removal of an empty project takes its events with it.
			expect(events()).toEqual([
				"board_created owner",
				"project_removed @someone",
			]);
		} finally {
			await board.close();
		}
	});
});

describe("every next names a command, never a tool", () => {
	const tool = /task_|question_|milestone_|board_status/;
	let clock: FakeClock;
	let store: Store;
	let board: Board;
	const inA = new Place("/w/a", notARepo);
	const elsewhere = new Place("/elsewhere", notARepo);

	beforeEach(async () => {
		clock = new FakeClock();
		store = await Store.memory(clock);
		board = new Board(store);
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: async (tx, now) => {
				await addProject(tx, now, "owner", {
					key: "A",
					name: "a",
					directory: "/w/a",
				});
				await addProject(tx, now, "owner", {
					key: "B",
					name: "b",
					directory: "/w/b",
				});
			},
		});
		await board.milestoneAdd(inA, { actor: "main", name: "v1", delivers: "x" });
		for (const title of ["one", "two", "three", "four"]) {
			await board.taskAdd(inA, { actor: "main", title, milestone: "v1" });
		}
		await board.taskAdd(inA, {
			actor: "main",
			title: "five",
			milestone: "none",
		});
		await board.taskAdd(new Place("/w/b", notARepo), {
			actor: "main",
			title: "other",
		});
		// A-1 claimed; A-2 waits on A-3; A-4 has an open question.
		await board.taskClaim({ actor: "main", key: "A-1", minutes: 30 });
		await board.taskUpdate({ actor: "main", key: "A-2", waits_add: ["A-3"] });
		await board.questionAsk({
			actor: "main",
			key: "A-4",
			text: "Which?",
			options: [{ label: "x" }, { label: "y" }],
			recommended: 1,
		});
		await board.questionAsk({
			actor: "main",
			key: "A-3",
			text: "Which?",
			options: [{ label: "x" }, { label: "y" }],
			recommended: 1,
		});
		await board.questionAnswer({
			actor: "main",
			question: "Q2",
			choice: 1,
			as: "owner",
		});
		await board.taskUpdate({ actor: "main", key: "A-5", status: "done" });
	});
	afterEach(() => store.close());

	test("each refusal the rules make", async () => {
		const cases: [() => Promise<unknown>, BoardError["code"], RegExp?][] = [
			[() => board.taskRead({ key: "A-99" }), "not_found", /board ls/],
			[() => board.taskRead({ key: "ZZ-1" }), "not_found"],
			[
				() => board.taskNext(inA, { milestone: "v9" }),
				"not_found",
				/board milestone ls/,
			],
			[
				() => board.questionValidate({ actor: "main", question: "Q99" }),
				"not_found",
				/board questions/,
			],
			[
				() => board.taskClaim({ actor: "main", key: "A-1", minutes: 5 }),
				"claim_held",
				/board extend/,
			],
			[
				() =>
					board.taskExtend({
						actor: "main",
						key: "A-1",
						holder: "@x",
						minutes: 5,
					}),
				"claim_held",
				/board show KEY/,
			],
			[
				() => board.taskRelease({ actor: "main", key: "A-3", holder: "main" }),
				"not_claimed",
				/board claim/,
			],
			[
				() => board.taskClaim({ actor: "main", key: "A-2", minutes: 5 }),
				"not_ready",
				/board show KEY/,
			],
			[
				() => board.taskClaim({ actor: "main", key: "A-4", minutes: 5 }),
				"not_ready",
			],
			[
				() => board.taskClaim({ actor: "main", key: "A-5", minutes: 5 }),
				"not_ready",
				/board edit KEY --status ready/,
			],
			[
				() =>
					board.questionAsk({
						actor: "main",
						key: "A-5",
						text: "?",
						options: [{ label: "x" }, { label: "y" }],
						recommended: 1,
					}),
				"invalid_transition",
				/board edit KEY --status ready/,
			],
			[
				() => board.taskUpdate({ actor: "main", key: "A-4", status: "done" }),
				"invalid_transition",
			],
			[
				() => board.milestoneDelete(inA, { actor: "main", milestone: "v1" }),
				"invalid_transition",
				/board edit KEY --milestone none/,
			],
			[
				() => board.questionValidate({ actor: "main", question: "Q2" }),
				"invalid_transition",
				/board questions --state to_validate/,
			],
			[
				() =>
					board.questionAnswer({
						actor: "main",
						question: "Q2",
						choice: 1,
						as: "owner",
					}),
				"already_answered",
				/board questions/,
			],
			[
				() =>
					board.taskUpdate({ actor: "main", key: "A-3", waits_add: ["A-2"] }),
				"cycle",
			],
			[
				() => board.taskUpdate({ actor: "main", key: "A-3", parent: "A-3" }),
				"cycle",
				/--parent .*--no-parent/,
			],
			[
				() =>
					board.questionAnswer({
						actor: "main",
						question: "Q1",
						choice: 3,
						as: "owner",
					}),
				"invalid_argument",
				/--text/,
			],
			[
				() => board.taskAdd(inA, { actor: "board", title: "t" }),
				"invalid_argument",
				/--actor/,
			],
			[
				() =>
					board.taskUpdate({
						actor: "main",
						key: "A-2",
						waits_add: ["A-1"],
						waits_remove: ["A-1"],
					}),
				"invalid_argument",
			],
			[
				() =>
					board.taskUpdate({ actor: "main", key: "A-2", waits_add: ["B-1"] }),
				"invalid_argument",
				/--waits-add/,
			],
			[
				() => board.taskList(inA, { project: "*", milestone: "v1" }),
				"invalid_argument",
				/-p KEY/,
			],
			[
				() => board.questionList(inA, { project: "B", key: "A-4" }),
				"invalid_argument",
				/-p/,
			],
			[
				() =>
					board.questionAnswer({ actor: "main", question: "Q1", as: "owner" }),
				"invalid_argument",
			],
			[
				() =>
					board.milestoneAdd(inA, {
						actor: "main",
						name: "none",
						delivers: "x",
					}),
				"invalid_argument",
			],
			[() => board.boardStatus(elsewhere, {}), "no_project", /-p KEY/],
		];
		for (const [call, code, names] of cases) {
			const refused = await refusal(call());
			expect(refused.code).toBe(code);
			expect(refused.next).not.toMatch(tool);
			if (names !== undefined) expect(refused.next).toMatch(names);
		}
	});

	test("details.field is the flag as typed", async () => {
		const fields: [() => Promise<unknown>, string][] = [
			[
				() =>
					board.taskUpdate({
						actor: "main",
						key: "A-2",
						waits_add: ["A-1"],
						waits_remove: ["A-1"],
					}),
				"waits-add",
			],
			[
				() =>
					board.taskUpdate({
						actor: "main",
						key: "A-2",
						waits_remove: ["A-2"],
					}),
				"waits-remove",
			],
			[
				() =>
					board.questionAnswer({
						actor: "main",
						question: "Q1",
						choice: 3,
						as: "owner",
					}),
				"N",
			],
			[() => board.questionList(inA, { project: "B", key: "A-4" }), "task"],
			[
				() =>
					board.milestoneAdd(inA, { actor: "main", name: "V1", delivers: "x" }),
				"NAME",
			],
			[
				() =>
					board.milestoneUpdate(inA, {
						actor: "main",
						milestone: "v1",
						name: "none",
					}),
				"name",
			],
		];
		for (const [call, field] of fields) {
			expect((await refusal(call())).details).toMatchObject({ field });
		}
	});
});

describe("--actor on the CLI's writes", () => {
	test("missing, it is a usage error before anything is opened; --as is required on answer", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "board-actor-cli-")));
		try {
			for (const argv of [
				["project", "add", "APP"],
				["project", "edit", "APP", "--name", "x"],
				["project", "rm", "APP"],
				["milestone", "add", "v1", "--delivers", "x"],
				["milestone", "edit", "v1", "--delivers", "x"],
				["milestone", "rm", "v1"],
				["answer", "Q1", "1", "--as", "owner"],
				["validate", "Q1"],
				["answer", "Q1", "1", "--actor", "owner"],
			]) {
				const err: string[] = [];
				const code = await runCli(argv, {
					io: { out: () => {}, err: (t) => err.push(t) },
					env: boardEnv({ BOARD_DIR: join(dir, "b") }),
					clock: new FakeClock(),
					runner: notARepo,
					cwd: dir,
					colors: false,
					exitCode: 0,
				});
				expect(code).toBe(64);
				expect(err).toHaveLength(1);
				expect(err[0]).toEndWith(
					`Missing required option "${argv.includes("--actor") ? "--as" : "--actor"}".`,
				);
				expect(existsSync(join(dir, "b"))).toBe(false);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
