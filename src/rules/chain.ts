import { stamp } from "../clock.ts";
import { type BoardError, refuse } from "../errors.ts";
import type { Milestone } from "../schemas.ts";
import type { Tx } from "../store/store.ts";
import { appendEvent } from "./events.ts";
import { type ChainLink, chain } from "./milestones.ts";
import type { ProjectRow } from "./projects.ts";
import { checkActor, invalid, milestoneByName } from "./tasks.ts";

/** What every milestone write answers besides its own fields. */
export interface ChainAnswer {
	project: string;
	chain: string[];
	events: number[];
}

function shape(link: ChainLink): Milestone {
	const { id: _, ...milestone } = link;
	return milestone;
}

/**
 * A name a milestone may take: `none` is the word for no milestone, and names
 * are unique per project in any case. `except` is the milestone being
 * renamed, whose own name does not count as taken; `field` is the flag or
 * positional the name came in (`NAME` on add, `name` on edit's `--name`).
 */
async function checkName(
	tx: Tx,
	project: ProjectRow,
	name: string,
	except: number | null,
	field: "NAME" | "name",
): Promise<void> {
	if (name.toLowerCase() === "none") {
		refuse(
			invalid(
				field,
				'"none" is the word for no milestone, so no milestone is called that.',
				"Choose another name.",
			),
		);
	}
	const taken = await tx.milestone.findUnique({
		where: { project_id_name: { project_id: project.id, name } },
	});
	if (taken !== null && taken.id !== except) {
		refuse(
			invalid(
				field,
				`${project.key} has a milestone ${taken.name} already; names are unique in any case.`,
				"Choose another name.",
			),
		);
	}
}

/**
 * Writes `order` as positions 1…n, a null leaving its position free for a
 * milestone about to be inserted. Positions are unique per project and
 * SQLite checks that per row, so every moved row goes through a negative
 * position first; the schema keeps 0 out.
 */
async function renumber(
	tx: Tx,
	order: readonly (ChainLink | null)[],
): Promise<void> {
	const moved = order.flatMap((link, i) =>
		link !== null && link.position !== i + 1 ? [{ link, to: i + 1 }] : [],
	);
	for (const { link } of moved) {
		await tx.milestone.update({
			where: { id: link.id },
			data: { position: -link.position },
		});
	}
	for (const { link, to } of moved) {
		await tx.milestone.update({
			where: { id: link.id },
			data: { position: to },
		});
	}
}

/** Where `before` / `after` / last puts a milestone among `others`. */
async function placeAt(
	tx: Tx,
	project: ProjectRow,
	others: ChainLink[],
	self: string,
	before: string | undefined,
	after: string | undefined,
): Promise<number> {
	const anchor = before ?? after;
	if (anchor === undefined) return others.length;
	const row = await milestoneByName(tx, project, anchor);
	if (row.name.toLowerCase() === self.toLowerCase()) {
		refuse(
			invalid(
				before === undefined ? "after" : "before",
				`${row.name} cannot be moved relative to itself.`,
				"Name another milestone of the chain.",
			),
		);
	}
	const at = others.findIndex((link) => link.id === row.id);
	return before === undefined ? at + 1 : at;
}

export interface MilestoneAddInput {
	actor: string;
	name: string;
	delivers: string;
	before?: string | undefined;
	after?: string | undefined;
}

/** `board milestone add`: last in the chain unless `--before` or `--after` names one. */
export async function addMilestone(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: MilestoneAddInput,
): Promise<ChainAnswer & { milestone: Milestone }> {
	checkActor(input.actor);
	await checkName(tx, project, input.name, null, "NAME");
	const links = await chain(tx, project.id);
	const at = await placeAt(
		tx,
		project,
		links,
		input.name,
		input.before,
		input.after,
	);
	// Make room: the new milestone takes position at + 1, later ones shift.
	await renumber(tx, [...links.slice(0, at), null, ...links.slice(at)]);
	const row = await tx.milestone.create({
		data: {
			project_id: project.id,
			name: input.name,
			delivers: input.delivers,
			position: at + 1,
			created_at: stamp(now),
			created_by: input.actor,
		},
	});
	const event = await appendEvent(tx, now, {
		actor: input.actor,
		kind: "milestone_added",
		projectId: project.id,
		milestoneId: row.id,
		data: { name: row.name, delivers: row.delivers, position: row.position },
	});
	const after = await chain(tx, project.id);
	return {
		project: project.key,
		milestone: shape(after.find((link) => link.id === row.id) as ChainLink),
		chain: after.map((link) => link.name),
		events: [event],
	};
}

