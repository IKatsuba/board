import { Database } from "bun:sqlite";
import { type Env, missingBoard } from "../env.ts";
import { Refusal } from "../errors.ts";
import {
	boardFileExists,
	notABoard,
	rethrow,
	schemaMismatch,
} from "./outcome.ts";
import { APPLICATION_ID, SCHEMA_VERSION } from "./store.ts";

/**
 * A read-only connection on the board for `board watch` and `board sql`,
 * which Prisma's adapter cannot open read-only. A read-only open creates
 * nothing, so it never makes a board.
 */
export function openReader(env: Env): Database {
	// SQLITE_CANTOPEN is both "not there" and "not readable": only the first
	// is no_board; the second is storage, with SQLite's message.
	if (!boardFileExists(env.file)) throw new Refusal(missingBoard(env));
	let db: Database | null = null;
	try {
		db = new Database(env.file, { readonly: true, strict: true });
		// A reader meets the busy handler only during WAL recovery.
		db.run("PRAGMA busy_timeout = 5000");
		const one = <T>(sql: string) =>
			(db as Database).query<T, []>(sql).get() as T;
		if (one<{ n: number }>("SELECT count(*) AS n FROM sqlite_master").n === 0) {
			throw new Refusal(missingBoard(env));
		}
		if (
			one<{ application_id: number }>("PRAGMA application_id")
				.application_id !== APPLICATION_ID
		) {
			throw new Refusal(notABoard(env.file));
		}
		const version = one<{ user_version: number }>(
			"PRAGMA user_version",
		).user_version;
		if (version !== SCHEMA_VERSION) {
			throw new Refusal(schemaMismatch(env.file, version, SCHEMA_VERSION));
		}
		return db;
	} catch (error) {
		db?.close();
		rethrow(error);
	}
}
