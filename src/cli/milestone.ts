import { Command, ValidationError } from "@cliffy/command";
import {
	milestoneAddedText,
	milestoneDeletedText,
	milestoneUpdatedText,
} from "../text.ts";
import {
	ACTOR,
	ACTOR_HELP,
	answer,
	type Deps,
	lengthIn,
	placeOf,
	refusing,
	table,
	withBoard,
} from "./io.ts";
import { milestoneType, projectType } from "./types.ts";

/** `board milestone`: the chain, and its writes. */
export function milestoneCommand(deps: Deps) {
	const ls = ({ project, json }: { project?: string; json?: boolean }) =>
		refusing(deps, json, () =>
			withBoard(deps, async (board) => {
				const { milestones } = await board.boardStatus(placeOf(deps), {
					project,
				});
				if (json) {
					deps.io.out(JSON.stringify(milestones));
					return;
				}
				if (milestones.length > 0) {
					deps.io.out(
						table(
							[
								"POS",
								"NAME",
								"STATUS",
								"DONE",
								"CANCELLED",
								"LEFT",
								"DELIVERS",
							],
							milestones.map((m) => [
								String(m.position),
								m.name,
								m.status,
								String(m.tasks.done),
								String(m.tasks.cancelled),
								String(m.tasks.left),
								m.delivers,
							]),
						),
					);
				}
				deps.io.err(
					`${milestones.length} milestone${milestones.length === 1 ? "" : "s"}`,
				);
			}),
		);
	return new Command()
		.description("The milestone chain, in order.")
		.globalType("project", projectType)
		.globalType("milestone", milestoneType)
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
		)
		.option("--json", "Print the chain.")
		.action(ls)
		.command("ls", "The milestone chain, in order.")
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
		)
		.option("--json", "Print the chain.")
		.action(ls)
		.command("add <NAME:milestone>", "Add a milestone.")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option(
			"--delivers <TEXT:string>",
			"What it delivers, 1 to 500 characters.",
			{
				required: true,
				value: lengthIn("--delivers", 1, 500),
			},
		)
		.option("--before <NAME:milestone>", "Place it before this one.", {
			conflicts: ["after"],
		})
		.option("--after <NAME:milestone>", "Place it after this one.")
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
		)
		.option("--json", "Print the answer as one JSON object.")
		.action(({ actor, delivers, before, after, project, json }, name) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.milestoneAdd(placeOf(deps), {
						actor,
						project,
						name,
						delivers,
						before,
						after,
					});
					answer(deps, json, value, milestoneAddedText(value));
				}),
			),
		)
		.command(
			"edit <NAME:milestone>",
			"Rename, re-describe or move a milestone.",
		)
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--name <NEW:milestone>", "A new name.")
		.option(
			"--delivers <TEXT:string>",
			"What it delivers, 1 to 500 characters.",
			{
				value: lengthIn("--delivers", 1, 500),
			},
		)
		.option("--before <NAME:milestone>", "Move it before this one.", {
			conflicts: ["after"],
		})
		.option("--after <NAME:milestone>", "Move it after this one.")
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
		)
		.option("--json", "Print the answer as one JSON object.")
		.action(
			(
				{ actor, name: rename, delivers, before, after, project, json },
				milestone,
			) => {
				if ([rename, delivers, before, after].every((v) => v === undefined)) {
					throw new ValidationError(
						"Nothing to change: give --name, --delivers, --before or --after.",
					);
				}
				const input = { milestone, name: rename, delivers, before, after };
				return refusing(deps, json, () =>
					withBoard(deps, async (board) => {
						const value = await board.milestoneUpdate(placeOf(deps), {
							actor,
							project,
							...input,
						});
						answer(deps, json, value, milestoneUpdatedText(value, input));
					}),
				);
			},
		)
		.command("rm <NAME:milestone>", "Delete a milestone with no tasks.")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
		)
		.option("--json", "Print the answer as one JSON object.")
		.action(({ actor, project, json }, milestone) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.milestoneDelete(placeOf(deps), {
						actor,
						project,
						milestone,
					});
					answer(deps, json, value, milestoneDeletedText(value));
				}),
			),
		)
		.reset();
}
