import { afterEach, beforeEach, expect, test } from "bun:test";
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
		apply: (tx, now) =>
			addProject(tx, now, "owner", { key: "A", name: "a", directory: "/w/a" }),
	});
	await board.taskAdd(inA, { actor: "main", title: "one" });
});

afterEach(() => board.close());

test("a note is a comment event", async () => {
	const got = await board.taskComment({
		actor: "@lead",
		key: "a-1",
		kind: "note",
		text: "looked at it",
	});
	expect(got.event).toMatchObject({
		id: got.events[0],
		actor: "@lead",
		kind: "comment",
		project: "A",
		task: "A-1",
		milestone: null,
		data: { text: "looked at it" },
	});
});

test("a handover is an event and nothing more: no claim moves, no status changes", async () => {
	await board.taskClaim({
		actor: "main",
		key: "A-1",
		minutes: 30,
		holder: "@lead",
	});
	const got = await board.taskComment({
		actor: "@lead",
		key: "A-1",
		kind: "handover",
		to: "main",
		text: "please close it",
		changed: "src/x.ts",
		ran: "bun run check",
		unchecked: "nothing",
	});
	expect(got.event).toMatchObject({
		kind: "handover",
		data: {
			to: "main",
			text: "please close it",
			changed: "src/x.ts",
			ran: "bun run check",
			unchecked: "nothing",
		},
	});
	const read = await board.taskRead({ key: "A-1" });
	expect(read.task).toMatchObject({ status: "active", holder: "@lead" });
});

test("closed tasks take comments; unknown tasks and the actor board are refused", async () => {
	await board.taskUpdate({ actor: "main", key: "A-1", status: "done" });
	expect(
		(
			await board.taskComment({
				actor: "main",
				key: "A-1",
				kind: "note",
				text: "after",
			})
		).event.kind,
	).toBe("comment");
	expect(
		await refusal(
			board.taskComment({ actor: "main", key: "A-9", kind: "note", text: "x" }),
		),
	).toMatchObject({
		code: "not_found",
		details: { what: "task", id: "A-9" },
	});
	expect(
		await refusal(
			board.taskComment({
				actor: "board",
				key: "A-1",
				kind: "note",
				text: "x",
			}),
		),
	).toMatchObject({
		details: { field: "actor" },
	});
});
