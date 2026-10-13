import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "@cliffy/command";
import { Board } from "../src/board.ts";
import type { Deps } from "../src/cli/io.ts";
import { buildCli, runCli } from "../src/cli/root.ts";
import { SystemClock } from "../src/clock.ts";
import { boardEnv, type Env } from "../src/env.ts";
import { ProcessGitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { defs, errorShape, outputs } from "../src/schemas.ts";
import { Store } from "../src/store/store.ts";
import { expectValid } from "./helpers/schema.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function valid(schema: unknown, value: unknown) {
	expectValid(schema, value);
}
const projectSchema = { ...defs.Project, $defs: defs };

let dir: string;
let repo: string;
let out: string[];
let err: string[];

function deps(
	cwd: string,
	env: Record<string, string> = { BOARD_DIR: join(dir, "b") },
): Deps {
	return {
		io: { out: (t) => out.push(t), err: (t) => err.push(t) },
		env: boardEnv(env),
		clock: SystemClock,
		runner: new ProcessGitRunner(),
		cwd,
		colors: false,
		exitCode: 0,
	};
}

/** Adds a task through Board, as an agent's write did before the CLI had add. */
async function addTask(
	cwd: string,
	input: { actor: string; title: string; body?: string },
) {
	const board = new Board(
		await Store.open(
			boardEnv({ BOARD_DIR: join(dir, "b") }) as Env,
			SystemClock,
		),
	);
	try {
		await board.taskAdd(new Place(cwd, new ProcessGitRunner()), input);
	} finally {
		await board.close();
	}
}

function git(cwd: string, ...args: string[]) {
	const run = Bun.spawnSync(["git", "-C", cwd, ...args]);
	if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

const run = (argv: string[], cwd = repo, env?: Record<string, string>) =>
	runCli(argv, deps(cwd, env));

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-cli-")));
	repo = join(dir, "repo");
	mkdirSync(join(repo, "sub"), { recursive: true });
	git(repo, "init", "-q");
	git(
		repo,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"x",
	);
	git(repo, "worktree", "add", "-q", join(dir, "wt"));
	mkdirSync(join(dir, "wt", "sub"));
	out = [];
	err = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("usage", () => {
	test("a bare board or board project prints help and exits 0", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		expect(await run([])).toBe(0);
		expect(await run(["project"])).toBe(0);
		expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
			expect.stringContaining("Usage:   board"),
			expect.stringContaining("Usage:   board project"),
		]);
		log.mockRestore();
	});

	test.each([
		[["nope"]],
		[["ls", "-p", "A", "--all"]],
		[["ls", "--status", "ready,bogus"]],
		[["ls", "--limit", "201"]],
		[["ls", "--offset", "-1"]],
		[["show"]],
		[["show", "nope"]],
		[["project", "add"]],
		[["project", "add", "--actor", "owner", "1BAD"]],
		[["ls", "--contains", "x".repeat(201)]],
		[["ls", "--contains", "😀".repeat(201)]],
		[["show", "T-1", "--since", "-1"]],
	])("%p is a usage error: one line, exit 64, no help", async (argv) => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		expect(await run(argv)).toBe(64);
		expect(log).not.toHaveBeenCalled();
		log.mockRestore();
		expect(out).toEqual([]);
		expect(err).toHaveLength(1);
		expect(err[0]).toStartWith("board: ");
	});

	test("the root command rejects with ValidationError and prints nothing", async () => {
		const error = spyOn(console, "error");
		await expect(
			buildCli(deps(repo)).parse(["ls", "--status", "x"]),
		).rejects.toBeInstanceOf(ValidationError);
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});

	test("--status is repeatable and comma-separated", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		out = [];
		expect(
			await run([
				"ls",
				"--status",
				"done,cancelled",
				"--status",
				"ready",
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(out[0] as string)).toMatchObject({
			project: "T",
			total: 0,
		});
	});
});

