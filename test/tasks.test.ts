import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { SystemClock, stamp } from "../src/clock.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import type { GitRun, GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { chain } from "../src/rules/milestones.ts";
import { addProject } from "../src/rules/projects.ts";
import { likePattern } from "../src/rules/tasks.ts";
import { Store } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";

const HOLDER = join(import.meta.dir, "helpers", "holder.ts");

class NoGit implements GitRunner {
	async commonDir(): Promise<GitRun> {
		throw new Error("git must not be asked");
	}
}

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
const at = (cwd: string): Place => new Place(cwd, new NoGit());
const inA = at("/w/a");

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
});

afterEach(() => board.close());

/** Writes rows the tools of later slices make, straight through a transaction. */
function seed(fn: Parameters<Store["write"]>[0]["apply"]) {
	return store.write({ actor: "test", resolve: async () => null, apply: fn });
}

const add = (title: string, extra: Record<string, unknown> = {}, ctx = inA) =>
	board.taskAdd(ctx, { actor: "main", title, ...extra });

async function milestone(name: string, position: number, project = 1) {
	await seed((tx, now) =>
		tx.milestone.create({
			data: {
				project_id: project,
				name,
				delivers: "x",
				position,
				created_at: stamp(now),
				created_by: "main",
			},
		}),
	);
}

async function claim(key: string, minutes: number) {
	await seed(async (tx, now) => {
		const number = Number(key.split("-")[1]);
		const task = await tx.task.update({
			where: { project_id_number: { project_id: 1, number } },
			data: { status: "active" },
		});
		await tx.claim.create({
			data: {
				task_id: task.id,
				holder: "@lead",
				since: stamp(now),
				until: stamp(new Date(now.getTime() + minutes * 60_000)),
				directory: "/w/a-wt",
				branch: "feat/x",
			},
		});
	});
}

async function ask(key: string) {
	await seed(async (tx, now) => {
		const number = Number(key.split("-")[1]);
		const task = await tx.task.findUniqueOrThrow({
			where: { project_id_number: { project_id: 1, number } },
		});
		await tx.question.create({
			data: {
				task_id: task.id,
				text: "which?",
				options: JSON.stringify([
					{ label: "a" },
					{ label: "b", detail: "the b" },
				]),
				recommended: 1,
				asked_by: "@lead",
				asked_at: stamp(now),
			},
		});
	});
}

async function setStatus(key: string, status: string) {
	await seed((tx) =>
		tx.task.update({
			where: {
				project_id_number: { project_id: 1, number: Number(key.split("-")[1]) },
			},
			data: { status },
		}),
	);
}

