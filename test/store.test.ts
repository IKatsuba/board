import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock, stamp } from "../src/clock.ts";
import type { Env } from "../src/env.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import { Store, type Tx } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";

const HOLDER = join(import.meta.dir, "helpers", "holder.ts");

async function refusal(promise: Promise<unknown>): Promise<BoardError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Refusal) return error.error;
		throw error;
	}
	throw new Error("expected a refusal");
}

async function addProject(tx: Tx, now: Date, key: string, directory: string) {
	const project = await tx.project.create({
		data: {
			key,
			name: key,
			directory,
			created_at: stamp(now),
			created_by: "owner",
		},
	});
	await tx.event.create({
		data: {
			at: stamp(now),
			actor: "owner",
			kind: "project_added",
			project_id: project.id,
			data: JSON.stringify({ key, name: key, directory }),
		},
	});
	return project;
}

/** A task of `projectId` claimed by `holder` for `minutes` from `now`. */
async function claimed(
	tx: Tx,
	now: Date,
	projectId: number,
	number: number,
	holder: string,
	minutes: number,
) {
	const task = await tx.task.create({
		data: {
			project_id: projectId,
			number,
			title: `task ${number}`,
			status: "active",
			created_at: stamp(now),
			created_by: "owner",
		},
	});
	await tx.claim.create({
		data: {
			task_id: task.id,
			holder,
			since: stamp(now),
			until: stamp(new Date(now.getTime() + minutes * 60_000)),
		},
	});
	return task;
}

const nothing = { resolve: async () => null };

describe("in memory", () => {
	let clock: FakeClock;
	let store: Store;

	beforeEach(async () => {
		clock = new FakeClock();
		store = await Store.memory(clock);
		await store.write({
			actor: "owner",
			...nothing,
			apply: async (tx, now) => {
				const a = await addProject(tx, now, "A", "/a");
				const b = await addProject(tx, now, "B", "/b");
				await claimed(tx, now, a.id, 1, "@lead", 30);
				await claimed(tx, now, b.id, 1, "@other", 90);
			},
		});
	});

	afterEach(() => store.close());

	test("a write sweeps every project's lapsed claims, once, in their projects", async () => {
		clock.advance(120);
		const first = await store.write({
			actor: "main",
			...nothing,
			apply: async () => "done",
		});
		expect(first.value).toBe("done");
		expect(first.swept).toHaveLength(2);
		const events = await store.read((tx) =>
			tx.event.findMany({
				where: { id: { in: first.swept } },
				orderBy: { id: "asc" },
			}),
		);
		expect(events.map((e) => [e.kind, e.actor, e.project_id])).toEqual([
			["claim_expired", "board", 1],
			["claim_expired", "board", 2],
		]);
		expect(JSON.parse(events[0]?.data ?? "")).toEqual({
			holder: "@lead",
			since: "2026-10-12T09:00:00.000Z",
			until: "2026-10-12T09:30:00.000Z",
			by: "main",
		});
		const tasks = await store.read((tx) => tx.task.findMany());
		expect(tasks.map((t) => t.status)).toEqual(["ready", "ready"]);
		const again = await store.write({
			actor: "main",
			...nothing,
			apply: async () => null,
		});
		expect(again.swept).toEqual([]);
	});

	test("only lapsed claims are swept; until equal to now is lapsed", async () => {
		clock.advance(30);
		const { swept } = await store.write({
			actor: "main",
			...nothing,
			apply: async () => null,
		});
		expect(swept).toHaveLength(1);
		expect(await store.read((tx) => tx.claim.count())).toBe(1);
	});

	test("a refusal in apply rolls back to the savepoint and keeps the sweep", async () => {
		clock.advance(120);
		const error = await refusal(
			store.write({
				actor: "main",
				...nothing,
				apply: async (tx, now) => {
					await addProject(tx, now, "C", "/c");
					throw new Refusal({
						code: "invalid_argument",
						message: "no",
						next: "",
						details: { field: "x" },
					});
				},
			}),
		);
		expect(error.code).toBe("invalid_argument");
		expect(await store.read((tx) => tx.project.count())).toBe(2);
		expect(await store.read((tx) => tx.claim.count())).toBe(0);
		expect(
			await store.read((tx) =>
				tx.event.count({ where: { kind: "claim_expired" } }),
			),
		).toBe(2);
	});

	test("a throw in resolve rolls back the whole write, sweep included", async () => {
		clock.advance(120);
		await expect(
			store.write({
				actor: "main",
				resolve: async () => {
					throw new Error("git needed");
				},
				apply: async () => null,
			}),
		).rejects.toThrow("git needed");
		expect(await store.read((tx) => tx.claim.count())).toBe(2);
	});

	test("an exception that is not a refusal rolls back everything", async () => {
		clock.advance(120);
		await expect(
			store.write({
				actor: "main",
				...nothing,
				apply: async () => {
					throw new TypeError("bug");
				},
			}),
		).rejects.toThrow(TypeError);
		expect(await store.read((tx) => tx.claim.count())).toBe(2);
	});

	test("reads treat nothing as swept and write nothing", async () => {
		clock.advance(120);
		const now = await store.read(async (tx, now) => {
			expect(await tx.claim.count()).toBe(2);
			return now;
		});
		expect(stamp(now)).toBe("2026-10-12T11:00:00.000Z");
	});
});

