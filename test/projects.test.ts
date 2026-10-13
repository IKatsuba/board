import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectAdd, withGit } from "../src/board.ts";
import { SystemClock, stamp } from "../src/clock.ts";
import type { Env } from "../src/env.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import type { GitRun, GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { addProject, NeedGit, resolveProject } from "../src/rules/projects.ts";
import { Store, type Tx } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";

/** Answers every call with one GitRun, and counts them. */
class FixedGit implements GitRunner {
	calls = 0;
	constructor(private run: GitRun) {}
	async commonDir(): Promise<GitRun> {
		this.calls++;
		return this.run;
	}
	set(run: GitRun) {
		this.run = run;
	}
}

const repoAt = (common: string): GitRun => ({
	kind: "exit",
	code: 0,
	stdout: `${common}\n`,
	stderr: "",
});
const notARepo: GitRun = {
	kind: "exit",
	code: 128,
	stdout: "",
	stderr:
		"fatal: not a git repository (or any of the parent directories): .git\n",
};

async function refusal(promise: Promise<unknown>): Promise<BoardError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Refusal) return error.error;
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("resolution", () => {
	let store: Store;

	beforeEach(async () => {
		store = await Store.memory(new FakeClock());
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: async (tx, now) => {
				await addProject(tx, now, "owner", {
					key: "APP",
					name: "app",
					directory: "/w/app",
				});
				await addProject(tx, now, "owner", {
					key: "PKG",
					name: "pkg",
					directory: "/w/app/pkg",
				});
				await addProject(tx, now, "owner", {
					key: "BRD",
					name: "board",
					directory: "/w/board",
				});
			},
		});
	});

	afterEach(() => store.close());

	const resolveIn = (scope: Parameters<typeof resolveProject>[1]) =>
		store.read((tx) => resolveProject(tx, scope));

	test("a named key wins over project and cwd, in any case", async () => {
		const p = await resolveIn({
			named: "brd",
			project: "APP",
			cwd: "/w/app",
			git: null,
		});
		expect(p.key).toBe("BRD");
	});

	test("then project, then the cwd", async () => {
		expect(
			(await resolveIn({ project: "app", cwd: "/w/app/pkg", git: null })).key,
		).toBe("APP");
		expect((await resolveIn({ cwd: "/w/app/pkg/src", git: null })).key).toBe(
			"PKG",
		);
		expect((await resolveIn({ cwd: "/w/app/src", git: null })).key).toBe("APP");
	});

	test("an unknown key is not_found with what: project, listing the keys", async () => {
		const error = await refusal(
			resolveIn({ project: "nope", cwd: "/w/app", git: null }),
		);
		expect(error).toMatchObject({
			code: "not_found",
			details: { what: "project", id: "NOPE" },
		});
		expect(error.next).toContain("APP /w/app");
	});

	test("a cwd in no project needs git, then matches git's root", async () => {
		await expect(
			resolveIn({ cwd: "/w/app-wt/sub", git: null }),
		).rejects.toBeInstanceOf(NeedGit);
		const p = await resolveIn({
			cwd: "/w/app-wt/sub",
			git: { git: "found", root: "/w/app", reason: null },
		});
		expect(p.key).toBe("APP");
	});

	test("no_project says what was looked at and how to add the project", async () => {
		const error = await refusal(
			resolveIn({
				cwd: "/work/app/server",
				git: { git: "found", root: "/work/app", reason: null },
			}),
		);
		expect(error.code).toBe("no_project");
		expect(error.message).toBe(
			"No project here. Looked at the working directory /work/app/server: no project's directory contains it. Looked at its git repository: the main repository is /work/app, and no project's directory contains it. Projects on this machine: APP /w/app, PKG /w/app/pkg, BRD /w/board.",
		);
		expect(error.next).toBe(
			"Pass `-p KEY` with one of the keys above, or ask the owner to choose a key and run `board project add KEY --dir /work/app`.",
		);
		expect(error.details).toMatchObject({
			cwd: "/work/app/server",
			git: "found",
			git_root: "/work/app",
		});
		expect((error.details as { projects: unknown[] }).projects).toHaveLength(3);
	});

	test("no_project carries git's reason when git failed, and the cwd as the directory", async () => {
		const error = await refusal(
			resolveIn({
				cwd: "/x",
				git: { git: "failed", root: null, reason: "git did not answer in 3 s" },
			}),
		);
		expect(error.details).toMatchObject({
			git: "failed",
			git_root: null,
			reason: "git did not answer in 3 s",
		});
		expect(error.message).toContain("git did not answer in 3 s");
		expect(error.next).toContain("--dir /x");
	});

	test("a bare repository's worktree is no_project", async () => {
		const error = await refusal(
			resolveIn({
				cwd: "/w/bare-wt",
				git: {
					git: "found",
					root: null,
					reason:
						"git names /w/app.git as the common directory, which is not a .git inside a checkout",
				},
			}),
		);
		expect(error.details).toMatchObject({ git: "found", git_root: null });
		expect(error.details).not.toHaveProperty("reason");
	});
});

