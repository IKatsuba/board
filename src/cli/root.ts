import { Command, ValidationError } from "@cliffy/command";
import { HelpCommand } from "@cliffy/command/help";
import pkg from "../../package.json" with { type: "json" };
import { errorText, Refusal } from "../errors.ts";
import { type Deps, shown } from "./io.ts";
import { lsCommand } from "./ls.ts";
import { milestoneCommand } from "./milestone.ts";
import { nextCommand } from "./next.ts";
import { projectCommand } from "./project.ts";
import {
	answerCommand,
	askCommand,
	questionsCommand,
	validateCommand,
} from "./questions.ts";
import { showCommand } from "./show.ts";
import { skillCommand } from "./skill.ts";
import { sqlCommand } from "./sql.ts";
import { statusCommand } from "./status.ts";
import {
	addCommand,
	claimCommand,
	commentCommand,
	editCommand,
	extendCommand,
	handoverCommand,
	releaseCommand,
} from "./tasks.ts";
import { upgradeCommand } from "./upgrade.ts";
import { watchCommand } from "./watch.ts";

/** The root command; the entry point and the tests build it the same way. */
export function buildCli(deps: Deps) {
	return new Command()
		.name("board")
		.version(pkg.version)
		.description("A local task board for coding agents.")
		.throwErrors()
		.noExit()
		.help({ colors: deps.colors })
		.command("help", new HelpCommand().global())
		.command("status", statusCommand(deps))
		.command("ls", lsCommand(deps))
		.command("show", showCommand(deps))
		.command("next", nextCommand(deps))
		.command("add", addCommand(deps))
		.command("edit", editCommand(deps))
		.command("claim", claimCommand(deps))
		.command("extend", extendCommand(deps))
		.command("release", releaseCommand(deps))
		.command("comment", commentCommand(deps))
		.command("handover", handoverCommand(deps))
		.command("ask", askCommand(deps))
		.command("questions", questionsCommand(deps))
		.command("answer", answerCommand(deps))
		.command("validate", validateCommand(deps))
		.command("milestone", milestoneCommand(deps))
		.command("project", projectCommand(deps))
		.command("watch", watchCommand(deps))
		.command("sql", sqlCommand(deps))
		.command("skill", skillCommand(deps))
		.command("upgrade", upgradeCommand(deps));
}

/**
 * Runs one command line and answers its exit code: 0 done, 1 refused by a
 * rule or the database, 64 usage. A usage error prints one line and never
 * the help.
 */
export async function runCli(argv: string[], deps: Deps): Promise<number> {
	try {
		await buildCli(deps).parse(argv);
	} catch (error) {
		// `board upgrade -l` lists outside cliffy's own catch, so its registry
		// refusal arrives here.
		if (error instanceof Refusal) {
			deps.io.err(shown(errorText(error.error)));
			return 1;
		}
		if (!(error instanceof ValidationError)) throw error;
		// cliffy's message quotes what was typed, which may hold controls.
		deps.io.err(`board: usage: ${shown(error.message)}`);
		return 64;
	}
	return deps.exitCode;
}
