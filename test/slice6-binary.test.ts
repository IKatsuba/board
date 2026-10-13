import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const built = process.env.BOARD_BIN;
const command = (...args: string[]) =>
	process.env.BOARD_BIN_ARCH
		? ["arch", `-${process.env.BOARD_BIN_ARCH}`, built as string, ...args]
		: [built as string, ...args];

test.skipIf(built === undefined)(
	"compiled CLI refuses missing storage and usage without creating a board",
	() => {
		const dir = mkdtempSync("/private/tmp/board-slice6-refusals-");
		const boardDir = join(dir, "missing");
		try {
			const env = { ...process.env, BOARD_DIR: boardDir };
			const missing = Bun.spawnSync(command("status", "--json"), {
				cwd: dir,
				env,
			});
			expect(missing.exitCode).toBe(1);
			expect(missing.stdout.toString()).toBe("");
			expect(JSON.parse(missing.stderr.toString())).toMatchObject({
				error: { code: "no_board" },
			});
			expect(existsSync(boardDir)).toBe(false);
			const usage = Bun.spawnSync(command("sql", "SELECT ?"), {
				cwd: dir,
				env,
			});
			expect(usage.exitCode).toBe(1);
			expect(existsSync(boardDir)).toBe(false);
			const invalid = Bun.spawnSync(command("watch", "--exec", "true"), {
				cwd: dir,
				env,
			});
			expect(invalid.exitCode).toBe(64);
			expect(invalid.stdout.toString()).toBe("");
			expect(existsSync(boardDir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
