import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { DDL } from "../src/store/ddl.ts";

const at = "2026-10-13T12:00:00.000Z";
let db: Database;

beforeEach(() => {
	db = new Database(":memory:", { strict: true });
	db.run("PRAGMA foreign_keys = ON");
	for (const statement of DDL) db.run(statement);
	db.run(
		"INSERT INTO project (id, key, name, directory, created_at, created_by) VALUES (1, 'A', 'Alpha', '/alpha', ?, 'owner'), (2, 'B', 'Beta', '/beta', ?, 'owner')",
		[at, at],
	);
	db.run(
		"INSERT INTO task (id, project_id, number, title, created_at, created_by) VALUES (1, 1, 1, 'Alpha task', ?, 'tester'), (2, 2, 1, 'Beta task', ?, 'tester')",
		[at, at],
	);
});

afterEach(() => db.close());

test("all application tables are strict and waits has no rowid", () => {
	const tables = db
		.query<{ name: string; strict: number; wr: number }, []>(
			"PRAGMA table_list",
		)
		.all()
		.filter((row) => !row.name.startsWith("sqlite_"));
	expect(tables).toHaveLength(7);
	expect(tables.every((row) => row.strict === 1)).toBe(true);
	expect(tables.find((row) => row.name === "waits")?.wr).toBe(1);
});

test("task numbers are unique within a project and reusable across projects", () => {
	expect(db.query("SELECT number FROM task").all()).toHaveLength(2);
	expect(() =>
		db.run(
			"INSERT INTO task (project_id, number, title, created_at, created_by) VALUES (1, 1, 'Duplicate', ?, 'tester')",
			[at],
		),
	).toThrow();
});

test("cross-project parents, waits, milestones and task events are refused", () => {
	db.run(
		"INSERT INTO milestone (id, project_id, name, delivers, position, created_at, created_by) VALUES (1, 2, 'v1', 'Beta', 1, ?, 'tester')",
		[at],
	);
	for (const sql of [
		"UPDATE task SET parent_id = 2 WHERE id = 1",
		"UPDATE task SET milestone_id = 1 WHERE id = 1",
		"INSERT INTO waits (project_id, task_id, on_id) VALUES (1, 1, 2)",
		`INSERT INTO event (at, actor, kind, project_id, task_id) VALUES ('${at}', 'tester', 'task_added', 1, 2)`,
	]) {
		expect(() => db.run(sql)).toThrow();
	}
	expect(db.query("SELECT * FROM waits").all()).toEqual([]);
});

test("a claim is unique per task and must end after it starts", () => {
	const sql =
		"INSERT INTO claim (task_id, holder, since, until) VALUES (1, ?, ?, ?)";
	expect(() => db.run(sql, ["tester", at, at])).toThrow();
	db.run(sql, ["tester", at, "2026-10-13T12:01:00.000Z"]);
	expect(() =>
		db.run(sql, ["other", at, "2026-10-13T12:02:00.000Z"]),
	).toThrow();
});

test("events require object data and the catalog's project nullability", () => {
	const sql =
		"INSERT INTO event (at, actor, kind, project_id, data) VALUES (?, 'tester', ?, ?, ?)";
	for (const data of ["[]", "null", "broken"]) {
		expect(() => db.run(sql, [at, "project_added", 1, data])).toThrow();
	}
	expect(() => db.run(sql, [at, "board_created", 1, "{}"])).toThrow();
	expect(() => db.run(sql, [at, "project_added", null, "{}"])).toThrow();
	expect(() => db.run(sql, [at, "claim_expiring", 1, "{}"])).toThrow();
});

test("history cannot be updated or deleted while its project exists", () => {
	db.run(
		"INSERT INTO event (at, actor, kind, project_id) VALUES (?, 'owner', 'project_added', 1), (?, 'board', 'board_created', NULL)",
		[at, at],
	);
	expect(() =>
		db.run("UPDATE event SET actor = 'other' WHERE id = 1"),
	).toThrow();
	expect(() => db.run("DELETE FROM event WHERE id = 1")).toThrow();
	expect(() => db.run("DELETE FROM event WHERE id = 2")).toThrow();
	expect(db.query("SELECT * FROM event").all()).toHaveLength(2);
});

test("empty project removal can remove its history with deferred foreign keys", () => {
	db.run("DELETE FROM task WHERE id = 2");
	db.run(
		"INSERT INTO event (at, actor, kind, project_id) VALUES (?, 'owner', 'project_added', 2)",
		[at],
	);
	db.transaction(() => {
		db.run("PRAGMA defer_foreign_keys = ON");
		db.run("DELETE FROM project WHERE id = 2");
		db.run("DELETE FROM event WHERE project_id = 2");
	})();
	expect(db.query("SELECT * FROM event").all()).toEqual([]);
});