describe("on a file", () => {
	let dir: string;
	let env: Env;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "board-projects-")));
		env = {
			dir: join(dir, "board"),
			file: join(dir, "board", "board.db"),
			boardDirSet: true,
		};
		mkdirSync(join(dir, "app", "sub"), { recursive: true });
		mkdirSync(join(dir, "other"));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const app = () => join(dir, "app");

	test("project add creates the board and stores the key in upper case", async () => {
		const project = await projectAdd(
			env,
			SystemClock,
			new FixedGit(notARepo),
			app(),
			{ actor: "owner", key: "app" },
		);
		expect(project).toMatchObject({
			key: "APP",
			name: "app",
			directory: app(),
		});
		expect(project.created_at).toBe(stamp(new Date(project.created_at)));
	});

	test("a relative --dir is taken from the cwd and stored real", async () => {
		const project = await projectAdd(
			env,
			SystemClock,
			new FixedGit(notARepo),
			dir,
			{ actor: "owner", key: "A", dir: "./app/../app", name: "My app" },
		);
		expect(project).toMatchObject({ directory: app(), name: "My app" });
	});

	test("refusals of the key, the directory and the name write nothing", async () => {
		const git = new FixedGit(notARepo);
		for (const key of ["1A", "A-B", "ABCDEFGHIJK", ""]) {
			expect(
				await refusal(
					projectAdd(env, SystemClock, git, app(), { actor: "owner", key }),
				),
			).toMatchObject({
				code: "invalid_argument",
				details: { field: "KEY" },
			});
		}
		expect(
			await refusal(
				projectAdd(env, SystemClock, git, app(), {
					actor: "owner",
					key: "A",
					dir: "missing",
				}),
			),
		).toMatchObject({ details: { field: "dir" } });
		expect(
			await refusal(
				projectAdd(env, SystemClock, git, "/", { actor: "owner", key: "A" }),
			),
		).toMatchObject({
			details: { field: "dir" },
		});
		expect(
			await refusal(
				projectAdd(env, SystemClock, git, app(), {
					actor: "owner",
					key: "A",
					name: "  ",
				}),
			),
		).toMatchObject({ details: { field: "name" } });
		expect((await refusal(Store.open(env, SystemClock))).code).toBe("no_board");
	});

	test("a refused add on an existing board keeps its sweep; on a fresh file it leaves the file empty", async () => {
		const clock = new FakeClock();
		const git = new FixedGit(notARepo);
		expect(
			await refusal(
				projectAdd(env, clock, git, app(), {
					actor: "owner",
					key: "A",
					name: " ",
				}),
			),
		).toMatchObject({ details: { field: "name" } });
		const fresh = new Database(env.file, { readonly: true });
		expect(
			fresh.query("SELECT count(*) AS n FROM sqlite_master").get(),
		).toEqual({ n: 0 });
		expect(fresh.query("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "wal",
		});
		fresh.close();

		await projectAdd(env, clock, git, app(), { actor: "owner", key: "APP" });
		const store = await Store.open(env, clock);
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: async (tx, now) => {
				const at = stamp(now);
				const task = await tx.task.create({
					data: {
						project_id: 1,
						number: 1,
						title: "t",
						status: "active",
						created_at: at,
						created_by: "o",
					},
				});
				await tx.claim.create({
					data: {
						task_id: task.id,
						holder: "@lead",
						since: at,
						until: stamp(new Date(now.getTime() + 60_000)),
					},
				});
			},
		});
		await store.close();
		clock.advance(5);
		for (const input of [
			{ actor: "owner", key: "B", name: " " },
			{ actor: "owner", key: "1B" },
			{ actor: "owner", key: "B", dir: "missing" },
		]) {
			expect(
				(await refusal(projectAdd(env, clock, git, join(dir, "other"), input)))
					.code,
			).toBe("invalid_argument");
		}
		const after = new Database(env.file, { readonly: true });
		expect(after.query("SELECT count(*) AS n FROM claim").get()).toEqual({
			n: 0,
		});
		expect(
			after
				.query("SELECT count(*) AS n FROM event WHERE kind = 'claim_expired'")
				.get(),
		).toEqual({ n: 1 });
		after.close();
	});

	test("a subdirectory or a worktree of a checkout is refused naming the root", async () => {
		const git = new FixedGit(repoAt(join(app(), ".git")));
		const error = await refusal(
			projectAdd(env, SystemClock, git, join(app(), "sub"), {
				actor: "owner",
				key: "A",
			}),
		);
		expect(error).toMatchObject({
			code: "invalid_argument",
			details: { field: "dir" },
		});
		expect(error.next).toContain(`--dir ${app()}`);
		const root = await projectAdd(env, SystemClock, git, app(), {
			actor: "owner",
			key: "A",
		});
		expect(root.directory).toBe(app());
	});

	test("a layout with no root is not supported, and a git that cannot answer is refused with its reason", async () => {
		const bare = new FixedGit(repoAt(join(dir, "other.git")));
		expect(
			(
				await refusal(
					projectAdd(env, SystemClock, bare, join(dir, "other"), {
						actor: "owner",
						key: "A",
					}),
				)
			).message,
		).toContain("does not support");
		for (const run of [
			{ kind: "missing" },
			{ kind: "timeout", seconds: 3 },
		] as GitRun[]) {
			const error = await refusal(
				projectAdd(env, SystemClock, new FixedGit(run), app(), {
					actor: "owner",
					key: "A",
				}),
			);
			expect(error).toMatchObject({
				code: "invalid_argument",
				details: { field: "dir" },
			});
			expect(error.details).toHaveProperty("reason");
		}
	});

	test("a taken key (any case) or directory is project_exists", async () => {
		const git = new FixedGit(notARepo);
		await projectAdd(env, SystemClock, git, app(), {
			actor: "owner",
			key: "APP",
		});
		expect(
			await refusal(
				projectAdd(env, SystemClock, git, join(dir, "other"), {
					actor: "owner",
					key: "app",
				}),
			),
		).toMatchObject({
			code: "project_exists",
			details: { field: "KEY", project: { key: "APP" } },
		});
		expect(
			await refusal(
				projectAdd(env, SystemClock, git, app(), { actor: "owner", key: "B" }),
			),
		).toMatchObject({
			code: "project_exists",
			details: { field: "dir" },
		});
	});

	test("project ls: counts, the current milestone, and here", async () => {
		const git = new FixedGit(notARepo);
		await projectAdd(env, SystemClock, git, app(), {
			actor: "owner",
			key: "APP",
		});
		await projectAdd(env, SystemClock, git, join(dir, "other"), {
			actor: "owner",
			key: "OTH",
		});
		const store = await Store.open(env, SystemClock);
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: async (tx, now) => {
				const at = stamp(now);
				await tx.milestone.create({
					data: {
						project_id: 1,
						name: "v1",
						delivers: "x",
						position: 1,
						created_at: at,
						created_by: "o",
					},
				});
				await tx.milestone.create({
					data: {
						project_id: 1,
						name: "v2",
						delivers: "y",
						position: 2,
						created_at: at,
						created_by: "o",
					},
				});
				const task = (
					number: number,
					status: string,
					milestone_id: number | null,
				) =>
					tx.task.create({
						data: {
							project_id: 1,
							number,
							title: "t",
							status,
							milestone_id,
							created_at: at,
							created_by: "o",
						},
					});
				await task(1, "done", 1);
				await task(2, "cancelled", 1);
				await task(3, "ready", 2);
				await task(4, "backlog", 2);
				await task(5, "active", null);
			},
		});
		const board = new Board(store);
		const runner = new FixedGit(notARepo);
		const list = await board.projectList(new Place(join(app(), "sub"), runner));
		expect(runner.calls).toBe(0);
		expect(list).toEqual({
			projects: [
				{
					project: expect.objectContaining({ key: "APP" }),
					open: 3,
					closed: 2,
					current: { name: "v2", position: 2, of: 2, left: 2 },
				},
				{
					project: expect.objectContaining({ key: "OTH" }),
					open: 0,
					closed: 0,
					current: null,
				},
			],
			here: "APP",
		});
		const elsewhere = await board.projectList(new Place(dir, runner));
		expect(elsewhere.here).toBeNull();
		expect(runner.calls).toBe(1);
		await board.close();
	});

	test("a project added by another connection is seen by the next call, through git's retry", async () => {
		const git = new FixedGit(notARepo);
		await projectAdd(env, SystemClock, git, join(dir, "other"), {
			actor: "owner",
			key: "OTH",
		});
		const store = await Store.open(env, SystemClock);
		const board = new Board(store);
		const worktree = new FixedGit(repoAt(join(app(), ".git")));
		const place = new Place(join(dir, "app-wt"), worktree);
		expect((await board.projectList(place)).here).toBeNull();
		await projectAdd(env, SystemClock, git, app(), {
			actor: "owner",
			key: "APP",
		});
		expect((await board.projectList(place)).here).toBe("APP");
		expect(worktree.calls).toBe(2);
		await board.close();
	});

	test("the retry resolves against the rows it reads, a project removed between calls included", async () => {
		await projectAdd(env, SystemClock, new FixedGit(notARepo), app(), {
			actor: "owner",
			key: "APP",
		});
		const store = await Store.open(env, SystemClock);
		const runner = new FixedGit(repoAt(join(app(), ".git")));
		const place = new Place(join(dir, "app-wt"), runner);
		const resolveHere = (git: Parameters<typeof resolveProject>[1]["git"]) =>
			store.read((tx: Tx) => resolveProject(tx, { cwd: place.cwd, git }));
		expect((await withGit(place, resolveHere)).key).toBe("APP");
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: async (tx) => {
				await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
				await tx.project.delete({ where: { key: "APP" } });
				await tx.event.deleteMany({ where: { project_id: 1 } });
			},
		});
		expect((await refusal(withGit(place, resolveHere))).code).toBe(
			"no_project",
		);
		expect(runner.calls).toBe(2);
		await store.close();
	});
});
