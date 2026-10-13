import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { SystemClock, stamp } from "../src/clock.ts";
import { Refusal } from "../src/errors.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";

const date = new Date("2026-10-13T12:00:00.000Z");
const ctx: Place = new Place("/test", {
	async commonDir() {
		throw new Error("Unexpected git");
	},
});

async function fixture() {
	let now = date;
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

test("contains binds punctuation literally and does not normalize Unicode", async () => {
	const { board } = await fixture();
	try {
		for (const title of ["Café", "Cafe\u0301", "plain", "a\\%_b", "aZZb"])
			await board.taskAdd(ctx, { actor: "tester", title });
		await board.taskAdd(ctx, {
			actor: "tester",
			title: "Body match",
			body: "x' OR 1=1 -- a\\%_b",
		});
		const find = async (contains: string) =>
			(await board.taskList(ctx, { contains })).tasks.map((task) => task.title);
		expect(await find("a\\%_b")).toEqual(["Body match", "a\\%_b"]);
		expect(await find("' OR 1=1 --")).toEqual(["Body match"]);
		expect(await find("Café")).toEqual(["Café"]);
		expect(await find("Cafe\u0301")).toEqual(["Cafe\u0301"]);
	} finally {
		await board.close();
	}
});

test("task ordering follows row ids and updated_at follows the latest event id", async () => {
	const { store, board, setNow } = await fixture();
	try {
		await board.taskAdd(ctx, { actor: "tester", title: "First" });
		setNow(new Date("2026-10-12T12:00:00.000Z"));
		await board.taskAdd(ctx, { actor: "tester", title: "Second" });
		expect(
			(await board.taskList(ctx, {})).tasks.map((task) => task.key),
		).toEqual(["A-2", "A-1"]);
		await store.write({
			actor: "tester",
			resolve: async () => null,
			apply: (tx, now) =>
				tx.event.create({
					data: {
						at: stamp(now),
						actor: "tester",
						kind: "comment",
						project_id: 1,
						task_id: 1,
						data: '{"text":"clock moved"}',
					},
				}),
		});
		expect((await board.taskRead({ key: "A-1" })).task.updated_at).toBe(
			"2026-10-12T12:00:00.000Z",
		);
	} finally {
		await board.close();
	}
});

test("exactly 200 task events is the final page, excluding another task's events", async () => {
	const { store, board } = await fixture();
	try {
		const first = await board.taskAdd(ctx, { actor: "tester", title: "Paged" });
		await board.taskAdd(ctx, { actor: "tester", title: "Other" });
		await store.write({
			actor: "tester",
			resolve: async () => null,
			apply: async (tx) => {
				for (let i = 0; i < 199; i++)
					await tx.event.create({
						data: {
							at: stamp(date),
							actor: "tester",
							kind: "comment",
							project_id: 1,
							task_id: 1,
							data: JSON.stringify({ text: `${i}` }),
						},
					});
			},
		});
		const page = await board.taskRead({ key: "A-1" });
		expect(page.events).toHaveLength(200);
		expect(page.more).toBe(false);
		expect(page.events.every((event) => event.task === "A-1")).toBe(true);
		expect(page.events[0]?.id).toBe(first.events[0]);
		expect(
			await board.taskRead({ key: "A-1", since: page.cursor }),
		).toMatchObject({ events: [], cursor: page.cursor, more: false });
	} finally {
		await board.close();
	}
});

test("two writer processes allocate contiguous keys with exactly one event per task", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice1-numbering-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	const children: Array<
		ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
	> = [];
	try {
		await Store.create(env, SystemClock, "owner", (tx, at) =>
			addProject(tx, at, "owner", { key: "A", name: "Test", directory: dir }),
		);
		const store = await Store.open(env, SystemClock);
		try {
			await expect(
				new Board(store).taskAdd(ctx, {
					actor: "tester",
					project: "A",
					title: " ",
				}),
			).rejects.toBeInstanceOf(Refusal);
		} finally {
			await store.close();
		}
		for (const actor of ["first", "second"])
			children.push(
				Bun.spawn(
					[
						process.execPath,
						join(import.meta.dir, "helpers", "holder.ts"),
						"tasks",
						env.file,
						actor,
						"30",
					],
					{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
				),
			);
		const results = await Promise.all(
			children.map(async (child) => ({
				code: await child.exited,
				stderr: await new Response(child.stderr).text(),
			})),
		);
		expect(results).toEqual([
			{ code: 0, stderr: "" },
			{ code: 0, stderr: "" },
		]);
		const opened = await Store.open(env, SystemClock);
		try {
			const rows = await opened.read((tx) =>
				tx.task.findMany({ orderBy: { number: "asc" } }),
			);
			expect(rows.map((row) => row.number)).toEqual(
				Array.from({ length: 60 }, (_, i) => i + 1),
			);
			expect(rows.filter((row) => row.created_by === "first")).toHaveLength(30);
			expect(rows.filter((row) => row.created_by === "second")).toHaveLength(
				30,
			);
			const events = await opened.read((tx) =>
				tx.event.findMany({
					where: { kind: "task_added" },
					orderBy: { id: "asc" },
				}),
			);
			expect(events).toHaveLength(60);
			expect(new Set(events.map((event) => event.task_id)).size).toBe(60);
			for (const event of events)
				expect(JSON.parse(event.data)).toEqual({
					title: rows.find((row) => row.id === event.task_id)?.title,
					body: "",
					status: "ready",
					priority: "normal",
					parent: null,
					milestone: null,
					waits: [],
				});
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
