import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { SystemClock } from "../src/clock.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { PROJECT_VIEWS, runSql, type SqlValue } from "../src/sql/readonly.ts";
import { Store } from "../src/store/store.ts";

test("every scoped table has a populated view with exactly its own project's rows, unchanged columns and explicit main escape", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice5-sql-views-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	const ctx = new Place("/unregistered", {
		async commonDir() {
			throw new Error("Explicit project should avoid git");
		},
	});
	try {
		await Store.create(env, SystemClock, "owner", async (tx, now) => {
			for (const key of ["A", "B"])
				await addProject(tx, now, "owner", {
					key,
					name: key,
					directory: `/${key.toLowerCase()}`,
				});
		});
		const board = new Board(await Store.open(env, SystemClock));
		try {
			for (const project of ["A", "B"]) {
				await board.milestoneAdd(ctx, {
					actor: "tester",
					project,
					name: "v1",
					delivers: "Milestone",
				});
				await board.taskAdd(ctx, {
					actor: "tester",
					project,
					title: "First",
					milestone: "v1",
				});
				await board.taskAdd(ctx, {
					actor: "tester",
					project,
					title: "Second",
					waits: [`${project}-1`],
				});
				await board.taskClaim({
					actor: "worker",
					key: `${project}-1`,
					minutes: 10,
				});
				await board.questionAsk({
					actor: "tester",
					key: `${project}-2`,
					text: "Which?",
					options: [{ label: "A" }, { label: "B" }],
					recommended: 1,
				});
			}
		} finally {
			await board.close();
		}
		const db = new Database(env.file, { readonly: true });
		try {
			const tables = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
				)
				.all();
			const scoped = tables
				.filter(
					({ name }) =>
						name === "project" ||
						db
							.query<{ name: string }, []>(`PRAGMA table_info(${name})`)
							.all()
							.some((c) => c.name === "project_id" || c.name === "task_id"),
				)
				.map((t) => t.name);
			expect(Object.keys(PROJECT_VIEWS).sort()).toEqual(scoped.sort());
			for (const key of ["A", "B"]) {
				const p = db
					.query<{ id: number }, [string]>("SELECT id FROM project WHERE key=?")
					.get(key);
				if (!p) throw new Error("Missing fixture project");
				const taskIds = new Set(
					db
						.query<{ id: number }, [number]>(
							"SELECT id FROM task WHERE project_id=?",
						)
						.all(p.id)
						.map((t) => t.id),
				);
				for (const table of scoped) {
					const all = db
						.query<Record<string, SqlValue>, []>(
							`SELECT * FROM ${table} ORDER BY 1,2`,
						)
						.all();
					const expected = all.filter((row) =>
						table === "project"
							? row.id === p.id
							: row.project_id !== undefined
								? row.project_id === p.id
								: taskIds.has(row.task_id as number),
					);
					expect(expected.length).toBeGreaterThan(0);
					const narrowed = runSql(
						env,
						`SELECT * FROM ${table} ORDER BY 1,2`,
						key.toLowerCase(),
					);
					if (narrowed.kind !== "rows")
						throw new Error(JSON.stringify(narrowed));
					expect(
						narrowed.rows.map((row) =>
							Object.fromEntries(
								narrowed.columns.map((column, i) => [column, row[i]]),
							),
						),
					).toEqual(expected);
					const wide = runSql(
						env,
						`SELECT * FROM main.${table} ORDER BY 1,2`,
						key,
					);
					if (wide.kind !== "rows") throw new Error(JSON.stringify(wide));
					expect(wide.columns).toEqual(narrowed.columns);
					expect(wide.rows).toHaveLength(all.length);
					expect(wide.rows.length).toBeGreaterThan(narrowed.rows.length);
				}
			}
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("query_only changes and TEMP view setup disappear with each throwaway SQL connection", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice5-sql-reset-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	try {
		await Store.create(env, SystemClock, "owner", (tx, now) =>
			addProject(tx, now, "owner", { key: "A", name: "A", directory: "/a" }),
		);
		expect(runSql(env, "PRAGMA query_only=0", "A").kind).toBe("rows");
		expect(runSql(env, "CREATE TEMP TABLE scratch(x)", null).kind).toBe(
			"readonly",
		);
		expect(runSql(env, "SELECT name FROM sqlite_temp_master", null)).toEqual({
			kind: "rows",
			columns: ["name"],
			rows: [],
		});
		expect(runSql(env, "PRAGMA query_only", null)).toEqual({
			kind: "rows",
			columns: ["query_only"],
			rows: [[1]],
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
