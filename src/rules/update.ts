import { type BoardError, refuse } from "../errors.ts";
import type { Priority, Task } from "../schemas.ts";
import { parentLoop, waitLoop } from "../store/generated/sql.ts";
import type { Tx } from "../store/store.ts";
import { appendEvent, type NewEvent } from "./events.ts";
import { chain } from "./milestones.ts";
import type { ProjectRow } from "./projects.ts";
import { isLive } from "./readiness.ts";
import {
	PRIORITIES,
	priorityWord,
	taskInclude,
	taskKey,
	toTask,
} from "./shapes.ts";
import {
	checkActor,
	invalid,
	milestoneByName,
	parseKey,
	relatedTask,
	taskByNumber,
} from "./tasks.ts";

export type UpdateField =
	| "title"
	| "body"
	| "priority"
	| "status"
	| "parent"
	| "milestone"
	| "waits";

export interface TaskUpdateInput {
	actor: string;
	key: string;
	title?: string | undefined;
	body?: string | undefined;
	priority?: Priority | undefined;
	status?: "backlog" | "ready" | "done" | "cancelled" | undefined;
	parent?: string | null | undefined;
	milestone?: string | undefined;
	waits_add?: readonly string[] | undefined;
	waits_remove?: readonly string[] | undefined;
}

/** Where each stored status may go by `board edit`; the rest is refused. */
const TRANSITIONS: Record<string, readonly string[]> = {
	backlog: ["ready", "done", "cancelled"],
	ready: ["backlog", "done", "cancelled"],
	active: ["ready", "backlog", "done", "cancelled"],
	done: ["backlog", "ready"],
	cancelled: ["backlog", "ready"],
};

/**
 * `board edit`: every field at once, validated before any change, applied
 * and logged in the catalog's order. An update that changes nothing writes
 * nothing of its own.
 */
