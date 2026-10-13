// Concurrency through the CLI is across processes, never in process: two
// runCli calls in one process share one thread, and SQLite's busy handler
// would block the holder behind the waiter ("Tests").
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
let dir: string;
let env: Record<string, string | undefined>;

/** Starts `board …` as its own process from the project's directory. */
function start(...argv: string[]) {
	return Bun.spawn([process.execPath, MAIN, ...argv], {
		cwd: dir,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function finish(child: ReturnType<typeof start>) {
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

async function board(...argv: string[]) {
	const done = await finish(start(...argv));
	if (done.code !== 0)
		throw new Error(`board ${argv.join(" ")}: ${done.stderr}`);
	return done.stdout;
}

beforeAll(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-concurrency-")));
	env = { ...process.env, BOARD_DIR: join(dir, "b") };
	await board("project", "add", "C", "--actor", "owner");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("two claims of one task started together: one exits 0, the other claim_held, 20 times", async () => {
	for (let round = 1; round <= 20; round++) {
		const key = JSON.parse(
			await board(
				"add",
				"--actor",
				"owner",
				"--title",
				`Round ${round}`,
				"--json",
			),
		).task.key as string;
		const results = await Promise.all(
			["@first", "@second"].map((who) =>
				finish(start("claim", key, "--actor", who, "--minutes", "30")),
			),
		);
		const codes = results.map((r) => r.code).sort();
		expect(codes).toEqual([0, 1]);
		const lost = results.find((r) => r.code === 1);
		expect(lost?.stdout).toBe("");
		expect(lost?.stderr).toStartWith(`board: claim_held: ${key} is held by @`);
		const won = results.find((r) => r.code === 0);
		const holder = won?.stdout.match(/claimed by (@\w+)/)?.[1];
		const shown = JSON.parse(await board("show", key, "--json"));
		expect(shown.task.claim.holder).toBe(holder);
		expect(
			shown.events.filter((e: { kind: string }) => e.kind === "claimed"),
		).toHaveLength(1);
	}
}, 120_000);

test("four concurrent edits of one task's waits all land; none loses another's", async () => {
	const keys: string[] = [];
	for (const title of ["Target", "A", "B", "C", "D"]) {
		keys.push(
			JSON.parse(
				await board("add", "--actor", "owner", "--title", title, "--json"),
			).task.key,
		);
	}
	const [target, ...waits] = keys as [string, ...string[]];
	const results = await Promise.all(
		waits.map((wait) =>
			finish(start("edit", target, "--actor", "owner", "--waits-add", wait)),
		),
	);
	expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
	const shown = JSON.parse(await board("show", target, "--json"));
	expect(shown.task.waits.map((w: { key: string }) => w.key).sort()).toEqual(
		[...waits].sort(),
	);
	expect(
		shown.events.filter((e: { kind: string }) => e.kind === "waits_changed"),
	).toHaveLength(4);
}, 60_000);
