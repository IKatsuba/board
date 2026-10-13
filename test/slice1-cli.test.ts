import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@cliffy/command";
import { Board } from "../src/board.ts";
import type { Deps } from "../src/cli/io.ts";
import { buildCli } from "../src/cli/root.ts";
import { SystemClock } from "../src/clock.ts";
import { boardEnv, type Env } from "../src/env.ts";
import { ProcessGitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { errorShape, outputs } from "../src/schemas.ts";
import { Store } from "../src/store/store.ts";
import { expectValid } from "./helpers/schema.ts";

const main = join(import.meta.dir, "..", "src", "main.ts");

function source(boardDir: string, cwd: string, ...args: string[]) {
	const result = Bun.spawnSync([process.execPath, main, ...args], {
		cwd,
		env: {
			...process.env,
			BOARD_DIR: boardDir,
			PWD: "/false-working-directory",
		},
	});
	return {
		code: result.exitCode,
		out: result.stdout.toString(),
		err: result.stderr.toString(),
	};
}

function valid(schema: unknown, value: unknown) {
	expectValid(schema, value);
}

test("in-process root rejects usage before opening storage or emitting data", async () => {
	const out: string[] = [];
	const err: string[] = [];
	const deps: Deps = {
		io: { out: (line) => out.push(line), err: (line) => err.push(line) },
		env: {
			code: "no_board",
			message: "Must not be reached",
			next: "",
			details: { reason: "no_home" },
		},
		clock: SystemClock,
		runner: {
			async commonDir() {
				throw new Error("Must not run git");
			},
		},
		cwd: "/nowhere",
		colors: false,
		exitCode: 0,
	};
	for (const args of [
		["ls", "--all", "--project", "T"],
		["show", "T-0"],
		["ls", "--limit", "0"],
		["project", "ls", "-p", "T"],
	]) {
		await expect(buildCli(deps).noExit().parse(args)).rejects.toBeInstanceOf(
			ValidationError,
		);
	}
	expect(out).toEqual([]);
	expect(err).toEqual([]);
});

test("source reads on a missing board create nothing and separate usage from refusals", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice1-source-errors-");
	const boardDir = join(dir, "missing");
	try {
		for (const args of [
			["ls", "--json"],
			["show", "T-1", "--json"],
			["project", "ls", "--json"],
		]) {
			const result = source(boardDir, dir, ...args);
			expect(result.code).toBe(1);
			expect(result.out).toBe("");
			const body = JSON.parse(result.err);
			await valid(errorShape, body);
			expect(body.error).toMatchObject({
				code: "no_board",
				details: { file: join(boardDir, "board.db"), reason: "missing" },
			});
		}
		const bad = source(boardDir, dir, "ls", "--limit", "201", "--json");
		expect(bad.code).toBe(64);
		expect(bad.out).toBe("");
		expect(bad.err).toStartWith("board: ");
		expect(bad.err).not.toContain("Usage:");
		expect(existsSync(boardDir)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(Bun.which("git") === null)(
	"Slice 1 Done when: source CLI in a linked worktree",
	async () => {
		const dir = realpathSync(mkdtempSync("/private/tmp/board-slice1-e2e-"));
		const repo = join(dir, "repo");
		const boardDir = join(dir, "board");
		const git = (cwd: string, ...args: string[]) => {
			const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
				env: {
					...process.env,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
			});
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		};
		try {
			mkdirSync(repo);
			git(repo, "init", "-q");
			git(
				repo,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"--allow-empty",
				"-qm",
				"Initial test commit",
			);
			git(repo, "worktree", "add", "-q", "-b", "fixture", join(dir, "linked"));
			const cwd = join(dir, "linked", "sub");
			mkdirSync(cwd);
			const registered = source(
				boardDir,
				dir,
				"project",
				"add",
				"--actor",
				"owner",
				"T",
				"--dir",
				repo,
			);
			expect(registered.code).toBe(0);
			expect(registered.out).toContain(repo);
			expect(registered.err).toContain("keys T-1, T-2");
			// The CLI has no add yet: the write goes through Board from the
			// worktree's subdirectory, resolving through git as a command does.
			const board = new Board(
				await Store.open(boardEnv({ BOARD_DIR: boardDir }) as Env, SystemClock),
			);
			const added = await board.taskAdd(
				new Place(cwd, new ProcessGitRunner()),
				{
					actor: "tester",
					title: "Progress 50% 中文",
					body: "Body from linked worktree",
				},
			);
			await board.close();
			expect(added.task.key).toBe("T-1");
			const ls = source(boardDir, cwd, "ls", "--contains", "50%");
			expect(ls.code).toBe(0);
			expect(ls.out).toContain("T-1");
			expect(ls.out).toContain("Progress 50% 中文");
			expect(ls.err).toContain("1 task in T");
			const show = source(boardDir, dir, "show", "T-1");
			expect(show.code).toBe(0);
			expect(show.out).toContain("Body from linked worktree");
			expect(show.out).toContain("task_added");
			const json = source(boardDir, dir, "show", "T-1", "--json");
			expect(json.code).toBe(0);
			const read = JSON.parse(json.out);
			valid(outputs.show, read);
			expect(read).toMatchObject({
				task: { key: "T-1", title: "Progress 50% 中文" },
				events: [
					{ kind: "task_added", project: "T", task: "T-1", actor: "tester" },
				],
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	20_000,
);

test("Bun-spawned CLI interrupted during a busy wait changes no rows or events", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice1-interrupt-");
	const boardDir = join(dir, "board");
	const other = join(dir, "other");
	mkdirSync(other);
	let holder: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | null =
		null;
	let waiting: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | null =
		null;
	try {
		expect(
			source(
				boardDir,
				dir,
				"project",
				"add",
				"--actor",
				"owner",
				"T",
				"--dir",
				dir,
			).code,
		).toBe(0);
		const file = join(boardDir, "board.db");
		const snapshot = () => {
			const db = new Database(file, { readonly: true });
			try {
				return {
					projects: db.query("SELECT * FROM project ORDER BY id").all(),
					events: db.query("SELECT * FROM event ORDER BY id").all(),
				};
			} finally {
				db.close();
			}
		};
		const before = snapshot();
		holder = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "helpers", "holder.ts"),
				"hold",
				file,
				"10000",
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		expect(
			new TextDecoder()
				.decode((await holder.stdout.getReader().read()).value)
				.trim(),
		).toBe("held");
		waiting = Bun.spawn(
			[
				process.execPath,
				main,
				"project",
				"add",
				"--actor",
				"owner",
				"OTHER",
				"--dir",
				other,
			],
			{
				cwd: dir,
				env: { ...process.env, BOARD_DIR: boardDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await Bun.sleep(1000);
		expect(waiting.exitCode).toBeNull();
		const sent = Date.now();
		waiting.kill("SIGINT");
		await waiting.exited;
		expect(waiting.signalCode).toBe("SIGINT");
		expect(Date.now() - sent).toBeLessThan(1000);
		expect(await new Response(waiting.stdout).text()).toBe("");
		expect(snapshot()).toEqual(before);
		holder.kill("SIGKILL");
		await holder.exited;
		expect(snapshot()).toEqual(before);
		expect(
			source(
				boardDir,
				dir,
				"project",
				"add",
				"--actor",
				"owner",
				"OTHER",
				"--dir",
				other,
			).code,
		).toBe(0);
	} finally {
		for (const child of [waiting, holder]) {
			if (child !== null) {
				if (child.exitCode === null) child.kill();
				await child.exited;
			}
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);
