import { Command } from "@cliffy/command";
import { nextText } from "../text.ts";
import { type Deps, placeOf, refusing, shown, table, withBoard } from "./io.ts";
import { milestoneType, projectType } from "./types.ts";

/** `board next`: the task to start next, or why there is none. */
export function nextCommand(deps: Deps) {
	return new Command()
		.description(
			"The task to start next in a project, and why nothing is ready.",
		)
		.type("project", projectType)
		.type("milestone", milestoneType)
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
		)
		.option("--milestone <NAME:milestone>", "Search this milestone only.")
		.option("--json", "Print task_next's answer.")
		.action(({ project, milestone, json }) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.taskNext(placeOf(deps), {
						project,
						milestone,
					});
					if (json) {
						deps.io.out(JSON.stringify(value));
						return;
					}
					const task = value.task;
					if (task !== null) {
						deps.io.out(
							table(
								["KEY", "STATUS", "PRIORITY", "MILESTONE", "TITLE"],
								[
									[
										task.key,
										task.status,
										task.priority,
										task.milestone ?? "-",
										task.title,
									],
								],
							),
						);
					}
					deps.io.err(shown(nextText(value)));
				}),
			),
		);
}
