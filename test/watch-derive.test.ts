import { describe, expect, test } from "bun:test";
import {
	expiring,
	humanLine,
	jsonLine,
	summary,
	type Warned,
	type WatchedClaim,
	type WatchLine,
} from "../src/watch/derive.ts";

const line = (over: Partial<WatchLine>): WatchLine => ({
	id: 436,
	derived: false,
	at: "2026-10-12T14:03:00.000Z",
	actor: "main",
	kind: "claimed",
	project: "BRD",
	task: "BRD-14",
	milestone: null,
	data: {},
	...over,
});

describe("lines", () => {
	test("the design's examples", () => {
		expect(
			humanLine(
				line({
					data: {
						holder: "@lead",
						since: "2026-10-12T14:03:00.000Z",
						until: "2026-10-12T15:33:00.000Z",
						directory: null,
						branch: "feat/watch",
					},
				}),
			),
		).toBe(
			"2026-10-12T14:03:00.000Z\t#436\tBRD\tBRD-14\tmain\tclaimed\t@lead for 90 min, until 2026-10-12T15:33:00.000Z, feat/watch",
		);
		expect(
			humanLine(
				line({
					id: 437,
					at: "2026-10-12T14:05:00.000Z",
					project: "APP",
					task: null,
					actor: "owner",
					kind: "milestone_added",
					data: { name: "v2", delivers: "x", position: 3 },
				}),
			),
		).toBe(
			"2026-10-12T14:05:00.000Z\t#437\tAPP\t-\towner\tmilestone_added\tv2 at 3",
		);
		const [warning] = expiring(
			[
				{
					project: "BRD",
					task: "BRD-14",
					holder: "@lead",
					since: "2026-10-12T14:03:00.000Z",
					until: "2026-10-12T15:33:00.000Z",
				},
			],
			new Date("2026-10-12T15:23:00.000Z"),
			new Map(),
			null,
		);
		expect(humanLine(warning as WatchLine)).toBe(
			"2026-10-12T15:23:00.000Z\t-\tBRD\tBRD-14\tboard\tclaim_expiring\t@lead's claim ends at 2026-10-12T15:33:00.000Z (in 10m)",
		);
	});

	test("the JSON line is one flat object, a derived one with id null", () => {
		expect(JSON.parse(jsonLine(line({ data: { a: 1 } })))).toEqual({
			id: 436,
			derived: false,
			at: "2026-10-12T14:03:00.000Z",
			actor: "main",
			kind: "claimed",
			project: "BRD",
			task: "BRD-14",
			milestone: null,
			data: { a: 1 },
		});
		expect(jsonLine(line({}))).not.toContain("\n");
	});

	test.each([
		["board_created", {}, "the board"],
		["project_added", { key: "B", name: "b", directory: "/w/b" }, "B b /w/b"],
		["project_edited", { name: { from: "a", to: "b" } }, "name a → b"],
		["project_removed", { key: "B", name: "b", directory: "/w/b" }, "B b /w/b"],
		[
			"task_added",
			{
				title: "T",
				body: "",
				status: "ready",
				priority: "normal",
				parent: "B-1",
				milestone: "v1",
				waits: [],
			},
			'"T" (v1, under B-1, ready)',
		],
		[
			"task_edited",
			{
				title: { from: "a", to: "b" },
				body: { from: "", to: "x" },
				parent: { from: null, to: "B-2" },
			},
			'title "a" → "b", body changed, parent none → B-2',
		],
		["task_status", { from: "ready", to: "done" }, "ready → done"],
		["task_moved", { from: null, to: "v1" }, "none → v1"],
		["waits_changed", { added: ["B-2"], removed: ["B-3"] }, "+B-2 -B-3"],
		[
			"claim_extended",
			{ holder: "@l", until: { from: "t1", to: "t2" } },
			"@l until t1 → t2",
		],
		[
			"claim_released",
			{ holder: "@l", reason: "sent_back", note: null },
			"@l, sent_back",
		],
		[
			"claim_released",
			{ holder: "@l", reason: "release", note: "later" },
			"@l, release: later",
		],
		[
			"claim_expired",
			{ holder: "@l", since: "t0", until: "t1", by: "main" },
			"@l's claim ended at t1, noticed by main",
		],
		["comment", { text: "first line\nsecond" }, "first line"],
		["comment", { text: "x".repeat(100) }, `${"x".repeat(79)}…`],
		[
			"handover",
			{ to: "main", text: "done", changed: "a", ran: "b", unchecked: "c" },
			"to main: done",
		],
		[
			"question_asked",
			{ question: "Q7", text: "How?", options: [], recommended: 1 },
			"Q7: How?",
		],
		[
			"question_answered",
			{
				question: "Q7",
				choice: 2,
				text: null,
				as: "delegate",
				overrides: null,
			},
			"Q7 as delegate: choice 2",
		],
		[
			"question_answered",
			{ question: "Q7", choice: null, text: "no", as: "owner", overrides: {} },
			"Q7 as owner: no, replacing a delegate's answer",
		],
		["question_validated", { question: "Q7" }, "Q7"],
		[
			"question_withdrawn",
			{ question: "Q7", why: "B-1 was cancelled" },
			"Q7: B-1 was cancelled",
		],
		[
			"milestone_edited",
			{
				name: { from: "v1", to: "v2" },
				delivers: { from: "a", to: "b" },
				position: { from: 1, to: 2 },
			},
			"name v1 → v2, delivers changed, position 1 → 2",
		],
		["milestone_deleted", { name: "v2" }, "v2"],
		["milestone_done", { name: "v2" }, "v2"],
		["milestone_reopened", { name: "v2", by: "B-4" }, "v2 by B-4"],
	] as const)("%s %#", (kind, data, expected) => {
		expect(summary(kind, data)).toBe(expected);
	});
});

