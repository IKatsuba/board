import { mkdirSync } from "node:fs";
import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import type { Clock } from "../clock.ts";
import { stamp } from "../clock.ts";
import { type Env, missingBoard } from "../env.ts";
import { Refusal } from "../errors.ts";
import { DDL } from "./ddl.ts";
import { type Prisma, PrismaClient } from "./generated/client.ts";
import { sweep } from "./generated/sql.ts";
import {
	boardFileExists,
	busy,
	notABoard,
	outcome,
	rethrow,
	schemaMismatch,
} from "./outcome.ts";

/** A transaction: all `rules/` ever gets of the database. */
export type Tx = Prisma.TransactionClient;

/** The schema version Appendix A writes with `PRAGMA user_version`. */
export const SCHEMA_VERSION = 1;
/** "BORD", Appendix A's `PRAGMA application_id`. */
export const APPLICATION_ID = 0x424f5244;

/** Every write takes the write lock with this before it reads anything. */
const LOCK = "UPDATE project SET id = id WHERE 0";
const OPTIONS = { timeout: 10_000, maxWait: 30_000 } as const;

/** One write: its project resolution (step 4) and its change (steps 7–8). */
export interface WriteOp<R, T> {
	/** The caller's actor, recorded as `by` on the `claim_expired` it sweeps. */
	actor: string;
	/** Runs before the sweep; a throw rolls the whole transaction back. */
	resolve: (tx: Tx, now: Date) => Promise<R>;
	/** Runs in `SAVEPOINT op`; a Refusal rolls back to it and the sweep stays. */
	apply: (tx: Tx, now: Date, resolved: R) => Promise<T>;
}

/** A committed write: its value and the ids its sweep appended, ascending. */
export interface Written<T> {
	value: T;
	swept: number[];
}

/**
 * The only holder of the PrismaClient. Every call is one `$transaction`, so
 * two requests of one process never interleave inside a transaction: a plain
 * client call made while one is open would run inside it on the one
 * connection and vanish with its rollback.
 */
export class Store {
	private constructor(
		private readonly client: PrismaClient,
		private readonly file: string,
		private readonly clock: Clock,
	) {}

	/**
	 * Opens an existing board and never creates one: the adapter would create
	 * a missing file, so its absence is checked first, and the empty file a
	 * failed first `project add` leaves reads as missing too.
	 */
	static async open(env: Env, clock: Clock): Promise<Store> {
		if (!boardFileExists(env.file)) throw new Refusal(missingBoard(env));
		const store = new Store(connect(env.file), env.file, clock);
		try {
			await store.client.$connect();
			await store.client.$executeRawUnsafe("PRAGMA synchronous = FULL");
			if ((await count(store.client)) === 0) {
				throw new Refusal(missingBoard(env));
			}
			if ((await pragma(store.client, "application_id")) !== APPLICATION_ID) {
				throw new Refusal(notABoard(env.file));
			}
			await store.checkVersion(store.client);
			return store;
		} catch (error) {
			await store.close();
			rethrow(error);
		}
	}

	/** A fresh board in memory with Appendix A run on it, for tests. */
	static async memory(clock: Clock): Promise<Store> {
		const store = new Store(connect(":memory:"), ":memory:", clock);
		await store.client.$transaction(async (tx) => {
			for (const statement of DDL) await tx.$executeRawUnsafe(statement);
		});
		return store;
	}

	/**
	 * `board project add`: the one operation that creates the file. The order
	 * is "`board project add`" of docs/design.md, step by step; `apply` adds
	 * the project and its event, on a fresh file after the schema and
	 * `board_created`, on an existing board inside `SAVEPOINT op`.
	 */
	static async create<T>(
		env: Env,
		clock: Clock,
		actor: string,
		apply: (tx: Tx, now: Date) => Promise<T>,
	): Promise<Written<T>> {
		try {
			mkdirSync(env.dir, { recursive: true });
		} catch (error) {
			rethrow(error);
		}
		const store = new Store(connect(env.file), env.file, clock);
		try {
			await store.client.$connect();
			await store.client.$executeRawUnsafe("PRAGMA synchronous = FULL");
			const id = await pragma(store.client, "application_id");
			if (id !== 0 && id !== APPLICATION_ID) {
				throw new Refusal(notABoard(env.file));
			}
			try {
				await store.client.$queryRawUnsafe("PRAGMA journal_mode = WAL");
			} catch (error) {
				// Refused at once while another first `project add` holds the
				// file: go on, since the lock statement below waits.
				if (outcome(error)?.code !== "busy") throw error;
			}
			const result = await store.client.$transaction(async (tx) => {
				// The lock statement of a file that may have no `project` table.
				await tx.$executeRawUnsafe(`PRAGMA application_id = ${APPLICATION_ID}`);
				const now = clock.now();
				// A fresh file not in WAL is one whose creator died before
				// committing: the refused switch never stands for its success.
				const mode = await tx.$queryRawUnsafe<{ journal_mode: string }[]>(
					"PRAGMA journal_mode",
				);
				if (mode[0]?.journal_mode !== "wal") throw new Refusal(busy());
				if ((await count(tx)) === 0) {
					for (const statement of DDL) await tx.$executeRawUnsafe(statement);
					await tx.event.create({
						data: { at: stamp(now), actor, kind: "board_created", data: "{}" },
					});
					return { value: await apply(tx, now), swept: [] };
				}
				const version = await pragma(tx, "user_version");
				if (version !== SCHEMA_VERSION) {
					const tables = await tx.$queryRawUnsafe<unknown[]>(
						"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project'",
					);
					throw new Refusal(
						version === 0 && tables.length === 0
							? notABoard(env.file)
							: schemaMismatch(env.file, version, SCHEMA_VERSION),
					);
				}
				return store.sweepAndApply(tx, now, actor, (op) => apply(op, now));
			}, OPTIONS);
			return unwrap(result);
		} catch (error) {
			rethrow(error);
		} finally {
			await store.close();
		}
	}

