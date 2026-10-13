import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectAdd } from "../src/board.ts";
import { SystemClock, stamp } from "../src/clock.ts";
import { type BoardError, Refusal } from "../src/errors.ts";
import type { GitRunner } from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";

const HOLDER = join(import.meta.dir, "helpers", "holder.ts");
const noGit: GitRunner = {
	commonDir: async () => {
		throw new Error("git must not be asked");
	},
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

let clock: FakeClock;
let store: Store;
let board: Board;
const inA: Place = new Place("/w/a", noGit);

beforeEach(async () => {
	clock = new FakeClock();
	store = await Store.memory(clock);
	board = new Board(store);
	await store.write({
		actor: "owner",
		resolve: async () => null,
		apply: (tx, now) =>
			addProject(tx, now, "owner", { key: "A", name: "a", directory: "/w/a" }),
	});
	for (const title of ["one", "two", "three"]) {
		await board.taskAdd(inA, { actor: "main", title });
	}
});

afterEach(() => board.close());

const kinds = (ids: number[]) =>
	store.read(async (tx) =>
		(
			await tx.event.findMany({
				where: { id: { in: ids } },
				orderBy: { id: "asc" },
			})
		).map((e) => [e.kind, JSON.parse(e.data)]),
	);

describe("task_claim", () => {
	test("takes a ready task: active, the claim, its event", async () => {
		const got = await board.taskClaim({
			actor: "main",
			key: "a-1",
			minutes: 90,
			holder: "@lead",
			directory: "/w/a-wt",
			branch: "feat/x",
		});
		expect(got.claim).toEqual({
			key: "A-1",
			title: "one",
			holder: "@lead",
			since: "2026-10-12T09:00:00.000Z",
			until: "2026-10-12T10:30:00.000Z",
			minutes_left: 90,
			directory: "/w/a-wt",
			branch: "feat/x",
		});
		expect(got.task).toMatchObject({
			key: "A-1",
			status: "active",
			holder: "@lead",
			ready: false,
		});
		expect(await kinds(got.events)).toEqual([
			[
				"claimed",
				{
					holder: "@lead",
					since: "2026-10-12T09:00:00.000Z",
					until: "2026-10-12T10:30:00.000Z",
					directory: "/w/a-wt",
					branch: "feat/x",
				},
			],
		]);
		const plain = await board.taskClaim({
			actor: "main",
			key: "A-2",
			minutes: 5,
		});
		expect(plain.claim).toMatchObject({
			holder: "main",
			directory: null,
			branch: null,
		});
	});

	test("a live claim is claim_held for anyone, its holder included", async () => {
		await board.taskClaim({
			actor: "main",
			key: "A-1",
			minutes: 30,
			holder: "@lead",
		});
		for (const actor of ["@lead", "@other"]) {
			const error = await refusal(
				board.taskClaim({ actor, key: "A-1", minutes: 30 }),
			);
			expect(error).toMatchObject({
				code: "claim_held",
				details: { claim: { key: "A-1", holder: "@lead", minutes_left: 30 } },
			});
		}
	});

	test("not_ready says why: status, question or waits", async () => {
		await store.write({
			actor: "test",
			resolve: async () => null,
			apply: async (tx, now) => {
				await tx.task.update({ where: { id: 1 }, data: { status: "backlog" } });
				await tx.question.create({
					data: {
						task_id: 2,
						text: "q",
						options: JSON.stringify([{ label: "a" }, { label: "b" }]),
						recommended: 1,
						asked_by: "x",
						asked_at: stamp(now),
					},
				});
			},
		});
		await board.taskAdd(inA, { actor: "main", title: "waits", waits: ["A-3"] });
		const reasons = [];
		for (const key of ["A-1", "A-2", "A-4"]) {
			const error = await refusal(
				board.taskClaim({ actor: "main", key, minutes: 10 }),
			);
			expect(error.code).toBe("not_ready");
			expect(error.details).toHaveProperty("task.key", key);
			reasons.push((error.details as { reason: string }).reason);
		}
		expect(reasons).toEqual(["status", "question", "waits"]);
	});

	test("a backlog task with an open question is not_ready by status, and stays so once it is withdrawn", async () => {
		await store.write({
			actor: "test",
			resolve: async () => null,
			apply: async (tx, now) => {
				await tx.task.update({ where: { id: 1 }, data: { status: "backlog" } });
				await tx.question.create({
					data: {
						task_id: 1,
						text: "q",
						options: JSON.stringify([{ label: "a" }, { label: "b" }]),
						recommended: 1,
						asked_by: "x",
						asked_at: stamp(now),
					},
				});
			},
		});
		const blocked = await refusal(
			board.taskClaim({ actor: "main", key: "A-1", minutes: 5 }),
		);
		expect(blocked).toMatchObject({
			code: "not_ready",
			details: { reason: "status", task: { status: "blocked" } },
		});
		expect(blocked.message).toContain("backlog");
		await store.write({
			actor: "test",
			resolve: async () => null,
			apply: (tx) =>
				tx.question.update({ where: { id: 1 }, data: { status: "withdrawn" } }),
		});
		expect(
			await refusal(board.taskClaim({ actor: "main", key: "A-1", minutes: 5 })),
		).toMatchObject({
			details: { reason: "status", task: { status: "backlog" } },
		});
	});

	test("a question with open waits says both must clear", async () => {
		const waiting = await board.taskAdd(inA, {
			actor: "main",
			title: "w",
			waits: ["A-3"],
		});
		await store.write({
			actor: "test",
			resolve: async () => null,
			apply: (tx, now) =>
				tx.question.create({
					data: {
						task_id: 4,
						text: "q",
						options: JSON.stringify([{ label: "a" }, { label: "b" }]),
						recommended: 1,
						asked_by: "x",
						asked_at: stamp(now),
					},
				}),
		});
		const error = await refusal(
			board.taskClaim({ actor: "main", key: waiting.task.key, minutes: 5 }),
		);
		expect(error).toMatchObject({ details: { reason: "question" } });
		expect(error.next).toContain("everything it waits for");
		await store.write({
			actor: "test",
			resolve: async () => null,
			apply: (tx) =>
				tx.question.update({ where: { id: 1 }, data: { status: "withdrawn" } }),
		});
		expect(
			await refusal(
				board.taskClaim({ actor: "main", key: waiting.task.key, minutes: 5 }),
			),
		).toMatchObject({ details: { reason: "waits" } });
	});

	test("a lapsed claim is swept and the task retaken in one call", async () => {
		await board.taskClaim({
			actor: "main",
			key: "A-1",
			minutes: 10,
			holder: "@dead",
		});
		clock.advance(10);
		const got = await board.taskClaim({
			actor: "main",
			key: "A-1",
			minutes: 10,
			holder: "@new",
		});
		expect(got.claim.holder).toBe("@new");
		expect((await kinds(got.events)).map(([kind]) => kind)).toEqual([
			"claim_expired",
			"claimed",
		]);
	});

	test("minutes are 1 to 1440; the actor board and unknown keys are refused", async () => {
		for (const minutes of [0, 1441, 1.5]) {
			expect(
				await refusal(board.taskClaim({ actor: "main", key: "A-1", minutes })),
			).toMatchObject({
				code: "invalid_argument",
				details: { field: "minutes" },
			});
		}
		expect(
			await refusal(
				board.taskClaim({ actor: "board", key: "A-1", minutes: 5 }),
			),
		).toMatchObject({
			details: { field: "actor" },
		});
		expect(
			await refusal(board.taskClaim({ actor: "main", key: "A-9", minutes: 5 })),
		).toMatchObject({
			code: "not_found",
			details: { what: "task", id: "A-9" },
		});
		expect(
			await refusal(board.taskClaim({ actor: "main", key: "Z-1", minutes: 5 })),
		).toMatchObject({
			details: { what: "project", id: "Z" },
		});
	});
});

describe("task_extend and task_release", () => {
	beforeEach(async () => {
		await board.taskClaim({
			actor: "main",
			key: "A-1",
			minutes: 30,
			holder: "@lead",
		});
	});

	test("extend sets the end to now plus minutes", async () => {
		clock.advance(20);
		const got = await board.taskExtend({
			actor: "@lead",
			key: "A-1",
			holder: "@lead",
			minutes: 60,
		});
		expect(got.claim).toMatchObject({
			until: "2026-10-12T10:20:00.000Z",
			minutes_left: 60,
		});
		expect(await kinds(got.events)).toEqual([
			[
				"claim_extended",
				{
					holder: "@lead",
					until: {
						from: "2026-10-12T09:30:00.000Z",
						to: "2026-10-12T10:20:00.000Z",
					},
				},
			],
		]);
	});

	test("release drops the claim and readies the task, with the note", async () => {
		const got = await board.taskRelease({
			actor: "main",
			key: "A-1",
			holder: "@lead",
			note: "done for now",
		});
		expect(got.task).toMatchObject({
			status: "ready",
			holder: null,
			ready: true,
		});
		expect(got.released).toMatchObject({ key: "A-1", holder: "@lead" });
		expect(await kinds(got.events)).toEqual([
			[
				"claim_released",
				{ holder: "@lead", reason: "release", note: "done for now" },
			],
		]);
		const again = await board.taskClaim({
			actor: "main",
			key: "A-1",
			minutes: 5,
		});
		expect(again.claim.holder).toBe("main");
		const plain = await board.taskRelease({
			actor: "main",
			key: "A-1",
			holder: "main",
		});
		expect((await kinds(plain.events))[0]?.[1]).toMatchObject({ note: null });
	});

	test("another holder is claim_held, with the claim in force", async () => {
		for (const op of [
			board.taskExtend({
				actor: "x",
				key: "A-1",
				holder: "@other",
				minutes: 5,
			}),
			board.taskRelease({ actor: "x", key: "A-1", holder: "@other" }),
		]) {
			expect(await refusal(op)).toMatchObject({
				code: "claim_held",
				details: { claim: { holder: "@lead" } },
			});
		}
	});

	test("no claim, or a lapsed one, is not_claimed; a lapsed one is not revived", async () => {
		for (const op of [
			() =>
				board.taskExtend({
					actor: "x",
					key: "A-2",
					holder: "@lead",
					minutes: 5,
				}),
			() => board.taskRelease({ actor: "x", key: "A-2", holder: "@lead" }),
		]) {
			expect((await refusal(op())).code).toBe("not_claimed");
		}
		clock.advance(30);
		expect(
			(
				await refusal(
					board.taskExtend({
						actor: "@lead",
						key: "A-1",
						holder: "@lead",
						minutes: 5,
					}),
				)
			).code,
		).toBe("not_claimed");
		const read = await board.taskRead({ key: "A-1" });
		expect(read.task).toMatchObject({ status: "ready", claim: null });
		expect(read.events.map((e) => e.kind)).toEqual([
			"task_added",
			"claimed",
			"claim_expired",
		]);
	});
});

describe("on a file", () => {
	let dir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "board-claims-")));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("two processes racing for one claim: one claims, the other is claim_held", async () => {
		const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
		const runner: GitRunner = {
			commonDir: async () => ({
				kind: "exit",
				code: 128,
				stdout: "",
				stderr: "fatal: not a git repository\n",
			}),
		};
		await projectAdd(env, SystemClock, runner, dir, {
			actor: "owner",
			key: "A",
		});
		const opened = new Board(await Store.open(env, SystemClock));
		await opened.taskAdd(new Place(dir, runner), {
			actor: "main",
			title: "contested",
		});
		await opened.close();
		for (let trial = 0; trial < 5; trial++) {
			const at = String(Date.now() + 300);
			const children = ["@one", "@two"].map((holder) =>
				Bun.spawn(
					[process.execPath, HOLDER, "claim", env.file, "A-1", holder, at],
					{
						stdout: "pipe",
						stderr: "inherit",
					},
				),
			);
			const outcomes = await Promise.all(
				children.map((c) => new Response(c.stdout).text()),
			);
			expect(outcomes.map((o) => o.trim()).sort()).toEqual([
				"claim_held",
				"claimed",
			]);
			const board2 = new Board(await Store.open(env, SystemClock));
			const holder = (await board2.taskRead({ key: "A-1" })).task
				.holder as string;
			await board2.taskRelease({ actor: "test", key: "A-1", holder });
			await board2.close();
		}
	}, 30_000);
});