describe("task_add", () => {
	test("numbers per project, with the defaults and its event", async () => {
		const first = await add("one");
		expect(first.task).toMatchObject({
			key: "A-1",
			title: "one",
			status: "ready",
			priority: "normal",
			milestone: null,
			parent: null,
			holder: null,
			ready: true,
			body: "",
			created_by: "main",
			waits: [],
			waited_by: [],
			children: [],
			claim: null,
			questions: [],
			created_at: "2026-10-12T09:00:00.000Z",
			updated_at: "2026-10-12T09:00:00.000Z",
		});
		expect((await add("two")).task.key).toBe("A-2");
		expect((await add("other", {}, at("/w/b/src"))).task.key).toBe("B-1");
		expect((await add("three", { project: "a" }, at("/w/b"))).task.key).toBe(
			"A-3",
		);
		const read = await board.taskRead({ key: "a-1" });
		expect(read.events).toHaveLength(1);
		expect(read.events[0]).toMatchObject({
			id: first.events[0],
			actor: "main",
			kind: "task_added",
			project: "A",
			task: "A-1",
			milestone: null,
			data: {
				title: "one",
				body: "",
				status: "ready",
				priority: "normal",
				parent: null,
				milestone: null,
				waits: [],
			},
		});
	});

	test("a finding takes its parent's project and milestone; none says none", async () => {
		await milestone("v1", 1);
		const parent = await add("feature", {
			milestone: "V1",
			priority: "high",
			status: "backlog",
		});
		expect(parent.task).toMatchObject({
			milestone: "v1",
			priority: "high",
			status: "backlog",
		});
		const finding = await add("finding", { parent: "a-1" }, at("/w/b"));
		expect(finding.task).toMatchObject({
			key: "A-2",
			parent: "A-1",
			milestone: "v1",
		});
		const chore = await add("chore", { parent: "A-1", milestone: "none" });
		expect(chore.task.milestone).toBeNull();
		const read = await board.taskRead({ key: "A-1" });
		expect(read.task.children.map((c) => c.key)).toEqual(["A-2", "A-3"]);
	});

	test("waits are kept, and shown both ways", async () => {
		await add("base");
		const waiting = await add("waits", { waits: ["A-1"] });
		expect(waiting.task.waits).toEqual([
			{ key: "A-1", title: "base", status: "ready" },
		]);
		expect(waiting.task.ready).toBe(false);
		const base = await board.taskRead({ key: "A-1" });
		expect(base.task.waited_by.map((w) => w.key)).toEqual(["A-2"]);
		const read = await board.taskRead({ key: "A-2" });
		expect(read.events[0]?.data).toMatchObject({ waits: ["A-1"] });
	});

	test("the same wait in two cases is one wait", async () => {
		await add("base");
		const waiting = await add("waits", { waits: ["A-1", "a-1"] });
		expect(waiting.task.waits.map((w) => w.key)).toEqual(["A-1"]);
		const read = await board.taskRead({ key: "A-2" });
		expect(read.events[0]?.data).toMatchObject({ waits: ["A-1"] });
	});

	test("refusals: other projects, missing keys, a blank title, the actor board", async () => {
		await add("in b", {}, at("/w/b"));
		// From A's directory, a parent of B names B: the key wins over the cwd.
		expect((await add("finding", { parent: "B-1" })).task.key).toBe("B-2");
		expect(
			await refusal(add("x", { project: "A", parent: "B-1" })),
		).toMatchObject({
			code: "invalid_argument",
			details: { field: "parent" },
		});
		expect(await refusal(add("x", { waits: ["B-1"] }))).toMatchObject({
			code: "invalid_argument",
			details: { field: "waits" },
		});
		expect(await refusal(add("x", { parent: "A-9" }))).toMatchObject({
			code: "not_found",
			details: { what: "task", id: "A-9" },
		});
		expect(await refusal(add("x", { parent: "Z-1" }))).toMatchObject({
			code: "not_found",
			details: { what: "project", id: "Z" },
		});
		expect(await refusal(add("x", { milestone: "v9" }))).toMatchObject({
			code: "not_found",
			details: { what: "milestone", id: "v9" },
		});
		expect(await refusal(add("   "))).toMatchObject({
			details: { field: "title" },
		});
		expect(
			await refusal(board.taskAdd(inA, { actor: "board", title: "x" })),
		).toMatchObject({ details: { field: "actor" } });
		expect((await board.taskList(inA, {})).total).toBe(0);
	});

	test("a done milestone takes the task and reopens, becoming current again", async () => {
		await milestone("v1", 1);
		await milestone("v2", 2);
		await add("only", { milestone: "v1" });
		await setStatus("A-1", "done");
		await add("next", { milestone: "v2" });
		const before = await store.read((tx) => chain(tx, 1));
		expect(before.map((m) => m.status)).toEqual(["done", "current"]);
		const added = await add("late", { milestone: "v1" });
		expect(added.events).toHaveLength(2);
		const after = await store.read((tx) => chain(tx, 1));
		expect(after.map((m) => m.status)).toEqual(["current", "planned"]);
		const events = await store.read((tx) =>
			tx.event.findMany({
				where: { id: { in: added.events } },
				orderBy: { id: "asc" },
			}),
		);
		expect(
			events.map((e) => [e.kind, e.actor, e.milestone_id, JSON.parse(e.data)]),
		).toEqual([
			[
				"task_added",
				"main",
				null,
				expect.objectContaining({ milestone: "v1" }),
			],
			["milestone_reopened", "main", 1, { name: "v1", by: "A-3" }],
		]);
		const plain = await add("open one", { milestone: "v2" });
		expect(plain.events).toHaveLength(1);
	});

	test("an empty milestone is open, not done, and takes a task without a flip", async () => {
		await milestone("v1", 1);
		expect((await store.read((tx) => chain(tx, 1)))[0]?.status).toBe("current");
		expect((await add("first", { milestone: "v1" })).events).toHaveLength(1);
	});

	test("its answer lists the sweep's ids first, and a refusal keeps the sweep", async () => {
		await add("held");
		await claim("A-1", 10);
		clock.advance(20);
		expect((await refusal(add("x", { parent: "A-9" }))).code).toBe("not_found");
		const swept = await store.read((tx) =>
			tx.event.findMany({ where: { kind: "claim_expired" } }),
		);
		expect(swept).toHaveLength(1);
		await claim("A-1", 10);
		clock.advance(20);
		const added = await add("y");
		expect(added.events).toHaveLength(2);
		const kinds = await store.read((tx) =>
			tx.event.findMany({
				where: { id: { in: added.events } },
				orderBy: { id: "asc" },
			}),
		);
		expect(kinds.map((e) => e.kind)).toEqual(["claim_expired", "task_added"]);
	});

	test("two calls started together both land, with their own numbers", async () => {
		const [a, b] = await Promise.all([add("one"), add("two")]);
		expect([a.task.key, b.task.key].sort()).toEqual(["A-1", "A-2"]);
	});

	test("two calls started together: one refused, the other's write kept", async () => {
		const results = await Promise.allSettled([
			add("kept"),
			add("x", { parent: "A-9" }),
		]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
		expect((await board.taskList(inA, {})).tasks.map((t) => t.title)).toEqual([
			"kept",
		]);
	});
});

describe("effective status and readiness", () => {
	beforeEach(async () => {
		for (const title of ["one", "two", "three", "four"]) await add(title);
	});

	test("an open question blocks; a live claim is active with its holder", async () => {
		await ask("A-1");
		await claim("A-2", 30);
		const one = await board.taskRead({ key: "A-1" });
		expect(one.task).toMatchObject({ status: "blocked", ready: false });
		expect(one.task.questions).toEqual([
			{
				id: "Q1",
				key: "A-1",
				text: "which?",
				options: [
					{ label: "a", detail: null },
					{ label: "b", detail: "the b" },
				],
				recommended: 1,
				asked_by: "@lead",
				asked_at: "2026-10-12T09:00:00.000Z",
				status: "open",
				answer: null,
				validated: null,
			},
		]);
		clock.advance(10);
		const two = await board.taskRead({ key: "A-2" });
		expect(two.task).toMatchObject({
			status: "active",
			holder: "@lead",
			ready: false,
		});
		expect(two.task.claim).toEqual({
			key: "A-2",
			title: "two",
			holder: "@lead",
			since: "2026-10-12T09:00:00.000Z",
			until: "2026-10-12T09:30:00.000Z",
			minutes_left: 20,
			directory: "/w/a-wt",
			branch: "feat/x",
		});
	});

	test("an expired claim reads as gone at once, and is logged at the next write", async () => {
		await claim("A-2", 30);
		clock.advance(30);
		const two = await board.taskRead({ key: "A-2" });
		expect(two.task).toMatchObject({
			status: "ready",
			holder: null,
			claim: null,
			ready: true,
		});
		const listed = await board.taskList(inA, { status: ["ready"] });
		expect(listed.tasks.map((t) => t.key)).toContain("A-2");
		expect((await board.taskList(inA, { status: ["active"] })).total).toBe(0);
		expect(await store.read((tx) => tx.claim.count())).toBe(1);
		await add("five", {}, at("/w/b"));
		const expired = await store.read((tx) =>
			tx.event.findMany({ where: { kind: "claim_expired" } }),
		);
		expect(expired.map((e) => [e.project_id, e.actor])).toEqual([[1, "board"]]);
	});

	test("minutes_left rounds up", async () => {
		await claim("A-1", 30);
		clock.advance(29.5);
		expect(
			(await board.taskRead({ key: "A-1" })).task.claim?.minutes_left,
		).toBe(1);
	});

	test("a task is ready when everything it waits for is done or cancelled", async () => {
		const waiting = await add("waits", { waits: ["A-1", "A-2"] });
		expect(waiting.task.ready).toBe(false);
		await setStatus("A-1", "done");
		expect((await board.taskRead({ key: "A-5" })).task.ready).toBe(false);
		await setStatus("A-2", "cancelled");
		expect((await board.taskRead({ key: "A-5" })).task.ready).toBe(true);
		const ready = await board.taskList(inA, { ready: true });
		expect(ready.tasks.map((t) => t.key)).toEqual(["A-5", "A-4", "A-3"]);
	});

	test("filters are by effective status; the default is the open ones", async () => {
		await ask("A-1");
		await claim("A-2", 30);
		await setStatus("A-3", "done");
		await setStatus("A-4", "backlog");
		const keys = async (status?: string[]) =>
			(
				await board.taskList(
					inA,
					status === undefined ? {} : { status: status as never },
				)
			).tasks.map((t) => [t.key, t.status]);
		expect(await keys()).toEqual([
			["A-4", "backlog"],
			["A-2", "active"],
			["A-1", "blocked"],
		]);
		expect(await keys(["blocked"])).toEqual([["A-1", "blocked"]]);
		expect(await keys(["done", "backlog"])).toEqual([
			["A-4", "backlog"],
			["A-3", "done"],
		]);
		expect((await board.taskList(inA, { ready: true })).total).toBe(0);
	});
});

describe("task_list", () => {
	test("pages newest first, with total and next_offset", async () => {
		for (let i = 1; i <= 5; i++) await add(`t${i}`);
		const first = await board.taskList(inA, { limit: 2 });
		expect(first).toMatchObject({ project: "A", total: 5, next_offset: 2 });
		expect(first.tasks.map((t) => t.key)).toEqual(["A-5", "A-4"]);
		const last = await board.taskList(inA, { limit: 2, offset: 4 });
		expect(last.tasks.map((t) => t.key)).toEqual(["A-1"]);
		expect(last.next_offset).toBeNull();
	});

	test('"*" spans every project; there a milestone may only be "none"', async () => {
		await milestone("v1", 1);
		await add("a1", { milestone: "v1" });
		await add("b1", {}, at("/w/b"));
		const all = await board.taskList(at("/nowhere"), { project: "*" });
		expect(all.project).toBe("*");
		expect(all.tasks.map((t) => t.key)).toEqual(["B-1", "A-1"]);
		expect(
			(
				await board.taskList(at("/nowhere"), {
					project: "*",
					milestone: "NONE",
				})
			).tasks.map((t) => t.key),
		).toEqual(["B-1"]);
		expect(
			await refusal(board.taskList(inA, { project: "*", milestone: "v1" })),
		).toMatchObject({
			code: "invalid_argument",
			details: { field: "milestone" },
		});
		expect(
			(await board.taskList(inA, { milestone: "v1" })).tasks.map((t) => t.key),
		).toEqual(["A-1"]);
	});

	test("parent narrows, names the project, and refuses another project's", async () => {
		await add("feature");
		await add("finding", { parent: "A-1" });
		const children = await board.taskList(at("/w/b"), { parent: "A-1" });
		expect(children).toMatchObject({ project: "A", total: 1 });
		await add("unrelated");
		await add("in b", {}, at("/w/b"));
		await add("b finding", { parent: "B-1" }, at("/w/b"));
		const everywhere = await board.taskList(at("/nowhere"), {
			project: "*",
			parent: "a-1",
		});
		expect(everywhere).toMatchObject({ project: "*", total: 1 });
		expect(everywhere.tasks.map((t) => t.key)).toEqual(["A-2"]);
		expect(
			await refusal(board.taskList(inA, { project: "B", parent: "A-1" })),
		).toMatchObject({
			details: { field: "parent" },
		});
	});

	test("contains is plain text: no wildcard, ASCII-only case folding", async () => {
		const titles = [
			"50% done",
			"500 done",
			"a_b",
			"axb",
			"back\\slash",
			"backslash",
			"Lease ends",
			"Café",
			"ÉTÉ",
			"APP-12 claim-release",
		];
		for (const title of titles) await add(title);
		await add("body only", { body: "the lease is long" });
		const find = async (text: string) =>
			(await board.taskList(inA, { contains: text, status: ["ready"] })).tasks
				.map((t) => t.title)
				.sort();
		expect(await find("50%")).toEqual(["50% done"]);
		expect(await find("_")).toEqual(["a_b"]);
		expect(await find("\\")).toEqual(["back\\slash"]);
		expect(await find("lease")).toEqual([
			"APP-12 claim-release",
			"Lease ends",
			"body only",
		]);
		expect(await find("app-12")).toEqual(["APP-12 claim-release"]);
		expect(await find("cafe")).toEqual([]);
		expect(await find("été")).toEqual([]);
		expect(await find("Café")).toEqual(["Café"]);
	});

	test("many matches are counted and paged in SQL", async () => {
		await seed((tx) =>
			tx.$executeRawUnsafe(
				"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 33000) INSERT INTO task (project_id, number, title, created_at, created_by) SELECT 1, i, 'match ' || i, '2026-10-12T09:00:00.000Z', 'test' FROM n",
			),
		);
		const page = await board.taskList(inA, { contains: "match", limit: 1 });
		expect(page.total).toBe(33000);
		expect(page.tasks.map((t) => t.key)).toEqual(["A-33000"]);
		expect(page.next_offset).toBe(1);
	});

	test("the LIKE pattern escapes the backslash first", () => {
		expect(likePattern("a\\%_")).toBe("%a\\\\\\%\\_%");
	});
});

describe("task_read", () => {
	test("events after since, 200 a page, with a cursor", async () => {
		const added = await add("busy");
		await seed(async (tx, now) => {
			for (let i = 0; i < 250; i++) {
				await tx.event.create({
					data: {
						at: stamp(now),
						actor: "a",
						kind: "comment",
						project_id: 1,
						task_id: 1,
						data: JSON.stringify({ text: `${i}` }),
					},
				});
			}
		});
		const first = await board.taskRead({ key: "A-1" });
		expect(first.events).toHaveLength(200);
		expect(first.more).toBe(true);
		expect(first.cursor).toBe(first.events[199]?.id as number);
		const second = await board.taskRead({ key: "A-1", since: first.cursor });
		expect(second.events).toHaveLength(51);
		expect(second.more).toBe(false);
		const empty = await board.taskRead({ key: "A-1", since: second.cursor });
		expect(empty).toMatchObject({
			events: [],
			cursor: second.cursor,
			more: false,
		});
		expect(first.events[0]?.id).toBe(added.events[0] as number);
		expect(second.events.at(-1)?.data).toEqual({ text: "249" });
		expect(first.task.updated_at).toBe("2026-10-12T09:00:00.000Z");
	});

	test("a key past any task number is simply not found", async () => {
		await add("one");
		const huge = "a-999999999999999999999999999999";
		expect(await refusal(board.taskRead({ key: huge }))).toMatchObject({
			code: "not_found",
			details: { what: "task", id: "A-999999999999999999999999999999" },
		});
		expect(await refusal(add("x", { parent: huge }))).toMatchObject({
			code: "not_found",
			details: { what: "task" },
		});
		expect(await refusal(board.taskList(inA, { parent: huge }))).toMatchObject({
			code: "not_found",
		});
	});

	test("a since past every id is an empty page; so is an offset past every match", async () => {
		await add("one");
		expect(await board.taskRead({ key: "A-1", since: 1e30 })).toMatchObject({
			events: [],
			cursor: 1e30,
			more: false,
		});
		expect(await board.taskList(inA, { offset: 1e30 })).toMatchObject({
			tasks: [],
			total: 1,
			next_offset: null,
		});
		expect(await board.taskList(inA, { offset: 1 })).toMatchObject({
			tasks: [],
			total: 1,
			next_offset: null,
		});
	});

	test("an unknown task or project is not_found", async () => {
		expect(await refusal(board.taskRead({ key: "A-1" }))).toMatchObject({
			code: "not_found",
			details: { what: "task", id: "A-1" },
		});
		expect(await refusal(board.taskRead({ key: "Q-1" }))).toMatchObject({
			details: { what: "project", id: "Q" },
		});
	});
});

describe("on a file", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "board-tasks-"));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("numbers stay unique under two writing processes in one project", async () => {
		const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
		const runner: GitRunner = {
			commonDir: async () => ({
				kind: "exit",
				code: 128,
				stdout: "",
				stderr: "fatal: not a git repository\n",
			}),
		};
		await projectAdd(env, SystemClock, runner, dir, {
			actor: "owner",
			key: "A",
		});
		const children = ["one", "two"].map((actor) =>
			Bun.spawn([process.execPath, HOLDER, "tasks", env.file, actor, "20"], {
				stdout: "pipe",
				stderr: "inherit",
			}),
		);
		await Promise.all(children.map((c) => c.exited));
		const opened = await Store.open(env, SystemClock);
		const list = await new Board(opened).taskList(at(dir), {
			project: "A",
			limit: 200,
		});
		expect(list.total).toBe(40);
		expect(new Set(list.tasks.map((t) => t.key)).size).toBe(40);
		await opened.close();
	});
});
