import { stamp } from "../clock.ts";
import { type BoardError, refuse } from "../errors.ts";
import type { Question, TaskSummary } from "../schemas.ts";
import type { Prisma } from "../store/generated/client.ts";
import type { Tx } from "../store/store.ts";
import { appendEvent } from "./events.ts";
import { type ProjectRow, projectByKey } from "./projects.ts";
import { summaryInclude, taskKey, toQuestion, toSummary } from "./shapes.ts";
import { checkActor, invalid, parseKey, taskByNumber } from "./tasks.ts";

/** `Q7` (any case) as its number; null past any id there can be. */
function questionNumber(id: string): number | null {
	const n = Number(id.slice(1));
	return Number.isSafeInteger(n) ? n : null;
}

function notFound(id: string): BoardError {
	return {
		code: "not_found",
		message: `No question ${id.toUpperCase()}.`,
		next: "Check the id; `board questions` finds questions.",
		details: { what: "question", id: id.toUpperCase() },
	};
}

const questionInclude = {
	task: { select: { number: true, project: { select: { key: true } } } },
} as const satisfies Prisma.questionInclude;

type QuestionRow = Prisma.questionGetPayload<{
	include: typeof questionInclude;
}>;

function shape(row: QuestionRow): Question {
	return toQuestion(row, taskKey(row.task.project.key, row.task.number));
}

/** The project a question id names: its task's. */
export async function projectOfQuestion(
	tx: Tx,
	id: string,
): Promise<ProjectRow> {
	const n = questionNumber(id);
	const row =
		n === null
			? null
			: await tx.question.findUnique({
					where: { id: n },
					select: { task: { select: { project: true } } },
				});
	if (row === null) refuse(notFound(id));
	return row.task.project;
}

async function questionById(tx: Tx, id: string): Promise<QuestionRow> {
	const n = questionNumber(id);
	const row =
		n === null
			? null
			: await tx.question.findUnique({
					where: { id: n },
					include: questionInclude,
				});
	if (row === null) refuse(notFound(id));
	return row;
}

async function summaryOf(
	tx: Tx,
	taskId: number,
	now: Date,
): Promise<TaskSummary> {
	return toSummary(
		await tx.task.findUniqueOrThrow({
			where: { id: taskId },
			include: summaryInclude,
		}),
		now,
	);
}

export interface AskInput {
	actor: string;
	key: string;
	text: string;
	options: readonly { label: string; detail?: string | undefined }[];
	recommended: number;
}

/**
 * Asks the owner a question on a task: 2–6 options and a recommendation,
 * both required, because a question always comes with one. The task is
 * blocked until its last open question is answered or withdrawn.
 */
export async function askQuestion(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: AskInput,
): Promise<{ question: Question; task: TaskSummary; events: number[] }> {
	checkActor(input.actor);
	if (input.options.length < 2 || input.options.length > 6) {
		refuse(
			invalid(
				"options",
				"A question has 2 to 6 options.",
				"Give 2 to 6 options.",
			),
		);
	}
	if (
		!Number.isInteger(input.recommended) ||
		input.recommended < 1 ||
		input.recommended > input.options.length
	) {
		refuse(
			invalid(
				"recommended",
				`--recommended is ${input.recommended}, but there are ${input.options.length} options.`,
				"--recommended is the number of one of the options given.",
			),
		);
	}
	const task = await taskByNumber(tx, project, input.key, {});
	if (task.status === "done" || task.status === "cancelled") {
		refuse({
			code: "invalid_transition",
			message: `${taskKey(project.key, task.number)} is ${task.status}; questions are asked on open tasks.`,
			next: "Reopen it with `board edit KEY --status ready` first, if the question still matters.",
			details: { from: task.status, reason: "closed" },
		});
	}
	const options = input.options.map((o) => ({
		label: o.label,
		detail: o.detail ?? null,
	}));
	const row = await tx.question.create({
		data: {
			task_id: task.id,
			text: input.text,
			options: JSON.stringify(options),
			recommended: input.recommended,
			asked_by: input.actor,
			asked_at: stamp(now),
		},
		include: questionInclude,
	});
	const event = await appendEvent(tx, now, {
		actor: input.actor,
		kind: "question_asked",
		projectId: project.id,
		taskId: task.id,
		data: {
			question: `Q${row.id}`,
			text: input.text,
			options,
			recommended: input.recommended,
		},
	});
	return {
		question: shape(row),
		task: await summaryOf(tx, task.id, now),
		events: [event],
	};
}

export interface AnswerInput {
	actor: string;
	question: string;
	choice?: number | undefined;
	text?: string | undefined;
	as: "owner" | "delegate";
}

/**
 * Answers a question, recording whose answer it is. The owner's answer over
 * a delegate's unvalidated one replaces it, and the event keeps the
 * replaced answer; any other answered question is `already_answered`.
 */
