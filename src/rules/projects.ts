import { stamp } from "../clock.ts";
import { type BoardError, refuse } from "../errors.ts";
import type { GitAnswer } from "../place/git.ts";
import { projectAt } from "../place/project-at.ts";
import type { Project, ProjectList } from "../schemas.ts";
import { projectCounts } from "../store/generated/sql.ts";
import type { Tx } from "../store/store.ts";
import { appendEvent } from "./events.ts";
import { chain, currentPlace } from "./milestones.ts";

/** A project row as rules use it. */
export type ProjectRow = {
	id: number;
	key: string;
	name: string;
	directory: string;
	created_at: string;
};

/**
 * Thrown by resolution that reached git without git's answer: the
 * transaction rolls back, git is asked outside it, and the operation runs
 * once more with the answer.
 */
export class NeedGit extends Error {
	constructor() {
		super("project resolution needs git's answer");
		this.name = "NeedGit";
	}
}

/** Where a call looks for its project, in the order of the design. */
export interface Scope {
	/** A key named by a task key, a parent or a question (step 1). */
	named?: string | undefined;
	/** `-p` (step 2). */
	project?: string | undefined;
	/** The process's cwd, a real path (step 3). */
	cwd: string;
	/** git's answer for the cwd, once asked (step 4). */
	git: GitAnswer | null;
}

export function projectShape(row: ProjectRow): Project {
	return {
		key: row.key,
		name: row.name,
		directory: row.directory,
		created_at: row.created_at,
	};
}

/** The project a call is about; every call resolves inside its transaction. */
export async function resolveProject(
	tx: Tx,
	scope: Scope,
): Promise<ProjectRow> {
	const key = scope.named ?? scope.project;
	if (key !== undefined) return projectByKey(tx, key);
	const found = await projectHere(tx, scope);
	if (found !== null) return found;
	// projectHere has thrown NeedGit unless git has answered.
	const git = scope.git as GitAnswer;
	refuse(noProject(scope.cwd, git, await allProjects(tx)));
}

/**
 * The project of the cwd or of its git root, or null. Throws NeedGit when
 * the cwd misses and git has not been asked yet.
 */
export async function projectHere(
	tx: Tx,
	scope: Pick<Scope, "cwd" | "git">,
): Promise<ProjectRow | null> {
	const projects = await allProjects(tx);
	const byCwd = projectAt(projects, scope.cwd);
	if (byCwd !== null) return byCwd;
	if (scope.git === null) throw new NeedGit();
	return scope.git.root === null ? null : projectAt(projects, scope.git.root);
}

/** A project by its key, in any case. */
export async function projectByKey(tx: Tx, key: string): Promise<ProjectRow> {
	const row = await tx.project.findUnique({ where: { key } });
	if (row !== null) return row;
	const projects = await allProjects(tx);
	const id = key.toUpperCase();
	refuse({
		code: "not_found",
		message: `No project ${id} on this machine.`,
		next:
			projects.length === 0
				? "There are no projects yet; the owner adds one with `board project add KEY`."
				: `Use one of the keys there are: ${listed(projects)}.`,
		details: { what: "project", id },
	});
}

function allProjects(tx: Tx): Promise<ProjectRow[]> {
	return tx.project.findMany({ orderBy: { id: "asc" } });
}

function listed(projects: readonly ProjectRow[]): string {
	return projects.map((p) => `${p.key} ${p.directory}`).join(", ");
}

/** `no_project`: what was looked at, and how the owner adds the project. */
export function noProject(
	cwd: string,
	git: GitAnswer,
	projects: readonly ProjectRow[],
): BoardError {
	const looked = [
		`No project here. Looked at the working directory ${cwd}: no project's directory contains it.`,
	];
	if (git.git === "found" && git.root !== null) {
		looked.push(
			`Looked at its git repository: the main repository is ${git.root}, and no project's directory contains it.`,
		);
	} else if (git.git === "found") {
		looked.push(`Looked at its git repository: ${git.reason}.`);
	} else if (git.git === "not_a_repo") {
		looked.push("Looked at git: the directory is not in a git repository.");
	} else {
		looked.push(`Looked at git: ${git.reason}.`);
	}
	looked.push(
		projects.length === 0
			? "There are no projects on this machine."
			: `Projects on this machine: ${listed(projects)}.`,
	);
	const dir = git.root ?? cwd;
	return {
		code: "no_project",
		message: looked.join(" "),
		next: `${projects.length === 0 ? "Ask" : "Pass `-p KEY` with one of the keys above, or ask"} the owner to choose a key and run \`board project add KEY --dir ${dir}\`.`,
		details: {
			cwd,
			git: git.git,
			git_root: git.root,
			projects: projects.map(projectShape),
			...(git.git === "failed" ? { reason: git.reason } : {}),
		},
	};
}

/** What `board project add` stores, already checked outside the transaction. */
export interface NewProject {
	key: string;
	name: string;
	directory: string;
}

