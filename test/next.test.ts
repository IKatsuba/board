import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Board } from "../src/board.ts";
import { stamp } from "../src/clock.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import type { GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";

const noGit: GitRunner = {
	commonDir: async () => {
		throw new Error("git must not be asked");
	},
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

let clock: FakeClock;
let store: Store;
let board: Board;
const inA: Place = new Place("/w/a", noGit);

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
			for (const [name, position] of [
				["v1", 1],
				["v2", 2],
				["v3", 3],
			] as const) {
				await tx.milestone.create({
					data: {
						project_id: 1,
						name,
						delivers: "x",
						position,
						created_at: stamp(now),
						created_by: "o",
					},
				});
			}
		},
	});
});

afterEach(() => board.close());

const add = (title: string, extra: Record<string, unknown> = {}) =>
	board.taskAdd(inA, { actor: "main", title, ...extra });
const next = (input: { milestone?: string } = {}) => board.taskNext(inA, input);
const close = (key: string) =>
	board.taskUpdate({ actor: "main", key, status: "done" });

describe("task_next", () => {
	test("the current milestone first, by priority then oldest", async () => {
		await add("later", { milestone: "v2", priority: "urgent" });
		await add("loose", { priority: "urgent" });
		await add("current low", { milestone: "v1", priority: "low" });
		await add("current high", { milestone: "v1", priority: "high" });
		await add("current high, newer", { milestone: "v1", priority: "high" });
		const got = await next();
		expect(got).toMatchObject({
			project: "A",
			task: { key: "A-4", title: "current high" },
			from: "current",
			milestone: { name: "v1", position: 1, of: 3, left: 3 },
		});
	});

	test("an exhausted current milestone falls through to no milestone, then later ones in chain order", async () => {
		await add("current", { milestone: "v1" });
		await add("v3 task", { milestone: "v3", priority: "urgent" });
		await add("v2 task", { milestone: "v2", priority: "low" });
		await add("loose");
		await board.taskClaim({ actor: "main", key: "A-1", minutes: 30 });
		expect(await next()).toMatchObject({
			task: { key: "A-4" },
			from: "unassigned",
		});
		await board.taskClaim({ actor: "main", key: "A-4", minutes: 30 });
		expect(await next()).toMatchObject({ task: { key: "A-3" }, from: "later" });
	});

	test("an empty current milestone falls through", async () => {
		await add("v2 task", { milestone: "v2" });
		expect(await next()).toMatchObject({
			task: { key: "A-1" },
			from: "later",
			milestone: { name: "v1", left: 0 },
		});
	});

	test("an explicit milestone restricts the search, with no fallback", async () => {
		await add("current", { milestone: "v1" });
		await add("v2 one", { milestone: "v2" });
		expect(await next({ milestone: "V2" })).toMatchObject({
			task: { key: "A-2" },
			from: "milestone",
			milestone: { name: "v2", position: 2 },
		});
		await board.taskClaim({ actor: "main", key: "A-2", minutes: 30 });
		expect(await next({ milestone: "v2" })).toMatchObject({
			task: null,
			from: null,
			waiting: { blocked: 0, active: 1, waits_open: 0 },
		});
		expect(await refusal(next({ milestone: "v9" }))).toMatchObject({
			code: "not_found",
			details: { what: "milestone", id: "v9" },
		});
	});

	test("nothing ready says why: blocked, active, waiting on other tasks", async () => {
		await add("asked");
		await add("held");
		await add("base", { status: "backlog" });
		await add("waits", { waits: ["A-3"] });
		await store.write({
			actor: "test",
			resolve: async () => null,
			apply: (tx, now) =>
				tx.question.create({
					data: {
						task_id: 1,
						text: "q",
						options: JSON.stringify([{ label: "a" }, { label: "b" }]),
						recommended: 1,
						asked_by: "x",
						asked_at: stamp(now),
					},
				}),
		});
		await board.taskClaim({ actor: "main", key: "A-2", minutes: 30 });
		expect(await next()).toEqual({
			project: "A",
			task: null,
			from: null,
			milestone: { name: "v1", position: 1, of: 3, left: 0 },
			waiting: { blocked: 1, active: 1, waits_open: 1 },
		});
	});

	test("an expired claim reads as ready; done milestones are passed over", async () => {
		await add("current", { milestone: "v1" });
		await add("v2", { milestone: "v2" });
		await close("A-1");
		expect(await next()).toMatchObject({
			task: { key: "A-2" },
			from: "current",
			milestone: { name: "v2" },
		});
		await board.taskClaim({ actor: "main", key: "A-2", minutes: 10 });
		expect((await next()).task).toBeNull();
		clock.advance(10);
		expect((await next()).task?.key).toBe("A-2");
	});

	test("no milestones at all: unassigned, and milestone is null", async () => {
		await store.write({
			actor: "test",
			resolve: async () => null,
			apply: (tx) => tx.milestone.deleteMany({}),
		});
		await add("loose");
		expect(await next()).toMatchObject({
			task: { key: "A-1" },
			from: "unassigned",
			milestone: null,
		});
	});

	test("waiting counts every open task once, backlog included, under the first reason", async () => {
		await add("base");
		await add("backlog asked", { status: "backlog" });
		await add("backlog waits", { status: "backlog", waits: ["A-1"] });
		await add("plain backlog", { status: "backlog" });
		await add("asked and waits", { waits: ["A-1"] });
		await add("held");
		await store.write({
			actor: "test",
			resolve: async () => null,
			apply: async (tx, now) => {
				for (const task_id of [2, 5]) {
					await tx.question.create({
						data: {
							task_id,
							text: "q",
							options: JSON.stringify([{ label: "a" }, { label: "b" }]),
							recommended: 1,
							asked_by: "x",
							asked_at: stamp(now),
						},
					});
				}
			},
		});
		await board.taskClaim({ actor: "main", key: "A-6", minutes: 30 });
		await board.taskClaim({ actor: "main", key: "A-1", minutes: 30 });
		expect((await next()).waiting).toEqual({
			blocked: 2,
			active: 2,
			waits_open: 1,
		});
	});
});