describe("commands", () => {
	test("project add creates the board; the note goes to stderr", async () => {
		expect(await run(["project", "add", "--actor", "owner", "t"])).toBe(0);
		expect(out).toHaveLength(1);
		expect(out[0]?.trim().split(/\s+/)).toEqual(["T", "repo", repo]);
		expect(err).toEqual([
			`keys T-1, T-2, …; agents started under ${repo} use it`,
		]);
	});

	test("project add --json prints the Project; a refusal under --json is the error object on stderr", async () => {
		expect(
			await run([
				"project",
				"add",
				"--actor",
				"owner",
				"T",
				"--name",
				"The repo",
				"--json",
			]),
		).toBe(0);
		const project = JSON.parse(out[0] as string);
		await valid(projectSchema, project);
		expect(project).toMatchObject({
			key: "T",
			name: "The repo",
			directory: repo,
		});
		out = [];
		expect(
			await run([
				"project",
				"add",
				"--actor",
				"owner",
				"T",
				"--dir",
				join(dir, "wt"),
				"--json",
			]),
		).toBe(1);
		expect(out).toEqual([]);
		const refused = JSON.parse(err[0] as string);
		await valid(errorShape, refused);
		expect(refused.error).toMatchObject({
			code: "invalid_argument",
			details: { field: "dir" },
		});
	});

	test("a refused command exits 1 with message and next on stderr", async () => {
		expect(await run(["ls"])).toBe(1);
		expect(err).toEqual([
			`board: no_board: No board at ${join(dir, "b", "board.db")} (BOARD_DIR names ${join(dir, "b")}). Check BOARD_DIR, or \`board project add KEY\` in a project's directory to create a board there.`,
		]);
		expect(await run(["ls"], repo, { BOARD_DIR: "rel" })).toBe(1);
		expect(err[1]).toContain("BOARD_DIR must be an absolute path");
	});

	test("an exception in board's code is internal, the error object under --json", async () => {
		await run(["project", "add", "--actor", "owner", "T"]);
		const broken = deps(dir);
		broken.runner = {
			commonDir: async () => {
				throw new Error("boom");
			},
		};
		expect(await runCli(["project", "ls", "--json"], broken)).toBe(1);
		const refused = JSON.parse(err.at(-1) as string);
		await valid(errorShape, refused);
		expect(refused.error).toMatchObject({
			code: "internal",
			details: { reason: "Error: boom" },
		});
		expect(await runCli(["project", "ls"], broken)).toBe(1);
		expect(err.at(-1)).toStartWith(
			"board: internal: board failed inside: Error: boom",
		);
	});

	test("--contains counts characters as the schema does, not UTF-16 units", async () => {
		await run(["project", "add", "--actor", "owner", "T"]);
		out = [];
		expect(await run(["ls", "--contains", "😀".repeat(200), "--json"])).toBe(0);
		expect(JSON.parse(out[0] as string)).toMatchObject({ total: 0 });
	});

	test("a huge --offset or --since reads an empty page, as the tools do", async () => {
		await run(["project", "add", "--actor", "owner", "T"]);
		const huge = "1".padEnd(31, "0");
		out = [];
		expect(await run(["ls", "--offset", huge, "--json"])).toBe(0);
		expect(JSON.parse(out[0] as string)).toMatchObject({
			tasks: [],
			next_offset: null,
		});
		await addTask(repo, { actor: "main", title: "t" });
		out = [];
		expect(await run(["show", "T-1", "--since", huge, "--json"])).toBe(0);
		expect(JSON.parse(out[0] as string)).toMatchObject({
			events: [],
			more: false,
		});
	});

	test("project ls marks the project here, from a worktree through git", async () => {
		await run(["project", "add", "--actor", "owner", "T"]);
		out = [];
		expect(await run(["project", "ls"], join(dir, "wt", "sub"))).toBe(0);
		const [header, row] = (out[0] as string).split("\n");
		expect(header?.trim().split(/\s{2,}/)).toEqual([
			"KEY",
			"NAME",
			"OPEN",
			"CLOSED",
			"CURRENT MILESTONE",
			"DIRECTORY",
		]);
		expect(row?.trim().split(/\s{2,}/)).toEqual([
			"*",
			"T",
			"repo",
			"0",
			"0",
			"-",
			repo,
		]);
		out = [];
		expect(await run(["project", "ls", "--json"], dir)).toBe(0);
		const list = JSON.parse(out[0] as string);
		await valid(outputs["project ls"], list);
		expect(list.here).toBeNull();
	});

	test("ls and show print what the tools answer", async () => {
		await run(["project", "add", "--actor", "owner", "T"]);
		await addTask(join(dir, "wt", "sub"), {
			actor: "main",
			title: "Lease 50% done",
			body: "the body",
		});
		out = [];
		err = [];
		expect(await run(["ls"], join(repo, "sub"))).toBe(0);
		expect(
			(out[0] as string)
				.split("\n")[1]
				?.trim()
				.split(/\s{2,}/),
		).toEqual(["T-1", "ready", "normal", "-", "-", "Lease 50% done"]);
		expect(err).toEqual(["1 task in T"]);
		out = [];
		expect(await run(["ls", "--all", "--contains", "%", "--json"], dir)).toBe(
			0,
		);
		const listed = JSON.parse(out[0] as string);
		await valid(outputs.ls, listed);
		expect(listed).toMatchObject({ project: "*", total: 1 });
		out = [];
		err = [];
		expect(await run(["show", "t-1"], dir)).toBe(0);
		expect(out[0]).toStartWith("T-1  Lease 50% done");
		expect(out[0]).toContain("the body");
		expect(out.at(-1)).toContain("task_added");
		expect(err).toEqual(["T-1 ready; 1 event since 0"]);
		out = [];
		expect(await run(["show", "T-1", "--since", "999", "--json"], dir)).toBe(0);
		const shown = JSON.parse(out[0] as string);
		await valid(outputs.show, shown);
		expect(shown).toMatchObject({ events: [], cursor: 999, more: false });
	});
});

