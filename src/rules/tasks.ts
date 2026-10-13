import { stamp } from "../clock.ts";
import { type BoardError, refuse } from "../errors.ts";
import type { Event, Priority, Status, Task, TaskSummary } from "../schemas.ts";
import type { Prisma } from "../store/generated/client.ts";
import {
	nextNumber,
	taskListCount,
	taskListPage,
} from "../store/generated/sql.ts";
import type { Tx } from "../store/store.ts";
import { appendEvent } from "./events.ts";
import { chain } from "./milestones.ts";
import { type ProjectRow, projectByKey } from "./projects.ts";
import {
	PRIORITIES,
	summaryInclude,
	taskInclude,
	taskKey,
	toEvents,
	toSummary,
	toTask,
} from "./shapes.ts";

/**
 * A task key split into its project's key and its number, upper-cased.
 * `number` is null when the digits are past any task number there can be,
 * so such a key is simply not found.
 */
export function parseKey(key: string): {
	project: string;
	number: number | null;
	key: string;
} {
	const at = key.lastIndexOf("-");
	const digits = key.slice(at + 1);
	const number = Number(digits);
	return {
		project: key.slice(0, at).toUpperCase(),
		number: Number.isSafeInteger(number) ? number : null,
		key: key.toUpperCase(),
	};
}

/** A task of `project` by its number, or not_found naming `key`. */
export async function taskByNumber<I extends Prisma.taskInclude>(
	tx: Tx,
	project: ProjectRow,
	key: string,
	include: I,
): Promise<Prisma.taskGetPayload<{ include: I }>> {
	const { number } = parseKey(key);
	const row =
		number === null
			? null
			: await tx.task.findUnique({
					where: { project_id_number: { project_id: project.id, number } },
					include,
				});
	if (row === null) refuse(notFound("task", parseKey(key).key));
	return row as Prisma.taskGetPayload<{ include: I }>;
}

function notFound(what: "task" | "milestone", id: string): BoardError {
	return {
		code: "not_found",
		message: `No ${what} ${id}.`,
		next:
			what === "task"
				? "Check the key; `board ls --contains` finds tasks."
				: "Check the name; `board milestone ls` lists the milestones.",
		details: { what, id },
	};
}

export function invalid(
	field: string,
	message: string,
	next: string,
): BoardError {
	return { code: "invalid_argument", message, next, details: { field } };
}

/**
 * The task with `key` in `project`; a key of another project in a relation
 * is `invalid_argument` naming the field, so a relation never crosses
 * projects. The foreign keys are the backstop.
 */
export async function relatedTask(
	tx: Tx,
	project: ProjectRow,
	key: string,
	field: string,
): Promise<{ id: number; number: number; milestone_id: number | null }> {
	const { project: prefix } = parseKey(key);
	if (prefix !== project.key) {
		refuse(
			invalid(
				field,
				`${key.toUpperCase()} is a task of ${prefix}, not of ${project.key}: tasks relate only within a project.`,
				`Use a task of ${project.key} in \`--${field}\`.`,
			),
		);
	}
	return taskByNumber(tx, project, key, {});
}

/** `none`, in any case, is the word for no milestone. */
function isNone(name: string): boolean {
	return name.toLowerCase() === "none";
}

export async function milestoneByName(
	tx: Tx,
	project: ProjectRow,
	name: string,
) {
	const row = await tx.milestone.findUnique({
		where: { project_id_name: { project_id: project.id, name } },
	});
	if (row === null) refuse(notFound("milestone", name));
	return row;
}

/** The actor `board` is board's own, for what it does itself. */
export function checkActor(actor: string): void {
	if (actor === "board") {
		refuse(
			invalid(
				"actor",
				"The actor `board` is reserved for what board does itself.",
				"Pass --actor with your own name.",
			),
		);
	}
}

export interface TaskAddInput {
	actor: string;
	title: string;
	body?: string | undefined;
	priority?: Priority | undefined;
	parent?: string | undefined;
	milestone?: string | undefined;
	waits?: readonly string[] | undefined;
	status?: "backlog" | "ready" | undefined;
}

/**
 * Adds a task. With a parent and no milestone, it takes the parent's
 * milestone, so a finding stays in the milestone it was found in; a done
 * milestone that takes a task reopens.
 */
