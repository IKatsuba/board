import { basename, resolve } from "node:path";
import type { Clock } from "./clock.ts";
import type { Env } from "./env.ts";
import { type BoardError, refuse } from "./errors.ts";
import type { GitAnswer, GitRunner } from "./place/git.ts";
import { Place, realDirectory } from "./place/place.ts";
import {
	addMilestone,
	deleteMilestone,
	type MilestoneAddInput,
	type MilestoneDeleteInput,
	type MilestoneUpdateInput,
	updateMilestone,
} from "./rules/chain.ts";
import {
	type ClaimInput,
	claimTask,
	type ExtendInput,
	extendClaim,
	type ReleaseInput,
	releaseClaim,
} from "./rules/claims.ts";
import { type CommentInput, commentOn } from "./rules/comments.ts";
import { nextTaskIn, type TaskNextOutput } from "./rules/next.ts";
import {
	addProject,
	editProject,
	listProjects,
	NeedGit,
	type NewProject,
	type ProjectRow,
	projectByKey,
	removeProject,
	resolveProject,
} from "./rules/projects.ts";
import {
	type AnswerInput,
	type AskInput,
	answerQuestion,
	askQuestion,
	listQuestions,
	projectOfQuestion,
	type QuestionState,
	validateQuestion,
} from "./rules/questions.ts";
import { type BoardStatus, boardStatus } from "./rules/status.ts";
import {
	addTask,
	checkActor,
	listTasks,
	parseKey,
	readTaskByKey,
	type TaskAddInput,
	type TaskListInput,
	type TaskListOutput,
	type TaskReadOutput,
} from "./rules/tasks.ts";
import { type TaskUpdateInput, updateTask } from "./rules/update.ts";
import type { Project, ProjectList, Task } from "./schemas.ts";
import { Store, type Tx } from "./store/store.ts";

/**
 * One method per operation over the store. Knows nothing of cliffy or stdout:
 * the CLI turns input into a call, and a result or a Refusal into output.
 */
export class Board {
	constructor(private readonly store: Store) {}

	/**
	 * `board project edit`: a new label or directory (the repository moved).
	 * The path and git are looked at first; every refusal is thrown inside
	 * the write, after its sweep.
	 */
	async projectEdit(
		runner: GitRunner,
		cwd: string,
		input: ProjectEditInput,
	): Promise<Project> {
		const directory =
			input.dir === undefined
				? undefined
				: await checkDirectory(
						runner,
						cwd,
						input.dir,
						`board project edit ${input.key} --dir ${input.dir}`,
					);
		const name =
			input.name === undefined
				? undefined
				: (checkName(input.name) ?? input.name);
		const written = await this.store.write({
			actor: input.actor,
			resolve: (tx) => projectByKey(tx, input.key),
			apply: (tx, now, project) => {
				checkActor(input.actor);
				if (typeof directory === "object") refuse(directory);
				if (typeof name === "object") refuse(name);
				return editProject(tx, now, input.actor, project, { name, directory });
			},
		});
		return written.value;
	}

	/** `board project rm`: a project with no tasks, its milestones and events. */
	async projectRemove(input: { actor: string; key: string }): Promise<Project> {
		const written = await this.store.write({
			actor: input.actor,
			resolve: (tx) => projectByKey(tx, input.key),
			apply: (tx, now, project) => {
				checkActor(input.actor);
				return removeProject(tx, now, input.actor, project);
			},
		});
		return written.value;
	}

	/** `board project ls`, with `here` resolved from the place. */
	projectList(place: Place): Promise<ProjectList> {
		return withGit(place, async (git) =>
			this.store.read((tx) => listProjects(tx, { cwd: place.cwd, git })),
		);
	}

	/** `board add`: the project is `-p`, else the parent's, else resolved. */
	async taskAdd(
		place: Place,
		input: TaskAddInput & { project?: string | undefined },
	): Promise<{ task: Task; events: number[] }> {
		const written = await withGit(place, async (git) =>
			this.store.write({
				actor: input.actor,
				resolve: (tx) =>
					resolveProject(tx, {
						named:
							input.project === undefined && input.parent !== undefined
								? parseKey(input.parent).project
								: undefined,
						project: input.project,
						cwd: place.cwd,
						git,
					}),
				apply: (tx, now, project) => addTask(tx, now, project, input),
			}),
		);
		return {
			task: written.value.task,
			events: [...written.swept, ...written.value.events],
		};
	}

