import { stamp } from "../clock.ts";
import type { Status } from "../schemas.ts";

/** The stored statuses a task is open in. */
export const OPEN = ["backlog", "ready", "active"] as const;
/** What a wait is satisfied by. */
export const CLOSED = ["done", "cancelled"] as const;

/** What a task's effective status and readiness are read from. */
export interface TaskState {
	status: string;
	claim: { until: string } | null;
	openQuestions: number;
	/** Stored statuses of the tasks it waits for. */
	waits: readonly string[];
}

/** The same rules as effectiveWhere, for a task already read. */
export function effectiveStatus(task: TaskState, now: Date): Status {
	if (task.status === "done" || task.status === "cancelled") return task.status;
	if (task.openQuestions > 0) return "blocked";
	if (task.status === "active" && !isLive(task.claim, now)) return "ready";
	return task.status as Status;
}

export function isReady(task: TaskState, now: Date): boolean {
	return (
		effectiveStatus(task, now) === "ready" &&
		task.waits.every((status) => status === "done" || status === "cancelled")
	);
}

/** A claim is live until its end; at its end it reads as gone. */
export function isLive(
	claim: { until: string } | null,
	now: Date,
): claim is { until: string } {
	return claim !== null && claim.until > stamp(now);
}
