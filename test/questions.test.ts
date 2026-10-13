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
const inB: Place = new Place("/w/b", noGit);

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
	await board.taskAdd(inA, { actor: "main", title: "one" });
	await board.taskAdd(inA, { actor: "main", title: "two" });
	await board.taskAdd(inB, { actor: "main", title: "b one" });
});

afterEach(() => board.close());

const options = [
	{ label: "up to 8", detail: "the limit" },
	{ label: "no limit" },
];
const ask = (key: string, extra: Record<string, unknown> = {}) =>
	board.questionAsk({
		actor: "@lead",
		key,
		text: "How many at once?",
		options,
		recommended: 1,
		...extra,
	});
const answer = (question: string, extra: Record<string, unknown>) =>
	board.questionAnswer({
		actor: "main",
		question,
		as: "delegate",
		...extra,
	} as never);

const logged = (ids: number[]) =>
	store.read(async (tx) =>
		(
			await tx.event.findMany({
				where: { id: { in: ids } },
				orderBy: { id: "asc" },
			})
		).map((e) => [e.kind, e.task_id, JSON.parse(e.data)]),
	);

describe("question_ask", () => {
	test("asks with options and a recommendation; the task is blocked", async () => {
		const got = await ask("a-1");
		expect(got.question).toEqual({
			id: "Q1",
			key: "A-1",
			text: "How many at once?",
			options: [
				{ label: "up to 8", detail: "the limit" },
				{ label: "no limit", detail: null },
			],
			recommended: 1,
			asked_by: "@lead",
			asked_at: "2026-10-12T09:00:00.000Z",
			status: "open",
			answer: null,
			validated: null,
		});
		expect(got.task).toMatchObject({
			key: "A-1",
			status: "blocked",
			ready: false,
		});
		expect(await logged(got.events)).toEqual([
			[
				"question_asked",
				1,
				{
					question: "Q1",
					text: "How many at once?",
					options: got.question.options,
					recommended: 1,
				},
			],
		]);
		expect((await ask("B-1")).question.id).toBe("Q2");
	});

	test("refusals: recommended past the options, options out of 2–6, a closed task, unknown task, actor board", async () => {
		expect(await refusal(ask("A-1", { recommended: 3 }))).toMatchObject({
			code: "invalid_argument",
			details: { field: "recommended" },
		});
		expect(
			await refusal(ask("A-1", { options: [{ label: "x" }] })),
		).toMatchObject({
			details: { field: "options" },
		});
		await board.taskUpdate({ actor: "main", key: "A-2", status: "done" });
		expect(await refusal(ask("A-2"))).toMatchObject({
			code: "invalid_transition",
			details: { reason: "closed" },
		});
		expect(await refusal(ask("A-9"))).toMatchObject({
			code: "not_found",
			details: { what: "task" },
		});
		expect(
			await refusal(
				board.questionAsk({
					actor: "board",
					key: "A-1",
					text: "x",
					options,
					recommended: 1,
				}),
			),
		).toMatchObject({
			details: { field: "actor" },
		});
		expect(await store.read((tx) => tx.question.count())).toBe(0);
	});
});

