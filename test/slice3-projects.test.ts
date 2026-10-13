import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { Refusal } from "../src/errors.ts";
import { Place } from "../src/place/place.ts";
import { Store } from "../src/store/store.ts";

async function fixture() {
	const dir = mkdtempSync("/private/tmp/board-slice3-projects-");
	for (const name of ["a", "b"]) mkdirSync(join(dir, name));
	const env = {
		dir: join(dir, "board"),
		file: join(dir, "board", "board.db"),
		boardDirSet: true,
	};
	let now = new Date("2026-10-13T12:00:00.000Z");
	const clock = { now: () => now };
	const runner = {
		async commonDir() {
			return {
				kind: "exit" as const,
				code: 128,
				stdout: "",
				stderr: "fatal: not a git repository",
			};
		},
	};
	await projectAdd(env, clock, runner, dir, {
		actor: "owner",
		key: "A",
		dir: "a",
	});
	await projectAdd(env, clock, runner, dir, {
		actor: "owner",
		key: "B",
		dir: "b",
	});
	const store = await Store.open(env, clock);
	const board = new Board(store);
	return {
		dir,
		env,
		runner,
		store,
		board,
		ctx: new Place(join(dir, "a"), runner),
		setNow: (date: Date) => {
			now = date;
		},
		async close() {
			await board.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("temp-file empty-project removal deletes its milestones/history under deferred foreign keys only", async () => {
	const f = await fixture();
	try {
		for (const name of ["v1", "v2", "v3"])
			await f.board.milestoneAdd(f.ctx, {
				actor: "tester",
				name,
				delivers: name,
			});
		await f.board.milestoneUpdate(f.ctx, {
			actor: "tester",
			milestone: "v2",
			delivers: "Changed",
		});
		await f.board.milestoneDelete(f.ctx, { actor: "tester", milestone: "v1" });
		await f.board.milestoneAdd(f.ctx, {
			actor: "tester",
			project: "B",
			name: "v1",
			delivers: "Other",
		});
		await f.board.taskAdd(f.ctx, {
			actor: "tester",
			project: "B",
			title: "Retained",
			milestone: "v1",
		});
		await f.board.taskClaim({ actor: "worker", key: "B-1", minutes: 30 });
		const retained = () =>
			f.store.read(async (tx) => ({
				project: await tx.project.findUnique({ where: { key: "B" } }),
				milestones: await tx.milestone.findMany({ where: { project_id: 2 } }),
				events: await tx.event.findMany({
					where: { project_id: 2 },
					orderBy: { id: "asc" },
				}),
				tasks: await tx.task.findMany({ where: { project_id: 2 } }),
				claims: await tx.claim.findMany(),
			}));
		const before = await retained();
		const removed = await f.board.projectRemove({ actor: "owner", key: "a" });
		expect(removed).toMatchObject({
			key: "A",
			name: "a",
			directory: join(f.dir, "a"),
		});
		expect(await retained()).toEqual(before);
		expect(
			await f.store.read((tx) =>
				tx.milestone.count({ where: { project_id: 1 } }),
			),
		).toBe(0);
		expect(
			await f.store.read((tx) => tx.event.count({ where: { project_id: 1 } })),
		).toBe(0);
		const global = await f.store.read((tx) =>
			tx.event.findMany({
				where: { project_id: null },
				orderBy: { id: "asc" },
			}),
		);
		expect(global.map((event) => event.kind)).toEqual([
			"board_created",
			"project_removed",
		]);
		expect(global[1]).toMatchObject({
			actor: "owner",
			task_id: null,
			milestone_id: null,
		});
		expect(JSON.parse(global[1]?.data ?? "")).toEqual({
			key: "A",
			name: "a",
			directory: join(f.dir, "a"),
		});
		expect(
			await f.store.read((tx) =>
				tx.$queryRawUnsafe("PRAGMA defer_foreign_keys"),
			),
		).toEqual([{ defer_foreign_keys: 0n }]);
		const db = new Database(f.env.file, { readonly: true });
		try {
			expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally {
			db.close();
		}
		await expect(
			f.board.boardStatus(f.ctx, { project: "A" }),
		).rejects.toBeInstanceOf(Refusal);
	} finally {
		await f.close();
	}
});

test("a refused combined project edit preserves its fields and commits another project's expiry", async () => {
	const f = await fixture();
	try {
		await f.board.taskAdd(f.ctx, {
			actor: "tester",
			project: "B",
			title: "Expired",
		});
		await f.board.taskClaim({ actor: "old", key: "B-1", minutes: 1 });
		const before = await f.store.read((tx) =>
			tx.project.findUnique({ where: { key: "A" } }),
		);
		f.setNow(new Date("2026-10-13T12:01:00.000Z"));
		try {
			await f.board.projectEdit(f.runner, f.dir, {
				actor: "owner",
				key: "a",
				name: "Lost",
				dir: "b",
			});
			throw new Error("Expected refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(Refusal);
			if (!(error instanceof Refusal)) throw error;
			expect(error.error).toMatchObject({
				code: "project_exists",
				details: { field: "dir", project: { key: "B" } },
			});
		}
		expect(
			await f.store.read((tx) =>
				tx.project.findUnique({ where: { key: "A" } }),
			),
		).toEqual(before);
		expect(
			await f.store.read((tx) =>
				tx.event.count({ where: { kind: "project_edited" } }),
			),
		).toBe(0);
		const read = await f.board.taskRead({ key: "B-1" });
		expect(read.task).toMatchObject({ status: "ready", claim: null });
		expect(
			read.events.filter((event) => event.kind === "claim_expired"),
		).toMatchObject([{ actor: "board", project: "B", data: { by: "owner" } }]);
		expect(
			(
				await f.board.projectEdit(f.runner, f.dir, {
					actor: "owner",
					key: "A",
					name: "Kept",
				})
			).name,
		).toBe("Kept");
	} finally {
		await f.close();
	}
});
