import type { TaskNextOutput } from "./rules/next.ts";
import type { BoardStatus } from "./rules/status.ts";
import type { TaskListOutput, TaskReadOutput } from "./rules/tasks.ts";
import type { UpdateField } from "./rules/update.ts";
import type { Claim, Event, Question, Task, TaskSummary } from "./schemas.ts";

// The one short line every answer has: a write's answer on stdout, a
// read's note on stderr.

export function addedText(task: Task): string {
	const where = [
		task.milestone,
		task.parent === null ? null : `under ${task.parent}`,
		task.status,
	].filter((part) => part !== null);
	return `added ${task.key} "${task.title}" (${where.join(", ")})`;
}

export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function listText(
	value: TaskListOutput,
	contains: string | undefined,
): string {
	const scope = value.project === "*" ? "every project" : value.project;
	const count =
		value.tasks.length < value.total
			? `${value.tasks.length} of ${plural(value.total, "task")}`
			: plural(value.total, "task");
	const containing = contains === undefined ? "" : ` containing "${contains}"`;
	const next =
		value.next_offset === null
			? ""
			: `; next page: --offset ${value.next_offset}`;
	return `${count} in ${scope}${containing}${next}`;
}

export function readText(value: TaskReadOutput, since: number): string {
	const { task } = value;
	const held =
		task.claim === null
			? ""
			: `, held by ${task.claim.holder} until ${task.claim.until}`;
	return `${task.key} ${task.status}${held}; ${plural(value.events.length, "event")} since ${since}`;
}

export function claimedText(claim: Claim, minutes: number): string {
	return `${claim.key} claimed by ${claim.holder} until ${claim.until} (${minutes} min)`;
}

export function extendedText(claim: Claim, minutes: number): string {
	return `${claim.key} held by ${claim.holder} until ${claim.until} (${minutes} min from now)`;
}

export function releasedText(released: Claim, actor: string): string {
	return `${released.key} released by ${actor} (held by ${released.holder} since ${released.since})`;
}

const ORDER: readonly UpdateField[] = [
	"title",
	"body",
	"priority",
	"status",
	"parent",
	"milestone",
	"waits",
];

/** "BRD-17: status backlog → ready, milestone v1 → v2". */
export function updatedText(
	before: Task,
	after: Task,
	changed: readonly UpdateField[],
): string {
	if (changed.length === 0) return `${after.key}: nothing to change`;
	const arrow = (from: string | null, to: string | null) =>
		`${from ?? "none"} → ${to ?? "none"}`;
	// Appendix B's field order, whatever order the events were written in.
	const parts = [...changed]
		.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
		.map((field) => {
			switch (field) {
				case "status":
					return `status ${arrow(before.status, after.status)}`;
				case "milestone":
					return `milestone ${arrow(before.milestone, after.milestone)}`;
				case "priority":
					return `priority ${arrow(before.priority, after.priority)}`;
				case "parent":
					return `parent ${arrow(before.parent, after.parent)}`;
				case "waits": {
					const was = new Set(before.waits.map((w) => w.key));
					const now = new Set(after.waits.map((w) => w.key));
					const added = [...now].filter((k) => !was.has(k)).map((k) => `+${k}`);
					const removed = [...was]
						.filter((k) => !now.has(k))
						.map((k) => `-${k}`);
					return `waits ${[...added, ...removed].join(" ")}`;
				}
				default:
					return field;
			}
		});
	return `${after.key}: ${parts.join(", ")}`;
}

export function nextText(value: TaskNextOutput): string {
	const task: TaskSummary | null = value.task;
	if (task === null) {
		const why = [
			value.waiting.blocked > 0
				? `${value.waiting.blocked} blocked on a question`
				: null,
			value.waiting.active > 0 ? `${value.waiting.active} active` : null,
			value.waiting.waits_open > 0
				? `${value.waiting.waits_open} waiting on other tasks`
				: null,
		].filter((part) => part !== null);
		return `nothing ready in ${value.project}${why.length > 0 ? `: ${why.join(", ")}` : ""}`;
	}
	const current = value.milestone?.name;
	const where =
		value.from === "current"
			? `current milestone ${current}`
			: value.from === "milestone"
				? `milestone ${task.milestone}`
				: value.from === "unassigned"
					? `no milestone${current === undefined ? "" : `; ${current} has nothing ready`}`
					: `milestone ${task.milestone}${current === undefined ? "" : `; ${current} has nothing ready`}`;
	return `next in ${value.project}: ${task.key} "${task.title}" (${where})`;
}

