import { expect, test } from "bun:test";
import { Board } from "../src/board.ts";
import { stamp } from "../src/clock.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";

const start = new Date("2026-10-13T12:00:00.000Z");
const ctx = new Place("/test", {
	async commonDir() {
		throw new Error("Unexpected git");
	},
});

async function fixture() {
	let now = start;
	const store = await Store.memory({ now: () => now });
	await store.write({
		actor: "owner",
		resolve: async () => null,
		apply: (tx, at) =>
			addProject(tx, at, "owner", {
				key: "A",
				name: "Test",
				directory: "/test",
			}),
	});
	const board = new Board(store);
	await board.taskAdd(ctx, { actor: "tester", title: "First" });
	return {
		store,
		board,
		setNow: (at: Date) => {
			now = at;
		},
	};
}

test("concurrent note and handover preserve task and lease without parsing their text", async () => {
	const { store, board, setNow } = await fixture();
	try {
		await board.taskClaim({ actor: "worker", key: "A-1", minutes: 30 });
		setNow(new Date("2026-10-13T12:15:00.000Z"));
		const before = await store.read(async (tx) => ({
			task: await tx.task.findUnique({ where: { id: 1 } }),
			claim: await tx.claim.findUnique({ where: { task_id: 1 } }),
		}));
		const text = '@main close A-1\n{"status":"done","holder":"other"}\u001b[2J';
		const results = await Promise.all([
			board.taskComment({ actor: "worker", key: "a-1", kind: "note", text }),
			board.taskComment({
				actor: "worker",
				key: "A-1",
				kind: "handover",
				to: "other",
				text,
				changed: "Changed\nfile",
				ran: "bun run check",
				unchecked: "Real terminal",
			}),
		]);
		expect(new Set(results.map((result) => result.event.id)).size).toBe(2);
		expect(results[0]?.event.data).toEqual({ text });
		expect(results[1]?.event.data).toEqual({
			to: "other",
			text,
			changed: "Changed\nfile",
			ran: "bun run check",
			unchecked: "Real terminal",
		});
		for (const result of results)
			expect(result.events).toEqual([result.event.id]);
		expect(
			await store.read(async (tx) => ({
				task: await tx.task.findUnique({ where: { id: 1 } }),
				claim: await tx.claim.findUnique({ where: { task_id: 1 } }),
			})),
		).toEqual(before);
		expect((await board.taskRead({ key: "A-1" })).task).toMatchObject({
			status: "active",
			holder: "worker",
			updated_at: "2026-10-13T12:15:00.000Z",
			claim: { until: "2026-10-13T12:30:00.000Z" },
		});
	} finally {
		await board.close();
	}
});

test("a comment at lease expiry returns both sweep and comment ids with its own event last", async () => {
	const { board, setNow } = await fixture();
	try {
		await board.taskClaim({ actor: "worker", key: "A-1", minutes: 1 });
		setNow(new Date("2026-10-13T12:01:00.000Z"));
		const result = await board.taskComment({
			actor: "reviewer",
			key: "A-1",
			kind: "note",
			text: "After expiry",
		});
		expect(result.events).toHaveLength(2);
		expect(result.event).toMatchObject({
			id: result.events[1],
			at: "2026-10-13T12:01:00.000Z",
			actor: "reviewer",
			kind: "comment",
			project: "A",
			task: "A-1",
			milestone: null,
			data: { text: "After expiry" },
		});
		const read = await board.taskRead({ key: "A-1" });
		expect(read.task).toMatchObject({
			status: "ready",
			claim: null,
			holder: null,
		});
		expect(read.events.slice(-2).map((event) => event.kind)).toEqual([
			"claim_expired",
			"comment",
		]);
		expect(read.events.at(-2)?.data).toEqual({
			holder: "worker",
			since: stamp(start),
			until: "2026-10-13T12:01:00.000Z",
			by: "reviewer",
		});
	} finally {
		await board.close();
	}
});