describe("a CLI write waiting on the lock", () => {
	test("SIGINT during the wait ends it at once with nothing written", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		mkdirSync(join(dir, "other"));
		const file = join(dir, "b", "board.db");
		const holder = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "helpers", "holder.ts"),
				"hold",
				file,
				"4000",
			],
			{ stdout: "pipe" },
		);
		const reader = holder.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe(
			"held",
		);
		// Spawned from Bun: a shell's `&` would start it with SIGINT ignored.
		const waiting = Bun.spawn(
			[
				process.execPath,
				MAIN,
				"project",
				"add",
				"--actor",
				"owner",
				"OTH",
				"--dir",
				join(dir, "other"),
			],
			{
				env: { ...process.env, BOARD_DIR: join(dir, "b") },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await Bun.sleep(1_000);
		const sent = Date.now();
		waiting.kill("SIGINT");
		await waiting.exited;
		expect(Date.now() - sent).toBeLessThan(500);
		expect(waiting.signalCode).toBe("SIGINT");
		await holder.exited;
		out = [];
		expect(await run(["project", "ls", "--json"])).toBe(0);
		expect(
			JSON.parse(out[0] as string).projects.map(
				(p: { project: { key: string } }) => p.project.key,
			),
		).toEqual(["T"]);
	}, 15_000);
});

describe("control characters in human output (decision 28)", () => {
	test("shown() makes C0 and C1 visible, keeps newline, tab and other text", async () => {
		const { shown } = await import("../src/cli/io.ts");
		expect(shown("a\x1b[31mb\x07c\x9b2J\x85\rd\te\nf é 日本 😀")).toBe(
			"a\\u001b[31mb\\u0007c\\u009b2J\\u0085\\u000dd\te\nf é 日本 😀",
		);
	});

	test("ls, show, project add/ls and usage errors never send an escape; --json is unchanged", async () => {
		const evil = join(dir, "evil\x1b[31mdir");
		mkdirSync(evil);
		expect(
			await run(["project", "add", "--actor", "owner", "E", "--dir", evil]),
		).toBe(0);
		expect(
			await run([
				"project",
				"add",
				"--actor",
				"owner",
				"T",
				"--name",
				"n\x1b]0;title\x07",
			]),
		).toBe(0);
		const title = "red \x1b[31mtitle\x9b2J";
		await addTask(repo, {
			actor: "@x\x1b[2J",
			title,
			body: "line\x1b]8;;http://x\x07\nnext",
		});
		for (const argv of [["ls"], ["show", "T-1"], ["project", "ls"]]) {
			expect(await run(argv)).toBe(0);
		}
		expect(await run(["ls", "--status", "\x1b[2J"])).toBe(64);
		expect(err.at(-1)).toContain("\\u001b[2J");
		const human = [...out, ...err].join("\n");
		const controls = [...human]
			.map((c) => c.codePointAt(0) as number)
			.filter(
				(c) =>
					(c < 0x20 && c !== 0x0a && c !== 0x09) || (c >= 0x80 && c <= 0x9f),
			);
		expect(controls).toEqual([]);
		expect(human).toContain("red \\u001b[31mtitle\\u009b2J");
		expect(human).toContain("line\\u001b]8;;http://x\\u0007\nnext");
		out = [];
		expect(await run(["show", "T-1", "--json"])).toBe(0);
		expect(JSON.parse(out[0] as string).task.title).toBe(title);
	});
});

