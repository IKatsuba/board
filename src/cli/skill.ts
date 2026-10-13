import { Command } from "@cliffy/command";
import { CLOSING, PROSE } from "../skill.ts";
import type { Deps } from "./io.ts";

/** A command of the tree, whatever its options. */
type Node = Pick<Command, "getCommands" | "getName" | "getShortDescription">;

/** What the index leaves out: no agent needs them to work the board. */
const LEFT_OUT = new Set(["help", "upgrade", "skill"]);

/** A command's own subcommands: `help` is global, so every command has it. */
const children = (command: Node) =>
	command.getCommands().filter((child) => child.getName() !== "help");

/**
 * The command index: one line per leaf command, in the tree's order, with
 * the description its Command carries.
 */
export function commandIndex(root: Node): string {
	const lines: string[] = [];
	const walk = (command: Node, path: string[]) => {
		for (const child of children(command)) {
			if (path.length === 0 && LEFT_OUT.has(child.getName())) continue;
			const at = [...path, child.getName()];
			if (children(child).length > 0) {
				walk(child, at);
				continue;
			}
			const name = `board ${at.join(" ")}`;
			lines.push(`  ${name.padEnd(27)}${child.getShortDescription()}`);
		}
	};
	walk(root, []);
	return lines.join("\n");
}

/** The guide whole: the prose, the generated index, the closing line. */
export function skillText(root: Node): string {
	return `${PROSE}\n${commandIndex(root)}\n\n${CLOSING.trimEnd()}`;
}

/**
 * `board skill`: the agent's guide on stdout. It takes nothing and opens no
 * board, so it works before `board project add` and with any BOARD_DIR.
 */
export function skillCommand(deps: Deps) {
	return new Command()
		.description(
			"Print the guide an agent needs: the model, the flows, what to do per error.",
		)
		.action(function () {
			deps.io.out(skillText(this.getMainCommand()));
		});
}