/**
 * Adds a project under the write lock: the key and the directory are unique
 * across the machine, the key case-insensitively.
 */
export async function addProject(
	tx: Tx,
	now: Date,
	actor: string,
	input: NewProject,
): Promise<{ project: Project; events: number[] }> {
	const sameKey = await tx.project.findUnique({ where: { key: input.key } });
	if (sameKey !== null) {
		refuse({
			code: "project_exists",
			message: `A project with key ${sameKey.key} exists already, at ${sameKey.directory}.`,
			next: "Choose another key: a key can never change, so it is never reused.",
			details: { field: "KEY", project: projectShape(sameKey) },
		});
	}
	const sameDir = await tx.project.findUnique({
		where: { directory: input.directory },
	});
	if (sameDir !== null) {
		refuse({
			code: "project_exists",
			message: `Project ${sameDir.key} has the directory ${sameDir.directory} already.`,
			next: `Move ${sameDir.key} first with \`board project edit ${sameDir.key} --dir DIR\`, or use another directory.`,
			details: { field: "dir", project: projectShape(sameDir) },
		});
	}
	const row = await tx.project.create({
		data: {
			key: input.key,
			name: input.name,
			directory: input.directory,
			created_at: stamp(now),
			created_by: actor,
		},
	});
	const event = await appendEvent(tx, now, {
		actor,
		kind: "project_added",
		projectId: row.id,
		data: { key: row.key, name: row.name, directory: row.directory },
	});
	return { project: projectShape(row), events: [event] };
}

/** `board project ls`: every project, its counts, its current milestone. */
export async function listProjects(
	tx: Tx,
	scope: Pick<Scope, "cwd" | "git">,
): Promise<ProjectList> {
	const here = await projectHere(tx, scope);
	const rows = await allProjects(tx);
	const counts = await tx.$queryRawTyped(projectCounts());
	const projects: ProjectList["projects"] = [];
	for (const row of rows) {
		const count = counts.find((c) => c.id === row.id);
		projects.push({
			project: projectShape(row),
			open: Number(count?.open ?? 0),
			closed: Number(count?.closed ?? 0),
			current: currentPlace(await chain(tx, row.id)),
		});
	}
	return { projects, here: here?.key ?? null };
}

/**
 * Changes a project's label or directory; the directory stays unique, and
 * the key never changes. Nothing to change writes nothing.
 */
export async function editProject(
	tx: Tx,
	now: Date,
	actor: string,
	project: ProjectRow,
	input: { name?: string | undefined; directory?: string | undefined },
): Promise<Project> {
	const edited: Record<string, { from: string; to: string }> = {};
	if (input.name !== undefined && input.name !== project.name) {
		edited.name = { from: project.name, to: input.name };
	}
	if (input.directory !== undefined && input.directory !== project.directory) {
		const other = await tx.project.findUnique({
			where: { directory: input.directory },
		});
		if (other !== null) {
			refuse({
				code: "project_exists",
				message: `Project ${other.key} has the directory ${other.directory} already.`,
				next: `Move ${other.key} first with \`board project edit ${other.key} --dir DIR\`, or use another directory.`,
				details: { field: "dir", project: projectShape(other) },
			});
		}
		edited.directory = { from: project.directory, to: input.directory };
	}
	if (Object.keys(edited).length === 0) return projectShape(project);
	const row = await tx.project.update({
		where: { id: project.id },
		data: {
			...(edited.name === undefined ? {} : { name: edited.name.to }),
			...(edited.directory === undefined
				? {}
				: { directory: edited.directory.to }),
		},
	});
	await appendEvent(tx, now, {
		actor,
		kind: "project_edited",
		projectId: project.id,
		data: edited,
	});
	return projectShape(row);
}

/**
 * Removes a project that has no tasks (a key typed wrong at `add`), with its
 * milestones and events. A project with tasks stays: its keys may still be
 * held by agents, and a re-added key would hand them to other tasks.
 */
export async function removeProject(
	tx: Tx,
	now: Date,
	actor: string,
	project: ProjectRow,
): Promise<Project> {
	const tasks = await tx.task.count({ where: { project_id: project.id } });
	if (tasks > 0) {
		refuse({
			code: "invalid_transition",
			message: `${project.key} has ${tasks} task${tasks === 1 ? "" : "s"}; only a project with none is removed.`,
			next: "A project with tasks stays: its keys may still be held by agents.",
			details: { reason: "has_tasks" },
		});
	}
	// The project row goes before its events: the trigger lets an event go
	// only once its project is gone, and the foreign key from event to
	// project is checked at commit.
	await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
	await tx.project.delete({ where: { id: project.id } });
	await tx.event.deleteMany({ where: { project_id: project.id } });
	await tx.milestone.deleteMany({ where: { project_id: project.id } });
	await appendEvent(tx, now, {
		actor,
		kind: "project_removed",
		projectId: null,
		data: {
			key: project.key,
			name: project.name,
			directory: project.directory,
		},
	});
	return projectShape(project);
}
