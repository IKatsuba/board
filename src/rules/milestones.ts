import type { Milestone, Place } from "../schemas.ts";
import type { Tx } from "../store/store.ts";

/** A milestone as read: its row id beside its public shape. */
export type ChainLink = Milestone & { id: number };

/**
 * A project's chain in order, with each milestone's derived status: done
 * when it has tasks and all are closed, current for the earliest open one,
 * planned for later open ones. An empty milestone is open, never done.
 */
export async function chain(tx: Tx, projectId: number): Promise<ChainLink[]> {
	const rows = await tx.milestone.findMany({
		where: { project_id: projectId },
		orderBy: { position: "asc" },
	});
	const counts = await tx.task.groupBy({
		by: ["milestone_id", "status"],
		where: { project_id: projectId, milestone_id: { not: null } },
		_count: { _all: true },
	});
	let currentSeen = false;
	return rows.map((row) => {
		let total = 0;
		let done = 0;
		let cancelled = 0;
		for (const c of counts) {
			if (c.milestone_id !== row.id) continue;
			total += c._count._all;
			if (c.status === "done") done += c._count._all;
			if (c.status === "cancelled") cancelled += c._count._all;
		}
		const closed = total > 0 && done + cancelled === total;
		const status = closed ? "done" : currentSeen ? "planned" : "current";
		if (status === "current") currentSeen = true;
		return {
			id: row.id,
			name: row.name,
			position: row.position,
			delivers: row.delivers,
			status,
			tasks: { total, done, cancelled, left: total - done - cancelled },
		};
	});
}

/** "milestone 2 of 5, 3 left" for the current milestone, or null. */
export function currentPlace(links: readonly ChainLink[]): Place | null {
	const current = links.find((link) => link.status === "current");
	if (current === undefined) return null;
	return {
		name: current.name,
		position: current.position,
		of: links.length,
		left: current.tasks.left,
	};
}