describe("on a file", () => {
	let dir: string;
	let env: Env;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "board-store-"));
		env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const create = (key: string, directory: string, clock = SystemClock) =>
		Store.create(env, clock, "owner", (tx, now) =>
			addProject(tx, now, key, directory),
		);

	function spawn(...args: string[]) {
		return Bun.spawn([process.execPath, HOLDER, ...args], {
			stdout: "pipe",
			stderr: "inherit",
		});
	}

	async function holdLock(ms: number) {
		const child = spawn("hold", env.file, String(ms));
		const reader = child.stdout.getReader();
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value).trim()).toBe("held");
		return child;
	}

	function lockFromOutside(): string {
		const out = Bun.spawnSync([process.execPath, HOLDER, "lock", env.file]);
		return out.stdout.toString().trim();
	}

	test("project add creates the board: WAL, the schema, board_created", async () => {
		await create("A", "/a");
		const db = new Database(env.file, { readonly: true });
		const row = (sql: string) =>
			Object.values(db.query(sql).get() as object)[0];
		expect(row("PRAGMA journal_mode")).toBe("wal");
		expect(row("PRAGMA application_id")).toBe(0x424f5244);
		expect(row("PRAGMA user_version")).toBe(1);
		expect(row("SELECT count(*) FROM sqlite_master")).toBe(28);
		expect(
			db.query("SELECT kind, project_id FROM event ORDER BY id").all(),
		).toEqual([
			{ kind: "board_created", project_id: null },
			{ kind: "project_added", project_id: 1 },
		]);
		db.close();
	});

	test("a second project add takes the existing branch, with its sweep", async () => {
		const clock = new FakeClock();
		await Store.create(env, clock, "owner", async (tx, now) => {
			const a = await addProject(tx, now, "A", "/a");
			await claimed(tx, now, a.id, 1, "@lead", 10);
		});
		clock.advance(60);
		const added = await create("B", "/b", clock);
		expect(added.swept).toHaveLength(1);
		const refused = await refusal(
			Store.create(env, clock, "owner", async () => {
				throw new Refusal({
					code: "project_exists",
					message: "taken",
					next: "",
					details: {
						field: "key",
						project: {
							key: "A",
							name: "A",
							directory: "/a",
							created_at: stamp(clock.now()),
						},
					},
				});
			}),
		);
		expect(refused.code).toBe("project_exists");
		const store = await Store.open(env, clock);
		const kinds = await store.read((tx) =>
			tx.event.findMany({ select: { kind: true }, orderBy: { id: "asc" } }),
		);
		expect(kinds.map((e) => e.kind)).toEqual([
			"board_created",
			"project_added",
			"claim_expired",
			"project_added",
		]);
		await store.close();
	});

	test("a refusal on a fresh file rolls everything back and leaves it empty", async () => {
		const error = await refusal(
			Store.create(env, SystemClock, "owner", async () => {
				throw new Refusal({
					code: "invalid_argument",
					message: "bad key",
					next: "",
					details: { field: "key" },
				});
			}),
		);
		expect(error.code).toBe("invalid_argument");
		const db = new Database(env.file, { readonly: true });
		expect(db.query("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({
			n: 0,
		});
		expect(db.query("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "wal",
		});
		db.close();
		expect((await refusal(Store.open(env, SystemClock))).code).toBe("no_board");
	});

	test("open never creates: a missing file is no_board and stays missing", async () => {
		const error = await refusal(Store.open(env, SystemClock));
		expect(error).toMatchObject({
			code: "no_board",
			details: { file: env.file, reason: "missing" },
		});
		expect(existsSync(env.file)).toBe(false);
	});

	test("an empty file is no_board", async () => {
		writeFileSync(env.file, "");
		expect((await refusal(Store.open(env, SystemClock))).code).toBe("no_board");
		expect(statSync(env.file).size).toBe(0);
		expect(existsSync(`${env.file}-wal`)).toBe(false);
		expect(existsSync(`${env.file}-shm`)).toBe(false);
	});

	test("a board directory that cannot be made is storage", async () => {
		const locked = join(dir, "locked");
		mkdirSync(locked, { mode: 0o555 });
		const inside: Env = {
			dir: join(locked, "board"),
			file: join(locked, "board", "board.db"),
			boardDirSet: true,
		};
		const error = await refusal(
			Store.create(inside, SystemClock, "owner", async () => null),
		);
		expect(error.code).toBe("storage");
		expect(error.details).toHaveProperty("sqlite");
		chmodSync(locked, 0o755);
	});

	test("a file that is not a database is damaged", async () => {
		writeFileSync(env.file, "x".repeat(4096));
		const error = await refusal(Store.open(env, SystemClock));
		expect(error.code).toBe("damaged");
		expect(error.details).toHaveProperty("sqlite");
		expect((await refusal(create("A", "/a"))).code).toBe("damaged");
	});

	test("another application's SQLite file is not_a_board, and project add writes nothing to it", async () => {
		const db = new Database(env.file);
		db.run("PRAGMA application_id = 7");
		db.run("CREATE TABLE notes (x TEXT)");
		db.close();
		expect((await refusal(Store.open(env, SystemClock))).code).toBe(
			"not_a_board",
		);
		expect((await refusal(create("A", "/a"))).code).toBe("not_a_board");
		const after = new Database(env.file, { readonly: true });
		expect(after.query("PRAGMA application_id").get()).toEqual({
			application_id: 7,
		});
		after.close();
	});

	test("tables with neither the version nor a project table are not_a_board", async () => {
		const db = new Database(env.file);
		db.run("PRAGMA journal_mode = WAL");
		db.run("CREATE TABLE notes (x TEXT)");
		db.close();
		expect((await refusal(create("A", "/a"))).code).toBe("not_a_board");
		const after = new Database(env.file, { readonly: true });
		expect(after.query("PRAGMA application_id").get()).toEqual({
			application_id: 0,
		});
		after.close();
	});

	test("a board of another schema version is schema_mismatch, at open and in project add", async () => {
		await create("A", "/a");
		const db = new Database(env.file);
		db.run("PRAGMA user_version = 2");
		db.close();
		expect(await refusal(Store.open(env, SystemClock))).toMatchObject({
			code: "schema_mismatch",
			details: { from: "2", to: "1" },
		});
		expect((await refusal(create("B", "/b"))).code).toBe("schema_mismatch");
	});

	test("a version changed under an open store is caught by the next transaction", async () => {
		await create("A", "/a");
		const store = await Store.open(env, SystemClock);
		const db = new Database(env.file);
		db.run("PRAGMA user_version = 3");
		db.close();
		expect((await refusal(store.read(async () => null))).code).toBe(
			"schema_mismatch",
		);
		expect(
			(
				await refusal(
					store.write({ actor: "a", ...nothing, apply: async () => null }),
				)
			).code,
		).toBe("schema_mismatch");
		await store.close();
	});

	test("the lock statement takes the write lock before anything is read", async () => {
		await create("A", "/a");
		const store = await Store.open(env, SystemClock);
		let inside = "";
		await store.write({
			actor: "a",
			resolve: async () => {
				inside = lockFromOutside();
				return null;
			},
			apply: async () => null,
		});
		expect(inside).toBe("SQLITE_BUSY");
		expect(lockFromOutside()).toBe("free");
		await store.close();
	});

	test("now is taken after the lock", async () => {
		await create("A", "/a");
		const store = await Store.open(env, {
			now: () => {
				sampled = Date.now();
				return new Date();
			},
		});
		let sampled = 0;
		const holder = await holdLock(800);
		const released = Date.now() + 700;
		await store.write({ actor: "a", ...nothing, apply: async () => null });
		expect(sampled).toBeGreaterThanOrEqual(released);
		await holder.exited;
		await store.close();
	});

	test("past the busy timeout a write is busy, nothing written, and the client still works", async () => {
		await create("A", "/a");
		const store = await Store.open(env, SystemClock);
		const holder = await holdLock(6_500);
		const started = Date.now();
		const error = await refusal(
			store.write({
				actor: "a",
				...nothing,
				apply: (tx, now) => addProject(tx, now, "B", "/b"),
			}),
		);
		expect(error.code).toBe("busy");
		expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
		await holder.exited;
		await store.write({
			actor: "a",
			...nothing,
			apply: (tx, now) => addProject(tx, now, "C", "/c"),
		});
		const keys = await store.read((tx) =>
			tx.project.findMany({ select: { key: true } }),
		);
		expect(keys.map((p) => p.key)).toEqual(["A", "C"]);
		await store.close();
	}, 15_000);

	test("every failure frees the lock: a throw, a constraint, a full disk", async () => {
		await create("A", "/a");
		const store = await Store.open(env, SystemClock);
		await expect(
			store.write({
				actor: "a",
				...nothing,
				apply: async () => {
					throw new Error("bug");
				},
			}),
		).rejects.toThrow("bug");
		expect(lockFromOutside()).toBe("free");

		await expect(
			store.write({
				actor: "a",
				...nothing,
				apply: (tx, now) => addProject(tx, now, "a", "/other"),
			}),
		).rejects.toThrow();
		expect(lockFromOutside()).toBe("free");

		const full = await refusal(
			store.write({
				actor: "a",
				...nothing,
				apply: async (tx, now) => {
					const [row] =
						await tx.$queryRawUnsafe<{ page_count: bigint }[]>(
							"PRAGMA page_count",
						);
					await tx.$executeRawUnsafe(
						`PRAGMA max_page_count = ${Number(row?.page_count) + 1}`,
					);
					await tx.event.create({
						data: {
							at: stamp(now),
							actor: "a",
							kind: "comment",
							project_id: 1,
							data: JSON.stringify({ text: "x".repeat(200_000) }),
						},
					});
				},
			}),
		);
		expect(full.code).toBe("storage");
		expect(lockFromOutside()).toBe("free");
		await store.write({
			actor: "a",
			...nothing,
			apply: (tx) => tx.$executeRawUnsafe("PRAGMA max_page_count = 1073741823"),
		});
		expect(
			await store.read((tx) => tx.event.count({ where: { kind: "comment" } })),
		).toBe(0);
		await store.close();
	});

	test("Prisma's own timeout frees the lock", async () => {
		await create("A", "/a");
		const store = await Store.open(env, SystemClock);
		const error = await refusal(
			store.write({
				actor: "a",
				...nothing,
				apply: () => Bun.sleep(10_500),
			}),
		);
		expect(error.code).toBe("busy");
		expect(lockFromOutside()).toBe("free");
		await store.write({ actor: "a", ...nothing, apply: async () => null });
		await store.close();
	}, 20_000);

	test.each([2, 5])(
		"%d first project adds at once make one board and every project",
		async (n) => {
			const at = String(Date.now() + 400);
			const children = Array.from({ length: n }, (_, i) =>
				spawn("add", dir, `K${i}`, `/p/${i}`, at),
			);
			const outputs = await Promise.all(
				children.map((child) => new Response(child.stdout).text()),
			);
			expect(outputs.map((o) => o.trim())).toEqual(Array(n).fill("added"));
			const db = new Database(env.file, { readonly: true });
			expect(db.query("SELECT count(*) AS n FROM sqlite_master").get()).toEqual(
				{ n: 28 },
			);
			expect(db.query("SELECT count(*) AS n FROM project").get()).toEqual({
				n,
			});
			expect(
				db
					.query(
						"SELECT kind, count(*) AS n FROM event GROUP BY kind ORDER BY kind",
					)
					.all(),
			).toEqual([
				{ kind: "board_created", n: 1 },
				{ kind: "project_added", n },
			]);
			db.close();
		},
		20_000,
	);

	test("two processes noticing one lapse write one claim_expired", async () => {
		const clock = new FakeClock(new Date(Date.now() - 3_600_000).toISOString());
		await Store.create(env, clock, "owner", async (tx, now) => {
			const a = await addProject(tx, now, "A", "/a");
			const b = await addProject(tx, now, "B", "/b");
			await claimed(tx, now, a.id, 1, "@lead", 10);
			await claimed(tx, now, b.id, 1, "@other", 10);
		});
		const children = ["one", "two"].map((actor) =>
			spawn("write", env.file, actor),
		);
		const swept = (
			await Promise.all(children.map((c) => new Response(c.stdout).text()))
		).map((out) => JSON.parse(out) as number[]);
		expect(swept.flat()).toHaveLength(2);
		expect(swept.some((ids) => ids.length === 0)).toBe(true);
		const db = new Database(env.file, { readonly: true });
		expect(
			db
				.query(
					"SELECT project_id FROM event WHERE kind = 'claim_expired' ORDER BY id",
				)
				.all(),
		).toEqual([{ project_id: 1 }, { project_id: 2 }]);
		db.close();
	});
});
