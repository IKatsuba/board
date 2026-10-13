import { Command, EnumType, ValidationError } from "@cliffy/command";
import {
	addedText,
	claimedText,
	commentText,
	extendedText,
	releasedText,
	updatedText,
} from "../text.ts";
import {
	ACTOR,
	ACTOR_HELP,
	answer,
	type Deps,
	inRange,
	lengthIn,
	placeOf,
	refusing,
	withBoard,
} from "./io.ts";
import { keyType, milestoneType, projectType } from "./types.ts";

const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
const JSON_HELP = "Print the answer as one JSON object.";

/**
 * A comma-separated, repeatable list of task keys, at most 50 in all;
 * duplicates are folded by the rules.
 */
function keys(flag: string) {
	return {
		collect: true,
		value: (value: string[], previous: string[] = []) => {
			const all = [...previous, ...value];
			if (all.length > 50) {
				throw new ValidationError(
					`${flag} takes at most 50 keys, got ${all.length}.`,
				);
			}
			return all;
		},
	} as const;
}

const minutes = {
	required: true,
	value: inRange("--minutes", 1, 1440),
} as const;

/** `board add`: a task, or a finding under a parent. */
export function addCommand(deps: Deps) {
	return new Command()
		.description("Add a task, or a finding under a parent.")
		.type("project", projectType)
		.type("key", keyType)
		.type("milestone", milestoneType)
		.type("priority", new EnumType(PRIORITIES))
		.type("status", new EnumType(["backlog", "ready"]))
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--title <TEXT:string>", "1 to 200 characters.", {
			required: true,
			value: lengthIn("--title", 1, 200),
		})
		.option("--body <TEXT:string>", "Up to 20,000 characters; default empty.", {
			value: lengthIn("--body", 0, 20_000),
		})
		.option("--priority <P:priority>", "urgent, high, normal (default) or low.")
		.option("--status <S:status>", "ready (default) or backlog.")
		.option(
			"--parent <KEY:key>",
			"File it under this task, in its project and milestone.",
		)
		.option(
			"--milestone <NAME:milestone>",
			"A milestone, or none; default the parent's, else none.",
		)
		.option(
			"--waits <KEY:key[]>",
			"Tasks it waits for, comma-separated; repeatable; at most 50.",
			keys("--waits"),
		)
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the parent's, else the working directory's.",
		)
		.option("--json", JSON_HELP)
		.action(({ json, project, ...input }) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.taskAdd(placeOf(deps), {
						...input,
						project,
					});
					answer(deps, json, value, addedText(value.task));
				}),
			),
		);
}

/** `board edit KEY`: title, body, priority, status, parent, milestone, waits. */
export function editCommand(deps: Deps) {
	return new Command()
		.description(
			"Change a task: title, body, priority, status, parent, milestone, waits.",
		)
		.type("key", keyType)
		.type("milestone", milestoneType)
		.type("priority", new EnumType(PRIORITIES))
		.type("status", new EnumType(["backlog", "ready", "done", "cancelled"]))
		.arguments("<KEY:key>")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--title <TEXT:string>", "1 to 200 characters.", {
			value: lengthIn("--title", 1, 200),
		})
		.option("--body <TEXT:string>", "Up to 20,000 characters.", {
			value: lengthIn("--body", 0, 20_000),
		})
		.option("--no-body", "Empty the body.")
		.option("--priority <P:priority>", "urgent, high, normal or low.")
		.option(
			"--status <S:status>",
			"backlog, ready, done or cancelled; an active task loses its claim.",
		)
		.option("--parent <KEY:key>", "A new parent, in the same project.")
		.option("--no-parent", "No parent.")
		.option("--milestone <NAME:milestone>", "A milestone, or none.")
		.option(
			"--waits-add <KEY:key[]>",
			"Tasks to wait for, comma-separated; repeatable; at most 50.",
			keys("--waits-add"),
		)
		.option(
			"--waits-remove <KEY:key[]>",
			"Tasks to stop waiting for, comma-separated; repeatable; at most 50.",
			keys("--waits-remove"),
		)
		.option("--json", JSON_HELP)
		.action(
			(
				{
					actor,
					json,
					body,
					parent,
					waitsAdd: waits_add,
					waitsRemove: waits_remove,
					...fields
				},
				key,
			) => {
				const input = {
					...fields,
					// --no-body empties the body; --no-parent clears the parent.
					body: body === false ? "" : body,
					parent: parent === false ? null : parent,
					waits_add,
					waits_remove,
				};
				if (Object.values(input).every((v) => v === undefined)) {
					throw new ValidationError(
						"Nothing to change: give --title, --body, --no-body, --priority, --status, --parent, --no-parent, --milestone, --waits-add or --waits-remove.",
					);
				}
				return refusing(deps, json, () =>
					withBoard(deps, async (board) => {
						const { before, ...value } = await board.taskUpdate({
							actor,
							key,
							...input,
						});
						answer(
							deps,
							json,
							value,
							updatedText(before, value.task, value.changed),
						);
					}),
				);
			},
		);
}