describe("board next", () => {
	async function seed(fn: (board: Board) => Promise<unknown>) {
		const board = new Board(
			await Store.open(
				boardEnv({ BOARD_DIR: join(dir, "b") }) as Env,
				SystemClock,
			),
		);
		await fn(board);
		await board.close();
	}

	test("prints the pick and task_next's line; --json is its answer; usage errors are 64", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		out = [];
		err = [];
		expect(await run(["next"])).toBe(0);
		expect(out).toEqual([]);
		expect(err).toEqual(["nothing ready in T"]);
		const ctx = new Place(repo, new ProcessGitRunner());
		await seed(async (board) => {
			await board.taskAdd(ctx, { actor: "main", title: "first \x1b[2J" });
			await board.taskAdd(ctx, {
				actor: "main",
				title: "urgent",
				priority: "urgent",
			});
		});
		err = [];
		expect(await run(["next"], join(dir, "wt", "sub"))).toBe(0);
		expect(
			(out[0] as string)
				.split("\n")[1]
				?.trim()
				.split(/\s{2,}/),
		).toEqual(["T-2", "ready", "urgent", "-", "urgent"]);
		expect(err).toEqual(['next in T: T-2 "urgent" (no milestone)']);
		out = [];
		expect(await run(["next", "-p", "t", "--json"], dir)).toBe(0);
		const value = JSON.parse(out[0] as string);
		await valid(outputs.next, value);
		expect(value).toMatchObject({
			project: "T",
			task: { key: "T-2" },
			from: "unassigned",
		});
		expect(await run(["next", "--milestone", "v9"])).toBe(1);
		expect(err.at(-1)).toContain("No milestone v9");
		expect(await run(["next", "--milestone", "bad name"])).toBe(64);
		await seed((board) =>
			board.taskClaim({ actor: "main", key: "T-2", minutes: 5 }),
		);
		err = [];
		expect(await run(["next"])).toBe(0);
		expect(err[0]).toBe('next in T: T-1 "first \\u001b[2J" (no milestone)');
	});
});

