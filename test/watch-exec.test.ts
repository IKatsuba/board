import { expect, test } from "bun:test";
import type { WatchLine } from "../src/watch/derive.ts";
import { runExec } from "../src/watch/exec.ts";

const line: WatchLine = {
	id: 436,
	derived: false,
	at: "2026-10-12T14:03:00.000Z",
	actor: "main",
	kind: "claimed",
	project: "BRD",
	task: "BRD-14",
	milestone: null,
	data: {
		holder: "@lead",
		since: "2026-10-12T14:03:00.000Z",
		until: "2026-10-12T15:33:00.000Z",
		directory: null,
		branch: "feat/watch",
	},
};

/** What board would have been started with: here, only a PATH and one mark. */
const inherited = { PATH: "/usr/bin:/bin", BOARD_TEST_MARK: "kept" };

async function run(command: string, l = line, timeout = 30) {
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	await runExec(
		command,
		l,
		timeout,
		(c) => chunks.push(typeof c === "string" ? c : decoder.decode(c)),
		inherited,
	);
	return chunks.join("");
}

test("the line's JSON on stdin; output goes to the sink", async () => {
	const out = await run("cat; echo done >&2");
	expect(JSON.parse(out.split("\n")[0] as string)).toMatchObject({
		id: 436,
		kind: "claimed",
		task: "BRD-14",
	});
	expect(out).toContain("done");
});

test("the BOARD_* environment, empty where there is nothing", async () => {
	const out = await run(
		'printf "%s|%s|%s|%s|%s|%s|%s" "$BOARD_EVENT_ID" "$BOARD_EVENT_KIND" "$BOARD_EVENT_AT" "$BOARD_PROJECT" "$BOARD_TASK" "$BOARD_ACTOR" "$BOARD_SUMMARY"',
	);
	expect(out).toBe(
		"436|claimed|2026-10-12T14:03:00.000Z|BRD|BRD-14|main|@lead for 90 min, until 2026-10-12T15:33:00.000Z, feat/watch",
	);
	const derived = await run(
		'printf "[%s][%s][%s]" "$BOARD_EVENT_ID" "$BOARD_PROJECT" "$BOARD_TASK"',
		{
			...line,
			id: null,
			derived: true,
			project: null,
			task: null,
			kind: "board_created",
			data: {},
		},
	);
	expect(derived).toBe("[][][]");
});

test("the command inherits the environment it is given, and nothing else", async () => {
	expect(await run('printf "%s|%s" "$BOARD_TEST_MARK" "$HOME"')).toBe("kept|");
});

test("a failing command is one line, and returns", async () => {
	expect(await run("exit 3")).toBe("board: --exec exited 3 for #436\n");
});

test("past the timeout: SIGTERM, and SIGKILL 2 s later for one that ignores it", async () => {
	const started = Date.now();
	expect(await run("sleep 30", line, 0.3)).toBe(
		"board: --exec did not finish in 0.3 s for #436; stopped (SIGTERM)\n",
	);
	expect(Date.now() - started).toBeLessThan(1_500);
	const stubborn = Date.now();
	const out = await run("trap '' TERM; while :; do sleep 0.1; done", line, 0.3);
	expect(out).toBe(
		"board: --exec did not finish in 0.3 s for #436; stopped (SIGKILL)\n",
	);
	expect(Date.now() - stubborn).toBeGreaterThanOrEqual(2_200);
}, 10_000);

test("a stopped command's own children do not hold the watcher", async () => {
	const started = Date.now();
	const out = await run("sleep 30; true", line, 0.3);
	expect(out).toContain("did not finish in 0.3 s");
	expect(Date.now() - started).toBeLessThan(1_500);
});

test("a command that exits leaving a child on its pipes returns at once, its output kept", async () => {
	const started = Date.now();
	const out = await run("echo before; sleep 30 & exit 0", line, 0.1);
	expect(out).toBe("before\n");
	expect(Date.now() - started).toBeLessThan(1_000);
});

test("lines run one at a time, in order", async () => {
	const order: string[] = [];
	for (const id of [1, 2, 3]) {
		order.push(await run(`sleep 0.0${4 - id}; printf ${id}`, { ...line, id }));
	}
	expect(order).toEqual(["1", "2", "3"]);
});