	/** `board ls`: `"*"` (`--all`) spans every project and resolves nothing. */
	async taskList(
		place: Place,
		input: TaskListInput & { project?: string | undefined },
	): Promise<TaskListOutput> {
		if (input.project === "*") {
			return this.store.read((tx, now) => listTasks(tx, now, null, input));
		}
		return withGit(place, async (git) =>
			this.store.read(async (tx, now) => {
				const project = await resolveProject(tx, {
					named:
						input.project === undefined && input.parent !== undefined
							? parseKey(input.parent).project
							: undefined,
					project: input.project,
					cwd: place.cwd,
					git,
				});
				return listTasks(tx, now, project, input);
			}),
		);
	}

	/** A write about one project: `-p`, the cwd or git. */
	private async inProject<T extends { events: number[] }>(
		place: Place,
		actor: string,
		project: string | undefined,
		apply: (tx: Tx, now: Date, project: ProjectRow) => Promise<T>,
	): Promise<T> {
		const written = await withGit(place, async (git) =>
			this.store.write({
				actor,
				resolve: (tx) =>
					resolveProject(tx, {
						project,
						cwd: place.cwd,
						git,
					}),
				apply,
			}),
		);
		return {
			...written.value,
			events: [...written.swept, ...written.value.events],
		};
	}

	/** `board milestone add`. */
	milestoneAdd(
		place: Place,
		input: MilestoneAddInput & { project?: string | undefined },
	) {
		return this.inProject(
			place,
			input.actor,
			input.project,
			(tx, now, project) => addMilestone(tx, now, project, input),
		);
	}

	/** `board milestone edit`. */
	milestoneUpdate(
		place: Place,
		input: MilestoneUpdateInput & { project?: string | undefined },
	) {
		return this.inProject(
			place,
			input.actor,
			input.project,
			(tx, now, project) => updateMilestone(tx, now, project, input),
		);
	}

	/** `board milestone rm`. */
	milestoneDelete(
		place: Place,
		input: MilestoneDeleteInput & { project?: string | undefined },
	) {
		return this.inProject(
			place,
			input.actor,
			input.project,
			(tx, now, project) => deleteMilestone(tx, now, project, input),
		);
	}

	/** A write about one task: its key names the project. */
	private async keyed<T extends { events: number[] }>(
		actor: string,
		key: string,
		apply: (tx: Tx, now: Date, project: ProjectRow) => Promise<T>,
	): Promise<T> {
		const written = await this.store.write({
			actor,
			resolve: (tx) => projectByKey(tx, parseKey(key).project),
			apply,
		});
		return {
			...written.value,
			events: [...written.swept, ...written.value.events],
		};
	}

	/** `board claim`. */
	taskClaim(input: ClaimInput) {
		return this.keyed(input.actor, input.key, (tx, now, project) =>
			claimTask(tx, now, project, input),
		);
	}

	/** `board extend`. */
	taskExtend(input: ExtendInput) {
		return this.keyed(input.actor, input.key, (tx, now, project) =>
			extendClaim(tx, now, project, input),
		);
	}

	/** `board release`. */
	taskRelease(input: ReleaseInput) {
		return this.keyed(input.actor, input.key, (tx, now, project) =>
			releaseClaim(tx, now, project, input),
		);
	}

	/** `board edit`. */
	taskUpdate(input: TaskUpdateInput) {
		return this.keyed(input.actor, input.key, (tx, now, project) =>
			updateTask(tx, now, project, input),
		);
	}

	/** `board next`: the project is `-p`, or the cwd's. */
	taskNext(
		place: Place,
		input: { project?: string | undefined; milestone?: string | undefined },
	): Promise<TaskNextOutput> {
		return withGit(place, async (git) =>
			this.store.read(async (tx, now) => {
				const project = await resolveProject(tx, {
					project: input.project,
					cwd: place.cwd,
					git,
				});
				return nextTaskIn(tx, now, project, input.milestone);
			}),
		);
	}