export async function updateTask(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: TaskUpdateInput,
): Promise<{
	task: Task;
	changed: UpdateField[];
	events: number[];
	/** The task as it stood, for the answer's text line; not in the shape. */
	before: Task;
}> {
	checkActor(input.actor);
	const row = await taskByNumber(tx, project, input.key, taskInclude);
	const key = taskKey(project.key, row.number);
	const changed: UpdateField[] = [];
	const edited: Record<string, { from: unknown; to: unknown }> = {};
	const data: {
		title?: string;
		body?: string;
		priority?: number;
		parent_id?: number | null;
		milestone_id?: number | null;
		status?: string;
	} = {};

	if (input.title !== undefined && input.title !== row.title) {
		if (input.title.trim() === "") {
			refuse(
				invalid(
					"title",
					"A task's title cannot be only whitespace.",
					"Give the task a title.",
				),
			);
		}
		edited.title = { from: row.title, to: input.title };
		data.title = input.title;
		changed.push("title");
	}
	if (input.body !== undefined && input.body !== row.body) {
		edited.body = { from: row.body, to: input.body };
		data.body = input.body;
		changed.push("body");
	}
	if (input.priority !== undefined) {
		const priority = PRIORITIES.indexOf(input.priority);
		if (priority !== row.priority) {
			edited.priority = {
				from: priorityWord(row.priority),
				to: input.priority,
			};
			data.priority = priority;
			changed.push("priority");
		}
	}

	let newParent: { id: number; number: number } | null | undefined;
	if (input.parent !== undefined) {
		newParent =
			input.parent === null
				? null
				: await relatedTask(tx, project, input.parent, "parent");
		if (newParent?.id === row.id) {
			refuse({
				code: "cycle",
				message: `${key} cannot be its own parent.`,
				next: "Pass --parent with another task, or --no-parent for none.",
				details: { path: [key, key] },
			});
		}
		if ((newParent?.id ?? null) !== row.parent_id) {
			edited.parent = {
				from:
					row.parent === null ? null : taskKey(project.key, row.parent.number),
				to: newParent === null ? null : taskKey(project.key, newParent.number),
			};
			data.parent_id = newParent?.id ?? null;
			changed.push("parent");
		}
	}

	let moved: { from: string | null; to: string | null } | null = null;
	if (input.milestone !== undefined) {
		const target =
			input.milestone.toLowerCase() === "none"
				? null
				: await milestoneByName(tx, project, input.milestone);
		if ((target?.id ?? null) !== row.milestone_id) {
			moved = { from: row.milestone?.name ?? null, to: target?.name ?? null };
			data.milestone_id = target?.id ?? null;
			changed.push("milestone");
		}
	}

	const adds = keysOf(input.waits_add);
	const removes = keysOf(input.waits_remove);
	for (const k of adds) {
		if (removes.includes(k)) {
			refuse(
				invalid(
					"waits-add",
					`${k} is in both --waits-add and --waits-remove.`,
					"Name each key in one of the two lists.",
				),
			);
		}
	}
	for (const [field, keys] of [
		["waits-add", adds],
		["waits-remove", removes],
	] as const) {
		if (keys.includes(key)) {
			refuse(
				invalid(
					field,
					`${key} cannot wait for itself.`,
					`Name other tasks in --${field}.`,
				),
			);
		}
	}
	const current = new Set(row.waits_on.map((w) => w.on.number));
	const added = [];
	for (const k of adds) {
		const on = await relatedTask(tx, project, k, "waits-add");
		if (!current.has(on.number)) added.push(on);
	}
	const removed = [];
	for (const k of removes) {
		const on = await relatedTask(tx, project, k, "waits-remove");
		if (current.has(on.number)) removed.push(on);
	}
	if (added.length > 0 || removed.length > 0) changed.push("waits");

	let toStatus: string | null = null;
	const openQuestions = row.question.filter((q) => q.status === "open");
	if (input.status !== undefined && input.status !== row.status) {
		const allowed = TRANSITIONS[row.status] ?? [];
		if (!allowed.includes(input.status)) {
			refuse(transition(key, row.status, input.status, allowed));
		}
		if (input.status === "done" && openQuestions.length > 0) {
			refuse({
				code: "invalid_transition",
				message: `${key} has an open question; closing it would hide a question the owner has not seen.`,
				next: "Have the question answered first, or cancel the task, which withdraws it.",
				details: {
					from: row.status,
					to: input.status,
					allowed: allowed.filter((s) => s !== "done"),
					reason: "question",
				},
			});
		}
		toStatus = input.status;
		data.status = input.status;
		changed.push("status");
	}

	if (changed.length === 0) {
		const same = toTask(row, now);
		return { task: same, changed, events: [], before: same };
	}

	// What the milestones were before, to log the flips this write causes.
	const touched = new Set(
		[row.milestone_id, data.milestone_id].filter(
			(id): id is number => id !== undefined && id !== null,
		),
	);
	const before = await doneMilestones(tx, project.id, touched);

	// Loops are found before anything is written. A walk from the new parent
	// or the new wait stops on reaching this task, so it never uses this
	// task's own edges, the only ones this update changes: the stored graph
	// answers for the updated one.
	if (newParent != null && data.parent_id !== undefined) {
		const [loop] = await tx.$queryRawTyped(parentLoop(newParent.id, row.id));
		if (loop?.path != null) {
			refuse(await cycle(tx, project, row.id, loop.path, "parent"));
		}
	}
	for (const on of added) {
		const path = waitPath(
			await tx.$queryRawTyped(waitLoop(on.id)),
			on.id,
			row.id,
		);
		if (path !== null) {
			refuse(await cycle(tx, project, row.id, path, "waits_add"));
		}
	}

	await tx.task.update({ where: { id: row.id }, data });
	for (const on of removed) {
		await tx.waits.delete({
			where: { task_id_on_id: { task_id: row.id, on_id: on.id } },
		});
	}
	for (const on of added) {
		await tx.waits.create({
			data: { project_id: project.id, task_id: row.id, on_id: on.id },
		});
	}

	const events: NewEvent[] = [];
	const about = { actor: input.actor, projectId: project.id, taskId: row.id };
	if (Object.keys(edited).length > 0) {
		events.push({ ...about, kind: "task_edited", data: edited });
	}
	if (moved !== null)
		events.push({ ...about, kind: "task_moved", data: moved });
	if (added.length > 0 || removed.length > 0) {
		events.push({
			...about,
			kind: "waits_changed",
			data: {
				added: added.map((t) => taskKey(project.key, t.number)),
				removed: removed.map((t) => taskKey(project.key, t.number)),
			},
		});
	}
	if (toStatus !== null) {
		events.push({
			...about,
			kind: "task_status",
			data: { from: row.status, to: toStatus },
		});
		// Sending back or closing drops the claim, whoever holds it.
		if (row.claim !== null && isLive(row.claim, now)) {
			await tx.claim.delete({ where: { task_id: row.id } });
			events.push({
				...about,
				kind: "claim_released",
				data: {
					holder: row.claim.holder,
					reason:
						toStatus === "done" || toStatus === "cancelled"
							? "closed"
							: "sent_back",
					note: null,
				},
			});
		}
		if (toStatus === "cancelled") {
			for (const q of openQuestions) {
				await tx.question.update({
					where: { id: q.id },
					data: { status: "withdrawn" },
				});
				events.push({
					...about,
					kind: "question_withdrawn",
					data: { question: `Q${q.id}`, why: `${key} was cancelled` },
				});
			}
		}
	}
	const after = await doneMilestones(tx, project.id, touched);
	for (const [id, name] of after) {
		if (!before.has(id)) {
			events.push({
				...about,
				taskId: undefined,
				milestoneId: id,
				kind: "milestone_done",
				data: { name },
			});
		}
	}
	for (const [id, name] of before) {
		if (!after.has(id)) {
			events.push({
				...about,
				taskId: undefined,
				milestoneId: id,
				kind: "milestone_reopened",
				data: { name, by: key },
			});
		}
	}

	const ids = [];
	for (const event of events) ids.push(await appendEvent(tx, now, event));
	const updated = await tx.task.findUniqueOrThrow({
		where: { id: row.id },
		include: taskInclude,
	});
	return {
		task: toTask(updated, now),
		changed,
		events: ids,
		before: toTask(row, now),
	};
}

