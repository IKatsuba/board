import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { shown } from "../src/cli/io.ts";
import { SystemClock } from "../src/clock.ts";
import { Place } from "../src/place/place.ts";
import { Store } from "../src/store/store.ts";

const codes = [
	...Array.from({ length: 32 }, (_, i) => i),
	...Array.from({ length: 32 }, (_, i) => i + 128),
].filter((code) => code !== 9 && code !== 10);
const controls = String.fromCharCode(...codes);

test("every C0/C1 control except newline and tab becomes a visible escape", () => {
	for (const code of codes)
		expect(shown(String.fromCharCode(code))).toBe(
			`\\u${code.toString(16).padStart(4, "0")}`,
		);
	expect(shown("\n\t\x7f é 中文 😀 \\u001b")).toBe(
		"\n\t\x7f é 中文 😀 \\u001b",
	);
});

test("source human CLI escapes all controls and JSON preserves stored strings", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice2-controls-");
	const env = {
		dir: join(dir, "board"),
		file: join(dir, "board", "board.db"),
		boardDirSet: true,
	};
	const runner = {
		async commonDir() {
			return {
				kind: "exit" as const,
				code: 128,
				stdout: "",
				stderr: "fatal: not a git repository",
			};
		},
	};
	const main = join(import.meta.dir, "..", "src", "main.ts");
	const title = `Title${controls}`;
	const body = `Body${controls}\nnext\tcolumn`;
	const actor = `A${controls}`;
	const source = (...args: string[]) => {
		const result = Bun.spawnSync([process.execPath, main, ...args], {
			cwd: dir,
			env: { ...process.env, BOARD_DIR: env.dir },
		});
		expect(result.exitCode).toBe(0);
		return { out: result.stdout.toString(), err: result.stderr.toString() };
	};
	try {
		await projectAdd(env, SystemClock, runner, dir, {
			actor: "owner",
			key: "T",
			name: `Name${controls}`,
		});
		const board = new Board(await Store.open(env, SystemClock));
		try {
			await board.taskAdd(new Place(dir, runner), { actor, title, body });
		} finally {
			await board.close();
		}
		const human = [
			source("ls"),
			source("show", "T-1"),
			source("project", "ls"),
		];
		for (const result of human) {
			for (const code of codes)
				expect(result.out + result.err).not.toContain(
					String.fromCharCode(code),
				);
		}
		expect(human[0]?.out).toContain(shown(title));
		expect(human[1]?.out).toContain(shown(body));
		expect(human[1]?.out).toContain(shown(actor));
		expect(human[2]?.out).toContain(shown(`Name${controls}`));
		const json = JSON.parse(source("show", "T-1", "--json").out);
		expect(json.task).toMatchObject({ title, body, created_by: actor });
		expect(json.events[0]).toMatchObject({ actor, data: { title, body } });
		expect(
			JSON.parse(source("project", "ls", "--json").out).projects[0].project
				.name,
		).toBe(`Name${controls}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
