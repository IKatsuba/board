import { stamp } from "../clock.ts";
import type { Kind } from "../schemas.ts";
import type { Tx } from "../store/store.ts";

/** One line of the log, appended in the transaction that made the change. */
export interface NewEvent {
	actor: string;
	kind: Kind;
	projectId: number | null;
	taskId?: number;
	milestoneId?: number;
	/** The catalog's shape for `kind`, with public identifiers only. */
	data: Record<string, unknown>;
}

/** Appends an event at `now` and returns its id. */
export async function appendEvent(
	tx: Tx,
	now: Date,
	event: NewEvent,
): Promise<number> {
	const row = await tx.event.create({
		data: {
			at: stamp(now),
			actor: event.actor,
			kind: event.kind,
			project_id: event.projectId,
			task_id: event.taskId ?? null,
			milestone_id: event.milestoneId ?? null,
			data: JSON.stringify(event.data),
		},
		select: { id: true },
	});
	return row.id;
}
