import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Board } from "../src/board.ts";
import { stamp } from "../src/clock.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import type { GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { chain } from "../src/rules/milestones.ts";
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
			await addProject(tx, now, "owner", {
				key: "B",
				name: "b",
				directory: "/w/b",
			});
			for (const [name, position] of [
				["v1", 1],
				["v2", 2],
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
	for (const title of ["one", "two", "three", "four"]) {
		await board.taskAdd(inA, { actor: "main", title });
	}
	await board.taskAdd(new Place("/w/b", noGit), { actor: "main", title: "b" });
});

afterEach(() => board.close());

const update = (key: string, fields: Record<string, unknown>) =>
	board.taskUpdate({ actor: "main", key, ...fields });

const logged = (ids: number[]) =>
	store.read(async (tx) =>
		(
			await tx.event.findMany({
				where: { id: { in: ids } },
				orderBy: { id: "asc" },
			})
		).map((e) => [e.kind, JSON.parse(e.data)]),
	);

async function ask(taskId: number) {
	await store.write({
		actor: "test",
		resolve: async () => null,
		apply: (tx, now) =>
			tx.question.create({
				data: {
					task_id: taskId,
					text: "q",
					options: JSON.stringify([{ label: "a" }, { label: "b" }]),
					recommended: 1,
					asked_by: "x",
					asked_at: stamp(now),
				},
			}),
	});
}

describe("fields", () => {
	test("title, body, priority and parent in one task_edited, with changed", async () => {
		const got = await update("a-2", {
			title: "Two",
			body: "b",
			priority: "urgent",
			parent: "a-1",
		});
		expect(got.changed).toEqual(["title", "body", "priority", "parent"]);
		expect(got.task).toMatchObject({
			title: "Two",
			body: "b",
			priority: "urgent",
			parent: "A-1",
		});
		expect(await logged(got.events)).toEqual([
			[
				"task_edited",
				{
					title: { from: "two", to: "Two" },
					body: { from: "", to: "b" },
					priority: { from: "normal", to: "urgent" },
					parent: { from: null, to: "A-1" },
				},
			],
		]);
		const cleared = await update("A-2", { parent: null });
		expect(await logged(cleared.events)).toEqual([
			["task_edited", { parent: { from: "A-1", to: null } }],
		]);
	});

	test("an update that changes nothing writes nothing: changed [] and no events", async () => {
		const got = await update("A-1", {
			title: "one",
			priority: "normal",
			status: "ready",
			milestone: "none",
		});
		expect(got).toMatchObject({ changed: [], events: [] });
	});

	test("refusals: blank title, another project's keys, unknown keys, the actor board", async () => {
		expect(await refusal(update("A-1", { title: "  " }))).toMatchObject({
			details: { field: "title" },
		});
		expect(await refusal(update("A-1", { parent: "B-1" }))).toMatchObject({
			code: "invalid_argument",
			details: { field: "parent" },
		});
		expect(await refusal(update("A-1", { waits_add: ["B-1"] }))).toMatchObject({
			details: { field: "waits-add" },
		});
		expect(
			await refusal(update("A-1", { waits_remove: ["B-1"] })),
		).toMatchObject({
			details: { field: "waits-remove" },
		});
		expect(await refusal(update("A-1", { milestone: "v9" }))).toMatchObject({
			code: "not_found",
			details: { what: "milestone" },
		});
		expect(await refusal(update("A-9", { title: "x" }))).toMatchObject({
			details: { what: "task", id: "A-9" },
		});
		expect(
			await refusal(
				board.taskUpdate({ actor: "board", key: "A-1", title: "x" }),
			),
		).toMatchObject({
			details: { field: "actor" },
		});
	});
});

