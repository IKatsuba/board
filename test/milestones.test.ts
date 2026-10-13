import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Board } from "../src/board.ts";
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
const inA: Place = new Place("/w/a", noGit);

async function refusal(promise: Promise<unknown>): Promise<BoardError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Refusal) return error.error;
		throw error;
	}
	throw new Error("expected a refusal");
}

let store: Store;
let board: Board;

beforeEach(async () => {
	store = await Store.memory(new FakeClock());
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
});

afterEach(() => board.close());

const add = (name: string, extra: Record<string, unknown> = {}) =>
	board.milestoneAdd(inA, {
		actor: "main",
		name,
		delivers: `${name} things`,
		...extra,
	});
const update = (milestone: string, extra: Record<string, unknown>) =>
	board.milestoneUpdate(inA, { actor: "main", milestone, ...extra });

const logged = (ids: number[]) =>
	store.read(async (tx) =>
		(
			await tx.event.findMany({
				where: { id: { in: ids } },
				orderBy: { id: "asc" },
			})
		).map((e) => [e.kind, JSON.parse(e.data)]),
	);

describe("milestone_add", () => {
	test("last by default, or before / after a named one", async () => {
		const first = await add("v1");
		expect(first).toMatchObject({
			project: "A",
			milestone: {
				name: "v1",
				position: 1,
				delivers: "v1 things",
				status: "current",
				tasks: { total: 0, done: 0, cancelled: 0, left: 0 },
			},
			chain: ["v1"],
		});
		expect(await logged(first.events)).toEqual([
			["milestone_added", { name: "v1", delivers: "v1 things", position: 1 }],
		]);
		await add("v3");
		expect((await add("v2", { after: "V1" })).chain).toEqual([
			"v1",
			"v2",
			"v3",
		]);
		const zero = await add("v0", { before: "v1" });
		expect(zero.chain).toEqual(["v0", "v1", "v2", "v3"]);
		expect(zero.milestone).toMatchObject({ position: 1, status: "current" });
	});

	test("names: none and a taken name (any case) are invalid_argument; anchors must exist", async () => {
		await add("v1");
		for (const name of ["none", "NONE", "V1"]) {
			expect(await refusal(add(name))).toMatchObject({
				code: "invalid_argument",
				details: { field: "NAME" },
			});
		}
		expect(await refusal(add("v2", { before: "v9" }))).toMatchObject({
			code: "not_found",
			details: { what: "milestone", id: "v9" },
		});
		expect(
			(
				await board.milestoneAdd(inA, {
					actor: "main",
					project: "b",
					name: "v1",
					delivers: "x",
				})
			).chain,
		).toEqual(["v1"]);
		expect(
			await refusal(
				board.milestoneAdd(inA, { actor: "board", name: "x", delivers: "x" }),
			),
		).toMatchObject({
			details: { field: "actor" },
		});
	});
});

describe("milestone_update", () => {
	beforeEach(async () => {
		for (const name of ["v1", "v2", "v3"]) await add(name);
	});

	test("rename and re-describe in one milestone_edited", async () => {
		const got = await update("v2", { name: "v2.0", delivers: "new" });
		expect(got).toMatchObject({
			changed: ["name", "delivers"],
			chain: ["v1", "v2.0", "v3"],
		});
		expect(await logged(got.events)).toEqual([
			[
				"milestone_edited",
				{
					name: { from: "v2", to: "v2.0" },
					delivers: { from: "v2 things", to: "new" },
				},
			],
		]);
		expect((await update("v2.0", { name: "V2.0" })).changed).toEqual(["name"]);
	});

	test("a move logs position on the moved milestone; the others shift", async () => {
		const got = await update("v3", { before: "v1" });
		expect(got).toMatchObject({
			changed: ["position"],
			chain: ["v3", "v1", "v2"],
			milestone: { position: 1 },
		});
		expect(await logged(got.events)).toEqual([
			["milestone_edited", { position: { from: 3, to: 1 } }],
		]);
		expect((await update("v3", { after: "v2" })).chain).toEqual([
			"v1",
			"v2",
			"v3",
		]);
		const stay = await update("v1", { before: "v2" });
		expect(stay).toMatchObject({ changed: [], events: [] });
	});

	test("a move relative to itself, a taken name or none is invalid_argument; unknown is not_found", async () => {
		expect(await refusal(update("v1", { before: "V1" }))).toMatchObject({
			code: "invalid_argument",
			details: { field: "before" },
		});
		expect(await refusal(update("v1", { name: "v2" }))).toMatchObject({
			details: { field: "name" },
		});
		expect(await refusal(update("v1", { name: "None" }))).toMatchObject({
			details: { field: "name" },
		});
		expect(await refusal(update("v9", { delivers: "x" }))).toMatchObject({
			code: "not_found",
		});
		expect(await refusal(update("v1", { after: "v9" }))).toMatchObject({
			code: "not_found",
		});
	});
});

