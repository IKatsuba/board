import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import type { Deps } from "../src/cli/io.ts";
import { buildCli, runCli } from "../src/cli/root.ts";
import { commandIndex, skillText } from "../src/cli/skill.ts";
import { boardEnv } from "../src/env.ts";
import type { GitRun, GitRunner } from "../src/place/git.ts";
import { errorShape } from "../src/schemas.ts";
import { PROSE } from "../src/skill.ts";
import { FakeClock } from "./helpers/clock.ts";

const notARepo: GitRunner = {
	commonDir: async (): Promise<GitRun> => ({
		kind: "exit",
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository\n",
	}),
};

let dir: string;
let out: string[];
let err: string[];

function deps(env = boardEnv({ BOARD_DIR: join(dir, "b") })): Deps {
	return {
		io: { out: (t) => out.push(t), err: (t) => err.push(t) },
		env,
		clock: new FakeClock(),
		runner: notARepo,
		cwd: join(dir, "brd"),
		colors: false,
		exitCode: 0,
	};
}

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-skill-")));
	mkdirSync(join(dir, "brd"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The prose's fenced `sh` blocks, unindented. */
function blocks(): string[] {
	return [...PROSE.matchAll(/^( *)```sh\n([\s\S]*?)^\1```$/gm)].map(
		([, indent, body]) =>
			(body as string)
				.split("\n")
				.map((line) => line.slice((indent as string).length))
				.join("\n"),
	);
}

/**
 * A block's `board` calls as an agent's shell would pass them: the block
 * runs under /bin/sh with `board` a function that prints its argv
 * NUL-separated, so heredocs, continuations, quotes and comments are the
 * shell's.
 */
function calls(block: string): string[][] {
	const run = Bun.spawnSync([
		"/bin/sh",
		"-c",
		`board() { printf '%s\\0' "$@"; printf '\\036\\0'; }\n${block}`,
	]);
	expect(run.stderr.toString()).toBe("");
	expect(run.exitCode).toBe(0);
	const found: string[][] = [];
	let call: string[] = [];
	for (const word of run.stdout.toString().split("\0").slice(0, -1)) {
		if (word === "\x1e") {
			found.push(call);
			call = [];
		} else {
			call.push(word);
		}
	}
	return found;
}

describe("board skill", () => {
	test("prints the design's guide, index included, with no board at all", async () => {
		out = [];
		err = [];
		const missing = boardEnv({ BOARD_DIR: join(dir, "nowhere") });
		expect(await runCli(["skill"], deps(missing))).toBe(0);
		expect(err).toEqual([]);
		const design = readFileSync(
			join(import.meta.dir, "..", "docs", "design.md"),
			"utf8",
		);
		const start = design.indexOf("````markdown\n") + "````markdown\n".length;
		const end = design.indexOf("\n````\n", start);
		expect(out).toEqual([design.slice(start, end)]);
		expect(existsSync(join(dir, "nowhere"))).toBe(false);
	});

	test("the index is generated from the tree: a description changed there changes here", () => {
		const root = buildCli(deps());
		const index = commandIndex(root);
		expect(index).toContain(
			"  board milestone edit       Rename, re-describe or move a milestone.",
		);
		expect(index).not.toMatch(/board (help|upgrade|skill)\b/);
		root.getCommand("claim")?.description("Take it.");
		expect(commandIndex(root)).toContain(
			"  board claim                Take it.",
		);
		expect(skillText(root)).toContain("  board claim                Take it.");
	});

	test("every board call in the prose's fenced blocks parses against the tree", async () => {
		const root = buildCli(deps());
		// No-op actions: what is checked is the shape, at parse.
		const all = (command: typeof root): (typeof root)[] =>
			command.getCommands().flatMap((c) => [c, ...all(c)]);
		for (const command of all(root)) command.action(() => {});
		const found = blocks().flatMap(calls);
		expect(found.length).toBeGreaterThan(20);
		out = [];
		err = [];
		for (const call of found) {
			try {
				await root.parse(call);
			} catch (error) {
				throw new Error(`board ${call.join(" ")}: ${error}`);
			}
		}
		expect(out).toEqual([]);
		expect(err).toEqual([]);
	});

	test("every error code has a row in the prose's table, and no row is without a code", () => {
		const rows = [...PROSE.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
		expect(rows.sort()).toEqual(
			[...errorShape.properties.error.properties.code.enum].sort(),
		);
	});

	test("the flows run, in the prose's order, against a fresh board", async () => {
		const run = async (argv: string[]) => {
			out = [];
			err = [];
			const code = await runCli(argv, deps());
			if (code !== 0) {
				throw new Error(`board ${argv.join(" ")} exited ${code}: ${err}`);
			}
		};
		// The prose's keys and ids: a project BRD whose 14th task is the one
		// handed out, and seven questions so that Q7 is open.
		await run(["project", "add", "BRD", "--actor", "owner"]);
		for (let n = 1; n <= 14; n++) {
			await run(["add", "--actor", "main", "--title", `Task ${n}`]);
		}
		for (let n = 1; n <= 7; n++) {
			await run([
				"ask",
				"BRD-13",
				"--actor",
				"@lead",
				"--text",
				`Question ${n}?`,
				"--option-1",
				"Up to 8",
				"--option-2",
				"Unbounded",
				"--recommended",
				"1",
			]);
		}
		for (const block of blocks()) {
			const found = calls(block);
			// A lead's section starts from the claim main gave it, which main's
			// own section dropped by closing the task and sending it back.
			if (found[0]?.join(" ") === "show BRD-14" && found[1]?.[0] === "extend") {
				await run([
					"claim",
					"BRD-14",
					"--actor",
					"main",
					"--holder",
					"@lead",
					"--minutes",
					"90",
				]);
			}
			for (const call of found) {
				// A notifier never exits; its line is parsed above.
				if (call.includes("--follow")) continue;
				await run(call);
			}
		}
		await run(["show", "BRD-14", "--json"]);
		const task = JSON.parse(out[0] as string).task;
		expect(task.status).toBe("blocked");
		expect(task.claim).toMatchObject({ holder: "@lead" });
		expect(task.children.map((c: { key: string }) => c.key)).toEqual([
			"BRD-16",
		]);
	});
});
