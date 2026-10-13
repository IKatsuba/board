import type { Database } from "bun:sqlite";
import type { Env } from "../env.ts";
import { refuse } from "../errors.ts";
import { openReader } from "../store/reader.ts";

/** A value SQLite returned: what bun:sqlite gives for each storage class. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** What `board sql` came to; the CLI owns the exit codes. */
export type SqlOutcome =
	| { kind: "rows"; columns: string[]; rows: SqlValue[][] }
	/** SQLITE_READONLY: a write, refused when it ran, nothing written. */
	| { kind: "readonly"; message: string }
	/** A statement with parameters: a usage error. */
	| { kind: "parameters"; count: number }
	/** Any other failure of the statement, in SQLite's own words. */
	| { kind: "failed"; message: string };

/**
 * The project tables, each narrowed to one project under its own name; a
 * store test checks that every table with a project_id or a task_id is here.
 */
export const PROJECT_VIEWS: Readonly<Record<string, (id: number) => string>> = {
	project: (id) => `SELECT * FROM main.project WHERE id = ${id}`,
	task: (id) => `SELECT * FROM main.task WHERE project_id = ${id}`,
	milestone: (id) => `SELECT * FROM main.milestone WHERE project_id = ${id}`,
	waits: (id) => `SELECT * FROM main.waits WHERE project_id = ${id}`,
	event: (id) => `SELECT * FROM main.event WHERE project_id = ${id}`,
	claim: (id) =>
		`SELECT c.* FROM main.claim c JOIN main.task t ON t.id = c.task_id WHERE t.project_id = ${id}`,
	question: (id) =>
		`SELECT q.* FROM main.question q JOIN main.task t ON t.id = q.task_id WHERE t.project_id = ${id}`,
};

/**
 * Runs one statement on a throwaway read-only connection. The boundary is
 * SQLite's own judgement: the read-only open, then `query_only`, which
 * closes what the open alone leaves (VACUUM INTO writing a copy elsewhere).
 * With `project`, temporary views shadow the project tables, so the query
 * sees one project; `main.<table>` still sees every one. Only the first
 * statement of the text runs: bun:sqlite exposes no tail.
 */
export function runSql(
	env: Env,
	query: string,
	project: string | null,
): SqlOutcome {
	const db = openReader(env);
	try {
		if (project !== null) narrow(db, project);
		db.run("PRAGMA query_only = 1");
		let statement: ReturnType<Database["prepare"]>;
		try {
			statement = db.prepare(query);
		} catch (error) {
			return failed(error);
		}
		if (statement.paramsCount > 0) {
			return { kind: "parameters", count: statement.paramsCount };
		}
		try {
			const rows = statement.values() as SqlValue[][];
			return { kind: "rows", columns: statement.columnNames, rows };
		} catch (error) {
			return failed(error);
		}
	} finally {
		db.close();
	}
}

/** The project's id, from board's own read, then one view per table. */
function narrow(db: Database, key: string): void {
	const row = db
		.query<{ id: number }, [string]>("SELECT id FROM project WHERE key = ?")
		.get(key);
	if (row === null) {
		refuse({
			code: "not_found",
			message: `No project ${key.toUpperCase()} on this machine.`,
			next: "`board project ls` lists the keys there are.",
			details: { what: "project", id: key.toUpperCase() },
		});
	}
	// The id is board's own integer, written as a literal because views take
	// no parameters; nothing the person typed reaches this DDL.
	for (const [table, select] of Object.entries(PROJECT_VIEWS)) {
		db.run(`CREATE TEMP VIEW ${table} AS ${select(row.id)}`);
	}
}

function failed(error: unknown): SqlOutcome {
	const { code, message } = error as { code?: string; message?: string };
	if (code?.startsWith("SQLITE_READONLY")) {
		return { kind: "readonly", message: String(message) };
	}
	if (code === undefined) throw error;
	return { kind: "failed", message: String(message) };
}
