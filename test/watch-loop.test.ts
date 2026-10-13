import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { SystemClock } from "../src/clock.ts";
import type { Env } from "../src/env.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import type { GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { openReader } from "../src/store/reader.ts";
import { Store } from "../src/store/store.ts";
import type { WatchLine } from "../src/watch/derive.ts";
import { Watcher, type WatchOptions, watch } from "../src/watch/loop.ts";
import { FakeClock } from "./helpers/clock.ts";

const HOLDER = join(import.meta.dir, "helpers", "holder.ts");
const outside: GitRunner = {
	commonDir: async () => ({
		kind: "exit",
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository\n",
	}),
};

async function refusal(promise: Promise<unknown>): Promise<BoardError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Refusal) return error.error;
		throw error;
	}
	throw new Error("expected a refusal");
}

let dir: string;
let env: Env;
let board: Board;
let lines: WatchLine[];
const ctx = (project: string) => new Place(join(dir, project), outside);

const options = (over: Partial<WatchOptions> = {}): WatchOptions => ({
	follow: true,
	since: null,
	projects: [],
	kinds: [],
	tasks: [],
	expiringWithin: null,
	...over,
});

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-watch-")));
	env = {
		dir: join(dir, "b"),
		file: join(dir, "b", "board.db"),
		boardDirSet: true,
	};
	for (const p of ["a", "b"]) mkdirSync(join(dir, p));
	await projectAdd(env, SystemClock, outside, dir, {
		actor: "owner",
		key: "A",
		dir: "a",
	});
	await projectAdd(env, SystemClock, outside, dir, {
		actor: "owner",
		key: "B",
		dir: "b",
	});
	board = new Board(await Store.open(env, SystemClock));
	lines = [];
});

afterEach(async () => {
	await board.close();
	rmSync(dir, { recursive: true, force: true });
});

function watcher(over: Partial<WatchOptions> = {}, clock = SystemClock) {
	const db = openReader(env);
	return {
		db,
		w: new Watcher(db, options(over), clock, (line) => void lines.push(line)),
	};
}

describe("the reader", () => {
	test("a missing board is no_board, and nothing is created", async () => {
		const missing = {
			dir: join(dir, "none"),
			file: join(dir, "none", "board.db"),
			boardDirSet: true,
		};
		expect(() => openReader(missing)).toThrow(Refusal);
		expect(existsSync(missing.file)).toBe(false);
	});
});

