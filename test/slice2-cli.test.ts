import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@cliffy/command";
import { Board } from "../src/board.ts";
import type { Deps } from "../src/cli/io.ts";
import { buildCli } from "../src/cli/root.ts";
import { SystemClock } from "../src/clock.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { outputs } from "../src/schemas.ts";
import { Store } from "../src/store/store.ts";
import { expectValid } from "./helpers/schema.ts";

test("next usage rejects unoffered scope and malformed milestone before storage", async () => {
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
				throw new Error("Must not run");
			},
		},
		cwd: "/nowhere",
		colors: false,
		exitCode: 0,
	};
	for (const args of [
		["next", "--all"],
		["next", "--milestone", "bad name"],
		["next", "-p", "*"],
	])
		await expect(buildCli(deps).noExit().parse(args)).rejects.toBeInstanceOf(
			ValidationError,
		);
	expect(out).toEqual([]);
	expect(err).toEqual([]);
});

test("source next prints escaped human text, exact JSON and no data when nothing is ready", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice2-next-cli-");
	const env = {
		dir: join(dir, "board"),
		file: join(dir, "board", "board.db"),
		boardDirSet: true,
	};
	const runner = {
		async commonDir() {
			throw new Error("Explicit project should avoid git");
		},
	};
	const ctx = new Place("/unregistered", runner);
	const title = "Control\u001b[2J\u009b title";
	const main = join(import.meta.dir, "..", "src", "main.ts");
	const source = (...args: string[]) => {
		const result = Bun.spawnSync(
			[process.execPath, main, "next", "-p", "t", ...args],
			{ cwd: dir, env: { ...process.env, BOARD_DIR: env.dir } },
		);
		return {
			code: result.exitCode,
			out: result.stdout.toString(),
			err: result.stderr.toString(),
		};
	};
	try {
		await Store.create(env, SystemClock, "owner", (tx, now) =>
			addProject(tx, now, "owner", {
				key: "T",
				name: "Test",
				directory: "/unregistered",
			}),
		);
		const board = new Board(await Store.open(env, SystemClock));
		try {
			await board.taskAdd(ctx, { actor: "tester", project: "T", title });
			const expected = await board.taskNext(ctx, { project: "T" });
			const json = source("--json");
			expect(json.code).toBe(0);
			expect(json.err).toBe("");
			expect(JSON.parse(json.out)).toEqual(expected);
			expectValid(outputs.next, JSON.parse(json.out));
			const human = source();
			expect(human.code).toBe(0);
			expect(human.out).toContain("T-1");
			for (const stream of [human.out, human.err]) {
				expect(stream).toContain("Control\\u001b[2J\\u009b title");
				expect(stream).not.toContain("\u001b");
				expect(stream).not.toContain("\u009b");
			}
			await board.taskUpdate({ actor: "tester", key: "T-1", status: "done" });
			expect(source()).toEqual({
				code: 0,
				out: "",
				err: "nothing ready in T\n",
			});
		} finally {
			await board.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