export async function answerQuestion(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: AnswerInput,
): Promise<{
	question: Question;
	task: TaskSummary;
	events: number[];
	/** Whether the owner replaced a delegate's answer; not in the shape. */
	overrode: boolean;
}> {
	checkActor(input.actor);
	const row = await questionById(tx, input.question);
	const id = `Q${row.id}`;
	if (input.choice === undefined && input.text === undefined) {
		refuse(
			invalid(
				"N",
				"An answer has a choice, a text, or both.",
				"Give the option's number N, --text, or both.",
			),
		);
	}
	const count = (JSON.parse(row.options) as unknown[]).length;
	if (
		input.choice !== undefined &&
		(input.choice < 1 || input.choice > count)
	) {
		refuse(
			invalid(
				"N",
				`${id} has ${count} options; ${input.choice} is not one of them.`,
				`Choose N from 1 to ${count}, or answer with --text.`,
			),
		);
	}
	if (row.status === "withdrawn") {
		refuse({
			code: "invalid_transition",
			message: `${id} was withdrawn when its task was cancelled; it takes no answer.`,
			next: "Ask again on an open task if it still matters.",
			details: { from: "withdrawn", to: "answered", reason: "withdrawn" },
		});
	}
	let overrides: Question["answer"] = null;
	if (row.status === "answered") {
		const replaceable =
			input.as === "owner" &&
			row.answered_as === "delegate" &&
			row.validated_at === null;
		if (!replaceable) {
			refuse({
				code: "already_answered",
				message: `${id} is answered already, by ${row.answered_by} as ${row.answered_as}.`,
				next: "`board questions` shows the answer; the owner may override a delegate's unvalidated answer.",
				details: { question: shape(row) },
			});
		}
		overrides = shape(row).answer;
	}
	const updated = await tx.question.update({
		where: { id: row.id },
		data: {
			status: "answered",
			choice: input.choice ?? null,
			answer: input.text ?? null,
			answered_by: input.actor,
			answered_at: stamp(now),
			answered_as: input.as,
		},
		include: questionInclude,
	});
	const event = await appendEvent(tx, now, {
		actor: input.actor,
		kind: "question_answered",
		projectId: project.id,
		taskId: row.task_id,
		data: {
			question: id,
			choice: input.choice ?? null,
			text: input.text ?? null,
			as: input.as,
			overrides,
		},
	});
	return {
		question: shape(updated),
		task: await summaryOf(tx, row.task_id, now),
		events: [event],
		overrode: overrides !== null,
	};
}

/** Marks a delegate's answer checked: the owner's approval, recorded. */
export async function validateQuestion(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: { actor: string; question: string },
): Promise<{ question: Question; events: number[] }> {
	checkActor(input.actor);
	const row = await questionById(tx, input.question);
	const id = `Q${row.id}`;
	const why =
		row.status !== "answered"
			? `${id} is ${row.status}, not answered`
			: row.answered_as !== "delegate"
				? `${id} was answered by the owner, so there is nothing to validate`
				: row.validated_at !== null
					? `${id} was validated already, by ${row.validated_by}`
					: null;
	if (why !== null) {
		refuse({
			code: "invalid_transition",
			message: `${why}.`,
			next: "Only a delegate's answer not yet validated is validated; `board questions --state to_validate` lists them.",
			details: {
				from: row.status,
				to: "validated",
				reason:
					row.status !== "answered"
						? row.status
						: row.answered_as !== "delegate"
							? "owner"
							: "validated",
			},
		});
	}
	const updated = await tx.question.update({
		where: { id: row.id },
		data: { validated_by: input.actor, validated_at: stamp(now) },
		include: questionInclude,
	});
	const event = await appendEvent(tx, now, {
		actor: input.actor,
		kind: "question_validated",
		projectId: project.id,
		taskId: row.task_id,
		data: { question: id },
	});
	return { question: shape(updated), events: [event] };
}

export type QuestionState =
	| "open"
	| "to_validate"
	| "answered"
	| "withdrawn"
	| "all";

const STATES: Record<QuestionState, Prisma.questionWhereInput> = {
	open: { status: "open" },
	to_validate: {
		status: "answered",
		answered_as: "delegate",
		validated_at: null,
	},
	answered: { status: "answered" },
	withdrawn: { status: "withdrawn" },
	all: {},
};

/** `board questions` over one project, or every project when it is null. */
export async function listQuestions(
	tx: Tx,
	project: ProjectRow | null,
	input: { state?: QuestionState | undefined; key?: string | undefined },
): Promise<{ project: string; questions: Question[] }> {
	const where: Prisma.questionWhereInput[] = [STATES[input.state ?? "open"]];
	if (project !== null) where.push({ task: { project_id: project.id } });
	if (input.key !== undefined) {
		const owner =
			project ?? (await projectByKey(tx, parseKey(input.key).project));
		if (parseKey(input.key).project !== owner.key) {
			refuse(
				invalid(
					"task",
					`${parseKey(input.key).key} is a task of ${parseKey(input.key).project}, not of ${owner.key}.`,
					"Leave out -p, or pass --task with a task of that project.",
				),
			);
		}
		const task = await taskByNumber(tx, owner, input.key, {});
		where.push({ task_id: task.id });
	}
	const rows = await tx.question.findMany({
		where: { AND: where },
		include: questionInclude,
		orderBy: { id: "asc" },
	});
	return { project: project?.key ?? "*", questions: rows.map(shape) };
}
