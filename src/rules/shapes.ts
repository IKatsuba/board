import type {
	Claim,
	Event,
	Kind,
	Priority,
	Question,
	Task,
	TaskRef,
	TaskSummary,
} from "../schemas.ts";
import type { Prisma } from "../store/generated/client.ts";
import type { Tx } from "../store/store.ts";
import {
	effectiveStatus,
	isLive,
	isReady,
	type TaskState,
} from "./readiness.ts";

/** Stored 0–3, shown as words. */
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export function priorityWord(stored: number): Priority {
	return PRIORITIES[stored] ?? "normal";
}

/** What effective status needs of a task, read with it. */
const stateInclude = {
	project: { select: { key: true } },
	claim: true,
	question: { where: { status: "open" }, select: { id: true } },
	waits_on: { select: { on: { select: { status: true } } } },
} as const satisfies Prisma.taskInclude;

/** What a TaskSummary needs. */
export const summaryInclude = {
	...stateInclude,
	milestone: { select: { name: true } },
	parent: { select: { number: true } },
	event: { orderBy: { id: "desc" }, take: 1, select: { at: true } },
} as const satisfies Prisma.taskInclude;

/** What a whole Task needs. */
export const taskInclude = {
	...summaryInclude,
	waits_on: {
		select: { on: { include: stateInclude } },
		orderBy: { on_id: "asc" },
	},
	waited_by: {
		select: { task: { include: stateInclude } },
		orderBy: { task_id: "asc" },
	},
	children: { include: stateInclude, orderBy: { number: "asc" } },
	question: { orderBy: { id: "asc" } },
} as const satisfies Prisma.taskInclude;

type StateRow = Prisma.taskGetPayload<{ include: typeof stateInclude }>;
type SummaryRow = Prisma.taskGetPayload<{ include: typeof summaryInclude }>;
type TaskRow = Prisma.taskGetPayload<{ include: typeof taskInclude }>;
type QuestionRow = TaskRow["question"][number];
type ClaimRow = NonNullable<StateRow["claim"]>;

export function taskKey(projectKey: string, number: number): string {
	return `${projectKey}-${number}`;
}

function state(row: StateRow): TaskState {
	return {
		status: row.status,
		claim: row.claim,
		openQuestions: row.question.length,
		waits: row.waits_on.map((w) => w.on.status),
	};
}

export function toRef(row: StateRow, now: Date): TaskRef {
	return {
		key: taskKey(row.project.key, row.number),
		title: row.title,
		status: effectiveStatus(state(row), now),
	};
}

export function toSummary(row: SummaryRow, now: Date): TaskSummary {
	return summarize(row, state(row), now);
}

function summarize(
	row: Omit<SummaryRow, "question" | "waits_on">,
	st: TaskState,
	now: Date,
): TaskSummary {
	const live = isLive(row.claim, now) ? row.claim : null;
	return {
		key: taskKey(row.project.key, row.number),
		title: row.title,
		status: effectiveStatus(st, now),
		priority: priorityWord(row.priority),
		milestone: row.milestone?.name ?? null,
		parent:
			row.parent === null ? null : taskKey(row.project.key, row.parent.number),
		holder: live?.holder ?? null,
		ready: isReady(st, now),
		created_at: row.created_at,
		updated_at: row.event[0]?.at ?? row.created_at,
	};
}

export function toTask(row: TaskRow, now: Date): Task {
	const summary = summarize(
		row,
		{
			status: row.status,
			claim: row.claim,
			openQuestions: row.question.filter((q) => q.status === "open").length,
			waits: row.waits_on.map((w) => w.on.status),
		},
		now,
	);
	const key = summary.key;
	return {
		...summary,
		body: row.body,
		created_by: row.created_by,
		waits: row.waits_on.map((w) => toRef(w.on, now)),
		waited_by: row.waited_by.map((w) => toRef(w.task, now)),
		children: row.children.map((c) => toRef(c, now)),
		claim:
			row.claim !== null && isLive(row.claim, now)
				? toClaim(row.claim, key, row.title, now)
				: null,
		questions: row.question.map((q) => toQuestion(q, key)),
	};
}

/** A live claim; `minutes_left` rounds up, so it shows 0 only under a minute. */
export function toClaim(
	claim: ClaimRow,
	key: string,
	title: string,
	now: Date,
): Claim {
	const left = Math.ceil((Date.parse(claim.until) - now.getTime()) / 60_000);
	return {
		key,
		title,
		holder: claim.holder,
		since: claim.since,
		until: claim.until,
		minutes_left: Math.min(1440, Math.max(0, left)),
		directory: claim.directory,
		branch: claim.branch,
	};
}

export function toQuestion(row: QuestionRow, key: string): Question {
	const options = JSON.parse(row.options) as {
		label: string;
		detail?: string;
	}[];
	return {
		id: `Q${row.id}`,
		key,
		text: row.text,
		options: options.map((o) => ({ label: o.label, detail: o.detail ?? null })),
		recommended: row.recommended,
		asked_by: row.asked_by,
		asked_at: row.asked_at,
		status: row.status as Question["status"],
		answer:
			row.answered_at === null
				? null
				: {
						choice: row.choice,
						text: row.answer,
						by: row.answered_by as string,
						as: row.answered_as as "owner" | "delegate",
						at: row.answered_at,
					},
		validated:
			row.validated_at === null
				? null
				: { by: row.validated_by as string, at: row.validated_at },
	};
}

/** Events in the public shape, their references as public identifiers. */
export async function toEvents(
	tx: Tx,
	rows: readonly {
		id: number;
		at: string;
		actor: string;
		kind: string;
		project_id: number | null;
		task_id: number | null;
		milestone_id: number | null;
		data: string;
	}[],
): Promise<Event[]> {
	const ids = (pick: (row: (typeof rows)[number]) => number | null) => [
		...new Set(rows.map(pick).filter((id): id is number => id !== null)),
	];
	const projects = await tx.project.findMany({
		where: { id: { in: ids((r) => r.project_id) } },
		select: { id: true, key: true },
	});
	const tasks = await tx.task.findMany({
		where: { id: { in: ids((r) => r.task_id) } },
		select: { id: true, number: true, project: { select: { key: true } } },
	});
	// Event.milestone_id has no foreign key: a deleted milestone's events
	// outlive it, and their milestone reads as null.
	const milestones = await tx.milestone.findMany({
		where: { id: { in: ids((r) => r.milestone_id) } },
		select: { id: true, name: true },
	});
	return rows.map((row) => {
		const task = tasks.find((t) => t.id === row.task_id);
		return {
			id: row.id,
			at: row.at,
			actor: row.actor,
			kind: row.kind as Kind,
			project: projects.find((p) => p.id === row.project_id)?.key ?? null,
			task: task === undefined ? null : taskKey(task.project.key, task.number),
			milestone:
				milestones.find((m) => m.id === row.milestone_id)?.name ?? null,
			data: JSON.parse(row.data) as Record<string, unknown>,
		};
	});
}
