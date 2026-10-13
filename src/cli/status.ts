import { Command } from "@cliffy/command";
import type { BoardStatus } from "../rules/status.ts";
import { type Deps, placeOf, refusing, table, withBoard } from "./io.ts";
import { projectType } from "./types.ts";

/** `board status`: one project's state. */
export function statusCommand(deps: Deps) {
	return new Command()
		.description("One project's state: milestones, claims, questions.")
		.type("project", projectType)
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
		)
		.option("--json", "Print board_status's answer.")
		.action(({ project, json }) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.boardStatus(placeOf(deps), { project });
					deps.io.out(
						json ? JSON.stringify(value) : describe(value, deps.clock.now()),
					);
				}),
			),
		);
}

function describe(value: BoardStatus, now: Date): string {
	const { project, counts: c, current, questions: q } = value;
	const milestone = value.milestones.find((m) => m.name === current?.name);
	const lines = [
		["project", `${project.key}  ${project.name}  ${project.directory}`],
		current === null || milestone === undefined
			? ["milestone", "no current milestone"]
			: [
					`milestone ${current.position} of ${current.of}`,
					`${current.name}  ${milestone.delivers}  ${current.left} tasks left (${milestone.tasks.done} done, ${milestone.tasks.cancelled} cancelled of ${milestone.tasks.total})`,
				],
		[
			"tasks",
			`${c.ready} ready, ${c.active} active, ${c.blocked} blocked, ${c.backlog} backlog, ${c.done} done, ${c.cancelled} cancelled`,
		],
		["questions", `${q.open} open, ${q.to_validate} to validate`],
	];
	const head = table(null, lines);
	if (value.claims.length === 0) return head;
	const claims = table(
		["KEY", "HOLDER", "UNTIL", "LEFT", "DIRECTORY", "BRANCH"],
		value.claims.map((claim) => [
			claim.key,
			claim.holder,
			claim.until,
			left(Date.parse(claim.until) - now.getTime()),
			claim.directory ?? "-",
			claim.branch ?? "-",
		]),
	);
	return `${head}\n\nclaims\n${claims}`;
}

/** "in 47m" or "in 2h05m". */
function left(ms: number): string {
	const minutes = Math.max(0, Math.ceil(ms / 60_000));
	return minutes < 60
		? `in ${minutes}m`
		: `in ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
