import { refuse } from "../errors.ts";
import type { Event } from "../schemas.ts";
import type { Tx } from "../store/store.ts";
import { appendEvent } from "./events.ts";
import type { ProjectRow } from "./projects.ts";
import { toEvents } from "./shapes.ts";
import { checkActor, invalid, taskByNumber } from "./tasks.ts";

/**
 * A note, or a handover with everything a reader needs to pick up: the tool's
 * schema requires its four fields for a handover and refuses them on a note.
 */
export interface CommentInput {
	actor: string;
	key: string;
	kind: "note" | "handover";
	text: string;
	to?: string | undefined;
	changed?: string | undefined;
	ran?: string | undefined;
	unchecked?: string | undefined;
}

/**
 * A comment is an event and nothing more: a handover moves no claim and
 * changes no status, and nothing in its text is read. Closed tasks take
 * comments too.
 */
export async function commentOn(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: CommentInput,
): Promise<{ event: Event; events: number[] }> {
	checkActor(input.actor);
	if (input.kind === "handover") {
		for (const field of ["to", "changed", "ran", "unchecked"] as const) {
			if (input[field] === undefined) {
				refuse(
					invalid(
						field,
						`A handover needs \`--${field}\`.`,
						"Give --to, --changed, --ran and --unchecked with a handover.",
					),
				);
			}
		}
	}
	const row = await taskByNumber(tx, project, input.key, {});
	const id = await appendEvent(tx, now, {
		actor: input.actor,
		kind: input.kind === "note" ? "comment" : "handover",
		projectId: project.id,
		taskId: row.id,
		data:
			input.kind === "note"
				? { text: input.text }
				: {
						to: input.to,
						text: input.text,
						changed: input.changed,
						ran: input.ran,
						unchecked: input.unchecked,
					},
	});
	const [event] = await toEvents(
		tx,
		await tx.event.findMany({ where: { id } }),
	);
	return { event: event as Event, events: [id] };
}
