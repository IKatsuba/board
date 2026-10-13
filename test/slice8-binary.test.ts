import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputs } from "../src/schemas.ts";
import { expectValid } from "./helpers/schema.ts";

test.skipIf(!process.env.BOARD_BIN)(
	"release self-test uses its own board and removes only its own scratch directory",
	() => {
		const dir = realpathSync(
			mkdtempSync(join(tmpdir(), "board-slice8-selftest-")),
		);
		try {
			const untouched = join(dir, "ambient-board");
			const scratch = join(dir, "scratch");
			mkdirSync(untouched);
			mkdirSync(scratch);
			const marker = join(untouched, "board.db");
			writeFileSync(marker, "Must not be opened by the release self-test");
			const result = Bun.spawnSync(
				[
					"bash",
					join(import.meta.dir, "..", "tool", "release", "selftest.sh"),
					process.env.BOARD_BIN as string,
				],
				{
					cwd: dir,
					env: { ...process.env, BOARD_DIR: untouched, TMPDIR: scratch },
					stdin: "ignore",
				},
			);
			expect({
				code: result.exitCode,
				error: result.stderr.toString(),
				output: result.stdout.toString(),
			}).toMatchObject({ code: 0 });
			expect(result.stderr.toString()).toBe("");
			expect(result.stdout.toString()).toStartWith("self-tested ");
			expect(readFileSync(marker, "utf8")).toBe(
				"Must not be opened by the release self-test",
			);
			expect(readdirSync(untouched)).toEqual(["board.db"]);
			expect(readdirSync(scratch)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	10000,
);

test.skipIf(!process.env.BOARD_BIN)(
	"compiled writes never wait on open stdin and complete one handover-to-close flow",
	async () => {
		const dir = realpathSync(
			mkdtempSync(join(tmpdir(), "board-slice8-input-bin-")),
		);
		const boardDir = join(dir, "board");
		const binary = process.env.BOARD_BIN as string;
		const children: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>[] = [];
		const json = async (name: keyof typeof outputs, ...argv: string[]) => {
			const child = Bun.spawn([binary, ...argv, "--json"], {
				cwd: dir,
				env: { ...process.env, BOARD_DIR: boardDir },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			children.push(child);
			const [code, out, err] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(0);
			expect(err).toBe("");
			const value = JSON.parse(out);
			expectValid(outputs[name], value);
			return value;
		};
		try {
			expect(existsSync(boardDir)).toBe(false);
			await json("project add", "project", "add", "T", "--actor", "smoke");
			const added = await json(
				"add",
				"add",
				"--actor",
				"smoke",
				"--title",
				"Open stdin",
				"--body",
				"@this-is-literal",
			);
			expect(added.task.key).toBe("T-1");
			await json("claim", "claim", "T-1", "--actor", "smoke", "--minutes", "5");
			await json(
				"handover",
				"handover",
				"T-1",
				"--actor",
				"smoke",
				"--to",
				"main",
				"--text",
				"Ready for review",
				"--changed",
				"One task",
				"--ran",
				"Binary commands",
				"--unchecked",
				"Nothing else",
			);
			const handed = await json("show", "show", "T-1");
			expect(handed.task).toMatchObject({
				status: "active",
				body: "@this-is-literal",
				claim: { holder: "smoke" },
			});
			await json("edit", "edit", "T-1", "--actor", "main", "--status", "done");
			const closed = await json("show", "show", "T-1");
			expect(closed.task).toMatchObject({ status: "done", claim: null });
			expect(
				closed.events.map((event: { kind: string }) => event.kind),
			).toEqual([
				"task_added",
				"claimed",
				"handover",
				"task_status",
				"claim_released",
			]);
		} finally {
			for (const child of children) {
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	},
	15000,
);
