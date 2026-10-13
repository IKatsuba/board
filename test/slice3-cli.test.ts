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

test("status and chain CLI reject unoffered options before touching storage", async () => {
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
		["status", "--all"],
		["status", "-p", "*"],
		["milestone", "ls", "--all"],
		["milestone", "rm", "--actor", "owner", "v1", "--force"],
		["project", "rm", "--actor", "owner", "T", "--force"],
	])
		await expect(buildCli(deps).noExit().parse(args)).rejects.toBeInstanceOf(
			ValidationError,
		);
	expect(out).toEqual([]);
	expect(err).toEqual([]);
});

test("source status and chain escape human cells while preserving JSON; project removal clears an empty chain", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice3-cli-");
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
	const main = join(import.meta.dir, "..", "src", "main.ts");
	const source = (...args: string[]) => {
		const result = Bun.spawnSync([process.execPath, main, ...args], {
			cwd: dir,
			env: { ...process.env, BOARD_DIR: env.dir },
		});
		return {
			code: result.exitCode,
			out: result.stdout.toString(),
			err: result.stderr.toString(),
		};
	};
	const name = "Project\u001b[2J\u009b";
	const delivers = "Delivers\u001b[2J\u009b😀";
	try {
		await Store.create(env, SystemClock, "owner", (tx, now) =>
			addProject(tx, now, "owner", { key: "T", name, directory: dir }),
		);
		const board = new Board(await Store.open(env, SystemClock));
		try {
			await board.milestoneAdd(ctx, {
				actor: "tester",
				project: "T",
				name: "v1",
				delivers,
			});
			await board.taskAdd(ctx, {
				actor: "tester",
				project: "T",
				title: "Task",
				milestone: "v1",
			});
			await board.taskClaim({
				actor: "holder\u001b\u009b",
				key: "T-1",
				minutes: 90,
				directory: "/claim\u001b\u009b",
				branch: "branch\u001b\u009b",
			});
		} finally {
			await board.close();
		}
		const json = source("status", "-p", "t", "--json");
		expect(json.code).toBe(0);
		expect(json.err).toBe("");
		const status = JSON.parse(json.out);
		expectValid(outputs.status, status);
		expect(status).toMatchObject({
			project: { name },
			milestones: [{ delivers }],
			claims: [
				{
					holder: "holder\u001b\u009b",
					directory: "/claim\u001b\u009b",
					branch: "branch\u001b\u009b",
				},
			],
		});
		const human = source("status", "-p", "T");
		expect(human.code).toBe(0);
		for (const value of ["Project", "Delivers", "holder", "/claim", "branch"])
			expect(human.out).toContain(`${value}\\u001b`);
		expect(human.out).toContain("\\u009b");
		expect(human.out).toContain("😀");
		for (const stream of [human.out, human.err]) {
			expect(stream).not.toContain("\u001b");
			expect(stream).not.toContain("\u009b");
		}
		const chain = source("milestone", "-p", "T", "--json");
		expect(chain).toEqual(source("milestone", "ls", "-p", "T", "--json"));
		expect(JSON.parse(chain.out)).toEqual(status.milestones);
		const humanChain = source("milestone", "ls", "-p", "T");
		expect(humanChain.code).toBe(0);
		expect(humanChain.out).toContain("Delivers\\u001b[2J\\u009b😀");
		expect(humanChain.err).toBe("1 milestone\n");
		const refusal = source("project", "rm", "--actor", "owner", "T");
		expect(refusal.code).toBe(1);
		expect(refusal.out).toBe("");
		expect(refusal.err).toContain("tasks");
		const emptyStore = await Store.open(env, SystemClock);
		const empty = new Board(emptyStore);
		try {
			await emptyStore.write({
				actor: "owner",
				resolve: async () => null,
				apply: (tx, now) =>
					addProject(tx, now, "owner", {
						key: "E",
						name: "Empty",
						directory: "/empty\u001b\u009b",
					}),
			});
			await empty.milestoneAdd(ctx, {
				actor: "tester",
				project: "E",
				name: "empty",
				delivers: "Empty",
			});
		} finally {
			await empty.close();
		}
		expect(source("project", "rm", "--actor", "owner", "e")).toEqual({
			code: 0,
			out: "removed E (/empty\\u001b\\u009b)\n",
			err: "",
		});
		expect(
			JSON.parse(source("project", "ls", "--json").out).projects,
		).toHaveLength(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
