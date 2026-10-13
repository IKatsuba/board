import { Command } from "@cliffy/command";
import { projectAdd } from "../board.ts";
import {
	ACTOR,
	ACTOR_HELP,
	answer,
	type Deps,
	envOf,
	placeOf,
	refusing,
	shown,
	table,
	withBoard,
} from "./io.ts";
import { projectType } from "./types.ts";

/** `board project`: add and list the projects on this board. */
export function projectCommand(deps: Deps) {
	return new Command()
		.description("The projects on this board.")
		.globalType("project", projectType)
		.command(
			"ls",
			"Every project on this machine.\n\n* marks the project the working directory resolves to.",
		)
		.option("--json", "Print {projects, here}.")
		.action(({ json }) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const list = await board.projectList(placeOf(deps));
					if (json) {
						deps.io.out(JSON.stringify(list));
						return;
					}
					deps.io.out(
						table(
							[
								"",
								"KEY",
								"NAME",
								"OPEN",
								"CLOSED",
								"CURRENT MILESTONE",
								"DIRECTORY",
							],
							list.projects.map(({ project, open, closed, current }) => [
								project.key === list.here ? "*" : "",
								project.key,
								project.name,
								String(open),
								String(closed),
								current === null
									? "-"
									: `${current.name} (${current.position} of ${current.of})`,
								project.directory,
							]),
						),
					);
				}),
			),
		)
		.command("add <KEY:project>", "Add a project (the person's command).")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option(
			"--name <NAME:string>",
			"A label; defaults to the directory's last component.",
		)
		.option(
			"--dir <DIR:string>",
			"The repository's root; defaults to the working directory.",
		)
		.option("--json", "Print the Project.")
		.action(({ actor, name, dir, json }, key) =>
			refusing(deps, json, async () => {
				const project = await projectAdd(
					envOf(deps),
					deps.clock,
					deps.runner,
					deps.cwd,
					{ actor, key, name, dir },
				);
				if (json) {
					deps.io.out(JSON.stringify(project));
					return;
				}
				deps.io.out(
					table(null, [[project.key, project.name, project.directory]]),
				);
				deps.io.err(
					shown(
						`keys ${project.key}-1, ${project.key}-2, …; agents started under ${project.directory} use it`,
					),
				);
			}),
		)
		.command(
			"edit <KEY:project>",
			"Change a project's name or directory (the person's command).",
		)
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--name <NAME:string>", "A new label.")
		.option("--dir <DIR:string>", "The repository's new root.")
		.option("--json", "Print the Project.")
		.action(({ actor, name, dir, json }, key) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const project = await board.projectEdit(deps.runner, deps.cwd, {
						actor,
						key,
						name,
						dir,
					});
					deps.io.out(
						json
							? JSON.stringify(project)
							: table(null, [[project.key, project.name, project.directory]]),
					);
				}),
			),
		)
		.command(
			"rm <KEY:project>",
			"Remove a project with no tasks (the person's command).",
		)
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--json", "Print the removed Project.")
		.action(({ actor, json }, key) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const project = await board.projectRemove({ actor, key });
					answer(
						deps,
						json,
						project,
						`removed ${project.key} (${project.directory})`,
					);
				}),
			),
		)
		.reset();
}
