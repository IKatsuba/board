import { stamp } from "../clock.ts";
import { type BoardError, refuse } from "../errors.ts";
import type { Claim, TaskSummary } from "../schemas.ts";
import type { Tx } from "../store/store.ts";
import { appendEvent } from "./events.ts";
import type { ProjectRow } from "./projects.ts";
import { isLive } from "./readiness.ts";
import { summaryInclude, toClaim, toSummary } from "./shapes.ts";
import { checkActor, invalid, taskByNumber } from "./tasks.ts";

/** A lease is 1 to 1440 minutes, sized by the claimer; there is no default. */
function checkMinutes(minutes: number): void {
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
		refuse(
			invalid(
				"minutes",
				`A lease is 1 to 1440 whole minutes, not ${minutes}.`,
				"Size the lease from the team's estimate.",
			),
		);
	}
}

async function readSummary(
	tx: Tx,
	id: number,
	now: Date,
): Promise<TaskSummary> {
	const row = await tx.task.findUniqueOrThrow({
		where: { id },
		include: summaryInclude,
	});
	return toSummary(row, now);
}

function claimHeld(claim: Claim, next: string): BoardError {
	return {
		code: "claim_held",
		message: `${claim.key} is held by ${claim.holder} until ${claim.until}.`,
		next,
		details: { claim },
	};
}

function notClaimed(key: string): BoardError {
	return {
		code: "not_claimed",
		message: `${key} has no live claim: it was never claimed, was released, or its lease ran out.`,
		next: "`board claim` it again if it is still yours to do.",
		details: {},
	};
}

export interface ClaimInput {
	actor: string;
	key: string;
	minutes: number;
	holder?: string | undefined;
	directory?: string | undefined;
	branch?: string | undefined;
}

/**
 * Takes a ready task for `holder` (the actor by default). A lapsed claim was
 * swept before this runs, so retaking a lapsed task is one call; any live
 * claim, the same holder's included, is `claim_held`.
 */
export async function claimTask(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: ClaimInput,
): Promise<{ claim: Claim; task: TaskSummary; events: number[] }> {
	checkActor(input.actor);
	checkMinutes(input.minutes);
	const row = await taskByNumber(tx, project, input.key, summaryInclude);
	const key = toSummary(row, now).key;
	if (row.claim !== null && isLive(row.claim, now)) {
		refuse(
			claimHeld(
				toClaim(row.claim, key, row.title, now),
				"Wait for it, or `board extend` it if the claim is yours.",
			),
		);
	}
	const summary = toSummary(row, now);
	if (!summary.ready) {
		// The stored status decides first: a question on a backlog task blocks
		// it, but answering the question leaves it backlog, not ready. A live
		// claim was refused above and a lapsed one swept, so ready is stored.
		const waitsOpen = row.waits_on.some(
			(w) => w.on.status !== "done" && w.on.status !== "cancelled",
		);
		const reason =
			row.status !== "ready"
				? "status"
				: row.question.length > 0
					? "question"
					: "waits";
		refuse({
			code: "not_ready",
			message:
				reason === "question"
					? `${key} is blocked on an open question.`
					: reason === "waits"
						? `${key} waits for tasks that are not done or cancelled.`
						: `${key} is ${row.status}, not ready.`,
			next:
				reason === "question"
					? waitsOpen
						? "It becomes ready when its open questions are answered or withdrawn and everything it waits for is done or cancelled; `board show KEY` lists both."
						: "It becomes ready when its open questions are answered or withdrawn."
					: reason === "waits"
						? "It becomes ready when everything it waits for is done or cancelled; `board show KEY` lists them."
						: "`board edit KEY --status ready` first, if it should be worked on.",
			details: { task: summary, reason },
		});
	}
	const holder = input.holder ?? input.actor;
	const since = stamp(now);
	const until = stamp(new Date(now.getTime() + input.minutes * 60_000));
	const directory = input.directory ?? null;
	const branch = input.branch ?? null;
	await tx.task.update({ where: { id: row.id }, data: { status: "active" } });
	const claim = await tx.claim.create({
		data: { task_id: row.id, holder, since, until, directory, branch },
	});
	const event = await appendEvent(tx, now, {
		actor: input.actor,
		kind: "claimed",
		projectId: project.id,
		taskId: row.id,
		data: { holder, since, until, directory, branch },
	});
	return {
		claim: toClaim(claim, key, row.title, now),
		task: await readSummary(tx, row.id, now),
		events: [event],
	};
}

/** The live claim of `key` if `holder` holds it: a compare-and-set, not a role check. */
async function heldBy(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	key: string,
	holder: string,
) {
	const row = await taskByNumber(tx, project, key, summaryInclude);
	const shownKey = toSummary(row, now).key;
	// The sweep has removed a lapsed claim, so a claim here is live.
	if (row.claim === null || !isLive(row.claim, now))
		refuse(notClaimed(shownKey));
	const claim = toClaim(row.claim, shownKey, row.title, now);
	if (row.claim.holder !== holder) {
		refuse(
			claimHeld(
				claim,
				"Re-read the claim with `board show KEY`; pass the holder it names as --holder.",
			),
		);
	}
	return { row, claim, live: row.claim };
}

export interface ExtendInput {
	actor: string;
	key: string;
	holder: string;
	minutes: number;
}

/**
 * Sets the end to now plus `minutes`, a fresh estimate from where the run
 * stands; a lapsed claim is not revived, since another run may already have
 * been told the task is ready.
 */
export async function extendClaim(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: ExtendInput,
): Promise<{ claim: Claim; events: number[] }> {
	checkActor(input.actor);
	checkMinutes(input.minutes);
	const { row, claim, live } = await heldBy(
		tx,
		now,
		project,
		input.key,
		input.holder,
	);
	const until = stamp(new Date(now.getTime() + input.minutes * 60_000));
	const updated = await tx.claim.update({
		where: { task_id: row.id },
		data: { until },
	});
	const event = await appendEvent(tx, now, {
		actor: input.actor,
		kind: "claim_extended",
		projectId: project.id,
		taskId: row.id,
		data: { holder: live.holder, until: { from: claim.until, to: until } },
	});
	return {
		claim: toClaim(updated, claim.key, row.title, now),
		events: [event],
	};
}

export interface ReleaseInput {
	actor: string;
	key: string;
	holder: string;
	note?: string | undefined;
}

/** Drops the claim; the task is ready again. */
export async function releaseClaim(
	tx: Tx,
	now: Date,
	project: ProjectRow,
	input: ReleaseInput,
): Promise<{ task: TaskSummary; released: Claim; events: number[] }> {
	checkActor(input.actor);
	const { row, claim } = await heldBy(
		tx,
		now,
		project,
		input.key,
		input.holder,
	);
	await tx.claim.delete({ where: { task_id: row.id } });
	await tx.task.update({ where: { id: row.id }, data: { status: "ready" } });
	const event = await appendEvent(tx, now, {
		actor: input.actor,
		kind: "claim_released",
		projectId: project.id,
		taskId: row.id,
		data: { holder: claim.holder, reason: "release", note: input.note ?? null },
	});
	return {
		task: await readSummary(tx, row.id, now),
		released: claim,
		events: [event],
	};
}
