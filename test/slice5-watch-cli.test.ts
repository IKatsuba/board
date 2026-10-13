import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { SystemClock } from "../src/clock.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";

const main = join(import.meta.dir, "..", "src", "main.ts");
async function fixture() {
	const dir = mkdtempSync("/private/tmp/board-slice5-watch-cli-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	await Store.create(env, SystemClock, "owner", (tx, now) =>
		addProject(tx, now, "owner", { key: "A", name: "A", directory: dir }),
	);
	return { dir, env };
}

test("source watch keeps seven human fields with visible LF/TAB and lossless JSON", async () => {
	const { dir, env } = await fixture();
	try {
		const board = new Board(await Store.open(env, SystemClock));
		const actor = "worker\t\u001b\u009b";
		const title = "First\nSecond\t😀\u001b\u009b";
		try {
			await board.taskAdd(
				new Place(dir, {
					async commonDir() {
						throw new Error("Unexpected git");
					},
				}),
				{ actor, title },
			);
		} finally {
			await board.close();
		}
		const run = (...args: string[]) =>
			Bun.spawnSync(
				[
					process.execPath,
					main,
					"watch",
					"--kind",
					"task_added",
					"--task",
					"a-1",
					...args,
				],
				{ cwd: dir, env: { ...process.env, BOARD_DIR: dir } },
			);
		const human = run();
		expect(human.exitCode).toBe(0);
		expect(human.stderr.toString()).toBe("");
		const text = human.stdout.toString().trimEnd();
		expect(text.split("\n")).toHaveLength(1);
		expect(text.split("\t")).toHaveLength(7);
		expect(text).toContain("worker\\u0009\\u001b\\u009b");
		expect(text).toContain("First\\u000aSecond\\u0009😀\\u001b\\u009b");
		const json = run("--json");
		expect(json.exitCode).toBe(0);
		expect(json.stderr.toString()).toBe("");
		expect(JSON.parse(json.stdout.toString())).toMatchObject({
			derived: false,
			actor,
			project: "A",
			task: "A-1",
			kind: "task_added",
			data: { title },
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Bun-spawned source watcher exits 143 on SIGTERM after its attach output", async () => {
	const { dir } = await fixture();
	const child = Bun.spawn(
		[
			process.execPath,
			main,
			"watch",
			"--follow",
			"--since",
			"0",
			"--kind",
			"project_added",
			"--json",
		],
		{
			cwd: dir,
			env: { ...process.env, BOARD_DIR: dir },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let text = "";
		while (!text.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Watcher exited before attach output");
			text += decoder.decode(chunk.value, { stream: true });
		}
		expect(JSON.parse(text.trim())).toMatchObject({
			kind: "project_added",
			project: "A",
		});
		child.kill("SIGTERM");
		expect(await child.exited).toBe(143);
		expect(child.signalCode).toBe("SIGTERM");
		expect(await new Response(child.stderr).text()).toBe("");
		await reader.cancel();
	} finally {
		if (child.exitCode === null) child.kill();
		await child.exited;
		rmSync(dir, { recursive: true, force: true });
	}
}, 10_000);
