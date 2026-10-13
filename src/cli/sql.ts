import { Command, ValidationError } from "@cliffy/command";
import { runSql, type SqlValue } from "../sql/readonly.ts";
import { type Deps, envOf, refusing, shown, table } from "./io.ts";
import { projectType } from "./types.ts";

const HELP = `Run one read-only SQL statement against the board.

It runs against the stored schema and prints its rows.

The schema is the stored one: keys are not stored (a task is project_id and
number), blocked is not a status, and an expired claim is a row until a write
sweeps it. Without -p the query sees every project, and it never resolves a
project from the working directory.

The boundary is SQLite's own judgement: the board is opened read-only, and
query_only is set before your statement runs. Nothing is written to the board.
Three things follow from it:

  1. A write is refused when it runs, not before. A refusal of a write exits
     64; a write on a -p view, an ATTACH of a new file, or a change of
     journal_mode fails with SQLite's own message instead, exit 1.
  2. VACUUM INTO '<path>' leaves an empty file at <path> before it is refused:
     a write outside the board, to the path you typed, not undone.
  3. Only the first statement runs. "SELECT 1; DELETE FROM task" runs the
     SELECT and silently does not run the rest.

-p KEY narrows by temporary views: project, task, milestone, waits, event,
claim and question are views of one project under the tables' own names, so
a query reads the same with or without -p. It narrows; it does not wall off:
main.<table> and sqlite_master still see every project.

A statement with parameters is a usage error. A long query is stopped with
Ctrl-C; a read never blocks the agents' writes.`;

function cell(value: SqlValue): string {
	if (value === null) return "NULL";
	if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
	return String(value);
}

function jsonValue(value: SqlValue): unknown {
	if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
	if (typeof value === "bigint") return Number(value);
	return value;
}

/** `board sql`: one read-only statement, through the gate of src/sql. */
export function sqlCommand(deps: Deps) {
	return new Command()
		.description(HELP)
		.type("project", projectType)
		.arguments("<QUERY:string>")
		.option(
			"-p, --project <KEY:project>",
			"Narrow the project tables to one project.",
		)
		.option("--json", "Print a JSON array of row objects.")
		.action(({ project, json }, query) =>
			refusing(deps, json, async () => {
				const env = envOf(deps);
				const outcome = runSql(env, query, project ?? null);
				switch (outcome.kind) {
					case "parameters":
						throw new ValidationError(
							`The query has ${outcome.count} parameter${outcome.count === 1 ? "" : "s"}; write the values into it.`,
						);
					case "readonly":
						throw new ValidationError(
							`\`board sql\` reads; it does not write. A change goes through the command that owns it (board edit, board claim, board answer, board project edit, …), so the board and its log move together. For what no command reaches, sqlite3 against ${env.file} is the last resort, and nothing checks what it does.`,
						);
					case "failed":
						deps.io.err(`board: ${shown(outcome.message)}`);
						deps.exitCode = 1;
						return;
					case "rows":
						if (json) {
							deps.io.out(
								JSON.stringify(
									outcome.rows.map((row) =>
										Object.fromEntries(
											outcome.columns.map((column, i) => [
												column,
												jsonValue(row[i] ?? null),
											]),
										),
									),
								),
							);
						} else if (outcome.columns.length > 0) {
							deps.io.out(
								table(
									outcome.columns,
									outcome.rows.map((row) => row.map(cell)),
								),
							);
						}
						deps.io.err(
							`${outcome.rows.length} row${outcome.rows.length === 1 ? "" : "s"}`,
						);
				}
			}),
		);
}