	/**
	 * One write, in the order of "Every operation": the lock statement, `now`,
	 * `user_version`, resolution, the machine-wide sweep, `SAVEPOINT op`, the
	 * change. A Refusal from `apply` commits the sweep and is thrown after.
	 */
	async write<R, T>(op: WriteOp<R, T>): Promise<Written<T>> {
		try {
			const result = await this.client.$transaction(async (tx) => {
				// No statement precedes it: a write that has read first fails
				// SQLITE_BUSY_SNAPSHOT in WAL without consulting the busy handler.
				await tx.$executeRawUnsafe(LOCK);
				const now = this.clock.now();
				await this.checkVersion(tx);
				const resolved = await op.resolve(tx, now);
				return this.sweepAndApply(tx, now, op.actor, (inner) =>
					op.apply(inner, now, resolved),
				);
			}, OPTIONS);
			return unwrap(result);
		} catch (error) {
			rethrow(error);
		}
	}

	/** One read: a deferred transaction, so its queries see one snapshot. */
	async read<T>(fn: (tx: Tx, now: Date) => Promise<T>): Promise<T> {
		try {
			return await this.client.$transaction(async (tx) => {
				const now = this.clock.now();
				await this.checkVersion(tx);
				return fn(tx, now);
			}, OPTIONS);
		} catch (error) {
			rethrow(error);
		}
	}

	async close(): Promise<void> {
		await this.client.$disconnect();
	}

	private async checkVersion(tx: Tx | PrismaClient): Promise<void> {
		const version = await pragma(tx, "user_version");
		if (version !== SCHEMA_VERSION) {
			throw new Refusal(schemaMismatch(this.file, version, SCHEMA_VERSION));
		}
	}

	/**
	 * Expiry, exactly once: every write deletes every project's lapsed
	 * claims and logs each in its task's project, so however many processes
	 * notice a lapse, one event is written.
	 */
	private async sweepAndApply<T>(
		tx: Tx,
		now: Date,
		actor: string,
		apply: (op: Tx) => Promise<T>,
	): Promise<Outcome<T>> {
		const swept: number[] = [];
		for (const claim of await tx.$queryRawTyped(sweep(stamp(now)))) {
			const task = await tx.task.update({
				where: { id: Number(claim.task_id) },
				data: { status: "ready" },
			});
			const event = await tx.event.create({
				data: {
					at: stamp(now),
					actor: "board",
					kind: "claim_expired",
					project_id: task.project_id,
					task_id: task.id,
					data: JSON.stringify({
						holder: claim.holder,
						since: claim.since,
						until: claim.until,
						by: actor,
					}),
				},
			});
			swept.push(event.id);
		}
		try {
			// A nested $transaction is SAVEPOINT op. Prisma's types leave
			// $transaction off a transaction client, its runtime does not.
			const value = await (tx as unknown as Nesting).$transaction(apply);
			return { value, swept };
		} catch (error) {
			if (error instanceof Refusal) return { refusal: error, swept };
			throw error;
		}
	}
}

type Nesting = { $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };
type Outcome<T> = Written<T> | { refusal: Refusal; swept: number[] };

function unwrap<T>(result: Outcome<T>): Written<T> {
	if ("refusal" in result) throw result.refusal;
	return result;
}

function connect(file: string): PrismaClient {
	// The adapter's `wal` option is not used: it would switch any file to WAL
	// before board has checked that the file is a board.
	return new PrismaClient({
		adapter: new PrismaBunSqlite({
			url: file === ":memory:" ? file : `file:${file}`,
		}),
	});
}

async function pragma(
	db: Tx | PrismaClient,
	name: "application_id" | "user_version",
): Promise<number> {
	const rows = await db.$queryRawUnsafe<Record<string, bigint | number>[]>(
		`PRAGMA ${name}`,
	);
	return Number(rows[0]?.[name] ?? 0);
}

async function count(db: Tx | PrismaClient): Promise<number> {
	const rows = await db.$queryRawUnsafe<{ n: bigint | number }[]>(
		"SELECT count(*) AS n FROM sqlite_master",
	);
	return Number(rows[0]?.n ?? 0);
}
