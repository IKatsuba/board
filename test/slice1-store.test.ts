import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stamp } from "../src/clock.ts";
import { Refusal } from "../src/errors.ts";
import { outcome } from "../src/store/outcome.ts";
import { Store, type Tx } from "../src/store/store.ts";

const start = new Date("2026-10-13T12:00:00.000Z");
const refusal = new Refusal({
	code: "invalid_argument",
	message: "Refused test operation.",
	next: "Retry with another value.",
	details: { field: "title" },
});

async function seed(tx: Tx) {
	await tx.project.create({
		data: {
			key: "T",
			name: "Test",
			directory: "/test",
			created_at: stamp(start),
			created_by: "owner",
		},
	});
	await tx.task.create({
		data: {
			id: 1,
			project_id: 1,
			number: 1,
			title: "Original",
			status: "active",
			created_at: stamp(start),
			created_by: "tester",
		},
	});
	await tx.claim.create({
		data: {
			task_id: 1,
			holder: "tester",
			since: stamp(start),
			until: "2026-10-13T12:01:00.000Z",
		},
	});
}

test("concurrent calls preserve the successful write when the other refuses", async () => {
	const store = await Store.memory({ now: () => start });
	try {
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: seed,
		});
		const results = await Promise.allSettled([
			store.write({
				actor: "first",
				resolve: async () => null,
				apply: async (tx) => {
					await tx.task.update({ where: { id: 1 }, data: { title: "Kept" } });
					await tx.event.create({
						data: {
							at: stamp(start),
							actor: "first",
							kind: "task_edited",
							project_id: 1,
							task_id: 1,
							data: JSON.stringify({ title: { from: "Original", to: "Kept" } }),
						},
					});
				},
			}),
			store.write({
				actor: "second",
				resolve: async () => null,
				apply: async (tx) => {
					await tx.task.update({ where: { id: 1 }, data: { title: "Lost" } });
					throw refusal;
				},
			}),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(
			await store.read((tx) => tx.task.findUnique({ where: { id: 1 } })),
		).toMatchObject({ title: "Kept" });
		expect(await store.read((tx) => tx.event.count())).toBe(1);
	} finally {
		await store.close();
	}
});

test("a refused existing project add commits the expiry it actually notices", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice1-store-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	let now = start;
	const clock = { now: () => now };
	try {
		await Store.create(env, clock, "owner", seed);
		now = new Date("2026-10-13T12:01:00.000Z");
		await expect(
			Store.create(env, clock, "owner", async (tx) => {
				await tx.task.update({ where: { id: 1 }, data: { title: "Lost" } });
				throw refusal;
			}),
		).rejects.toBe(refusal);
		const store = await Store.open(env, clock);
		try {
			expect(await store.read((tx) => tx.claim.count())).toBe(0);
			expect(
				await store.read((tx) => tx.task.findUnique({ where: { id: 1 } })),
			).toMatchObject({ title: "Original", status: "ready" });
			const events = await store.read((tx) =>
				tx.event.findMany({ where: { kind: "claim_expired" } }),
			);
			expect(events).toHaveLength(1);
			expect(JSON.parse(events[0]?.data ?? "")).toEqual({
				holder: "tester",
				since: stamp(start),
				until: stamp(now),
				by: "owner",
			});
			expect(events[0]).toMatchObject({
				actor: "board",
				project_id: 1,
				task_id: 1,
			});
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("each open enables foreign keys, FULL synchronization and the 5 s busy timeout", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice1-pragmas-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	try {
		await Store.create(env, { now: () => start }, "owner", seed);
		const store = await Store.open(env, { now: () => start });
		try {
			const values = await store.read(async (tx) => ({
				fk: await tx.$queryRawUnsafe("PRAGMA foreign_keys"),
				sync: await tx.$queryRawUnsafe("PRAGMA synchronous"),
				busy: await tx.$queryRawUnsafe("PRAGMA busy_timeout"),
			}));
			expect(values).toEqual({
				fk: [{ foreign_keys: 1n }],
				sync: [{ synchronous: 2n }],
				busy: [{ timeout: 5000n }],
			});
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outcomes distinguish contention, storage damage and programming errors", () => {
	for (const code of ["P2010", "P1008"]) {
		expect(
			outcome({
				code,
				meta: {
					driverAdapterError: { cause: { originalCode: "SQLITE_BUSY" } },
				},
			}),
		).toMatchObject({ code: "busy", details: {} });
	}
	expect(outcome({ code: "P2028" })).toMatchObject({ code: "busy" });
	for (const code of [
		"SQLITE_FULL",
		"SQLITE_IOERR_WRITE",
		"SQLITE_READONLY",
		"EACCES",
	]) {
		expect(
			outcome({ code, message: "Prisma wrapper\n disk message" }),
		).toMatchObject({ code: "storage", details: { sqlite: "disk message" } });
	}
	expect(outcome({ code: "SQLITE_CORRUPT", message: "broken" })).toMatchObject({
		code: "damaged",
		details: { sqlite: "broken" },
	});
	for (const error of [
		null,
		undefined,
		"bug",
		new TypeError("bug"),
		{ code: "SQLITE_CONSTRAINT" },
	])
		expect(outcome(error)).toBeNull();
	expect(outcome(refusal)).toBe(refusal.error);
});
