import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { SystemClock, stamp } from "../src/clock.ts";
import { Refusal } from "../src/errors.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";

const now = new Date("2026-10-13T12:00:00.000Z");
const ctx = new Place("/test", {
	async commonDir() {
		throw new Error("Unexpected git");
	},
});

async function fixture() {
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
	for (const title of ["First", "Second", "Third", "Fourth"])
		await board.taskAdd(ctx, { actor: "tester", title });
	return { store, board };
}

test("cancel withdraws all open questions, preserves answers and logs the full ordered change", async () => {
	const { store, board } = await fixture();
	try {
		await store.write({
			actor: "seed",
			resolve: async () => null,
			apply: async (tx) => {
				for (const [id, name] of [
					[1, "v1"],
					[2, "v2"],
				] as const)
					await tx.milestone.create({
						data: {
							id,
							project_id: 1,
							name,
							delivers: "Fixture",
							position: id,
							created_at: stamp(now),
							created_by: "owner",
						},
					});
				await tx.task.update({ where: { id: 1 }, data: { milestone_id: 1 } });
				await tx.task.update({
					where: { id: 2 },
					data: { milestone_id: 1, status: "done" },
				});
				await tx.task.update({
					where: { id: 3 },
					data: { milestone_id: 2, status: "done" },
				});
				for (let id = 1; id <= 3; id++)
					await tx.question.create({
						data: {
							id,
							task_id: 1,
							text: `Question ${id}`,
							options: '[{"label":"A"},{"label":"B"}]',
							recommended: 1,
							asked_by: "tester",
							asked_at: stamp(now),
							...(id === 3
								? {
										status: "answered",
										choice: 1,
										answered_by: "owner",
										answered_at: stamp(now),
										answered_as: "owner",
									}
								: {}),
						},
					});
			},
		});
		// A held claim with open questions is seeded, since claim refuses blocked tasks.
		await store.write({
			actor: "seed",
			resolve: async () => null,
			apply: async (tx) => {
				await tx.task.update({ where: { id: 1 }, data: { status: "active" } });
				await tx.claim.create({
					data: {
						task_id: 1,
						holder: "worker",
						since: stamp(now),
						until: "2026-10-13T13:00:00.000Z",
					},
				});
			},
		});
		const changed = await board.taskUpdate({
			actor: "main",
			key: "A-1",
			title: "Revised",
			body: "New body",
			priority: "high",
			parent: "A-4",
			milestone: "v2",
			waits_add: ["A-4"],
			status: "cancelled",
		});
		expect(changed.changed).toEqual([
			"title",
			"body",
			"priority",
			"parent",
			"milestone",
			"waits",
			"status",
		]);
		expect(changed.task).toMatchObject({
			status: "cancelled",
			claim: null,
			holder: null,
			milestone: "v2",
			parent: "A-4",
		});
		expect(changed.task.questions.map((question) => question.status)).toEqual([
			"withdrawn",
			"withdrawn",
			"answered",
		]);
		expect(changed.task.questions[2]?.answer).toMatchObject({
			choice: 1,
			by: "owner",
			as: "owner",
		});
		const events = await store.read((tx) =>
			tx.event.findMany({
				where: { id: { in: changed.events } },
				orderBy: { id: "asc" },
			}),
		);
		expect(events.map((event) => event.kind)).toEqual([
			"task_edited",
			"task_moved",
			"waits_changed",
			"task_status",
			"claim_released",
			"question_withdrawn",
			"question_withdrawn",
			"milestone_done",
		]);
		expect(events.every((event) => event.actor === "main")).toBe(true);
		expect(events.at(-1)).toMatchObject({
			task_id: null,
			milestone_id: 1,
			data: '{"name":"v1"}',
		});
	} finally {
		await board.close();
	}
});

test("a combined parent/wait cycle refusal preserves complete task and event state", async () => {
	const { board } = await fixture();
	try {
		await board.taskUpdate({ actor: "tester", key: "A-2", parent: "A-1" });
		await board.taskUpdate({ actor: "tester", key: "A-3", parent: "A-2" });
		const before = await board.taskRead({ key: "A-1" });
		try {
			await board.taskUpdate({
				actor: "tester",
				key: "A-1",
				title: "Lost",
				body: "Lost",
				priority: "urgent",
				parent: "A-3",
				waits_add: ["A-4"],
				status: "done",
			});
			throw new Error("Expected cycle refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(Refusal);
			if (!(error instanceof Refusal)) throw error;
			expect(error.error).toMatchObject({
				code: "cycle",
				details: { path: ["A-1", "A-3", "A-2", "A-1"] },
			});
		}
		expect(await board.taskRead({ key: "A-1" })).toEqual(before);
	} finally {
		await board.close();
	}
});

test("independent writers add different waits without losing either edit", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice2-wait-writers-");
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
			for (const title of ["Target", "Dependency 1", "Dependency 2"])
				await board.taskAdd(ctx, { actor: "owner", project: "A", title });
		} finally {
			await board.close();
		}
		const script = join(dir, "writer.ts");
		writeFileSync(
			script,
			`import { Board } from ${JSON.stringify(join(import.meta.dir, "..", "src", "board.ts"))};\nimport { Store } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store", "store.ts"))};\nimport { SystemClock } from ${JSON.stringify(join(import.meta.dir, "..", "src", "clock.ts"))};\nconst [file, wait, at] = process.argv.slice(2);\nconst board = new Board(await Store.open({dir:"", file, boardDirSet:true}, SystemClock));\ntry { await Bun.sleep(Math.max(0, Number(at) - Date.now())); await board.taskUpdate({actor:wait,key:"A-1",waits_add:[wait]}); } finally { await board.close(); }\n`,
		);
		const at = String(Date.now() + 500);
		for (const wait of ["A-2", "A-3"])
			children.push(
				Bun.spawn([process.execPath, script, env.file, wait, at], {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
		const results = await Promise.all(
			children.map(async (child) => ({
				code: await child.exited,
				err: await new Response(child.stderr).text(),
			})),
		);
		expect(results).toEqual([
			{ code: 0, err: "" },
			{ code: 0, err: "" },
		]);
		const opened = new Board(await Store.open(env, SystemClock));
		try {
			const read = await opened.taskRead({ key: "A-1" });
			expect(read.task.waits.map((task) => task.key)).toEqual(["A-2", "A-3"]);
			const changes = read.events.filter(
				(event) => event.kind === "waits_changed",
			);
			expect(changes).toHaveLength(2);
			expect(
				changes.map((event) => (event.data.added as string[])[0]).sort(),
			).toEqual(["A-2", "A-3"]);
		} finally {
			await opened.close();
		}
	} finally {
		for (const child of children) {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);