export function commentText(event: Event): string {
	const data = event.data as { to?: string };
	return event.kind === "handover"
		? `handover on ${event.task} from ${event.actor} to ${data.to}`
		: `note on ${event.task}`;
}

/** "BRD: milestone 2 of 5 (v1), 3 tasks left; 2 ready, 1 active, …". */
export function statusText(value: BoardStatus): string {
	const where =
		value.current === null
			? "no current milestone"
			: `milestone ${value.current.position} of ${value.current.of} (${value.current.name}), ${plural(value.current.left, "task")} left`;
	const c = value.counts;
	const q = value.questions;
	return `${value.project.key}: ${where}; ${c.ready} ready, ${c.active} active, ${c.blocked} blocked; ${plural(value.claims.length, "claim")}; ${plural(q.open, "open question")}, ${q.to_validate} to validate`;
}

export function milestoneAddedText(value: {
	project: string;
	milestone: { name: string; position: number };
	chain: string[];
}): string {
	return `${value.project}: milestone ${value.milestone.name} added at ${value.milestone.position} of ${value.chain.length}`;
}

export function milestoneUpdatedText(
	value: {
		project: string;
		milestone: { name: string; position: number };
		chain: string[];
		changed: readonly string[];
	},
	input: {
		milestone: string;
		before?: string | undefined;
		after?: string | undefined;
	},
): string {
	const name = value.milestone.name;
	if (value.changed.length === 0) {
		return `${value.project}: milestone ${name}: nothing to change`;
	}
	const parts = [
		value.changed.includes("name")
			? `milestone ${input.milestone} → ${name}`
			: `milestone ${name}`,
	];
	if (value.changed.includes("delivers")) parts.push("delivers changed");
	if (value.changed.includes("position")) {
		parts.push(
			input.before !== undefined
				? `moved before ${input.before}`
				: `moved after ${input.after}`,
		);
	}
	return `${value.project}: ${parts.join(", ")}`;
}

export function milestoneDeletedText(value: {
	project: string;
	deleted: string;
	chain: string[];
}): string {
	return `${value.project}: milestone ${value.deleted} deleted; ${value.chain.length} left`;
}

export function askedText(question: Question): string {
	return `${question.id} asked on ${question.key}; ${question.key} is blocked until it is answered`;
}

/** "Q7 answered by main as delegate: up to 8 at once; BRD-14 unblocked; …". */
export function answeredText(
	question: Question,
	task: TaskSummary,
	overrode: boolean,
): string {
	const answer = question.answer;
	if (answer === null) return `${question.id} answered`;
	if (overrode)
		return `${question.id}: the owner's answer replaces the delegate's`;
	const chosen =
		answer.choice === null ? null : question.options[answer.choice - 1]?.label;
	const said = [chosen, answer.text].filter((part) => part != null).join(" — ");
	const blocked =
		task.status === "blocked"
			? `${task.key} still blocked`
			: `${task.key} unblocked`;
	const waits =
		answer.as === "delegate" ? "; waits for the owner to validate" : "";
	return `${question.id} answered by ${answer.by} as ${answer.as}: ${said}; ${blocked}${waits}`;
}

const STATE_WORDS = {
	open: "open questions",
	to_validate: "questions to validate",
	answered: "answered questions",
	withdrawn: "withdrawn questions",
	all: "questions",
} as const;

/** "2 questions to validate in BRD" / "… in every project". */
export function questionsText(
	value: { project: string; questions: readonly Question[] },
	state: keyof typeof STATE_WORDS | undefined,
): string {
	const n = value.questions.length;
	const words = STATE_WORDS[state ?? "open"];
	const phrase = n === 1 ? words.replace("questions", "question") : words;
	const scope = value.project === "*" ? "every project" : value.project;
	return `${n} ${phrase} in ${scope}`;
}
