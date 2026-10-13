import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { openReader } from "../src/store/reader.ts";
import { Store } from "../src/store/store.ts";
import type { WatchLine } from "../src/watch/derive.ts";
import { Watcher, type WatchOptions } from "../src/watch/loop.ts";
import { FakeClock } from "./helpers/clock.ts";

const ctx = new Place("/a", {
	async commonDir() {
		throw new Error("Unexpected git");
	},
});
const options = (extra: Partial<WatchOptions> = {}): WatchOptions => ({
	follow: true,
	since: null,
	projects: ["A"],
	kinds: [],
	tasks: [],
	expiringWithin: null,
	...extra,
});
async function fixture() {
	const dir = mkdtempSync("/private/tmp/board-slice5-loop-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	const clock = new FakeClock();
	await Store.create(env, clock, "owner", async (tx, now) => {
		for (const key of ["A", "B"])
			await addProject(tx, now, "owner", {
				key,
				name: key,
				directory: `/${key.toLowerCase()}`,
			});
	});
	const store = await Store.open(env, clock);
	const board = new Board(store);
	const db = openReader(env);
	return {
		clock,
		store,
		board,
		db,
		async close() {
			db.close();
			await board.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("1,200 unrelated events cost one SQL-filtered page and never advance the narrowed cursor", async () => {
	const f = await fixture();
	const queries: string[] = [];
	const lines: WatchLine[] = [];
	const instrumented = new Proxy(f.db, {
		get(target, property) {
			if (property === "query")
				return (sql: string) => {
					if (sql.includes("FROM event e") && sql.includes("LIMIT"))
						queries.push(sql);
					return target.query(sql);
				};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Database;
	try {
		const watcher = new Watcher(
			instrumented,
			options({ kinds: ["task_added"] }),
			f.clock,
			(line) => {
				lines.push(line);
			},
		);
		await watcher.attach();
		const position = watcher.position;
		const project = await f.store.read((tx) =>
			tx.project.findUniqueOrThrow({ where: { key: "B" } }),
		);
		await f.store.write({
			actor: "other",
			resolve: async () => project,
			apply: async (tx) => {
				for (let i = 0; i < 1200; i++)
					await tx.event.create({
						data: {
							at: f.clock.now().toISOString(),
							actor: "other",
							kind: "project_edited",
							project_id: project.id,
							data: "{}",
						},
					});
			},
		});
		await watcher.tick();
		expect(lines).toEqual([]);
		expect(watcher.position).toBe(position);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("e.project_id IN");
		const attached = await f.store.read((tx) =>
			tx.project.findUniqueOrThrow({ where: { key: "A" } }),
		);
		const explain = f.db.prepare<{ detail: string }, [number, number]>(
			`EXPLAIN QUERY PLAN ${queries[0]}`,
		);
		const plan = explain.all(position, attached.id);
		explain.finalize();
		expect(
			plan.some((row) =>
				/SEARCH e USING .*?(INDEX|PRIMARY KEY)/.test(row.detail),
			),
		).toBe(true);
		await watcher.tick();
		expect(queries).toHaveLength(1);
		await f.board.taskAdd(ctx, {
			actor: "tester",
			project: "B",
			title: "Still unrelated",
		});
		await watcher.tick();
		expect(queries).toHaveLength(2);
		expect(watcher.position).toBe(position);
		await f.board.projectEdit(
			{
				async commonDir() {
					throw new Error("Name change should avoid git");
				},
			},
			"/a",
			{ actor: "owner", key: "A", name: "Changed" },
		);
		await watcher.tick();
		expect(watcher.position).toBeGreaterThan(position);
		expect(lines).toEqual([]);
		await f.board.taskAdd(ctx, { actor: "tester", title: "Watched" });
		await watcher.tick();
		expect(lines).toMatchObject([
			{ project: "A", task: "A-1", kind: "task_added" },
		]);
		await watcher.tick();
		expect(lines).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("filtered removals still drop each attached project and a re-added key is not watched", async () => {
	const f = await fixture();
	const lines: WatchLine[] = [];
	try {
		const watcher = new Watcher(
			f.db,
			options({ projects: ["A", "B"], kinds: ["task_added"], tasks: ["A-1"] }),
			f.clock,
			(line) => {
				lines.push(line);
			},
		);
		await watcher.attach();
		await f.board.projectRemove({ actor: "owner", key: "A" });
		await watcher.tick();
		expect(watcher.done).toBe(false);
		expect(lines).toEqual([]);
		await f.store.write({
			actor: "owner",
			resolve: async () => null,
			apply: (tx, now) =>
				addProject(tx, now, "owner", {
					key: "A",
					name: "New A",
					directory: "/new-a",
				}),
		});
		await f.board.taskAdd(ctx, {
			actor: "tester",
			project: "A",
			title: "New project",
		});
		await watcher.tick();
		expect(lines).toEqual([]);
		expect(watcher.done).toBe(false);
		await f.board.projectRemove({ actor: "owner", key: "B" });
		await watcher.tick();
		expect(watcher.done).toBe(true);
		expect(lines).toEqual([]);
	} finally {
		await f.close();
	}
});

test("follow with since drains historical lines before the attach warning and read-only ticks append nothing", async () => {
	const f = await fixture();
	const lines: WatchLine[] = [];
	try {
		await f.board.taskAdd(ctx, { actor: "worker", title: "Held" });
		await f.board.taskClaim({ actor: "worker", key: "A-1", minutes: 20 });
		f.clock.advance(15);
		const before = await f.store.read((tx) => tx.event.count());
		const watcher = new Watcher(
			f.db,
			options({ since: 0 }),
			f.clock,
			(line) => {
				lines.push(line);
			},
		);
		await watcher.attach();
		expect(lines.map((line) => line.kind)).toEqual([
			"project_added",
			"task_added",
			"claimed",
			"claim_expiring",
		]);
		const last = lines.at(-1);
		expect(last).toMatchObject({
			id: null,
			derived: true,
			data: { minutes_left: 5 },
		});
		const lastLogged = lines.at(-2);
		if (lastLogged === undefined || lastLogged.id === null)
			throw new Error("Missing logged attach line");
		expect(watcher.position).toBe(lastLogged.id);
		await watcher.tick();
		await watcher.tick();
		expect(lines).toHaveLength(4);
		expect(await f.store.read((tx) => tx.event.count())).toBe(before);
		const oneShot: WatchLine[] = [];
		const reader = new Watcher(
			f.db,
			options({ follow: false, since: 0 }),
			f.clock,
			(line) => {
				oneShot.push(line);
			},
		);
		await reader.attach();
		await reader.drain();
		expect(oneShot.some((line) => line.derived)).toBe(false);
	} finally {
		await f.close();
	}
});