export type MilestoneField = "name" | "delivers" | "position";

export interface MilestoneUpdateInput {
	actor: string;
	milestone: string;
	name?: string | undefined;
	delivers?: string | undefined;
	before?: string | undefined;
	after?: string | undefined;
}

/**
 * `board milestone edit`: rename, re-describe, and move relative to another
 * milestone. A move logs `position` on the moved milestone only; the shift
 * of the others follows from it.
 */
export async function updateMilestone(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: MilestoneUpdateInput,
): Promise<ChainAnswer & { milestone: Milestone; changed: MilestoneField[] }> {
	checkActor(input.actor);
	const row = await milestoneByName(tx, project, input.milestone);
	const changed: MilestoneField[] = [];
	const edited: Record<string, { from: unknown; to: unknown }> = {};
	if (input.name !== undefined && input.name !== row.name) {
		await checkName(tx, project, input.name, row.id, "name");
		edited.name = { from: row.name, to: input.name };
		changed.push("name");
	}
	if (input.delivers !== undefined && input.delivers !== row.delivers) {
		edited.delivers = { from: row.delivers, to: input.delivers };
		changed.push("delivers");
	}
	const links = await chain(tx, project.id);
	let order = links;
	if (input.before !== undefined || input.after !== undefined) {
		const others = links.filter((link) => link.id !== row.id);
		const at = await placeAt(
			tx,
			project,
			others,
			row.name,
			input.before,
			input.after,
		);
		const self = links.find((link) => link.id === row.id) as ChainLink;
		order = [...others.slice(0, at), self, ...others.slice(at)];
		if (at + 1 !== row.position) {
			edited.position = { from: row.position, to: at + 1 };
			changed.push("position");
		}
	}
	const events: number[] = [];
	if (changed.length > 0) {
		await tx.milestone.update({
			where: { id: row.id },
			data: {
				...(edited.name === undefined ? {} : { name: input.name }),
				...(edited.delivers === undefined ? {} : { delivers: input.delivers }),
			},
		});
		await renumber(tx, order);
		events.push(
			await appendEvent(tx, now, {
				actor: input.actor,
				kind: "milestone_edited",
				projectId: project.id,
				milestoneId: row.id,
				data: edited,
			}),
		);
	}
	const after = await chain(tx, project.id);
	return {
		project: project.key,
		milestone: shape(after.find((link) => link.id === row.id) as ChainLink),
		chain: after.map((link) => link.name),
		changed,
		events,
	};
}

export interface MilestoneDeleteInput {
	actor: string;
	milestone: string;
}

/** `board milestone rm`: only a milestone with no tasks; later ones shift up. */
export async function deleteMilestone(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: MilestoneDeleteInput,
): Promise<ChainAnswer & { deleted: string }> {
	checkActor(input.actor);
	const row = await milestoneByName(tx, project, input.milestone);
	const tasks = await tx.task.count({ where: { milestone_id: row.id } });
	if (tasks > 0) {
		refuse({
			code: "invalid_transition",
			message: `${row.name} has ${tasks} task${tasks === 1 ? "" : "s"}, cancelled ones included; only an empty milestone is deleted.`,
			next: "Move its tasks out with `board edit KEY --milestone none` first.",
			details: { reason: "has_tasks" },
		} satisfies BoardError);
	}
	await tx.milestone.delete({ where: { id: row.id } });
	await renumber(tx, await chain(tx, project.id));
	const event = await appendEvent(tx, now, {
		actor: input.actor,
		kind: "milestone_deleted",
		projectId: project.id,
		milestoneId: row.id,
		data: { name: row.name },
	});
	const after = await chain(tx, project.id);
	return {
		project: project.key,
		deleted: row.name,
		chain: after.map((link) => link.name),
		events: [event],
	};
}
