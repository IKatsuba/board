import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@cliffy/command";
import type { Deps } from "../src/cli/io.ts";
import { buildCli } from "../src/cli/root.ts";
import { SystemClock } from "../src/clock.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";

test("source SQL handles empty rows and blobs, preserves JSON column controls, and distinguishes literal parameter marks", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice5-sql-cli-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	const main = join(import.meta.dir, "..", "src", "main.ts");
	const source = (query: string, ...args: string[]) => {
		const r = Bun.spawnSync([process.execPath, main, "sql", query, ...args], {
			cwd: dir,
			env: { ...process.env, BOARD_DIR: dir },
		});
		return {
			code: r.exitCode,
			out: r.stdout.toString(),
			err: r.stderr.toString(),
		};
	};
	try {
		await Store.create(env, SystemClock, "owner", async (tx, now) => {
			for (const key of ["A", "B"])
				await addProject(tx, now, "owner", {
					key,
					name: key,
					directory: `/unregistered/${key}`,
				});
		});
		const column = "column\u001b\u009b";
		const value = "value\u001b\u009b😀";
		const query = `SELECT '${value}' AS "${column}", NULL AS missing, x'' AS empty_blob, x'00ff80' AS binary`;
		const json = source(query, "--json");
		expect(json.code).toBe(0);
		expect(json.err).toBe("1 row\n");
		expect(JSON.parse(json.out)).toEqual([
			{ [column]: value, missing: null, empty_blob: "", binary: "00ff80" },
		]);
		const human = source(query);
		expect(human.code).toBe(0);
		expect(human.out).toContain("column\\u001b\\u009b");
		expect(human.out).toContain("value\\u001b\\u009b😀");
		expect(human.out).toContain("NULL");
		expect(human.out).toContain("00ff80");
		expect(human.out).not.toContain("\u001b");
		expect(human.out).not.toContain("\u009b");
		const empty = source("SELECT id AS identifier FROM task WHERE 0");
		expect(empty.code).toBe(0);
		expect(empty.out).toContain("identifier");
		expect(empty.err).toBe("0 rows\n");
		expect(source("SELECT id FROM task WHERE 0", "--json")).toEqual({
			code: 0,
			out: "[]\n",
			err: "0 rows\n",
		});
		expect(
			source(
				"SELECT '?' AS positional, ':named' AS named, '@named' AS atname, '$named' AS dollar",
				"--json",
			),
		).toEqual({
			code: 0,
			out: `${JSON.stringify([{ positional: "?", named: ":named", atname: "@named", dollar: "$named" }])}\n`,
			err: "1 row\n",
		});
		const parameters = source("SELECT ?5");
		expect(parameters.code).toBe(64);
		expect(parameters.out).toBe("");
		expect(parameters.err).toContain("5 parameters");
		expect(
			JSON.parse(source("SELECT key FROM project ORDER BY key", "--json").out),
		).toEqual([{ key: "A" }, { key: "B" }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the injected root refuses wildcard project scope and absent query before opening a board", async () => {
	const out: string[] = [];
	const err: string[] = [];
	const deps: Deps = {
		io: { out: (text) => out.push(text), err: (text) => err.push(text) },
		env: {
			code: "no_board",
			message: "Must not be reached",
			next: "",
			details: { reason: "no_home" },
		},
		clock: SystemClock,
		runner: {
			async commonDir() {
				throw new Error("SQL never needs git");
			},
		},
		cwd: "/nowhere",
		colors: false,
		exitCode: 0,
	};
	for (const args of [
		["sql"],
		["sql", "SELECT 1", "-p", "*"],
		["sql", "SELECT 1", "--all"],
	])
		await expect(buildCli(deps).noExit().parse(args)).rejects.toBeInstanceOf(
			ValidationError,
		);
	expect(out).toEqual([]);
	expect(err).toEqual([]);
});