/** `board claim KEY`: the lease, sized by the claimer. */
export function claimCommand(deps: Deps) {
	return new Command()
		.description("Claim a ready task for a number of minutes.")
		.type("key", keyType)
		.arguments("<KEY:key>")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option(
			"--minutes <N:integer>",
			"The lease, 1 to 1440; no default.",
			minutes,
		)
		.option(
			"--holder <NAME:string>",
			"Who holds it, 1 to 64 characters; defaults to --actor.",
			{ value: lengthIn("--holder", 1, 64) },
		)
		.option(
			"--directory <DIR:string>",
			"Where the run works, stored as given.",
			{ value: lengthIn("--directory", 1, 1024) },
		)
		.option("--branch <BRANCH:string>", "The run's branch, stored as given.", {
			value: lengthIn("--branch", 1, 255),
		})
		.option("--json", JSON_HELP)
		.action(({ json, ...input }, key) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.taskClaim({ ...input, key });
					answer(deps, json, value, claimedText(value.claim, input.minutes));
				}),
			),
		);
}

const holder = {
	required: true,
	value: lengthIn("--holder", 1, 64),
} as const;

/** `board extend KEY`: the end becomes now plus the minutes. */
export function extendCommand(deps: Deps) {
	return new Command()
		.description("Set a live claim's end to now plus minutes.")
		.type("key", keyType)
		.arguments("<KEY:key>")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option(
			"--holder <NAME:string>",
			"The holder you saw; compared with the live claim's.",
			holder,
		)
		.option(
			"--minutes <N:integer>",
			"From now, 1 to 1440; no default.",
			minutes,
		)
		.option("--json", JSON_HELP)
		.action(({ json, ...input }, key) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.taskExtend({ ...input, key });
					answer(deps, json, value, extendedText(value.claim, input.minutes));
				}),
			),
		);
}

/** `board release KEY`: the claim goes, the task is ready. */
export function releaseCommand(deps: Deps) {
	return new Command()
		.description("Drop a live claim; the task is ready again.")
		.type("key", keyType)
		.arguments("<KEY:key>")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option(
			"--holder <NAME:string>",
			"The holder you saw; compared with the live claim's.",
			holder,
		)
		.option("--note <TEXT:string>", "Why, 1 to 500 characters.", {
			value: lengthIn("--note", 1, 500),
		})
		.option("--json", JSON_HELP)
		.action(({ json, ...input }, key) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.taskRelease({ ...input, key });
					answer(deps, json, value, releasedText(value.released, input.actor));
				}),
			),
		);
}

const text = (max: number) =>
	({ required: true, value: lengthIn("--text", 1, max) }) as const;

/** `board comment KEY`: a note; `--to` is handover's, so it is unknown here. */
export function commentCommand(deps: Deps) {
	return new Command()
		.description("A note on a task.")
		.type("key", keyType)
		.arguments("<KEY:key>")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option(
			"--text <TEXT:string>",
			"The note, 1 to 10,000 characters.",
			text(10_000),
		)
		.option("--json", JSON_HELP)
		.action(({ json, ...input }, key) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.taskComment({
						...input,
						key,
						kind: "note",
					});
					answer(deps, json, value, commentText(value.event));
				}),
			),
		);
}

/** `board handover KEY`: a record of handing work on; it moves nothing. */
export function handoverCommand(deps: Deps) {
	const part = (flag: string) =>
		({ required: true, value: lengthIn(flag, 1, 4000) }) as const;
	return new Command()
		.description(
			"Hand work on: to, why, what changed, what ran, what is unchecked.",
		)
		.type("key", keyType)
		.arguments("<KEY:key>")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--to <NAME:string>", "Whom it goes to, 1 to 64 characters.", {
			required: true,
			value: lengthIn("--to", 1, 64),
		})
		.option(
			"--text <TEXT:string>",
			"Why, and what is asked; 1 to 10,000 characters.",
			text(10_000),
		)
		.option(
			"--changed <TEXT:string>",
			"What changed, 1 to 4,000 characters.",
			part("--changed"),
		)
		.option(
			"--ran <TEXT:string>",
			"What was run, 1 to 4,000 characters.",
			part("--ran"),
		)
		.option(
			"--unchecked <TEXT:string>",
			"What is not checked, 1 to 4,000 characters.",
			part("--unchecked"),
		)
		.option("--json", JSON_HELP)
		.action(({ json, ...input }, key) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.taskComment({
						...input,
						key,
						kind: "handover",
					});
					answer(deps, json, value, commentText(value.event));
				}),
			),
		);
}
