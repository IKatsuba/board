import { expect, test } from "bun:test";
import {
	expiring,
	humanLine,
	jsonLine,
	type WatchedClaim,
	type WatchLine,
} from "../src/watch/derive.ts";

const origin = Date.parse("2026-10-13T12:00:00.000Z");
const at = (ms: number) => new Date(origin + ms);
const claim = (task: string, ms: number): WatchedClaim => ({
	project: task.split("-")[0] ?? "A",
	task,
	holder: "worker",
	since: at(0).toISOString(),
	until: at(ms).toISOString(),
});

test("a one-minute lease warns at its exact quarter threshold and never consumes an early or expired warning", () => {
	const c = claim("A-1", 60_000);
	const warned = new Map<string, string>();
	expect(expiring([c], at(44_999), warned, null)).toEqual([]);
	expect(warned.size).toBe(0);
	const first = expiring([c], at(45_000), warned, null);
	expect(first).toEqual([
		{
			id: null,
			derived: true,
			at: at(45_000).toISOString(),
			actor: "board",
			kind: "claim_expiring",
			project: "A",
			task: "A-1",
			milestone: null,
			data: {
				holder: "worker",
				until: at(60_000).toISOString(),
				minutes_left: 1,
			},
		},
	]);
	expect(expiring([c], at(59_999), warned, null)).toEqual([]);
	expect(expiring([c], at(60_000), new Map(), null)).toEqual([]);
	const expired = new Map<string, string>();
	expect(expiring([c], at(60_001), expired, 10)).toEqual([]);
	expect(expired.size).toBe(0);
	expect(expiring([c], at(59_999), new Map(), null)[0]?.data.minutes_left).toBe(
		1,
	);
});

test("each task and watcher warns independently, and a shortened end re-arms a warned lease", () => {
	const a = claim("A-1", 20 * 60_000);
	const b = claim("B-1", 20 * 60_000);
	const warned = new Map<string, string>();
	expect(
		expiring([a, b], at(15 * 60_000), warned, null).map((line) => line.task),
	).toEqual(["A-1", "B-1"]);
	expect(expiring([a, b], at(15 * 60_000 + 1), warned, null)).toEqual([]);
	expect(expiring([a, b], at(15 * 60_000 + 1), new Map(), null)).toHaveLength(
		2,
	);
	const shorter = { ...a, until: at(16 * 60_000).toISOString() };
	expect(
		expiring([shorter, b], at(15 * 60_000 + 1), warned, null),
	).toMatchObject([
		{ task: "A-1", data: { until: shorter.until, minutes_left: 1 } },
	]);
	expect(expiring([shorter, b], at(15 * 60_000 + 2), warned, null)).toEqual([]);
	const fixed = new Map<string, string>();
	expect(expiring([a], at(10 * 60_000 - 1), fixed, 10)).toEqual([]);
	expect(expiring([a], at(10 * 60_000), fixed, 10)).toHaveLength(1);
});

test("JSON preserves the full event and controls while human output escapes controls without mutating the data", () => {
	const line: WatchLine = {
		id: 1,
		derived: false,
		at: at(0).toISOString(),
		actor: "worker\u001b\u009b",
		kind: "handover",
		project: "A",
		task: "A-1",
		milestone: "v1",
		data: {
			to: "main\u001b\u009b",
			text: "First\u001b\u009b😀\nSecond",
			changed: "Long\nchange",
			ran: "Tests\tall",
			unchecked: "None",
		},
	};
	const before = structuredClone(line);
	expect(JSON.parse(jsonLine(line))).toEqual(before);
	expect(jsonLine(line).split("\n")).toHaveLength(1);
	const human = humanLine(line);
	expect(human.split("\t")).toHaveLength(7);
	expect(human).toContain("worker\\u001b\\u009b");
	expect(human).toContain("to main\\u001b\\u009b: First\\u001b\\u009b😀");
	expect(human).not.toContain("Second");
	expect(human).not.toContain("\u001b");
	expect(human).not.toContain("\u009b");
	expect(line).toEqual(before);
});
