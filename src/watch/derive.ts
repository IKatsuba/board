import { stamp } from "../clock.ts";
import type { Kind } from "../schemas.ts";
import { oneLine } from "../visible.ts";

/** The one kind a watcher derives and never writes. */
export type WatchKind = Kind | "claim_expiring";

/**
 * One line of `board watch`, logged or derived, in the one flat shape of its
 * `--json`. A derived line has no id, so a consumer that tracks the last id
 * it saw never advances onto it.
 */
export interface WatchLine {
	id: number | null;
	derived: boolean;
	at: string;
	actor: string;
	kind: WatchKind;
	project: string | null;
	task: string | null;
	milestone: string | null;
	data: Record<string, unknown>;
}

/**
 * The human line: tab-separated time, #id, project, task, actor, kind,
 * summary. Each field is shown on one line, controls, newlines and tabs as
 * visible escapes, so a field written by an agent cannot drive the terminal
 * or forge a line or a column.
 */
export function humanLine(line: WatchLine): string {
	return [
		line.at,
		line.id === null ? "-" : `#${line.id}`,
		line.project ?? "-",
		line.task ?? "-",
		line.actor,
		line.kind,
		summary(line.kind, line.data),
	]
		.map(oneLine)
		.join("\t");
}

/** The JSON line: the shape above, one object. */
export function jsonLine(line: WatchLine): string {
	return JSON.stringify({
		id: line.id,
		derived: line.derived,
		at: line.at,
		actor: line.actor,
		kind: line.kind,
		project: line.project,
		task: line.task,
		milestone: line.milestone,
		data: line.data,
	});
}

type Data = Record<string, unknown>;
type Change = { from: unknown; to: unknown };

const or = (value: unknown, none = "none") =>
	value === null || value === undefined ? none : String(value);

/** A text on one line: its first line, cut at 80 characters. */
function brief(text: unknown): string {
	const first = String(text ?? "").split("\n")[0] ?? "";
	return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

function changes(data: Data, quoted: readonly string[] = []): string {
	return Object.entries(data)
		.map(([field, value]) => {
			const { from, to } = value as Change;
			if (field === "body" || field === "delivers") return `${field} changed`;
			const show = (v: unknown) =>
				quoted.includes(field) && v !== null ? `"${v}"` : or(v);
			return `${field} ${show(from)} → ${show(to)}`;
		})
		.join(", ");
}

function minutesBetween(since: unknown, until: unknown): number {
	return Math.round(
		(Date.parse(String(until)) - Date.parse(String(since))) / 60_000,
	);
}

/** "in 10m", rounded up, so a live claim never reads "in 0m" past a minute. */
function inMinutes(minutes: number): string {
	return `in ${minutes}m`;
}

/** The summary written from an event's data, per kind. */
export function summary(kind: WatchKind, d: Data): string {
	switch (kind) {
		case "board_created":
			return "the board";
		case "project_added":
		case "project_removed":
			return `${d.key} ${d.name} ${d.directory}`;
		case "project_edited":
		case "milestone_edited":
			return changes(d);
		case "task_added": {
			const where = [
				d.milestone,
				d.parent === null ? null : `under ${d.parent}`,
				d.status,
			].filter((part) => part !== null && part !== undefined);
			return `"${d.title}" (${where.join(", ")})`;
		}
		case "task_edited":
			return changes(d, ["title"]);
		case "task_status":
		case "task_moved":
			return `${or(d.from)} → ${or(d.to)}`;
		case "waits_changed": {
			const added = (d.added as string[]).map((k) => `+${k}`);
			const removed = (d.removed as string[]).map((k) => `-${k}`);
			return [...added, ...removed].join(" ");
		}
		case "claimed": {
			const parts = [
				`${d.holder} for ${minutesBetween(d.since, d.until)} min`,
				`until ${d.until}`,
				d.branch,
			].filter((part) => part !== null && part !== undefined);
			return parts.join(", ");
		}
		case "claim_extended": {
			const until = d.until as Change;
			return `${d.holder} until ${until.from} → ${until.to}`;
		}
		case "claim_released":
			return `${d.holder}, ${d.reason}${d.note === null ? "" : `: ${brief(d.note)}`}`;
		case "claim_expired":
			return `${d.holder}'s claim ended at ${d.until}, noticed by ${d.by}`;
		case "comment":
			return brief(d.text);
		case "handover":
			return `to ${d.to}: ${brief(d.text)}`;
		case "question_asked":
			return `${d.question}: ${brief(d.text)}`;
		case "question_answered": {
			const said = [d.choice === null ? null : `choice ${d.choice}`, d.text]
				.filter((part) => part !== null && part !== undefined)
				.map(brief)
				.join(", ");
			const over =
				d.overrides === null ? "" : ", replacing a delegate's answer";
			return `${d.question} as ${d.as}: ${said}${over}`;
		}
		case "question_validated":
			return String(d.question);
		case "question_withdrawn":
			return `${d.question}: ${d.why}`;
		case "milestone_added":
			return `${d.name} at ${d.position}`;
		case "milestone_deleted":
		case "milestone_done":
			return String(d.name);
		case "milestone_reopened":
			return `${d.name} by ${d.by}`;
		case "claim_expiring":
			return `${d.holder}'s claim ends at ${d.until} (${inMinutes(Number(d.minutes_left))})`;
	}
}

/** A live claim a watcher watches. */
export interface WatchedClaim {
	project: string;
	task: string;
	holder: string;
	since: string;
	until: string;
}

/**
 * What a watcher remembers between ticks: the lease it last warned about,
 * per task, as its start and end, so each lease warns once, an extend (a new
 * end) can warn again, and a task released and claimed again warns for the
 * new lease even when its end is the same.
 */
export type Warned = Map<string, string>;

/**
 * The `claim_expiring` lines due at `now`: a claim inside its window, `until
 * − threshold <= now < until`, not yet warned about for this end. The
 * default threshold is min(10 minutes, a quarter of the lease): a fixed 10
 * would fire at once on a short lease, and a share alone would warn half an
 * hour ahead of a long one. `fixed` (minutes) replaces it.
 */
export function expiring(
	claims: readonly WatchedClaim[],
	now: Date,
	warned: Warned,
	fixed: number | null,
): WatchLine[] {
	const lines: WatchLine[] = [];
	const at = now.getTime();
	for (const claim of claims) {
		const until = Date.parse(claim.until);
		const lease = until - Date.parse(claim.since);
		const threshold =
			fixed === null ? Math.min(10 * 60_000, lease / 4) : fixed * 60_000;
		if (at < until - threshold || at >= until) continue;
		const identity = `${claim.since}/${claim.until}`;
		if (warned.get(claim.task) === identity) continue;
		warned.set(claim.task, identity);
		lines.push({
			id: null,
			derived: true,
			at: stamp(now),
			actor: "board",
			kind: "claim_expiring",
			project: claim.project,
			task: claim.task,
			milestone: null,
			data: {
				holder: claim.holder,
				until: claim.until,
				minutes_left: Math.ceil((until - at) / 60_000),
			},
		});
	}
	return lines;
}