describe("question_answer and question_validate", () => {
	beforeEach(async () => {
		await ask("A-1");
	});

	test("a delegate's answer unblocks the task and waits to be validated", async () => {
		clock.advance(5);
		const got = await answer("q1", { choice: 1, text: "eight" });
		expect(got.question).toMatchObject({
			status: "answered",
			answer: {
				choice: 1,
				text: "eight",
				by: "main",
				as: "delegate",
				at: "2026-10-12T09:05:00.000Z",
			},
			validated: null,
		});
		expect(got.task).toMatchObject({ status: "ready", ready: true });
		expect(await logged(got.events)).toEqual([
			[
				"question_answered",
				1,
				{
					question: "Q1",
					choice: 1,
					text: "eight",
					as: "delegate",
					overrides: null,
				},
			],
		]);
		const listed = await board.questionList(inA, { state: "to_validate" });
		expect(listed.questions.map((q) => q.id)).toEqual(["Q1"]);
		const validated = await board.questionValidate({
			actor: "owner",
			question: "Q1",
		});
		expect(validated.question.validated).toEqual({
			by: "owner",
			at: "2026-10-12T09:05:00.000Z",
		});
		expect(await logged(validated.events)).toEqual([
			["question_validated", 1, { question: "Q1" }],
		]);
		expect(
			(await board.questionList(inA, { state: "to_validate" })).questions,
		).toEqual([]);
	});

	test("the owner's answer over an unvalidated delegate's replaces it, with overrides", async () => {
		await answer("Q1", { choice: 1 });
		clock.advance(1);
		const got = await answer("Q1", {
			as: "owner",
			text: "no limit after all",
			choice: 2,
		});
		expect(got.question).toMatchObject({
			answer: { choice: 2, as: "owner", by: "main" },
			validated: null,
		});
		expect(await logged(got.events)).toEqual([
			[
				"question_answered",
				1,
				{
					question: "Q1",
					choice: 2,
					text: "no limit after all",
					as: "owner",
					overrides: {
						choice: 1,
						text: null,
						by: "main",
						as: "delegate",
						at: "2026-10-12T09:00:00.000Z",
					},
				},
			],
		]);
		expect(
			(await board.questionList(inA, { state: "to_validate" })).questions,
		).toEqual([]);
	});

	test("already_answered: an owner's answer, a validated delegate's, a delegate again", async () => {
		await answer("Q1", { choice: 1 });
		expect(await refusal(answer("Q1", { choice: 2 }))).toMatchObject({
			code: "already_answered",
			details: { question: { id: "Q1" } },
		});
		await board.questionValidate({ actor: "owner", question: "Q1" });
		expect((await refusal(answer("Q1", { as: "owner", choice: 2 }))).code).toBe(
			"already_answered",
		);
		await ask("A-2");
		await answer("Q2", { as: "owner", choice: 1 });
		expect((await refusal(answer("Q2", { as: "owner", choice: 2 }))).code).toBe(
			"already_answered",
		);
	});

	test("refusals: choice past the options, no choice nor text, a withdrawn question, unknown ids", async () => {
		expect(await refusal(answer("Q1", { choice: 3 }))).toMatchObject({
			code: "invalid_argument",
			details: { field: "N" },
		});
		expect(await refusal(answer("Q1", {}))).toMatchObject({
			code: "invalid_argument",
		});
		await board.taskUpdate({ actor: "main", key: "A-1", status: "cancelled" });
		expect(await refusal(answer("Q1", { choice: 1 }))).toMatchObject({
			code: "invalid_transition",
			details: { reason: "withdrawn" },
		});
		expect(await refusal(answer("Q9", { choice: 1 }))).toMatchObject({
			code: "not_found",
			details: { what: "question", id: "Q9" },
		});
		expect(
			(await refusal(answer("q99999999999999999999999", { choice: 1 }))).code,
		).toBe("not_found");
	});

	test("validate refuses an open, owner-answered, withdrawn or already validated question", async () => {
		const reasons = [];
		reasons.push(
			(
				await refusal(
					board.questionValidate({ actor: "owner", question: "Q1" }),
				)
			).details,
		);
		await answer("Q1", { as: "owner", choice: 1 });
		reasons.push(
			(
				await refusal(
					board.questionValidate({ actor: "owner", question: "Q1" }),
				)
			).details,
		);
		await ask("A-2");
		await answer("Q2", { choice: 1 });
		await board.questionValidate({ actor: "owner", question: "Q2" });
		reasons.push(
			(
				await refusal(
					board.questionValidate({ actor: "owner", question: "Q2" }),
				)
			).details,
		);
		await ask("A-2");
		await board.taskUpdate({ actor: "main", key: "A-2", status: "cancelled" });
		reasons.push(
			(
				await refusal(
					board.questionValidate({ actor: "owner", question: "Q3" }),
				)
			).details,
		);
		expect(reasons.map((d) => (d as { reason: string }).reason)).toEqual([
			"open",
			"owner",
			"validated",
			"withdrawn",
		]);
	});
});

