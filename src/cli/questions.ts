import { Command, EnumType, ValidationError } from "@cliffy/command";
import type { Question } from "../schemas.ts";
import { answeredText, askedText, questionsText } from "../text.ts";
import {
	ACTOR,
	ACTOR_HELP,
	answer,
	type Deps,
	inRange,
	lengthIn,
	placeOf,
	refusing,
	shown,
	table,
	withBoard,
} from "./io.ts";
import { keyType, projectType, questionType } from "./types.ts";

const STATES = ["open", "to_validate", "answered", "withdrawn", "all"] as const;

/** `board questions`: questions by state, oldest first. */
export function questionsCommand(deps: Deps) {
	return new Command()
		.description("List questions by state.")
		.type("state", new EnumType(STATES))
		.type("project", projectType)
		.type("key", keyType)
		.option(
			"-p, --project <KEY:project>",
			"The project; defaults to the working directory's.",
			{
				conflicts: ["all"],
			},
		)
		.option("--all", "Every project.")
		.option(
			"--state <STATE:state>",
			"open (default), to_validate, answered, withdrawn or all.",
		)
		.option("--task <KEY:key>", "One task's questions.")
		.option("--json", "Print question_list's answer.")
		.action(({ project, all, state, task, json }) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.questionList(placeOf(deps), {
						project: all ? "*" : project,
						state,
						key: task,
					});
					if (json) {
						deps.io.out(JSON.stringify(value));
						return;
					}
					if (value.questions.length > 0) {
						deps.io.out(
							table(
								["ID", "TASK", "STATUS", "ASKED BY", "QUESTION", "ANSWER"],
								value.questions.map((q) => [
									q.id,
									q.key,
									q.validated !== null
										? "validated"
										: q.answer?.as === "delegate"
											? "to validate"
											: q.status,
									q.asked_by,
									q.text,
									answerOf(q),
								]),
							),
						);
					}
					deps.io.err(shown(questionsText(value, state)));
				}),
			),
		);
}

function answerOf(question: Question): string {
	const answer = question.answer;
	if (answer === null) return "-";
	const chosen =
		answer.choice === null
			? null
			: `${answer.choice}. ${question.options[answer.choice - 1]?.label ?? ""}`;
	const said = [chosen, answer.text].filter((part) => part != null).join(" — ");
	return `${said} (${answer.by} as ${answer.as})`;
}

/**
 * `board ask KEY`: a question for the owner. Options are numbered flags, so
 * a detail cannot be paired with the wrong label and cliffy checks them all.
 */