describe("status, milestone and project edit / rm", () => {
	test("milestone add, ls, edit, rm and status, as a person sees them", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		err = [];
		expect(
			await run([
				"milestone",
				"add",
				"--actor",
				"owner",
				"v1",
				"--delivers",
				"the store",
			]),
		).toBe(0);
		expect(
			await run([
				"milestone",
				"add",
				"--actor",
				"owner",
				"v2",
				"--delivers",
				"the tools",
				"--before",
				"v1",
			]),
		).toBe(0);
		expect(err).toEqual([]);
		expect(out.slice(-2)).toEqual([
			"T: milestone v1 added at 1 of 1",
			"T: milestone v2 added at 1 of 2",
		]);
		out = [];
		expect(await run(["milestone"], join(dir, "wt", "sub"))).toBe(0);
		expect(
			(out[0] as string).split("\n").map((l) => l.trim().split(/\s{2,}/)),
		).toEqual([
			["POS", "NAME", "STATUS", "DONE", "CANCELLED", "LEFT", "DELIVERS"],
			["1", "v2", "current", "0", "0", "0", "the tools"],
			["2", "v1", "planned", "0", "0", "0", "the store"],
		]);
		out = [];
		expect(await run(["milestone", "ls", "-p", "t", "--json"], dir)).toBe(0);
		const chain = JSON.parse(out[0] as string);
		await valid(
			{ type: "array", items: { $ref: "#/$defs/Milestone" }, $defs: defs },
			chain,
		);
		err = [];
		expect(
			await run([
				"milestone",
				"edit",
				"--actor",
				"owner",
				"v2",
				"--after",
				"v1",
				"--name",
				"v2.0",
			]),
		).toBe(0);
		expect(out.at(-1)).toBe("T: milestone v2 → v2.0, moved after v1");
		out = [];
		expect(await run(["status"])).toBe(0);
		const lines = (out[0] as string)
			.split("\n")
			.map((l) => l.trim().split(/\s{2,}/));
		expect(lines[0]).toEqual(["project", "T", "repo", repo]);
		expect(lines[1]).toEqual([
			"milestone 1 of 2",
			"v1",
			"the store",
			"0 tasks left (0 done, 0 cancelled of 0)",
		]);
		expect(lines[2]).toEqual([
			"tasks",
			"0 ready, 0 active, 0 blocked, 0 backlog, 0 done, 0 cancelled",
		]);
		out = [];
		expect(await run(["status", "--json"])).toBe(0);
		await valid(outputs.status, JSON.parse(out[0] as string));
		err = [];
		expect(await run(["milestone", "rm", "--actor", "owner", "v2.0"])).toBe(0);
		expect(err).toEqual([]);
		expect(out.at(-1)).toBe("T: milestone v2.0 deleted; 1 left");
		expect(await run(["milestone", "rm", "--actor", "owner", "v9"])).toBe(1);
		expect(err.at(-1)).toContain("No milestone v9");
	});

	test("milestone usage errors: nothing to edit, --before with --after, no --delivers", async () => {
		for (const argv of [
			["milestone", "edit", "--actor", "owner", "v1"],
			[
				"milestone",
				"add",
				"--actor",
				"owner",
				"v2",
				"--delivers",
				"x",
				"--before",
				"a",
				"--after",
				"b",
			],
			["milestone", "add", "--actor", "owner", "v2"],
			["milestone", "add", "--actor", "owner", "bad name", "--delivers", "x"],
			[
				"milestone",
				"add",
				"--actor",
				"owner",
				"v2",
				"--delivers",
				"x".repeat(501),
			],
			[
				"milestone",
				"add",
				"--actor",
				"owner",
				"v2",
				"--delivers",
				"😀".repeat(501),
			],
			[
				"milestone",
				"edit",
				"--actor",
				"owner",
				"v1",
				"--delivers",
				"x".repeat(501),
			],
		]) {
			err = [];
			expect(await run(argv)).toBe(64);
			expect(err).toHaveLength(1);
			expect(err[0]).toStartWith("board: ");
		}
	});

	test("--delivers takes 500 characters, counted as the schema counts them", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		expect(
			await run([
				"milestone",
				"add",
				"--actor",
				"owner",
				"v1",
				"--delivers",
				"😀".repeat(500),
			]),
		).toBe(0);
		expect(
			await run([
				"milestone",
				"edit",
				"--actor",
				"owner",
				"v1",
				"--delivers",
				"x".repeat(500),
			]),
		).toBe(0);
	});

	test("status shows live claims; without a current milestone it says so", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		const board = new Board(
			await Store.open(
				boardEnv({ BOARD_DIR: join(dir, "b") }) as Env,
				SystemClock,
			),
		);
		const ctx = new Place(repo, new ProcessGitRunner());
		await board.taskAdd(ctx, { actor: "main", title: "t" });
		await board.taskClaim({
			actor: "main",
			key: "T-1",
			minutes: 90,
			holder: "@lead",
			branch: "feat/x",
		});
		await board.close();
		out = [];
		expect(await run(["status"])).toBe(0);
		const text = out[0] as string;
		expect(text).toContain("no current milestone");
		const claims = text
			.split("\n\nclaims\n")[1]
			?.split("\n")
			.map((l) => l.trim().split(/\s{2,}/));
		expect(claims?.[0]).toEqual([
			"KEY",
			"HOLDER",
			"UNTIL",
			"LEFT",
			"DIRECTORY",
			"BRANCH",
		]);
		expect(claims?.[1]?.slice(0, 2)).toEqual(["T-1", "@lead"]);
		expect(claims?.[1]?.[3]).toMatch(/^in 1h(29|30)m$/);
		expect(claims?.[1]?.slice(4)).toEqual(["-", "feat/x"]);
	});

	test("project edit prints the Project; project rm removes an empty one; refusals exit 1", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		mkdirSync(join(dir, "moved"));
		out = [];
		expect(
			await run([
				"project",
				"edit",
				"--actor",
				"owner",
				"t",
				"--name",
				"Moved",
				"--dir",
				join(dir, "moved"),
				"--json",
			]),
		).toBe(0);
		const project = JSON.parse(out[0] as string);
		await valid(projectSchema, project);
		expect(project).toMatchObject({
			key: "T",
			name: "Moved",
			directory: join(dir, "moved"),
		});
		expect(
			await run(["project", "edit", "--actor", "owner", "NOPE", "--name", "x"]),
		).toBe(1);
		const board = new Board(
			await Store.open(
				boardEnv({ BOARD_DIR: join(dir, "b") }) as Env,
				SystemClock,
			),
		);
		await board.taskAdd(new Place(join(dir, "moved"), new ProcessGitRunner()), {
			actor: "main",
			title: "t",
		});
		await board.close();
		err = [];
		expect(await run(["project", "rm", "--actor", "owner", "T"])).toBe(1);
		expect(err[0]).toContain("has 1 task");
		mkdirSync(join(dir, "empty"));
		expect(
			await run([
				"project",
				"add",
				"--actor",
				"owner",
				"E",
				"--dir",
				join(dir, "empty"),
			]),
		).toBe(0);
		err = [];
		expect(await run(["project", "rm", "--actor", "owner", "e"])).toBe(0);
		expect(err).toEqual([]);
		expect(out.at(-1)).toBe(`removed E (${join(dir, "empty")})`);
	});
});

