import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { SystemClock } from "../src/clock.ts";
import { boardEnv, type Env } from "../src/env.ts";
import type { GitRun, GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { Store } from "../src/store/store.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const notARepo: GitRunner = {
	commonDir: async (): Promise<GitRun> => ({
		kind: "exit",
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository\n",
	}),
};

let dir: string;

beforeAll(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-epipe-")));
	const env = boardEnv({ BOARD_DIR: join(dir, "b") }) as Env;
	await projectAdd(env, SystemClock, notARepo, dir, {
		actor: "owner",
		key: "P",
	});
	// Far more than a pipe's buffer, so the writer meets the closed end.
	const board = new Board(await Store.open(env, SystemClock));
	try {
		for (let n = 0; n < 1500; n++) {
			await board.taskAdd(new Place(dir, notARepo), {
				actor: "main",
				title: `Task ${n} ${"x".repeat(100)}`,
			});
		}
	} finally {
		await board.close();
	}
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `board …` into `head -c 1` and answers board's own exit and stderr. */
function intoHead(...argv: string[]) {
	const errFile = join(dir, "stderr.txt");
	const quoted = [process.execPath, MAIN, ...argv]
		.map((a) => `'${a.replaceAll("'", `'\\''`)}'`)
		.join(" ");
	const run = Bun.spawnSync(
		[
			"bash",
			"-c",
			`${quoted} 2>'${errFile}' | head -c 1 >/dev/null; echo "\${PIPESTATUS[0]}"`,
		],
		{ cwd: dir, env: { ...process.env, BOARD_DIR: join(dir, "b") } },
	);
	return {
		code: Number(run.stdout.toString().trim()),
		stderr: Bun.file(errFile).text(),
	};
}

test("board watch --json | head -c 1 ends board quietly with 141", async () => {
	const { code, stderr } = intoHead("watch", "--json");
	expect(code).toBe(141);
	expect(await stderr).toBe("");
}, 30_000);

test("so do watch's human lines", async () => {
	const { code, stderr } = intoHead("watch");
	expect(code).toBe(141);
	expect(await stderr).toBe("");
}, 30_000);

// A note written before the closed pipe is noticed may still show (sql's
// row count); nothing else from board does, no stack and no error line.
test("sql's table cut short is 141 with no board: line", async () => {
	const { code, stderr } = intoHead("sql", "SELECT * FROM task");
	expect(code).toBe(141);
	expect(await stderr).not.toContain("board:");
	expect(await stderr).not.toContain("EPIPE");
}, 30_000);