/** Keys upper-cased and each once: keys are accepted in any case. */
function keysOf(keys: readonly string[] | undefined): string[] {
	return [...new Set((keys ?? []).map((k) => parseKey(k).key))];
}

function transition(
	key: string,
	from: string,
	to: string,
	allowed: readonly string[],
): BoardError {
	return {
		code: "invalid_transition",
		message: `${key} cannot go from ${from} to ${to} by board edit.`,
		next: `From ${from} it can go to ${allowed.join(", ")}.`,
		details: { from, to, allowed: [...allowed] },
	};
}

/** The done milestones among `ids`, by id, with their names. */
async function doneMilestones(
	tx: Tx,
	projectId: number,
	ids: ReadonlySet<number>,
): Promise<Map<number, string>> {
	const done = new Map<number, string>();
	if (ids.size === 0) return done;
	for (const link of await chain(tx, projectId)) {
		if (ids.has(link.id) && link.status === "done")
			done.set(link.id, link.name);
	}
	return done;
}

/**
 * The ids from `start` to `target` along the walked edges, comma-separated,
 * or null when `target` was not reached. Each reached task has a `prev`
 * that waits for it; following them back ends at `start` in a DAG.
 */
function waitPath(
	reached: readonly { id: number | null; prev: number | null }[],
	start: number,
	target: number,
): string | null {
	const prev = new Map<number, number>();
	for (const r of reached) {
		if (r.id !== null && r.prev !== null && !prev.has(r.id))
			prev.set(r.id, r.prev);
	}
	if (target !== start && !prev.has(target)) return null;
	const path = [target];
	for (let at = target; at !== start; ) {
		at = prev.get(at) as number;
		path.unshift(at);
	}
	return path.join(",");
}

/** `cycle`, naming the loop by keys, starting and ending at the task. */
async function cycle(
	tx: Tx,
	project: ProjectRow,
	taskId: number,
	path: string,
	field: string,
): Promise<BoardError> {
	const ids = [taskId, ...path.split(",").map(Number)];
	const rows = await tx.task.findMany({
		where: { id: { in: ids } },
		select: { id: true, number: true },
	});
	const keys = ids.map((id) =>
		taskKey(project.key, rows.find((r) => r.id === id)?.number ?? 0),
	);
	return {
		code: "cycle",
		message: `That ${field === "parent" ? "parent" : "wait"} would close a loop: ${keys.join(" → ")}.`,
		next: "Break the loop elsewhere first, or relate the tasks the other way.",
		details: { path: keys },
	};
}