describe("questions, answer and validate", () => {
	async function seed(fn: (board: Board) => Promise<unknown>) {
		const board = new Board(
			await Store.open(
				boardEnv({ BOARD_DIR: join(dir, "b") }) as Env,
				SystemClock,
			),
		);
		await fn(board);
		await board.close();
	}
	const options = [{ label: "up to 8" }, { label: "no limit", detail: "x" }];

	test("the owner answers, a delegate's answer is validated, and the lists follow", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		const ctx = new Place(repo, new ProcessGitRunner());
		await seed(async (board) => {
			await board.taskAdd(ctx, { actor: "main", title: "one" });
			await board.taskAdd(ctx, { actor: "main", title: "two" });
			await board.questionAsk({
				actor: "@lead",
				key: "T-1",
				text: "How many \x1b[2J?",
				options,
				recommended: 1,
			});
			await board.questionAsk({
				actor: "@lead",
				key: "T-2",
				text: "Name?",
				options,
				recommended: 2,
			});
			await board.questionAnswer({
				actor: "main",
				question: "Q2",
				choice: 2,
				as: "delegate",
			});
		});
		out = [];
		err = [];
		expect(await run(["questions"], join(dir, "wt", "sub"))).toBe(0);
		expect(
			(out[0] as string).split("\n").map((l) => l.trim().split(/\s{2,}/)),
		).toEqual([
			["ID", "TASK", "STATUS", "ASKED BY", "QUESTION", "ANSWER"],
			["Q1", "T-1", "open", "@lead", "How many \\u001b[2J?", "-"],
		]);
		expect(err).toEqual(["1 open question in T"]);
		out = [];
		err = [];
		expect(
			await run(
				["questions", "--all", "--state", "to_validate", "--json"],
				dir,
			),
		).toBe(0);
		const listed = JSON.parse(out[0] as string);
		await valid(outputs.questions, listed);
		expect(listed).toMatchObject({ project: "*", questions: [{ id: "Q2" }] });
		err = [];
		expect(
			await run([
				"answer",
				"--actor",
				"owner",
				"--as",
				"owner",
				"q1",
				"1",
				"--text",
				"eight",
			]),
		).toBe(0);
		expect(out.at(-1)).toBe(
			"Q1 answered by owner as owner: up to 8 — eight; T-1 unblocked",
		);
		expect(await run(["validate", "--actor", "owner", "Q2"])).toBe(0);
		expect(out.at(-1)).toBe("Q2 validated");
		out = [];
		expect(await run(["questions", "--state", "all", "--task", "t-2"])).toBe(0);
		expect(
			(out[0] as string)
				.split("\n")[1]
				?.trim()
				.split(/\s{2,}/),
		).toEqual([
			"Q2",
			"T-2",
			"validated",
			"@lead",
			"Name?",
			"2. no limit (main as delegate)",
		]);
		err = [];
		expect(
			await run(["answer", "--actor", "owner", "--as", "owner", "Q1", "2"]),
		).toBe(1);
		expect(err[0]).toStartWith(
			"board: already_answered: Q1 is answered already",
		);
		expect(await run(["validate", "--actor", "owner", "Q1"])).toBe(1);
		expect(await run(["validate", "--actor", "owner", "Q9"])).toBe(1);
	});

	test("usage errors exit 64 with one line", async () => {
		for (const argv of [
			["answer", "--actor", "owner", "--as", "owner", "Q1"],
			["answer", "--actor", "owner", "--as", "owner", "7", "1"],
			["answer", "--actor", "owner", "--as", "owner", "Q1", "7"],
			[
				"answer",
				"--actor",
				"owner",
				"--as",
				"owner",
				"Q1",
				"--text",
				"x".repeat(2001),
			],
			["validate"],
			["questions", "--state", "pending"],
			["questions", "-p", "T", "--all"],
			["questions", "--task", "nope"],
		]) {
			err = [];
			expect(await run(argv)).toBe(64);
			expect(err).toHaveLength(1);
		}
	});
});

