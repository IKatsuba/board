import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { SystemClock, stamp } from "../src/clock.ts";
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

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Refusal) return error.error;
		throw error;
	}
	throw new Error("Expected refusal");
}

test("lease bounds are inclusive and another actor may shorten a lease from now", async () => {
	const { board, setNow } = await fixture();
	try {
		const claimed = await board.taskClaim({
			actor: "owner",
			key: "A-1",
			minutes: 1440,
			holder: "worker",
			directory: "/unregistered",
			branch: "other",
		});
		expect(claimed.claim.until).toBe("2026-10-14T12:00:00.000Z");
		setNow(new Date("2026-10-13T12:05:00.000Z"));
		await board.taskAdd(ctx, { actor: "worker", title: "Other write" });
		expect((await board.taskRead({ key: "A-1" })).task.claim?.until).toBe(
			claimed.claim.until,
		);
		const extended = await board.taskExtend({
			actor: "someone-else",
			key: "a-1",
			holder: "worker",
			minutes: 1,
		});
		expect(extended.claim).toMatchObject({
			holder: "worker",
			since: stamp(start),
			until: "2026-10-13T12:06:00.000Z",
			directory: "/unregistered",
			branch: "other",
		});
		const released = await board.taskRelease({
			actor: "third-actor",
			key: "A-1",
			holder: "worker",
		});
		expect(released.released).toEqual(extended.claim);
		expect(released.task).toMatchObject({
			status: "ready",
			holder: null,
			ready: true,
		});
	} finally {
		await board.close();
	}
});

test("expired blocked claims are swept once even when retaking is refused", async () => {
	const { store, board, setNow } = await fixture();
	try {
		await board.taskClaim({ actor: "tester", key: "A-1", minutes: 1 });
		await store.write({
			actor: "seed",
			resolve: async () => null,
			apply: (tx, at) =>
				tx.question.create({
					data: {
						task_id: 1,
						text: "Question",
						options: '[{"label":"A"},{"label":"B"}]',
						recommended: 1,
						asked_by: "owner",
						asked_at: stamp(at),
					},
				}),
		});
		setNow(new Date("2026-10-13T12:01:00.000Z"));
		expect(
			await refusal(
				board.taskClaim({ actor: "replacement", key: "A-1", minutes: 1 }),
			),
		).toMatchObject({ code: "not_ready", details: { reason: "question" } });
		expect(
			await refusal(
				board.taskRelease({ actor: "owner", key: "A-1", holder: "tester" }),
			),
		).toMatchObject({ code: "not_claimed" });
		const read = await board.taskRead({ key: "A-1" });
		expect(read.task).toMatchObject({
			status: "blocked",
			holder: null,
			claim: null,
			ready: false,
		});
		expect(
			read.events.filter((event) => event.kind === "claim_expired"),
		).toMatchObject([
			{
				actor: "board",
				project: "A",
				data: {
					holder: "tester",
					by: "replacement",
					until: "2026-10-13T12:01:00.000Z",
				},
			},
		]);
		expect(await store.read((tx) => tx.claim.count())).toBe(0);
	} finally {
		await board.close();
	}
});

test("invalid claim and extend durations leave live lease and history unchanged", async () => {
	const { board } = await fixture();
	try {
		await board.taskClaim({ actor: "tester", key: "A-1", minutes: 10 });
		const before = await board.taskRead({ key: "A-1" });
		for (const minutes of [
			-1,
			0,
			1441,
			1.1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			for (const run of [
				() => board.taskClaim({ actor: "tester", key: "A-1", minutes }),
				() =>
					board.taskExtend({
						actor: "tester",
						key: "A-1",
						holder: "tester",
						minutes,
					}),
			])
				expect(await refusal(run())).toMatchObject({
					code: "invalid_argument",
					details: { field: "minutes" },
				});
		}
		expect(await board.taskRead({ key: "A-1" })).toEqual(before);
	} finally {
		await board.close();
	}
});

test("two Bun-spawned claim contenders have one winner and one committed claimed event", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice2-claim-race-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	const children: Array<
		ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
	> = [];
	try {
		await Store.create(env, SystemClock, "owner", (tx, at) =>
			addProject(tx, at, "owner", { key: "A", name: "Test", directory: dir }),
		);
		const board = new Board(await Store.open(env, SystemClock));
		try {
			await board.taskAdd(ctx, {
				actor: "owner",
				project: "A",
				title: "Contested",
			});
		} finally {
			await board.close();
		}
		const at = String(Date.now() + 500);
		for (const holder of ["first", "second"])
			children.push(
				Bun.spawn(
					[
						process.execPath,
						join(import.meta.dir, "helpers", "holder.ts"),
						"claim",
						env.file,
						"A-1",
						holder,
						at,
					],
					{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
				),
			);
		const results = await Promise.all(
			children.map(async (child) => ({
				code: await child.exited,
				out: (await new Response(child.stdout).text()).trim(),
				err: await new Response(child.stderr).text(),
			})),
		);
		expect(results.map((result) => result.code)).toEqual([0, 0]);
		expect(results.map((result) => result.err)).toEqual(["", ""]);
		expect(results.map((result) => result.out).sort()).toEqual([
			"claim_held",
			"claimed",
		]);
		const winner = ["first", "second"][
			results.findIndex((result) => result.out === "claimed")
		];
		const opened = await Store.open(env, SystemClock);
		const checked = new Board(opened);
		try {
			expect((await checked.taskRead({ key: "A-1" })).task).toMatchObject({
				status: "active",
				holder: winner,
			});
			expect(await opened.read((tx) => tx.claim.count())).toBe(1);
			const events = (await checked.taskRead({ key: "A-1" })).events;
			expect(events.map((event) => event.kind)).toEqual([
				"task_added",
				"claimed",
			]);
			expect(events[1]).toMatchObject({
				actor: winner,
				data: { holder: winner, directory: null, branch: null },
			});
		} finally {
			await checked.close();
		}
	} finally {
		for (const child of children) {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);