describe("claim_expiring", () => {
	const at = (s: string) => new Date(`2026-10-12T${s}:00.000Z`);
	const claim = (since: string, until: string): WatchedClaim => ({
		project: "BRD",
		task: "BRD-1",
		holder: "@lead",
		since: at(since).toISOString(),
		until: at(until).toISOString(),
	});

	test("the default threshold is min(10 minutes, a quarter of the lease)", () => {
		const long = claim("10:00", "12:00");
		expect(expiring([long], at("11:49"), new Map(), null)).toEqual([]);
		expect(expiring([long], at("11:50"), new Map(), null)).toHaveLength(1);
		const short = claim("10:00", "10:20");
		expect(expiring([short], at("10:14"), new Map(), null)).toEqual([]);
		const [line] = expiring([short], at("10:15"), new Map(), null);
		expect(line?.data).toEqual({
			holder: "@lead",
			until: "2026-10-12T10:20:00.000Z",
			minutes_left: 5,
		});
	});

	test("a fixed threshold replaces it", () => {
		const long = claim("10:00", "12:00");
		expect(expiring([long], at("11:29"), new Map(), 30)).toEqual([]);
		expect(expiring([long], at("11:30"), new Map(), 30)).toHaveLength(1);
	});

	test("once per lease; an extend re-arms it; none at or past the end", () => {
		const warned: Warned = new Map();
		const first = claim("10:00", "11:00");
		expect(expiring([first], at("10:50"), warned, null)).toHaveLength(1);
		expect(expiring([first], at("10:55"), warned, null)).toEqual([]);
		const extended = { ...first, until: at("11:30").toISOString() };
		expect(expiring([extended], at("10:56"), warned, null)).toEqual([]);
		expect(expiring([extended], at("11:20"), warned, null)).toHaveLength(1);
		expect(
			expiring([claim("10:00", "11:00")], at("11:00"), new Map(), null),
		).toEqual([]);
	});

	test("the attach line: a claim already inside its window warns at once, minutes rounded up", () => {
		const [line] = expiring(
			[claim("10:00", "11:00")],
			new Date("2026-10-12T10:58:30.000Z"),
			new Map(),
			null,
		);
		expect(line).toMatchObject({
			id: null,
			derived: true,
			actor: "board",
			kind: "claim_expiring",
			at: "2026-10-12T10:58:30.000Z",
			data: { minutes_left: 2 },
		});
	});
});

test("a lease released and claimed again with the same end warns for the new lease", () => {
	const warned: Warned = new Map();
	const first: WatchedClaim = {
		project: "A",
		task: "A-1",
		holder: "@one",
		since: "2026-10-12T10:00:00.000Z",
		until: "2026-10-12T11:00:00.000Z",
	};
	expect(
		expiring([first], new Date("2026-10-12T10:50:00.000Z"), warned, null),
	).toHaveLength(1);
	const again = { ...first, holder: "@two", since: "2026-10-12T10:51:00.000Z" };
	expect(
		expiring([again], new Date("2026-10-12T10:58:00.000Z"), warned, null),
	).toMatchObject([
		{ data: { holder: "@two", until: "2026-10-12T11:00:00.000Z" } },
	]);
	expect(
		expiring([again], new Date("2026-10-12T10:59:00.000Z"), warned, null),
	).toEqual([]);
});

test("a field holding controls, a newline or a tab stays one field of one line", () => {
	const text = humanLine({
		id: 1,
		derived: false,
		at: "2026-10-12T10:00:00.000Z",
		actor: "@x\t\x1b[2J",
		kind: "task_added",
		project: "A",
		task: "A-1",
		milestone: null,
		data: {
			title: "evil\n2026\t#9\x9b",
			body: "",
			status: "ready",
			priority: "normal",
			parent: null,
			milestone: null,
			waits: [],
		},
	});
	expect(text.split("\n")).toHaveLength(1);
	expect(text.split("\t")).toHaveLength(7);
	expect(text).toContain("@x\\u0009\\u001b[2J");
	expect(text).toContain('"evil\\u000a2026\\u0009#9\\u009b"');
});