describe("board watch", () => {
	async function seed(fn: (board: Board) => Promise<unknown>) {
		const board = new Board(
			await Store.open(
				boardEnv({ BOARD_DIR: join(dir, "b") }) as Env,
				SystemClock,
			),
		);
		await fn(board);
		await board.close();
	}

	test("without --follow, the log from the beginning; filters; --json one object per line", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		const ctx = new Place(repo, new ProcessGitRunner());
		await seed((board) =>
			board.taskAdd(ctx, { actor: "main", title: "one \x1b[2J" }),
		);
		out = [];
		expect(await run(["watch"], dir)).toBe(0);
		expect(out.map((l) => l.split("\t").slice(1, 6))).toEqual([
			["#1", "-", "-", "owner", "board_created"],
			["#2", "T", "-", "owner", "project_added"],
			["#3", "T", "T-1", "main", "task_added"],
		]);
		expect(out[2]).toContain('"one \\u001b[2J"');
		out = [];
		expect(
			await run(
				[
					"watch",
					"--kind",
					"task_added,project_added",
					"--task",
					"t-1",
					"--json",
				],
				dir,
			),
		).toBe(0);
		expect(out.map((l) => JSON.parse(l))).toEqual([
			expect.objectContaining({
				id: 3,
				derived: false,
				kind: "task_added",
				project: "T",
				task: "T-1",
				milestone: null,
			}),
		]);
		out = [];
		expect(await run(["watch", "-p", "t", "--since", "2"], dir)).toBe(0);
		expect(out).toHaveLength(1);
	});

	test("--expiring-within has no maximum", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		expect(await run(["watch", "--expiring-within", "100000"])).toBe(0);
	});

	test("refusals: no board, an unknown -p key, before anything is printed", async () => {
		expect(await run(["watch"])).toBe(1);
		expect(err.at(-1)).toContain("No board at");
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		out = [];
		expect(await run(["watch", "-p", "T,ZZ", "--json"])).toBe(1);
		expect(out).toEqual([]);
		expect(JSON.parse(err.at(-1) as string)).toMatchObject({
			error: { code: "not_found", details: { what: "project", id: "ZZ" } },
		});
	});

	test("usage errors: --exec without --follow, an unknown kind, ranges", async () => {
		for (const argv of [
			["watch", "--exec", "true"],
			["watch", "--kind", "claimed,nope"],
			["watch", "--expiring-within", "0"],
			["watch", "--follow", "--exec", "true", "--exec-timeout", "0"],
			["watch", "-p", "1A"],
		]) {
			err = [];
			expect(await run(argv)).toBe(64);
			expect(err).toHaveLength(1);
		}
	});

	test("--follow --exec in its own process sees another process's writes and a claim_expiring; Ctrl-C ends it, 130", async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		const seen = join(dir, "seen.jsonl");
		const watcher = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "..", "src", "main.ts"),
				"watch",
				"--follow",
				"-p",
				"T",
				"--expiring-within",
				"1",
				"--exec",
				`cat >> '${seen}'; echo note >&2`,
			],
			{
				cwd: dir,
				env: { ...process.env, BOARD_DIR: join(dir, "b") },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		// cat may be appending while this reads: only whole lines count.
		const kinds = () => {
			if (!existsSync(seen)) return [];
			const text = readFileSync(seen, "utf8");
			return text
				.slice(0, text.lastIndexOf("\n") + 1)
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l).kind);
		};
		try {
			await Bun.sleep(700);
			const ctx = new Place(repo, new ProcessGitRunner());
			await seed(async (board) => {
				await board.taskAdd(ctx, { actor: "main", title: "watched" });
				await board.taskClaim({
					actor: "main",
					key: "T-1",
					minutes: 1,
					holder: "@lead",
				});
			});
			const deadline = Date.now() + 8_000;
			while (!kinds().includes("claim_expiring") && Date.now() < deadline)
				await Bun.sleep(100);
			watcher.kill("SIGINT");
			await watcher.exited;
		} finally {
			// Never leave a watcher behind on a board the test removes.
			if (watcher.exitCode === null && watcher.signalCode === null) {
				watcher.kill("SIGKILL");
				await watcher.exited;
			}
		}
		expect(watcher.signalCode).toBe("SIGINT");
		expect(kinds()).toEqual(["task_added", "claimed", "claim_expiring"]);
		const stdout = await new Response(watcher.stdout).text();
		expect(
			stdout
				.trim()
				.split("\n")
				.map((l) => l.split("\t")[5]),
		).toEqual(["task_added", "claimed", "claim_expiring"]);
		expect(await new Response(watcher.stderr).text()).toContain("note");
	}, 20_000);
});

