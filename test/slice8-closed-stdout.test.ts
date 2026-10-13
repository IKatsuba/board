import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputs } from "../src/schemas.ts";
import { expectValid } from "./helpers/schema.ts";

const main = join(import.meta.dir, "..", "src", "main.ts");

async function exercise(binary?: string) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "board-slice8-closed-")));
	const env = { ...process.env, BOARD_DIR: join(dir, "board") };
	const command = binary ? [binary] : [process.execPath, main];
	const run = (...argv: string[]) =>
		Bun.spawnSync([...command, ...argv], { cwd: dir, env, stdin: "ignore" });
	const intoHead = (...argv: string[]) =>
		Bun.spawnSync(
			[
				"bash",
				"-c",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expands its pipeline status.
				'"$@" | head -c 1 >/dev/null; exit "${PIPESTATUS[0]}"',
				"slice8",
				...command,
				...argv,
			],
			{ cwd: dir, env, stdin: "ignore" },
		);
	try {
		expect(run("project", "add", "T", "--actor", "@tester").exitCode).toBe(0);
		const body = "😀".repeat(20000);
		const cutWrite = intoHead(
			"add",
			"--actor",
			"@tester",
			"--title",
			"Committed despite cut output",
			"--body",
			body,
			"--json",
		);
		expect(cutWrite.exitCode).toBe(141);
		expect(cutWrite.stdout.toString()).toBe("");
		expect(cutWrite.stderr.toString()).toBe("");
		const read = run("show", "T-1", "--json");
		expect(read.exitCode).toBe(0);
		const shown = JSON.parse(read.stdout.toString());
		expectValid(outputs.show, shown);
		expect(shown.task).toMatchObject({
			key: "T-1",
			body,
			created_by: "@tester",
		});
		expect(shown.events.map((event: { kind: string }) => event.kind)).toEqual([
			"task_added",
		]);
		const cutRead = intoHead("show", "T-1", "--json");
		expect(cutRead.exitCode).toBe(141);
		expect(cutRead.stderr.toString()).toBe("");
		const cutWatch = intoHead("watch", "--json");
		expect(cutWatch.exitCode).toBe(141);
		expect(cutWatch.stderr.toString()).toBe("");
		const cutSql = intoHead("sql", "SELECT body FROM task");
		expect(cutSql.exitCode).toBe(141);
		expect(cutSql.stderr.toString()).not.toContain("board:");
		expect(cutSql.stderr.toString()).not.toContain("EPIPE");
		const after = JSON.parse(run("show", "T-1", "--json").stdout.toString());
		expect(after).toEqual(shown);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test(
	"source exits 141 quietly on cut reads and writes while preserving the committed write",
	() => exercise(),
	15000,
);
test.skipIf(!process.env.BOARD_BIN)(
	"compiled CLI exits 141 quietly and preserves a cut write's commit",
	() => exercise(process.env.BOARD_BIN),
	15000,
);