describe("milestone_delete", () => {
	test("an empty milestone goes; later ones shift up", async () => {
		for (const name of ["v1", "v2", "v3"]) await add(name);
		const got = await board.milestoneDelete(inA, {
			actor: "main",
			milestone: "V2",
		});
		expect(got).toMatchObject({
			project: "A",
			deleted: "v2",
			chain: ["v1", "v3"],
		});
		expect(await logged(got.events)).toEqual([
			["milestone_deleted", { name: "v2" }],
		]);
		const v3 = await store.read((tx) =>
			tx.milestone.findFirstOrThrow({ where: { name: "v3" } }),
		);
		expect(v3.position).toBe(2);
	});

	test("one with tasks, cancelled ones included, is invalid_transition has_tasks", async () => {
		await add("v1");
		await board.taskAdd(inA, { actor: "main", title: "t", milestone: "v1" });
		await board.taskUpdate({ actor: "main", key: "A-1", status: "cancelled" });
		const error = await refusal(
			board.milestoneDelete(inA, { actor: "main", milestone: "v1" }),
		);
		expect(error).toMatchObject({
			code: "invalid_transition",
			details: { reason: "has_tasks" },
		});
		expect(error.next).toContain("board edit KEY --milestone none");
	});
});

test("the chain walked to done: current follows the earliest open milestone", async () => {
	for (const name of ["v1", "v2", "v3"]) await add(name);
	for (const name of ["v1", "v2", "v3"]) {
		await board.taskAdd(inA, { actor: "main", title: name, milestone: name });
	}
	await update("v3", { before: "v1" });
	expect((await board.taskNext(inA, {})).task?.title).toBe("v3");
	for (const key of ["A-3", "A-1", "A-2"]) {
		const next = await board.taskNext(inA, {});
		expect(next.task?.key).toBe(key);
		await board.taskUpdate({ actor: "main", key, status: "done" });
	}
	const done = await board.taskNext(inA, {});
	expect(done).toMatchObject({ task: null, milestone: null });
});

test("update and delete refuse the actor board and unknown milestones, changing nothing", async () => {
	await add("v1");
	const before = await store.read(async (tx) => ({
		milestones: await tx.milestone.findMany({ orderBy: { id: "asc" } }),
		events: await tx.event.count(),
	}));
	expect(
		await refusal(
			board.milestoneUpdate(inA, {
				actor: "board",
				milestone: "v1",
				delivers: "y",
			}),
		),
	).toMatchObject({ code: "invalid_argument", details: { field: "actor" } });
	expect(
		await refusal(
			board.milestoneDelete(inA, { actor: "board", milestone: "v1" }),
		),
	).toMatchObject({ code: "invalid_argument", details: { field: "actor" } });
	expect(
		await refusal(
			board.milestoneDelete(inA, { actor: "main", milestone: "v9" }),
		),
	).toMatchObject({
		code: "not_found",
		details: { what: "milestone", id: "v9" },
	});
	const after = await store.read(async (tx) => ({
		milestones: await tx.milestone.findMany({ orderBy: { id: "asc" } }),
		events: await tx.event.count(),
	}));
	expect(after).toEqual(before);
});
