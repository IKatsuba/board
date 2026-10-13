import { Command, EnumType } from "@cliffy/command";
import type { Status } from "../schemas.ts";
import { listText } from "../text.ts";
import {
	type Deps,
	inRange,
	lengthIn,
	placeOf,
	refusing,
	shown,
	table,
	withBoard,
} from "./io.ts";
import { keyType, milestoneType, projectType } from "./types.ts";

const STATUSES = [
	"backlog",
	"ready",
	"active",
	"blocked",
	"done",
	"cancelled",
] as const;

/** `board ls`: tasks, newest first. */
export function lsCommand(deps: Deps) {
	return new Command()
		.description(
			"List tasks, newest first, by status, milestone, parent, readiness or text.",
		)
		.type("status", new EnumType(STATUSES))
		.type("project", projectType)
		.type("key", keyType)
		.type("milestone", milestoneType)
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
			{
				conflicts: ["all"],
			},
		)
		.option("--all", "Every project.")
		.option(
			"--status <S:status[]>",
			"Effective statuses, comma-separated; repeatable.",
			{
				collect: true,
				value: (value: Status[], previous: Status[] = []) => [
					...previous,
					...value,
				],
			},
		)
		.option("--milestone <NAME:milestone>", "A milestone, or none.")
		.option("--parent <KEY:key>", "The children of a task.")
		.option("--ready", "Only tasks ready by the rule.")
		.option(
			"--contains <TEXT:string>",
			"Plain text in the title or body; ASCII letters in any case.",
			{ value: lengthIn("--contains", 1, 200) },
		)
		.option("--limit <N:integer>", "1 to 200; default 50.", {
			value: inRange("--limit", 1, 200),
		})
		.option("--offset <N:integer>", "Default 0.", {
			value: inRange("--offset", 0),
		})
		.option("--json", "Print task_list's answer.")
		.action((options) =>
			refusing(deps, options.json, () =>
				withBoard(deps, async (board) => {
					const contains = options.contains;
					const value = await board.taskList(placeOf(deps), {
						project: options.all ? "*" : options.project,
						status: options.status,
						milestone: options.milestone,
						parent: options.parent,
						ready: options.ready,
						contains,
						limit: options.limit,
						offset: options.offset,
					});
					if (options.json) {
						deps.io.out(JSON.stringify(value));
						return;
					}
					if (value.tasks.length > 0) {
						deps.io.out(
							table(
								["KEY", "STATUS", "PRIORITY", "MILESTONE", "HOLDER", "TITLE"],
								value.tasks.map((t) => [
									t.key,
									t.status,
									t.priority,
									t.milestone ?? "-",
									t.holder ?? "-",
									t.title,
								]),
							),
						);
					}
					deps.io.err(shown(listText(value, contains)));
				}),
			),
		);
}
