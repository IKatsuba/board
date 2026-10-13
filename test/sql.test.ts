import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { SystemClock } from "../src/clock.ts";
import type { Env } from "../src/env.ts";
import { Refusal } from "../src/errors.ts";
import type { GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { PROJECT_VIEWS, runSql } from "../src/sql/readonly.ts";
import { Store } from "../src/store/store.ts";

const outside: GitRunner = {
	commonDir: async () => ({
		kind: "exit",
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository\n",
	}),
};

let dir: string;
let env: Env;

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-sql-")));
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
	const board = new Board(await Store.open(env, SystemClock));
	for (const p of ["a", "b"]) {
		const ctx = new Place(join(dir, p), outside);
		await board.taskAdd(ctx, { actor: "main", title: `${p} one` });
		await board.taskAdd(ctx, { actor: "main", title: `${p} two` });
	}
	await board.taskClaim({ actor: "main", key: "A-1", minutes: 30 });
	await board.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The board's state as bytes of meaning: rows, version, and the file's mtime. */
function fingerprint() {
	const db = new Database(env.file, { readonly: true });
	const tables = [
		"project",
		"task",
		"milestone",
		"waits",
		"claim",
		"question",
		"event",
	];
	const rows = tables.map((t) =>
		db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all(),
	);
	const version = db.query("PRAGMA user_version").get();
	db.close();
	return { rows, version, mtime: statSync(env.file).mtimeMs };
}

describe("the read-only matrix of data.md §5", () => {
	test.each([
		["SELECT count(*) AS n FROM task", "rows"],
		["SELECT count(*) AS n FROM main.task", "rows"],
		["EXPLAIN SELECT * FROM task", "rows"],
		["PRAGMA journal_mode", "rows"],
		["ATTACH ':memory:' AS scratch", "rows"],
		["PRAGMA query_only = 0", "rows"],
		[
			"INSERT INTO task (project_id, number, title, created_at, created_by) VALUES (1, 9, 'x', 'x', 'x')",
			"readonly",
		],
		["DELETE FROM task", "readonly"],
		["UPDATE task SET title = 'x'", "readonly"],
		["CREATE TABLE extra (x)", "readonly"],
		["CREATE TEMP TABLE extra (x)", "readonly"],
		["VACUUM", "readonly"],
		["PRAGMA user_version = 9", "readonly"],
		["PRAGMA wal_checkpoint", "readonly"],
		["REINDEX", "readonly"],
		["ANALYZE", "readonly"],
		["PRAGMA journal_mode = DELETE", "failed"],
	] as const)("%s → %s, nothing written", (query, kind) => {
		const before = fingerprint();
		expect(runSql(env, query, null).kind).toBe(kind);
		expect(fingerprint()).toEqual(before);
	});

	test("VACUUM INTO is refused; it leaves an empty file at the path it was given (loss 2)", () => {
		const before = fingerprint();
		const target = join(dir, "copy.db");
		expect(runSql(env, `VACUUM INTO '${target}'`, null).kind).toBe("readonly");
		expect(statSync(target).size).toBe(0);
		expect(fingerprint()).toEqual(before);
	});

	test("ATTACH of a new file fails as SQLite says, and creates nothing", () => {
		const before = fingerprint();
		const target = join(dir, "new.db");
		expect(runSql(env, `ATTACH '${target}' AS other`, null)).toMatchObject({
			kind: "failed",
		});
		expect(existsSync(target)).toBe(false);
		expect(fingerprint()).toEqual(before);
	});

	test("with -p, a write on a view is SQLite's own refusal; DROP VIEW is read-only", () => {
		const before = fingerprint();
		expect(runSql(env, "DELETE FROM task", "a")).toMatchObject({
			kind: "failed",
			message: expect.stringContaining(
				"cannot modify task because it is a view",
			),
		});
		expect(runSql(env, "UPDATE task SET title = 'x'", "a").kind).toBe("failed");
		expect(runSql(env, "DROP VIEW task", "a").kind).toBe("readonly");
		expect(fingerprint()).toEqual(before);
	});

	test("only the first statement runs (loss 3)", () => {
		const before = fingerprint();
		expect(runSql(env, "SELECT 1 AS one; DELETE FROM task", null)).toEqual({
			kind: "rows",
			columns: ["one"],
			rows: [[1]],
		});
		expect(fingerprint()).toEqual(before);
	});

	test("a statement with parameters is a usage error", () => {
		expect(runSql(env, "SELECT * FROM task WHERE id = ?", null)).toEqual({
			kind: "parameters",
			count: 1,
		});
		expect(runSql(env, "SELECT :a, :b", null)).toEqual({
			kind: "parameters",
			count: 2,
		});
	});

	test("a query that fails as SQL is SQLite's message", () => {
		expect(runSql(env, "SELEC 1", null)).toMatchObject({
			kind: "failed",
			message: expect.stringContaining("syntax error"),
		});
		expect(runSql(env, "SELECT * FROM nope", null)).toMatchObject({
			kind: "failed",
		});
	});
});

describe("-p narrows; it does not wall off", () => {
	test("unqualified names see one project, main.<table> sees all", () => {
		const one = (query: string, project: string | null) => {
			const outcome = runSql(env, query, project);
			if (outcome.kind !== "rows") throw new Error(outcome.kind);
			return outcome.rows;
		};
		expect(one("SELECT title FROM task ORDER BY id", "a")).toEqual([
			["a one"],
			["a two"],
		]);
		expect(one("SELECT key FROM project", "B")).toEqual([["B"]]);
		expect(one("SELECT count(*) FROM claim", "b")).toEqual([[0]]);
		expect(one("SELECT count(*) FROM claim", "a")).toEqual([[1]]);
		expect(one("SELECT count(*) FROM event", "a")).toEqual(
			one("SELECT count(*) FROM main.event WHERE project_id = 1", null),
		);
		expect(one("SELECT count(*) FROM main.task", "a")).toEqual([[4]]);
		expect(one("SELECT count(*) FROM task", null)).toEqual([[4]]);
	});

	test("an unknown key is not_found", () => {
		expect(() => runSql(env, "SELECT 1", "zz")).toThrow(Refusal);
	});

	test("every table with a project_id or a task_id has a view", () => {
		const db = new Database(env.file, { readonly: true });
		const tables = (
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
				)
				.all() as { name: string }[]
		).map((t) => t.name);
		const scoped = tables.filter((table) =>
			(
				db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
			).some(
				(column) => column.name === "project_id" || column.name === "task_id",
			),
		);
		db.close();
		expect(scoped.length).toBeGreaterThan(0);
		for (const table of [...scoped, "project"])
			expect(Object.keys(PROJECT_VIEWS)).toContain(table);
	});

	test("the views keep their tables' columns", () => {
		const columns = (query: string, project: string | null) => {
			const outcome = runSql(env, query, project);
			return outcome.kind === "rows" ? outcome.columns : [];
		};
		for (const table of Object.keys(PROJECT_VIEWS)) {
			expect(columns(`SELECT * FROM ${table} LIMIT 0`, "a")).toEqual(
				columns(`SELECT * FROM main.${table} LIMIT 0`, null),
			);
		}
	});
});

test("a missing board is no_board and nothing is created", () => {
	const missing: Env = {
		dir: join(dir, "none"),
		file: join(dir, "none", "board.db"),
		boardDirSet: true,
	};
	expect(() => runSql(missing, "SELECT 1", null)).toThrow(Refusal);
	expect(existsSync(missing.file)).toBe(false);
});
