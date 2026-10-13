import { Command } from "@cliffy/command";
import type { Event, Task } from "../schemas.ts";
import { readText } from "../text.ts";
import { type Deps, inRange, refusing, shown, table, withBoard } from "./io.ts";
import { keyType } from "./types.ts";

/** `board show`: task_read for a person; the key names the project. */
export function showCommand(deps: Deps) {
	return new Command()
		.description("One task whole, and its events.")
		.type("key", keyType)
		.arguments("<KEY:key>")
		.option("--since <ID:integer>", "Only events after this id.", {
			value: inRange("--since", 0),
		})
		.option("--json", "Print task_read's answer.")
		.action(({ since, json }, key) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.taskRead({ key, since });
					if (json) {
						deps.io.out(JSON.stringify(value));
						return;
					}
					deps.io.out(describe(value.task));
					if (value.events.length > 0) {
						deps.io.out("");
						deps.io.out(table(null, value.events.map(eventRow)));
					}
					deps.io.err(shown(readText(value, since ?? 0)));
				}),
			),
		);
}

function refs(list: Task["waits"]): string {
	return list.length === 0
		? "-"
		: list.map((r) => `${r.key} (${r.status})`).join(", ");
}

function describe(task: Task): string {
	const claim =
		task.claim === null
			? "-"
			: [
					`${task.claim.holder} until ${task.claim.until} (${task.claim.minutes_left} min left)`,
					task.claim.directory,
					task.claim.branch,
				]
					.filter((part) => part !== null)
					.join(", ");
	const fields = table(null, [
		["status", task.status],
		["ready", task.ready ? "yes" : "no"],
		["priority", task.priority],
		["milestone", task.milestone ?? "-"],
		["parent", task.parent ?? "-"],
		["claim", claim],
		["waits", refs(task.waits)],
		["waited by", refs(task.waited_by)],
		["children", refs(task.children)],
		[
			"questions",
			task.questions.map((q) => `${q.id} (${q.status})`).join(", ") || "-",
		],
		["created", `${task.created_at} by ${task.created_by}`],
		["updated", task.updated_at],
	]);
	const body = task.body === "" ? "" : `\n\n${shown(task.body)}`;
	return `${task.key}  ${shown(task.title)}\n\n${fields}${body}`;
}

function eventRow(event: Event): string[] {
	return [
		event.at,
		`#${event.id}`,
		event.actor,
		event.kind,
		JSON.stringify(event.data),
	];
}