describe("board sql", () => {
	beforeEach(async () => {
		expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
		out = [];
		err = [];
	});

	test("a table with NULL and blobs as hex, the row count on stderr; --json an array of row objects", async () => {
		expect(
			await run([
				"sql",
				"SELECT key, NULL AS gone, x'00ff' AS raw FROM project",
			]),
		).toBe(0);
		expect(
			(out[0] as string).split("\n").map((l) => l.trim().split(/\s{2,}/)),
		).toEqual([
			["key", "gone", "raw"],
			["T", "NULL", "00ff"],
		]);
		expect(err).toEqual(["1 row"]);
		out = [];
		expect(
			await run([
				"sql",
				"SELECT key, NULL AS gone, x'00ff' AS raw FROM project",
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(out[0] as string)).toEqual([
			{ key: "T", gone: null, raw: "00ff" },
		]);
	});

	test("every write of the matrix is refused, 64 or SQLite's own 1, and nothing is written", async () => {
		const file = join(dir, "b", "board.db");
		const before = readFileSync(file);
		for (const [query, code] of [
			["DELETE FROM task", 64],
			[
				"INSERT INTO project (key, name, directory, created_at, created_by) VALUES ('X', 'x', '/x', 'x', 'x')",
				64,
			],
			["UPDATE project SET name = 'x'", 64],
			["CREATE TABLE extra (x)", 64],
			["CREATE TEMP TABLE extra (x)", 64],
			["VACUUM", 64],
			["PRAGMA user_version = 9", 64],
			["PRAGMA wal_checkpoint", 64],
			["REINDEX", 64],
			["ANALYZE", 64],
			[`VACUUM INTO '${join(dir, "copy.db")}'`, 64],
			[`ATTACH '${join(dir, "new.db")}' AS other`, 1],
			["PRAGMA journal_mode = DELETE", 1],
		] as const) {
			err = [];
			expect(await run(["sql", query])).toBe(code);
			expect(err).toHaveLength(1);
		}
		err = [];
		expect(await run(["sql", "-p", "t", "DELETE FROM task"])).toBe(1);
		expect(err[0]).toContain("cannot modify task because it is a view");
		expect(readFileSync(file)).toEqual(before);
		expect(err.length).toBe(1);
		err = [];
		expect(await run(["sql", "DELETE FROM task"])).toBe(64);
		expect(err[0]).toStartWith(
			"board: usage: `board sql` reads; it does not write.",
		);
	});

	test("parameters are a usage error; bad SQL is SQLite's message, 1; no board, 1", async () => {
		expect(await run(["sql", "SELECT ?"])).toBe(64);
		expect(await run(["sql", "SELEC 1"])).toBe(1);
		expect(err.at(-1)).toContain("syntax error");
		expect(
			await run(["sql", "SELECT 1"], dir, { BOARD_DIR: join(dir, "nope") }),
		).toBe(1);
		expect(err.at(-1)).toContain("No board at");
	});

	test("-p narrows; main.<table> sees every project", async () => {
		mkdirSync(join(dir, "other"));
		expect(
			await run([
				"project",
				"add",
				"--actor",
				"owner",
				"O",
				"--dir",
				join(dir, "other"),
			]),
		).toBe(0);
		out = [];
		expect(
			await run(["sql", "-p", "o", "SELECT key FROM project", "--json"]),
		).toBe(0);
		expect(JSON.parse(out[0] as string)).toEqual([{ key: "O" }]);
		out = [];
		expect(
			await run([
				"sql",
				"-p",
				"o",
				"SELECT key FROM main.project ORDER BY id",
				"--json",
			]),
		).toBe(0);
		expect(JSON.parse(out[0] as string)).toEqual([{ key: "T" }, { key: "O" }]);
	});

	test("board help sql names the three losses and that -p narrows but does not wall off", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		expect(await run(["help", "sql"])).toBe(0);
		const help = String(log.mock.calls[0]?.[0]);
		log.mockRestore();
		expect(help).toContain("A write is refused when it runs, not before.");
		expect(help).toContain("leaves an empty file at <path>");
		expect(help).toContain("Only the first statement runs.");
		expect(help).toContain("It narrows; it does not wall off");
	});
});

test("board sql shows a control character in a column name; --json keeps the name", async () => {
	expect(await run(["project", "add", "--actor", "owner", "T"])).toBe(0);
	out = [];
	expect(await run(["sql", 'SELECT 1 AS "evil\x1b[2J"'])).toBe(0);
	expect(out[0]).toContain("evil\\u001b[2J");
	expect(out[0]).not.toContain("\x1b");
	out = [];
	expect(await run(["sql", 'SELECT 1 AS "evil\x1b[2J"', "--json"])).toBe(0);
	expect(JSON.parse(out[0] as string)).toEqual([{ "evil\x1b[2J": 1 }]);
});
