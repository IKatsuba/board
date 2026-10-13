import { expect, test } from "bun:test";
import { Board } from "../src/board.ts";
import { stamp } from "../src/clock.ts";
import { Refusal } from "../src/errors.ts";
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
	return {
		store,
		board: new Board(store),
		setNow: (at: Date) => {
			now = at;
		},
	};
}

test("concurrent next reads return the same expired task without claiming, sweeping or logging", async () => {
	const { store, board, setNow } = await fixture();
	try {
		await board.taskAdd(ctx, {
			actor: "tester",
			title: "Expired",
			priority: "urgent",
		});
		await board.taskClaim({ actor: "old", key: "A-1", minutes: 1 });
		const events = await store.read((tx) => tx.event.count());
		setNow(new Date("2026-10-13T12:01:00.000Z"));
		const [first, second] = await Promise.all([
			board.taskNext(ctx, {}),
			board.taskNext(ctx, {}),
		]);
		expect(first).toEqual(second);
		expect(first).toMatchObject({
			task: { key: "A-1", status: "ready", holder: null, ready: true },
			from: "unassigned",
			milestone: null,
			waiting: { blocked: 0, active: 0, waits_open: 0 },
		});
		expect(await store.read((tx) => tx.claim.count())).toBe(1);
		expect(await store.read((tx) => tx.event.count())).toBe(events);
		const claimed = await board.taskClaim({
			actor: "new",
			key: "A-1",
			minutes: 1,
		});
		expect(claimed.events).toHaveLength(2);
		await expect(
			board.taskClaim({ actor: "other", key: "A-1", minutes: 1 }),
		).rejects.toBeInstanceOf(Refusal);
	} finally {
		await board.close();
	}
});

test("explicit empty and done milestones never fall back to ready unassigned work", async () => {
	const { store, board } = await fixture();
	try {
		await store.write({
			actor: "seed",
			resolve: async () => null,
			apply: async (tx) => {
				for (const [id, name] of [
					[1, "empty"],
					[2, "finished"],
				] as const)
					await tx.milestone.create({
						data: {
							id,
							project_id: 1,
							name,
							position: id,
							delivers: "Fixture",
							created_at: stamp(start),
							created_by: "owner",
						},
					});
			},
		});
		await board.taskAdd(ctx, {
			actor: "tester",
			title: "Done",
			milestone: "finished",
		});
		await board.taskUpdate({ actor: "tester", key: "A-1", status: "done" });
		await board.taskAdd(ctx, {
			actor: "tester",
			title: "Ready",
			priority: "urgent",
		});
		expect(await board.taskNext(ctx, {})).toMatchObject({
			task: { key: "A-2" },
			from: "unassigned",
			milestone: { name: "empty", position: 1, of: 2, left: 0 },
		});
		for (const [milestone, position] of [
			["EMPTY", 1],
			["finished", 2],
		] as const)
			expect(await board.taskNext(ctx, { milestone })).toEqual({
				project: "A",
				task: null,
				from: null,
				milestone: { name: milestone.toLowerCase(), position, of: 2, left: 0 },
				waiting: { blocked: 0, active: 0, waits_open: 0 },
			});
	} finally {
		await board.close();
	}
});
