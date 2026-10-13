import { stamp } from "../clock.ts";
import type { Place, TaskSummary } from "../schemas.ts";
import { nextTask, nextWaiting } from "../store/generated/sql.ts";
import type { Tx } from "../store/store.ts";
import { chain } from "./milestones.ts";
import type { ProjectRow } from "./projects.ts";
import { summaryInclude, toSummary } from "./shapes.ts";
import { milestoneByName } from "./tasks.ts";

export interface TaskNextOutput {
	project: string;
	task: TaskSummary | null;
	from: "current" | "unassigned" | "later" | "milestone" | null;
	milestone: Place | null;
	waiting: { blocked: number; active: number; waits_open: number };
}

/**
 * The ready task to start next in one project. It only reads: two callers
 * may get the same task, and the second `board claim` is `claim_held`.
 */
export async function nextTaskIn(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	milestone: string | undefined,
): Promise<TaskNextOutput> {
	const links = await chain(tx, project.id);
	const explicit =
		milestone === undefined
			? null
			: await milestoneByName(tx, project, milestone);
	const shown =
		explicit === null
			? links.find((link) => link.status === "current")
			: links.find((link) => link.id === explicit.id);
	const place: Place | null =
		shown === undefined
			? null
			: {
					name: shown.name,
					position: shown.position,
					of: links.length,
					left: shown.tasks.left,
				};
	const current = links.find((link) => link.status === "current")?.id ?? null;
	const [picked] = await tx.$queryRawTyped(
		nextTask(project.id, explicit?.id ?? null, stamp(now), current),
	);
	const [counts] = await tx.$queryRawTyped(
		nextWaiting(stamp(now), project.id, explicit?.id ?? null),
	);
	const waiting = {
		blocked: Number(counts?.blocked ?? 0),
		active: Number(counts?.active ?? 0),
		waits_open: Number(counts?.waits_open ?? 0),
	};
	if (picked?.id == null) {
		return {
			project: project.key,
			task: null,
			from: null,
			milestone: place,
			waiting,
		};
	}
	const row = await tx.task.findUniqueOrThrow({
		where: { id: picked.id },
		include: summaryInclude,
	});
	const from =
		explicit !== null
			? "milestone"
			: picked.milestone_id === null
				? "unassigned"
				: picked.milestone_id === current
					? "current"
					: "later";
	return {
		project: project.key,
		task: toSummary(row, now),
		from,
		milestone: place,
		waiting,
	};
}