describe("waits", () => {
	test("added and removed, never replaced; no-ops change nothing", async () => {
		const added = await update("A-1", { waits_add: ["A-2", "a-3"] });
		expect(added.changed).toEqual(["waits"]);
		expect(added.task.waits.map((w) => w.key)).toEqual(["A-2", "A-3"]);
		expect(await logged(added.events)).toEqual([
			["waits_changed", { added: ["A-2", "A-3"], removed: [] }],
		]);
		const mixed = await update("A-1", {
			waits_add: ["A-2", "A-4"],
			waits_remove: ["A-3"],
		});
		expect(await logged(mixed.events)).toEqual([
			["waits_changed", { added: ["A-4"], removed: ["A-3"] }],
		]);
		const none = await update("A-1", {
			waits_add: ["A-2"],
			waits_remove: ["A-3"],
		});
		expect(none).toMatchObject({ changed: [], events: [] });
	});

	test("the same key in both lists, or the task itself, is invalid_argument", async () => {
		expect(
			await refusal(
				update("A-1", { waits_add: ["A-2"], waits_remove: ["a-2"] }),
			),
		).toMatchObject({
			code: "invalid_argument",
		});
		expect(await refusal(update("A-1", { waits_add: ["A-1"] }))).toMatchObject({
			code: "invalid_argument",
			details: { field: "waits-add" },
		});
		expect(
			await refusal(update("a-1", { waits_remove: ["A-1"] })),
		).toMatchObject({
			code: "invalid_argument",
			details: { field: "waits-remove" },
		});
	});

	test("a loop refused with other changes leaves the task and the log untouched", async () => {
		await update("A-1", { waits_add: ["A-2"] });
		const before = await store.read((tx) => tx.event.count());
		expect(
			(
				await refusal(
					update("A-2", {
						title: "renamed",
						waits_add: ["A-1"],
						parent: "A-3",
					}),
				)
			).code,
		).toBe("cycle");
		expect(await store.read((tx) => tx.event.count())).toBe(before);
		expect((await board.taskRead({ key: "A-2" })).task).toMatchObject({
			title: "two",
			parent: null,
			waits: [],
		});
	});

	test("a wait that closes a loop is cycle with the loop's keys", async () => {
		await update("A-1", { waits_add: ["A-2"] });
		await update("A-2", { waits_add: ["A-3"] });
		const error = await refusal(update("A-3", { waits_add: ["A-1"] }));
		expect(error).toMatchObject({
			code: "cycle",
			details: { path: ["A-3", "A-1", "A-2", "A-3"] },
		});
		expect((await board.taskRead({ key: "A-3" })).task.waits).toEqual([]);
	});

	test("a parent that closes a loop is cycle; so is a task its own parent", async () => {
		await update("A-2", { parent: "A-1" });
		await update("A-3", { parent: "A-2" });
		expect(await refusal(update("A-1", { parent: "A-3" }))).toMatchObject({
			code: "cycle",
			details: { path: ["A-1", "A-3", "A-2", "A-1"] },
		});
		expect(await refusal(update("A-1", { parent: "A-1" }))).toMatchObject({
			code: "cycle",
			details: { path: ["A-1", "A-1"] },
		});
		expect((await board.taskRead({ key: "A-1" })).task.parent).toBeNull();
	});
});

describe("status", () => {
	test("the transitions table; anything else is invalid_transition with allowed", async () => {
		const back = await update("A-1", { status: "backlog" });
		expect(await logged(back.events)).toEqual([
			["task_status", { from: "ready", to: "backlog" }],
		]);
		await update("A-1", { status: "ready" });
		await update("A-1", { status: "done" });
		expect(await refusal(update("A-1", { status: "cancelled" }))).toMatchObject(
			{
				code: "invalid_transition",
				details: {
					from: "done",
					to: "cancelled",
					allowed: ["backlog", "ready"],
				},
			},
		);
		const reopened = await update("A-1", { status: "backlog" });
		expect(reopened.task.status).toBe("backlog");
		await update("A-2", { status: "cancelled" });
		expect(await refusal(update("A-2", { status: "done" }))).toMatchObject({
			code: "invalid_transition",
		});
	});

	test("an active task sent back or closed loses its claim, whoever holds it", async () => {
		await board.taskClaim({
			actor: "main",
			key: "A-1",
			minutes: 30,
			holder: "@lead",
		});
		const back = await update("A-1", { status: "ready" });
		expect(back.task).toMatchObject({ status: "ready", claim: null });
		expect(await logged(back.events)).toEqual([
			["task_status", { from: "active", to: "ready" }],
			["claim_released", { holder: "@lead", reason: "sent_back", note: null }],
		]);
		await board.taskClaim({
			actor: "main",
			key: "A-1",
			minutes: 30,
			holder: "@lead",
		});
		const closed = await update("A-1", { status: "done" });
		expect((await logged(closed.events))[1]).toEqual([
			"claim_released",
			{ holder: "@lead", reason: "closed", note: null },
		]);
	});

	test("done is refused with an open question; cancelled withdraws it", async () => {
		await ask(1);
		expect(await refusal(update("A-1", { status: "done" }))).toMatchObject({
			code: "invalid_transition",
			details: { reason: "question" },
		});
		const cancelled = await update("A-1", { status: "cancelled" });
		expect(cancelled.task.questions[0]?.status).toBe("withdrawn");
		expect(await logged(cancelled.events)).toEqual([
			["task_status", { from: "ready", to: "cancelled" }],
			["question_withdrawn", { question: "Q1", why: "A-1 was cancelled" }],
		]);
	});
});

