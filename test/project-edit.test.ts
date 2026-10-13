import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { SystemClock } from "../src/clock.ts";
import type { Env } from "../src/env.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import type { GitRun, GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { Store } from "../src/store/store.ts";

const notARepo: GitRun = {
	kind: "exit",
	code: 128,
	stdout: "",
	stderr: "fatal: not a git repository\n",
};
const outside: GitRunner = { commonDir: async () => notARepo };

async function refusal(promise: Promise<unknown>): Promise<BoardError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Refusal) return error.error;
		throw error;
	}
	throw new Error("expected a refusal");
}

let dir: string;
let env: Env;
let board: Board;

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-edit-")));
	env = {
		dir: join(dir, "b"),
		file: join(dir, "b", "board.db"),
		boardDirSet: true,
	};
	for (const d of ["app", "app2", "other", "repo/sub"])
		mkdirSync(join(dir, d), { recursive: true });
	await projectAdd(env, SystemClock, outside, dir, {
		actor: "owner",
		key: "APP",
		dir: "app",
	});
	await projectAdd(env, SystemClock, outside, dir, {
		actor: "owner",
		key: "OTH",
		dir: "other",
	});
	board = new Board(await Store.open(env, SystemClock));
});

afterEach(async () => {
	await board.close();
	rmSync(dir, { recursive: true, force: true });
});

const kinds = () => {
	const db = new Database(env.file, { readonly: true });
	const rows = db
		.query("SELECT kind, project_id, data FROM event ORDER BY id")
		.all() as {
		kind: string;
		project_id: number | null;
		data: string;
	}[];
	db.close();
	return rows.map((r) => [r.kind, r.project_id, JSON.parse(r.data)]);
};

describe("project edit", () => {
	test("a new name and directory, one project_edited with from and to", async () => {
		const edited = await board.projectEdit(outside, dir, {
			actor: "owner",
			key: "app",
			name: "App",
			dir: "app2",
		});
		expect(edited).toMatchObject({
			key: "APP",
			name: "App",
			directory: join(dir, "app2"),
		});
		expect(kinds().at(-1)).toEqual([
			"project_edited",
			1,
			{
				name: { from: "app", to: "App" },
				directory: { from: join(dir, "app"), to: join(dir, "app2") },
			},
		]);
		const before = kinds().length;
		expect(
			(
				await board.projectEdit(outside, dir, {
					actor: "owner",
					key: "APP",
					name: "App",
				})
			).name,
		).toBe("App");
		expect(kinds()).toHaveLength(before);
		const here = await board.projectList(new Place(join(dir, "app2"), outside));
		expect(here.here).toBe("APP");
	});

	test("refusals: unknown key, a taken directory, a bad directory or name, git's root rule", async () => {
		expect(
			await refusal(
				board.projectEdit(outside, dir, {
					actor: "owner",
					key: "NOPE",
					name: "x",
				}),
			),
		).toMatchObject({
			code: "not_found",
			details: { what: "project", id: "NOPE" },
		});
		expect(
			await refusal(
				board.projectEdit(outside, dir, {
					actor: "owner",
					key: "APP",
					dir: "other",
				}),
			),
		).toMatchObject({
			code: "project_exists",
			details: { field: "dir", project: { key: "OTH" } },
		});
		expect(
			await refusal(
				board.projectEdit(outside, dir, {
					actor: "owner",
					key: "APP",
					dir: "missing",
				}),
			),
		).toMatchObject({
			code: "invalid_argument",
			details: { field: "dir" },
		});
		expect(
			await refusal(
				board.projectEdit(outside, dir, {
					actor: "owner",
					key: "APP",
					name: " ",
				}),
			),
		).toMatchObject({
			details: { field: "name" },
		});
		const inRepo: GitRunner = {
			commonDir: async () => ({
				kind: "exit",
				code: 0,
				stdout: `${join(dir, "repo", ".git")}\n`,
				stderr: "",
			}),
		};
		const error = await refusal(
			board.projectEdit(inRepo, dir, {
				actor: "owner",
				key: "APP",
				dir: "repo/sub",
			}),
		);
		expect(error).toMatchObject({
			code: "invalid_argument",
			details: { field: "dir" },
		});
		expect(error.next).toContain(join(dir, "repo"));
		expect(kinds().map(([kind]) => kind)).not.toContain("project_edited");
	});
});

describe("project rm", () => {
	test("an empty project goes with its milestones and events, under defer_foreign_keys", async () => {
		const ctx = new Place(join(dir, "app"), outside);
		await board.milestoneAdd(ctx, {
			actor: "owner",
			name: "v1",
			delivers: "x",
		});
		await board.milestoneUpdate(ctx, {
			actor: "owner",
			milestone: "v1",
			delivers: "y",
		});
		const removed = await board.projectRemove({ actor: "owner", key: "app" });
		expect(removed).toMatchObject({ key: "APP", directory: join(dir, "app") });
		const db = new Database(env.file, { readonly: true });
		expect(db.query("SELECT key FROM project").all()).toEqual([{ key: "OTH" }]);
		expect(db.query("SELECT count(*) AS n FROM milestone").get()).toEqual({
			n: 0,
		});
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		db.close();
		expect(kinds()).toEqual([
			["board_created", null, {}],
			[
				"project_added",
				2,
				{ key: "OTH", name: "other", directory: join(dir, "other") },
			],
			[
				"project_removed",
				null,
				{ key: "APP", name: "app", directory: join(dir, "app") },
			],
		]);
		expect(
			await refusal(board.projectRemove({ actor: "owner", key: "APP" })),
		).toMatchObject({
			code: "not_found",
		});
	});

	test("a project with tasks stays: invalid_transition has_tasks, nothing removed", async () => {
		const ctx = new Place(join(dir, "app"), outside);
		await board.taskAdd(ctx, { actor: "owner", title: "t" });
		await board.taskUpdate({
			actor: "owner",
			key: "APP-1",
			status: "cancelled",
		});
		expect(
			await refusal(board.projectRemove({ actor: "owner", key: "APP" })),
		).toMatchObject({
			code: "invalid_transition",
			details: { reason: "has_tasks" },
		});
		expect((await board.taskRead({ key: "APP-1" })).task.key).toBe("APP-1");
	});
});

test("without git, edit's refusal says to run the edit again, and add's says add", async () => {
	const noGit: GitRunner = { commonDir: async () => ({ kind: "missing" }) };
	const edit = await refusal(
		board.projectEdit(noGit, dir, { actor: "owner", key: "APP", dir: "app2" }),
	);
	expect(edit).toMatchObject({
		code: "invalid_argument",
		details: { field: "dir" },
	});
	expect(edit.next).toContain(
		`then run board project edit APP --dir app2 again`,
	);
	const add = await refusal(
		projectAdd(env, SystemClock, noGit, dir, {
			actor: "owner",
			key: "NEW",
			dir: "app2",
		}),
	);
	expect(add.next).toContain("then run board project add again");
});
