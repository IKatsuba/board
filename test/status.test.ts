import { afterEach, beforeEach, expect, test } from "bun:test";
import { Board } from "../src/board.ts";
import { stamp } from "../src/clock.ts";
import { Refusal } from "../src/errors.ts";
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

let clock: FakeClock;
let store: Store;
let board: Board;

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

test("an empty project", async () => {
	expect(await board.boardStatus(inA, {})).toEqual({
		project: {
			key: "A",
			name: "a",
			directory: "/w/a",
			created_at: "2026-10-12T09:00:00.000Z",
		},
		counts: {
			backlog: 0,
			ready: 0,
			active: 0,
			blocked: 0,
			done: 0,
			cancelled: 0,
		},
		milestones: [],
		current: null,
		claims: [],
		questions: { open: 0, to_validate: 0 },
		last_event: 1,
	});
});

test("counts by effective status, the chain, current, live claims soonest first, questions, last event", async () => {
	for (const name of ["v1", "v2"])
		await board.milestoneAdd(inA, { actor: "main", name, delivers: "x" });
	const add = (title: string, extra: Record<string, unknown> = {}) =>
		board.taskAdd(inA, { actor: "main", title, ...extra });
	await add("done", { milestone: "v1" });
	await add("left", { milestone: "v1" });
	await add("asked");
	await add("held long");
	await add("held short");
	await add("lapsed");
	await add("later", { status: "backlog" });
	await add("dropped");
	await board.taskUpdate({ actor: "main", key: "A-1", status: "done" });
	await board.taskUpdate({ actor: "main", key: "A-8", status: "cancelled" });
	await board.taskClaim({
		actor: "main",
		key: "A-4",
		minutes: 90,
		holder: "@long",
	});
	await board.taskClaim({
		actor: "main",
		key: "A-5",
		minutes: 30,
		holder: "@short",
		directory: "/w/wt",
		branch: "b",
	});
	await board.taskClaim({
		actor: "main",
		key: "A-6",
		minutes: 5,
		holder: "@gone",
	});
	await store.write({
		actor: "test",
		resolve: async () => null,
		apply: async (tx, now) => {
			const question = (task_id: number, extra: Record<string, unknown> = {}) =>
				tx.question.create({
					data: {
						task_id,
						text: "q",
						options: JSON.stringify([{ label: "a" }, { label: "b" }]),
						recommended: 1,
						asked_by: "x",
						asked_at: stamp(now),
						...extra,
					},
				});
			await question(3);
			const answered = {
				status: "answered",
				choice: 1,
				answered_by: "main",
				answered_at: stamp(now),
			};
			await question(2, { ...answered, answered_as: "delegate" });
			await question(2, { ...answered, answered_as: "owner" });
		},
	});
	await board.taskAdd(new Place("/w/b", noGit), {
		actor: "main",
		title: "elsewhere",
	});
	clock.advance(10);
	const status = await board.boardStatus(inA, {});
	expect(status.counts).toEqual({
		backlog: 1,
		ready: 2,
		active: 2,
		blocked: 1,
		done: 1,
		cancelled: 1,
	});
	expect(status.milestones.map((m) => [m.name, m.status, m.tasks])).toEqual([
		["v1", "current", { total: 2, done: 1, cancelled: 0, left: 1 }],
		["v2", "planned", { total: 0, done: 0, cancelled: 0, left: 0 }],
	]);
	expect(status.current).toEqual({ name: "v1", position: 1, of: 2, left: 1 });
	expect(
		status.claims.map((c) => [
			c.key,
			c.holder,
			c.minutes_left,
			c.directory,
			c.branch,
		]),
	).toEqual([
		["A-5", "@short", 20, "/w/wt", "b"],
		["A-4", "@long", 80, null, null],
	]);
	expect(status.questions).toEqual({ open: 1, to_validate: 1 });
	const lastA = await store.read((tx) =>
		tx.event.findFirstOrThrow({
			where: { project_id: 1 },
			orderBy: { id: "desc" },
		}),
	);
	expect(status.last_event).toBe(lastA.id);
	expect((await board.boardStatus(inA, { project: "b" })).project.key).toBe(
		"B",
	);
});

test("an unknown project is not_found; a cwd in no project is no_project; nothing is written", async () => {
	const codeOf = async (promise: Promise<unknown>) => {
		try {
			await promise;
		} catch (error) {
			if (error instanceof Refusal) return error.error;
			throw error;
		}
		throw new Error("expected a refusal");
	};
	const events = () => store.read((tx) => tx.event.count());
	const before = await events();
	expect(await codeOf(board.boardStatus(inA, { project: "zz" }))).toMatchObject(
		{
			code: "not_found",
			details: { what: "project", id: "ZZ" },
		},
	);
	const notARepo: GitRunner = {
		commonDir: async () => ({
			kind: "exit",
			code: 128,
			stdout: "",
			stderr: "fatal: not a git repository\n",
		}),
	};
	const nowhere = new Place("/elsewhere", notARepo);
	expect(await codeOf(board.boardStatus(nowhere, {}))).toMatchObject({
		code: "no_project",
		details: { cwd: "/elsewhere", git: "not_a_repo" },
	});
	expect(await events()).toBe(before);
});