describe("milestones", () => {
	test("a move logs task_moved; closing the last task logs milestone_done", async () => {
		const moved = await update("A-1", { milestone: "V1" });
		expect(await logged(moved.events)).toEqual([
			["task_moved", { from: null, to: "v1" }],
		]);
		const done = await update("A-1", { status: "done" });
		expect(await logged(done.events)).toEqual([
			["task_status", { from: "ready", to: "done" }],
			["milestone_done", { name: "v1" }],
		]);
		expect(
			(await store.read((tx) => chain(tx, 1))).map((m) => m.status),
		).toEqual(["done", "current"]);
	});

	test("moving into, or reopening in, a done milestone reopens it", async () => {
		await update("A-1", { milestone: "v1", status: "done" });
		const into = await update("A-2", { milestone: "v1" });
		expect(await logged(into.events)).toEqual([
			["task_moved", { from: null, to: "v1" }],
			["milestone_reopened", { name: "v1", by: "A-2" }],
		]);
		const out = await update("A-2", { milestone: "none" });
		expect((await logged(out.events)).map(([kind]) => kind)).toEqual([
			"task_moved",
			"milestone_done",
		]);
		const reopened = await update("A-1", { status: "ready" });
		expect(await logged(reopened.events)).toEqual([
			["task_status", { from: "done", to: "ready" }],
			["milestone_reopened", { name: "v1", by: "A-1" }],
		]);
	});

	test("events come in the catalog's order", async () => {
		await update("A-1", { milestone: "v1", status: "done" });
		await board.taskClaim({ actor: "main", key: "A-2", minutes: 30 });
		await ask(2);
		const got = await update("A-2", {
			title: "Two",
			milestone: "v1",
			waits_add: ["A-3"],
			status: "cancelled",
		});
		expect((await logged(got.events)).map(([kind]) => kind)).toEqual([
			"task_edited",
			"task_moved",
			"waits_changed",
			"task_status",
			"claim_released",
			"question_withdrawn",
		]);
		expect(got.changed).toEqual(["title", "milestone", "waits", "status"]);
	});

	test("a refused update changes none of its rows", async () => {
		await update("A-1", { waits_add: ["A-2"] });
		expect(
			(
				await refusal(
					update("A-2", { title: "new", milestone: "v1", waits_add: ["A-1"] }),
				)
			).code,
		).toBe("cycle");
		const two = (await board.taskRead({ key: "A-2" })).task;
		expect(two).toMatchObject({ title: "two", milestone: null, waits: [] });
	});
});

test("a wait into a dense web of waits is checked in bounded time", async () => {
	const child = Bun.spawn(
		[process.execPath, `${import.meta.dir}/helpers/dense.ts`, "27"],
		{
			stdout: "pipe",
			stderr: "inherit",
			timeout: 10_000,
			killSignal: "SIGKILL",
		},
	);
	const out = await new Response(child.stdout).text();
	await child.exited;
	expect(child.signalCode).toBeNull();
	expect(out).toMatch(/^seeded\nwaits \d+ms\n$/);
}, 20_000);
