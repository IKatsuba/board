import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.env.BOARD_ACTIONLINT === undefined)(
	"CI workflow passes actionlint semantic validation",
	() => {
		const result = Bun.spawnSync([
			process.env.BOARD_ACTIONLINT as string,
			join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toBe("");
	},
);