describe("Watcher", () => {
	test("without --follow, the whole log from the beginning, filtered", async () => {
		await board.taskAdd(ctx("a"), { actor: "main", title: "one" });
		await board.taskAdd(ctx("b"), { actor: "main", title: "two" });
		const { db, w } = watcher({ follow: false });
		await watch(w, false, async () => {});
		expect(lines.map((l) => [l.id, l.kind, l.project, l.task])).toEqual([
			[1, "board_created", null, null],
			[2, "project_added", "A", null],
			[3, "project_added", "B", null],
			[4, "task_added", "A", "A-1"],
			[5, "task_added", "B", "B-1"],
		]);
		lines = [];
		const narrowed = new Watcher(
			db,
			options({ follow: false, tasks: ["a-1"] }),
			SystemClock,
			(l) => void lines.push(l),
		);
		await watch(narrowed, false, async () => {});
		expect(lines.map((l) => l.id)).toEqual([4]);
		lines = [];
		const kinds = new Watcher(
			db,
			options({ follow: false, kinds: ["project_added"], since: 2 }),
			SystemClock,
			(l) => void lines.push(l),
		);
		await watch(kinds, false, async () => {});
		expect(lines.map((l) => l.id)).toEqual([3]);
		db.close();
	});

	test("with --follow, from now: another connection's commit is read at the next tick", async () => {
		await board.taskAdd(ctx("a"), { actor: "main", title: "before" });
		const { db, w } = watcher();
		await w.attach();
		await w.tick();
		expect(lines).toEqual([]);
		await board.taskAdd(ctx("a"), { actor: "main", title: "after" });
		await w.tick();
		expect(lines.map((l) => [l.kind, l.task, l.data.title])).toEqual([
			["task_added", "A-2", "after"],
		]);
		await w.tick();
		expect(lines).toHaveLength(1);
		db.close();
	});

	test("--since in follow mode reads what is already after it at attach", async () => {
		await board.taskAdd(ctx("a"), { actor: "main", title: "old" });
		const { db, w } = watcher({ since: 3 });
		await w.attach();
		expect(lines.map((l) => l.id)).toEqual([4]);
		db.close();
	});

	test("a commit that lands during the drain is printed on the next tick", async () => {
		const db = openReader(env);
		let wrote = false;
		const w = new Watcher(db, options(), SystemClock, async (line) => {
			lines.push(line);
			if (!wrote) {
				wrote = true;
				await board.taskAdd(ctx("a"), { actor: "main", title: "during" });
			}
		});
		await w.attach();
		await board.taskAdd(ctx("a"), { actor: "main", title: "first" });
		await w.tick();
		const seen = lines.map((l) => l.data.title);
		await w.tick();
		expect([
			...seen,
			...lines.slice(seen.length).map((l) => l.data.title),
		]).toEqual(["first", "during"]);
		db.close();
	});

	// The project condition is in the drain query, as the design writes it
	// (owner's ruling), so another project's rows are not read at all; rows
	// read and filtered out by --kind or --task move the cursor.
	test("another project's events are not printed and cost one indexed query per tick; rows filtered out by --kind move the cursor", async () => {
		const { db, w } = watcher({ projects: ["a"], kinds: ["task_added"] });
		await w.attach();
		const writer = new Database(env.file);
		writer.run("BEGIN IMMEDIATE");
		for (const project of [2, 1]) {
			const insert = writer.prepare(
				`INSERT INTO event (at, actor, kind, project_id, data) VALUES ('2026-10-12T00:00:00.000Z', 'x', 'project_edited', ${project}, '{}')`,
			);
			for (let i = 0; i < 1200; i++) insert.run();
		}
		writer.run("COMMIT");
		const last = (
			writer.query("SELECT max(id) AS id FROM event").get() as { id: number }
		).id;
		writer.close();
		await w.tick();
		expect(lines).toEqual([]);
		expect(w.position).toBe(last);
		db.close();
	});

	test("-p A stops on A's removal and the watch ends; an unnarrowed one goes on", async () => {
		const { db, w } = watcher({ projects: ["a"] });
		const all = new Watcher(db, options(), SystemClock, () => {});
		await all.attach();
		let ticks = 0;
		const running = watch(
			w,
			true,
			async () => {
				ticks++;
				if (ticks === 2)
					await board.projectRemove({ actor: "owner", key: "A" });
			},
			() => ticks > 10,
			0,
		);
		await running;
		expect(w.done).toBe(true);
		expect(lines.map((l) => [l.kind, l.data.key])).toEqual([
			["project_removed", "A"],
		]);
		await all.tick();
		expect(all.done).toBe(false);
		db.close();
	});

	test("an unknown -p key is not_found before attaching", async () => {
		const { db, w } = watcher({ projects: ["zz"] });
		expect(await refusal(w.attach())).toMatchObject({
			code: "not_found",
			details: { what: "project", id: "ZZ" },
		});
		db.close();
	});

	test("claim_expiring under --follow: at attach for a claim inside its window, once per lease, re-armed by an extend", async () => {
		const clock = new FakeClock(new Date().toISOString());
		await board.taskAdd(ctx("a"), { actor: "main", title: "held" });
		await board.taskClaim({
			actor: "main",
			key: "A-1",
			minutes: 20,
			holder: "@lead",
		});
		clock.advance(16);
		const { db, w } = watcher({}, clock);
		await w.attach();
		expect(lines.map((l) => [l.kind, l.derived, l.id, l.task])).toEqual([
			["claim_expiring", true, null, "A-1"],
		]);
		await w.tick();
		expect(lines).toHaveLength(1);
		await board.taskExtend({
			actor: "@lead",
			key: "A-1",
			holder: "@lead",
			minutes: 60,
		});
		// The board writes on the wall clock; the watcher runs 16 minutes
		// ahead on its own, so the new end is 44 minutes away for it.
		await w.tick();
		expect(lines.map((l) => l.kind)).toEqual([
			"claim_expiring",
			"claim_extended",
		]);
		clock.advance(35);
		await w.tick();
		expect(lines.map((l) => l.kind)).toEqual([
			"claim_expiring",
			"claim_extended",
			"claim_expiring",
		]);
		db.close();
	});
});

test("a watcher keeps its 500 ms ticks while another process holds the write lock", async () => {
	const holder = Bun.spawn(
		[process.execPath, HOLDER, "hold", env.file, "2500"],
		{ stdout: "pipe" },
	);
	const reader = holder.stdout.getReader();
	expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe(
		"held",
	);
	const { db, w } = watcher();
	const times: number[] = [];
	await watch(
		w,
		true,
		(ms) => Bun.sleep(ms),
		() => {
			times.push(Date.now());
			return times.length > 5;
		},
	);
	await holder.exited;
	const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
	expect(Math.max(...gaps)).toBeLessThan(700);
	db.close();
}, 15_000);

