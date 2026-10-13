import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summary, type WatchLine } from "../src/watch/derive.ts";
import { runExec } from "../src/watch/exec.ts";

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const line: WatchLine = {
	id: null,
	derived: true,
	at: "2026-10-13T12:00:00.000Z",
	actor: "board",
	kind: "claim_expiring",
	project: "A",
	task: "A-1",
	milestone: null,
	data: {
		holder: "worker",
		until: "2026-10-13T12:01:00.000Z",
		minutes_left: 1,
	},
};

test("a real notifier receives exact JSON and current BOARD fields overriding stale inherited values", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice5-exec-input-");
	try {
		const script = join(dir, "notifier.ts");
		writeFileSync(
			script,
			`const input=await Bun.stdin.text(); console.log(JSON.stringify({input,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith("BOARD_")))}));\n`,
		);
		const chunks: Buffer[] = [];
		const value: WatchLine = {
			...line,
			id: 12,
			derived: false,
			actor: "actor\u001b\u009b",
			kind: "comment",
			data: { text: "Literal $(echo forged); ' quote 😀\nSecond line" },
		};
		await runExec(
			`exec ${shellQuote(process.execPath)} ${shellQuote(script)}`,
			value,
			5,
			(chunk) => chunks.push(Buffer.from(chunk)),
			{
				PATH: "/usr/bin:/bin",
				BOARD_EVENT_ID: "999",
				BOARD_EVENT_KIND: "stale",
				BOARD_EVENT_AT: "stale",
				BOARD_PROJECT: "stale",
				BOARD_TASK: "stale",
				BOARD_ACTOR: "stale",
				BOARD_SUMMARY: "stale",
				BOARD_TEST_MARK: "kept",
			},
		);
		const output = JSON.parse(Buffer.concat(chunks).toString());
		expect(output.input).toBe(`${JSON.stringify(value)}\n`);
		expect(JSON.parse(output.input)).toEqual(value);
		expect(output.env).toEqual({
			BOARD_EVENT_ID: "12",
			BOARD_EVENT_KIND: "comment",
			BOARD_EVENT_AT: value.at,
			BOARD_PROJECT: "A",
			BOARD_TASK: "A-1",
			BOARD_ACTOR: value.actor,
			BOARD_SUMMARY: summary(value.kind, value.data),
			BOARD_TEST_MARK: "kept",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("both output pipes drain beyond their buffers and a failing derived notifier does not stop the next invocation", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice5-exec-output-");
	try {
		const script = join(dir, "notifier.ts");
		writeFileSync(
			script,
			`await Bun.stdin.text(); await Promise.all([Bun.write(Bun.stdout,"O".repeat(128*1024)),Bun.write(Bun.stderr,"E".repeat(128*1024))]); process.exit(7);\n`,
		);
		const chunks: Buffer[] = [];
		const sink = (chunk: Uint8Array | string) =>
			chunks.push(Buffer.from(chunk));
		await runExec(
			`exec ${shellQuote(process.execPath)} ${shellQuote(script)}`,
			line,
			5,
			sink,
			{ PATH: "/usr/bin:/bin" },
		);
		const out = Buffer.concat(chunks).toString();
		expect(out.split("O").length - 1).toBe(128 * 1024);
		expect(out.split("E").length - 1).toBe(128 * 1024);
		expect(out).toEndWith(
			"board: --exec exited 7 for the derived claim_expiring\n",
		);
		expect(out.match(/board: --exec/g)).toHaveLength(1);
		chunks.length = 0;
		await runExec(
			'printf "%s|%s" "$BOARD_EVENT_ID" "$BOARD_EVENT_KIND"',
			line,
			5,
			sink,
			{ PATH: "/usr/bin:/bin" },
		);
		expect(Buffer.concat(chunks).toString()).toBe("|claim_expiring");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
