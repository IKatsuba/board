import { stamp } from "../clock.ts";
import type { Claim, Milestone, Place, Project } from "../schemas.ts";
import { statusCounts } from "../store/generated/sql.ts";
import type { Tx } from "../store/store.ts";
import { chain, currentPlace } from "./milestones.ts";
import { type ProjectRow, projectShape } from "./projects.ts";
import { taskKey, toClaim } from "./shapes.ts";

export interface BoardStatus {
	project: Project;
	counts: {
		backlog: number;
		ready: number;
		active: number;
		blocked: number;
		done: number;
		cancelled: number;
	};
	milestones: Milestone[];
	current: Place | null;
	claims: Claim[];
	questions: { open: number; to_validate: number };
	last_event: number;
}

/** `board status`: one project's state, read in one snapshot. */
export async function boardStatus(
	tx: Tx,
	now: Date,
	project: ProjectRow,
): Promise<BoardStatus> {
	const [counts] = await tx.$queryRawTyped(
		statusCounts(stamp(now), project.id),
	);
	const links = await chain(tx, project.id);
	const claims = await tx.claim.findMany({
		where: { until: { gt: stamp(now) }, task: { project_id: project.id } },
		include: { task: { select: { number: true, title: true } } },
		orderBy: [{ until: "asc" }, { task_id: "asc" }],
	});
	const inProject = { task: { project_id: project.id } };
	const open = await tx.question.count({
		where: { ...inProject, status: "open" },
	});
	const toValidate = await tx.question.count({
		where: {
			...inProject,
			status: "answered",
			answered_as: "delegate",
			validated_at: null,
		},
	});
	const last = await tx.event.aggregate({
		where: { project_id: project.id },
		_max: { id: true },
	});
	return {
		project: projectShape(project),
		counts: {
			backlog: Number(counts?.backlog ?? 0),
			ready: Number(counts?.ready ?? 0),
			active: Number(counts?.active ?? 0),
			blocked: Number(counts?.blocked ?? 0),
			done: Number(counts?.done ?? 0),
			cancelled: Number(counts?.cancelled ?? 0),
		},
		milestones: links.map(({ id: _, ...milestone }) => milestone),
		current: currentPlace(links),
		claims: claims.map((claim) =>
			toClaim(
				claim,
				taskKey(project.key, claim.task.number),
				claim.task.title,
				now,
			),
		),
		questions: { open, to_validate: toValidate },
		last_event: last._max.id ?? 0,
	};
}