export function askCommand(deps: Deps) {
	return new Command()
		.description(
			"Ask the owner a question with 2 to 6 options and a recommendation.",
		)
		.type("key", keyType)
		.arguments("<KEY:key>")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--text <TEXT:string>", "The question, 1 to 2,000 characters.", {
			required: true,
			value: lengthIn("--text", 1, 2000),
		})
		.option("--recommended <N:integer>", "The option you recommend, 1 to 6.", {
			required: true,
			value: inRange("--recommended", 1, 6),
		})
		.option("--option-1 <LABEL:string>", "Option 1, 1 to 80 characters.", {
			required: true,
			value: lengthIn("--option-1", 1, 80),
		})
		.option(
			"--detail-1 <TEXT:string>",
			"What option 1 means, 1 to 500 characters.",
			{
				depends: ["option-1"],
				value: lengthIn("--detail-1", 1, 500),
			},
		)
		.option("--option-2 <LABEL:string>", "Option 2, 1 to 80 characters.", {
			required: true,
			value: lengthIn("--option-2", 1, 80),
		})
		.option(
			"--detail-2 <TEXT:string>",
			"What option 2 means, 1 to 500 characters.",
			{
				depends: ["option-2"],
				value: lengthIn("--detail-2", 1, 500),
			},
		)
		.option("--option-3 <LABEL:string>", "Option 3, 1 to 80 characters.", {
			depends: ["option-2"],
			value: lengthIn("--option-3", 1, 80),
		})
		.option(
			"--detail-3 <TEXT:string>",
			"What option 3 means, 1 to 500 characters.",
			{
				depends: ["option-3"],
				value: lengthIn("--detail-3", 1, 500),
			},
		)
		.option("--option-4 <LABEL:string>", "Option 4, 1 to 80 characters.", {
			depends: ["option-3"],
			value: lengthIn("--option-4", 1, 80),
		})
		.option(
			"--detail-4 <TEXT:string>",
			"What option 4 means, 1 to 500 characters.",
			{
				depends: ["option-4"],
				value: lengthIn("--detail-4", 1, 500),
			},
		)
		.option("--option-5 <LABEL:string>", "Option 5, 1 to 80 characters.", {
			depends: ["option-4"],
			value: lengthIn("--option-5", 1, 80),
		})
		.option(
			"--detail-5 <TEXT:string>",
			"What option 5 means, 1 to 500 characters.",
			{
				depends: ["option-5"],
				value: lengthIn("--detail-5", 1, 500),
			},
		)
		.option("--option-6 <LABEL:string>", "Option 6, 1 to 80 characters.", {
			depends: ["option-5"],
			value: lengthIn("--option-6", 1, 80),
		})
		.option(
			"--detail-6 <TEXT:string>",
			"What option 6 means, 1 to 500 characters.",
			{
				depends: ["option-6"],
				value: lengthIn("--detail-6", 1, 500),
			},
		)
		.option("--json", "Print the answer as one JSON object.")
		.action(({ actor, text, recommended, json, ...numbered }, key) => {
			const flags = numbered as Record<string, string | undefined>;
			const options = [1, 2, 3, 4, 5, 6]
				.filter((n) => flags[`option-${n}`] !== undefined)
				.map((n) => ({
					label: flags[`option-${n}`] as string,
					detail: flags[`detail-${n}`],
				}));
			return refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.questionAsk({
						actor,
						key,
						text,
						options,
						recommended,
					});
					answer(deps, json, value, askedText(value.question));
				}),
			);
		});
}

/** `board answer QID [N] [--text TEXT]`: the owner's answer or a delegate's. */
export function answerCommand(deps: Deps) {
	return new Command()
		.description("Answer a question, as the owner or as a delegate.")
		.type("question", questionType)
		.type("as", new EnumType(["owner", "delegate"]))
		.arguments("<QID:question> [N:integer]")
		.option("--text <TEXT:string>", "The answer in words, with or without N.", {
			value: lengthIn("--text", 1, 2000),
		})
		.option(
			"--as <WHO:as>",
			"Whose decision it is: owner (the person's own words) or delegate.",
			{ required: true },
		)
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--json", "Print the answer as one JSON object.")
		.action(({ text, as, actor, json }, question, choice) => {
			if (choice === undefined && text === undefined) {
				throw new ValidationError(
					"Give the option's number N, --text, or both.",
				);
			}
			if (choice !== undefined) inRange("N", 1, 6)(choice);
			return refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const { overrode, ...value } = await board.questionAnswer({
						actor,
						question,
						choice,
						text,
						as,
					});
					answer(
						deps,
						json,
						value,
						answeredText(value.question, value.task, overrode),
					);
				}),
			);
		});
}

/** `board validate QID`: the owner's check of a delegate's answer. */
export function validateCommand(deps: Deps) {
	return new Command()
		.description("Mark a delegate's answer as approved by the owner.")
		.type("question", questionType)
		.arguments("<QID:question>")
		.option("--actor <NAME:string>", ACTOR_HELP, ACTOR)
		.option("--json", "Print the answer as one JSON object.")
		.action(({ actor, json }, question) =>
			refusing(deps, json, () =>
				withBoard(deps, async (board) => {
					const value = await board.questionValidate({
						actor,
						question,
					});
					answer(deps, json, value, `${value.question.id} validated`);
				}),
			),
		);
}