	/** `board comment` and `board handover`. */
	taskComment(input: CommentInput) {
		return this.keyed(input.actor, input.key, (tx, now, project) =>
			commentOn(tx, now, project, input),
		);
	}

	/** `board status`: the project is `-p`, or the cwd's. */
	boardStatus(
		place: Place,
		input: { project?: string | undefined },
	): Promise<BoardStatus> {
		return withGit(place, async (git) =>
			this.store.read(async (tx, now) => {
				const project = await resolveProject(tx, {
					project: input.project,
					cwd: place.cwd,
					git,
				});
				return boardStatus(tx, now, project);
			}),
		);
	}

	/** `board ask`: the task's key names the project. */
	questionAsk(input: AskInput) {
		return this.keyed(input.actor, input.key, (tx, now, project) =>
			askQuestion(tx, now, project, input),
		);
	}

	/** A write about one question: its id names the project, its task's. */
	private async aboutQuestion<T extends { events: number[] }>(
		actor: string,
		question: string,
		apply: (tx: Tx, now: Date, project: ProjectRow) => Promise<T>,
	): Promise<T> {
		const written = await this.store.write({
			actor,
			resolve: (tx) => projectOfQuestion(tx, question),
			apply,
		});
		return {
			...written.value,
			events: [...written.swept, ...written.value.events],
		};
	}

	/** `board answer`. */
	questionAnswer(input: AnswerInput) {
		return this.aboutQuestion(input.actor, input.question, (tx, now, project) =>
			answerQuestion(tx, now, project, input),
		);
	}

	/** `board validate`. */
	questionValidate(input: { actor: string; question: string }) {
		return this.aboutQuestion(input.actor, input.question, (tx, now, project) =>
			validateQuestion(tx, now, project, input),
		);
	}

	/**
	 * `board questions`: `"*"` (`--all`) spans every project; otherwise `-p`,
	 * else `--task`'s project, else the resolved one.
	 */
	async questionList(
		place: Place,
		input: {
			project?: string | undefined;
			state?: QuestionState | undefined;
			key?: string | undefined;
		},
	) {
		if (input.project === "*") {
			return this.store.read((tx) => listQuestions(tx, null, input));
		}
		return withGit(place, async (git) =>
			this.store.read(async (tx) => {
				const project = await resolveProject(tx, {
					named:
						input.project === undefined && input.key !== undefined
							? parseKey(input.key).project
							: undefined,
					project: input.project,
					cwd: place.cwd,
					git,
				});
				return listQuestions(tx, project, input);
			}),
		);
	}

	/** `board show`: the key names the project; the cwd plays no part. */
	async taskRead(input: {
		key: string;
		since?: number | undefined;
	}): Promise<TaskReadOutput> {
		return this.store.read(async (tx, now) => {
			const project = await projectByKey(tx, parseKey(input.key).project);
			return readTaskByKey(tx, now, project, input.key, input.since ?? 0);
		});
	}

	/** Closes the store; the CLI opens one per command. */
	close(): Promise<void> {
		return this.store.close();
	}
}

/**
 * Runs an operation with the cwd only, and when its resolution needs git,
 * asks git outside any transaction and runs it once more with the answer:
 * git is a process, and no transaction may await one.
 */
export async function withGit<T>(
	place: Place,
	attempt: (git: GitAnswer | null) => Promise<T>,
): Promise<T> {
	try {
		return await attempt(null);
	} catch (error) {
		if (!(error instanceof NeedGit)) throw error;
	}
	return attempt(await place.git());
}

/** What a person gives `board project edit`. */
export interface ProjectEditInput {
	actor: string;
	key: string;
	name?: string | undefined;
	/** A relative one is taken from the cwd. */
	dir?: string | undefined;
}

/** What a person gives `board project add`. */
export interface ProjectAddInput {
	actor: string;
	key: string;
	name?: string | undefined;
	/** Defaults to the cwd; a relative one is taken from the cwd. */
	dir?: string | undefined;
}

