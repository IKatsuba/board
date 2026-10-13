import { Command, EnumType } from "@cliffy/command";
import { openReader } from "../store/reader.ts";
import {
	humanLine,
	jsonLine,
	type WatchKind,
	type WatchLine,
} from "../watch/derive.ts";
import { runExec } from "../watch/exec.ts";
import { Watcher, watch } from "../watch/loop.ts";
import { type Deps, envOf, inRange, refusing } from "./io.ts";
import { keyType, projectType } from "./types.ts";

const KINDS = [
	"board_created",
	"project_added",
	"project_edited",
	"project_removed",
	"task_added",
	"task_edited",
	"task_status",
	"task_moved",
	"waits_changed",
	"claimed",
	"claim_extended",
	"claim_released",
	"claim_expired",
	"comment",
	"handover",
	"question_asked",
	"question_answered",
	"question_validated",
	"question_withdrawn",
	"milestone_added",
	"milestone_edited",
	"milestone_deleted",
	"milestone_done",
	"milestone_reopened",
	"claim_expiring",
] as const satisfies readonly WatchKind[];

/** A list option: comma-separated, repeatable, flattened into one list. */
function flatten<T>(value: T[], previous: T[] = []): T[] {
	return [...previous, ...value];
}

/**
 * `board watch`: the machine's event log, one line per event, oldest first.
 * It reads on a read-only connection and never waits behind a writer. It
 * installs no signal handler: Ctrl-C ends it at once, 130, and SIGTERM, 143.
 */
export function watchCommand(deps: Deps) {
	return new Command()
		.description("Print the event log; --follow to keep printing.")
		.type("kind", new EnumType(KINDS))
		.type("project", projectType)
		.type("key", keyType)
		.option(
			"-f, --follow",
			"Keep watching from now, with claim_expiring lines.",
		)
		.option("--since <ID:integer>", "Start after this event id.", {
			value: inRange("--since", 0),
		})
		.option(
			"-p, --project <KEY:project[]>",
			"Only these projects; comma-separated, repeatable.",
			{
				collect: true,
				value: flatten<string>,
			},
		)
		.option(
			"--kind <K:kind[]>",
			"Only these kinds; comma-separated, repeatable.",
			{
				collect: true,
				value: flatten<WatchKind>,
			},
		)
		.option(
			"--task <KEY:key[]>",
			"Only these tasks; comma-separated, repeatable.",
			{
				collect: true,
				value: flatten<string>,
			},
		)
		.option("--json", "One JSON object per line.")
		.option(
			"--expiring-within <MINUTES:integer>",
			"Warn this many minutes before a lease ends.",
			{
				value: inRange("--expiring-within", 1),
			},
		)
		.option(
			"--exec <CMD:string>",
			"Run CMD through sh -c for every line, the line's JSON on stdin.",
			{
				depends: ["follow"],
			},
		)
		.option(
			"--exec-timeout <SECONDS:integer>",
			"Stop a --exec command after this long; default 30.",
			{
				value: inRange("--exec-timeout", 1),
			},
		)
		.action((options) =>
			refusing(deps, options.json, async () => {
				const db = openReader(envOf(deps));
				const follow = options.follow === true;
				const raw =
					deps.io.errRaw ??
					((chunk: Uint8Array | string) =>
						deps.io.err(
							(typeof chunk === "string"
								? chunk
								: new TextDecoder().decode(chunk)
							).replace(/\n$/, ""),
						));
				const print = async (line: WatchLine) => {
					deps.io.out(options.json ? jsonLine(line) : humanLine(line));
					if (options.exec !== undefined) {
						await runExec(
							options.exec,
							line,
							options.execTimeout ?? 30,
							raw,
							deps.environment ?? {},
						);
					}
				};
				const watcher = new Watcher(
					db,
					{
						follow,
						since: options.since ?? null,
						projects: options.project ?? [],
						kinds: options.kind ?? [],
						tasks: options.task ?? [],
						expiringWithin: options.expiringWithin ?? null,
					},
					deps.clock,
					print,
				);
				try {
					await watch(watcher, follow, (ms) => Bun.sleep(ms));
				} finally {
					db.close();
				}
			}),
		);
}