export async function addTask(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: TaskAddInput,
): Promise<{ task: Task; events: number[] }> {
	checkActor(input.actor);
	if (input.title.trim() === "") {
		refuse(
			invalid(
				"title",
				"A task's title cannot be only whitespace.",
				"Give the task a title.",
			),
		);
	}
	const parent =
		input.parent === undefined
			? null
			: await relatedTask(tx, project, input.parent, "parent");
	const waits = [];
	// Keys are accepted in any case, so A-1 and a-1 are one wait.
	for (const key of new Set((input.waits ?? []).map((k) => k.toUpperCase()))) {
		waits.push(await relatedTask(tx, project, key, "waits"));
	}
	let milestone: { id: number; name: string } | null = null;
	if (input.milestone === undefined) {
		if (parent?.milestone_id != null) {
			milestone = await tx.milestone.findUniqueOrThrow({
				where: { id: parent.milestone_id },
			});
		}
	} else if (!isNone(input.milestone)) {
		milestone = await milestoneByName(tx, project, input.milestone);
	}
	const links = milestone === null ? [] : await chain(tx, project.id);
	const wasDone =
		links.find((link) => link.id === milestone?.id)?.status === "done";

	const [next] = await tx.$queryRawTyped(nextNumber(project.id));
	const number = Number(next?.next ?? 1);
	const status = input.status ?? "ready";
	const priority = PRIORITIES.indexOf(input.priority ?? "normal");
	const row = await tx.task.create({
		data: {
			project_id: project.id,
			number,
			title: input.title,
			body: input.body ?? "",
			status,
			priority,
			parent_id: parent?.id ?? null,
			milestone_id: milestone?.id ?? null,
			created_at: stamp(now),
			created_by: input.actor,
		},
	});
	for (const wait of waits) {
		await tx.waits.create({
			data: { project_id: project.id, task_id: row.id, on_id: wait.id },
		});
	}
	const key = taskKey(project.key, number);
	const events = [
		await appendEvent(tx, now, {
			actor: input.actor,
			kind: "task_added",
			projectId: project.id,
			taskId: row.id,
			data: {
				title: input.title,
				body: row.body,
				status,
				priority: PRIORITIES[priority],
				parent: parent === null ? null : taskKey(project.key, parent.number),
				milestone: milestone?.name ?? null,
				waits: waits.map((w) => taskKey(project.key, w.number)),
			},
		}),
	];
	if (milestone !== null && wasDone) {
		events.push(
			await appendEvent(tx, now, {
				actor: input.actor,
				kind: "milestone_reopened",
				projectId: project.id,
				milestoneId: milestone.id,
				data: { name: milestone.name, by: key },
			}),
		);
	}
	return { task: await readTask(tx, row.id, now), events };
}

async function readTask(tx: Tx, id: number, now: Date): Promise<Task> {
	const row = await tx.task.findUniqueOrThrow({
		where: { id },
		include: taskInclude,
	});
	return toTask(row, now);
}

/** The open statuses `board ls` shows when no status is asked for. */
const DEFAULT_STATUSES: readonly Status[] = [
	"backlog",
	"ready",
	"active",
	"blocked",
];

export interface TaskListInput {
	status?: readonly Status[] | undefined;
	parent?: string | undefined;
	milestone?: string | undefined;
	ready?: boolean | undefined;
	contains?: string | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
}

export interface TaskListOutput {
	project: string;
	tasks: TaskSummary[];
	total: number;
	next_offset: number | null;
}

/**
 * `contains` as a LIKE pattern: `\` is escaped first, then `%` and `_`, so
 * no character of the text is a wildcard. Escaping `\` last would double the
 * escapes just added.
 */
export function likePattern(text: string): string {
	return `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

/** `board ls` over one project, or every project when `project` is null. */
export async function listTasks(
	tx: Tx,
	now: Date,
	project: ProjectRow | null,
	input: TaskListInput,
): Promise<TaskListOutput> {
	let parentId: number | null = null;
	if (input.parent !== undefined) {
		// Under "*", the parent's own project holds its children.
		const owner =
			project ?? (await projectByKey(tx, parseKey(input.parent).project));
		parentId = (await relatedTask(tx, owner, input.parent, "parent")).id;
	}
	let milestoneId: number | null = null;
	const none = input.milestone !== undefined && isNone(input.milestone);
	if (input.milestone !== undefined && !none) {
		if (project === null) {
			refuse(
				invalid(
					"milestone",
					'A milestone is one project\'s, so with --all, --milestone may only be "none".',
					"Pass -p KEY with the milestone's project instead of --all.",
				),
			);
		}
		milestoneId = (await milestoneByName(tx, project, input.milestone)).id;
	}
	const filter = [
		stamp(now),
		project?.id ?? null,
		parentId,
		milestoneId,
		none ? 1 : 0,
		input.contains === undefined ? null : likePattern(input.contains),
		JSON.stringify(input.status ?? DEFAULT_STATUSES),
		input.ready === undefined ? null : input.ready ? 1 : 0,
	] as const;
	const limit = input.limit ?? 50;
	const offset = input.offset ?? 0;
	const [count] = await tx.$queryRawTyped(taskListCount(...filter));
	const total = Number(count?.total ?? 0);
	// An offset past every match has an empty page, and need not reach SQLite,
	// which cannot take an offset past 64 bits.
	const page =
		offset >= total
			? []
			: await tx.$queryRawTyped(taskListPage(...filter, limit, offset));
	const rows = await tx.task.findMany({
		where: { id: { in: page.map((r) => r.id) } },
		include: summaryInclude,
		orderBy: { id: "desc" },
	});
	return {
		project: project?.key ?? "*",
		tasks: rows.map((row) => toSummary(row, now)),
		total,
		next_offset: offset + rows.length < total ? offset + rows.length : null,
	};
}

/** How many events `board show` returns at most. */
export const EVENT_PAGE = 200;

export interface TaskReadOutput {
	task: Task;
	events: Event[];
	cursor: number;
	more: boolean;
}

/** One task whole, and its events after `since`, oldest first. */
export async function readTaskByKey(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	key: string,
	since: number,
): Promise<TaskReadOutput> {
	const row = await taskByNumber(tx, project, key, taskInclude);
	// No event id is past the safe integers, so nothing is after such a since.
	const page = !Number.isSafeInteger(since)
		? []
		: await tx.event.findMany({
				where: { task_id: row.id, id: { gt: since } },
				orderBy: { id: "asc" },
				take: EVENT_PAGE + 1,
			});
	const events = await toEvents(tx, page.slice(0, EVENT_PAGE));
	return {
		task: toTask(row, now),
		events,
		cursor: events.at(-1)?.id ?? since,
		more: page.length > EVENT_PAGE,
	};
}