const KEY = /^[A-Za-z][A-Za-z0-9]{0,9}$/;

/**
 * `board project add`: the one operation that creates the board. The path
 * and git are looked at before the transaction, since git runs outside any;
 * every refusal is thrown inside it, after the sweep, so a refused add on an
 * existing board still commits the expiries it noticed.
 */
export async function projectAdd(
	env: Env,
	clock: Clock,
	runner: GitRunner,
	cwd: string,
	input: ProjectAddInput,
): Promise<Project> {
	const checked = await checkProjectAdd(runner, cwd, input);
	const written = await Store.create(env, clock, input.actor, (tx, now) => {
		checkActor(input.actor);
		if ("code" in checked) refuse(checked);
		return addProject(tx, now, input.actor, checked);
	});
	return written.value.project;
}

async function checkProjectAdd(
	runner: GitRunner,
	cwd: string,
	input: ProjectAddInput,
): Promise<NewProject | BoardError> {
	if (!KEY.test(input.key)) {
		return invalid(
			"KEY",
			`The key "${input.key}" is not a project key: 1 to 10 characters, a letter then letters or digits.`,
			"Choose a key such as BRD; it prefixes every task key of the project and never changes.",
		);
	}
	const directory = await checkDirectory(
		runner,
		cwd,
		input.dir ?? ".",
		"board project add",
	);
	if (typeof directory !== "string") return directory;
	const name = input.name ?? basename(directory);
	const badName = checkName(name);
	if (badName !== null) return badName;
	return { key: input.key.toUpperCase(), name, directory };
}

/**
 * A project's directory as stored: real, not `/`, and the main root of its
 * repository when it is in one. Looked at before the transaction, since git
 * runs outside any.
 */
async function checkDirectory(
	runner: GitRunner,
	cwd: string,
	dir: string,
	/** The command to run again once git answers, for the refusal's next. */
	retry: string,
): Promise<string | BoardError> {
	const given = resolve(cwd, dir);
	const directory = realDirectory(given);
	if (directory === null) {
		return invalid(
			"dir",
			`${given} does not exist or is not a directory.`,
			"Pass --dir with an existing directory, the repository's root.",
		);
	}
	if (directory === "/") {
		return invalid(
			"dir",
			"The root directory / cannot be a project's directory.",
			"Pass --dir with the repository's root.",
		);
	}
	return (
		checkRoot(directory, await new Place(directory, runner).git(), retry) ??
		directory
	);
}

function checkName(name: string): BoardError | null {
	return name.trim().length < 1 || name.trim().length > 100
		? invalid(
				"name",
				"A project's name is 1 to 100 characters, not only spaces.",
				"Pass --name with a short label.",
			)
		: null;
}

function invalid(
	field: string,
	message: string,
	next: string,
	reason?: string,
): BoardError {
	return {
		code: "invalid_argument",
		message,
		next,
		details: reason === undefined ? { field } : { field, reason },
	};
}

/**
 * One repository is one project, and its directory is the repository's
 * root: a subdirectory or a linked worktree is refused naming the root, a
 * layout with no root is not supported, and a directory outside git is
 * taken as it is. When git cannot answer, the rule cannot be checked.
 */
function checkRoot(
	directory: string,
	git: GitAnswer,
	retry: string,
): BoardError | null {
	if (git.git === "not_a_repo") return null;
	if (git.git === "found" && git.root === directory) return null;
	if (git.git === "found" && git.root !== null) {
		return invalid(
			"dir",
			`${directory} is inside the git checkout ${git.root} but is not its main root.`,
			`Use --dir ${git.root}: one repository is one project, and its directory is the repository's root.`,
		);
	}
	if (git.git === "found") {
		return invalid(
			"dir",
			`${directory} is in a git layout board does not support: ${git.reason}.`,
			"Use the directory of an ordinary checkout, whose git directory is its .git.",
		);
	}
	return invalid(
		"dir",
		`git could not tell whether ${directory} is a repository's root: ${git.reason}.`,
		`Install or fix git (on macOS, the command line tools), then run ${retry} again.`,
		git.reason,
	);
}