describe("narrowed removal", () => {
	/** Removes a project from a second connection, as `board project rm` does. */
	function removeRaw(key: string) {
		const writer = new Database(env.file);
		writer.run("PRAGMA defer_foreign_keys = ON");
		writer.run("BEGIN IMMEDIATE");
		const row = writer
			.query("SELECT id, name, directory FROM project WHERE key = ?")
			.get(key) as {
			id: number;
			name: string;
			directory: string;
		};
		writer.run("DELETE FROM project WHERE id = ?", [row.id]);
		writer.run("DELETE FROM event WHERE project_id = ?", [row.id]);
		writer.run(
			"INSERT INTO event (at, actor, kind, project_id, data) VALUES ('2026-10-12T00:00:00.000Z', 'owner', 'project_removed', NULL, ?)",
			[JSON.stringify({ key, name: row.name, directory: row.directory })],
		);
		writer.run("COMMIT");
		writer.close();
	}

	test("a removal committed while the watcher attaches is still seen, and ends it", async () => {
		const db = openReader(env);
		let removed = false;
		const racing = new Proxy(db, {
			get(target, prop) {
				if (prop !== "query") {
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return (sql: string) => {
					const statement = target.query(sql);
					if (!sql.includes("FROM project p WHERE p.key")) return statement;
					return {
						get: (...args: unknown[]) => {
							const row = (statement.get as (...a: unknown[]) => unknown)(
								...args,
							);
							if (!removed) {
								removed = true;
								removeRaw("A");
							}
							return row;
						},
					};
				};
			},
		}) as Database;
		const w = new Watcher(
			racing,
			options({ projects: ["a"] }),
			SystemClock,
			(l) => void lines.push(l),
		);
		await w.attach();
		expect(removed).toBe(true);
		await w.tick();
		expect(lines.map((l) => [l.kind, l.data.key])).toEqual([
			["project_removed", "A"],
		]);
		expect(w.done).toBe(true);
		db.close();
	});

	test("a key added again: the older removal is printed but does not end the watch", async () => {
		await board.projectRemove({ actor: "owner", key: "A" });
		await projectAdd(env, SystemClock, outside, dir, {
			actor: "owner",
			key: "A",
			dir: "a",
		});
		const { db, w } = watcher({ projects: ["a"], since: 0 });
		await w.attach();
		expect(lines.map((l) => [l.kind, l.data.key])).toEqual([
			["project_removed", "A"],
			["project_added", "A"],
		]);
		expect(w.done).toBe(false);
		await board.projectRemove({ actor: "owner", key: "A" });
		await w.tick();
		expect(lines.at(-1)).toMatchObject({
			kind: "project_removed",
			data: { key: "A" },
		});
		expect(w.done).toBe(true);
		db.close();
	});
});

describe("the reader's refusals", () => {
	const at = (name: string): Env => ({
		dir: join(dir, name),
		file: join(dir, name, "board.db"),
		boardDirSet: true,
	});
	const refusalOf = (env: Env) => {
		try {
			openReader(env).close();
		} catch (error) {
			if (error instanceof Refusal) return error.error;
			throw error;
		}
		throw new Error("expected a refusal");
	};
	const { chmodSync, readFileSync, writeFileSync } =
		require("node:fs") as typeof import("node:fs");

	test("an unreadable board is storage, not no_board", () => {
		chmodSync(env.file, 0o000);
		try {
			expect(refusalOf(env)).toMatchObject({
				code: "storage",
				details: { sqlite: expect.any(String) },
			});
		} finally {
			chmodSync(env.file, 0o644);
		}
	});

	test("an empty file is no_board; text is damaged; a foreign or other-version file is refused; nothing changes", () => {
		for (const name of ["empty", "text", "foreign", "version"])
			mkdirSync(join(dir, name));
		writeFileSync(at("empty").file, "");
		writeFileSync(at("text").file, "x".repeat(4096));
		const foreign = new Database(at("foreign").file);
		foreign.run("CREATE TABLE notes (x)");
		foreign.close();
		const other = new Database(at("version").file);
		other.run("PRAGMA application_id = 1112494660");
		other.run("PRAGMA user_version = 7");
		other.run("CREATE TABLE notes (x)");
		other.close();
		const bytes = (name: string) => readFileSync(at(name).file);
		const before = ["empty", "text", "foreign", "version"].map(bytes);
		expect(refusalOf(at("empty")).code).toBe("no_board");
		expect(refusalOf(at("text")).code).toBe("damaged");
		expect(refusalOf(at("foreign")).code).toBe("not_a_board");
		expect(refusalOf(at("version"))).toMatchObject({
			code: "schema_mismatch",
			details: { from: "7", to: "1" },
		});
		expect(["empty", "text", "foreign", "version"].map(bytes)).toEqual(before);
	});
});

test("a board behind a directory board may not read is storage for the reader and the store", async () => {
	const { chmodSync } = require("node:fs") as typeof import("node:fs");
	chmodSync(env.dir, 0o000);
	try {
		let reader: unknown;
		try {
			openReader(env);
		} catch (error) {
			reader = error instanceof Refusal ? error.error.code : error;
		}
		expect(reader).toBe("storage");
		expect(await refusal(Store.open(env, SystemClock))).toMatchObject({
			code: "storage",
		});
	} finally {
		chmodSync(env.dir, 0o755);
	}
});