describe("question_list", () => {
	test("by state, oldest first; key narrows and names the project; * spans every project", async () => {
		await ask("A-1");
		await ask("B-1");
		await ask("A-2");
		await answer("Q3", { choice: 1 });
		const ids = async (ctx: Place, input: Record<string, unknown>) =>
			(await board.questionList(ctx, input)).questions.map((q) => q.id);
		expect(await ids(inA, {})).toEqual(["Q1"]);
		expect(await ids(inA, { state: "all" })).toEqual(["Q1", "Q3"]);
		expect(await ids(inA, { state: "answered" })).toEqual(["Q3"]);
		expect(await ids(inA, { project: "*", state: "all" })).toEqual([
			"Q1",
			"Q2",
			"Q3",
		]);
		expect((await board.questionList(inA, { project: "*" })).project).toBe("*");
		expect(await ids(inB, { key: "a-2", state: "all" })).toEqual(["Q3"]);
		expect((await board.questionList(inB, { key: "A-2" })).project).toBe("A");
		expect(await ids(inA, { project: "*", key: "B-1" })).toEqual(["Q2"]);
	});

	test("refusals: a key of another project than `project`, an unknown key", async () => {
		expect(
			await refusal(board.questionList(inA, { project: "B", key: "A-1" })),
		).toMatchObject({
			code: "invalid_argument",
			details: { field: "task" },
		});
		expect(
			await refusal(board.questionList(inA, { key: "A-9" })),
		).toMatchObject({ code: "not_found" });
	});
});

test("the slice's path: a question blocks, a delegate's answer waits, the owner overrides, another is validated", async () => {
	await ask("A-1");
	expect((await board.taskRead({ key: "A-1" })).task.status).toBe("blocked");
	await answer("Q1", { choice: 1 });
	expect((await board.taskRead({ key: "A-1" })).task.status).toBe("ready");
	expect(
		(await board.questionList(inA, { state: "to_validate" })).questions,
	).toHaveLength(1);
	await answer("Q1", { as: "owner", choice: 2 });
	await ask("A-2");
	await answer("Q2", { choice: 1 });
	await board.questionValidate({ actor: "owner", question: "Q2" });
	expect(
		(await board.questionList(inA, { state: "to_validate" })).questions,
	).toEqual([]);
	expect((await board.boardStatus(inA, {})).questions).toEqual({
		open: 0,
		to_validate: 0,
	});
});

test("answer and validate refuse the actor board and unknown ids, changing nothing", async () => {
	await ask("A-1");
	await answer("Q1", { choice: 1 });
	const snapshot = () =>
		store.read(async (tx) => ({
			questions: await tx.question.findMany({ orderBy: { id: "asc" } }),
			events: await tx.event.count(),
		}));
	const before = await snapshot();
	expect(
		await refusal(
			board.questionAnswer({
				actor: "board",
				question: "Q1",
				as: "owner",
				choice: 2,
			}),
		),
	).toMatchObject({ code: "invalid_argument", details: { field: "actor" } });
	expect(
		await refusal(board.questionValidate({ actor: "board", question: "Q1" })),
	).toMatchObject({
		code: "invalid_argument",
		details: { field: "actor" },
	});
	expect(
		await refusal(board.questionValidate({ actor: "owner", question: "Q9" })),
	).toMatchObject({
		code: "not_found",
		details: { what: "question", id: "Q9" },
	});
	expect(await snapshot()).toEqual(before);
});

test("a task stays blocked until its last open question is answered", async () => {
	await ask("A-1");
	await ask("A-1");
	const first = await answer("Q1", { choice: 1 });
	expect(first.task).toMatchObject({ key: "A-1", status: "blocked" });
	const last = await answer("Q2", { choice: 2 });
	expect(last.task).toMatchObject({ key: "A-1", status: "ready", ready: true });
});
