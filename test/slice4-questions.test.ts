import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { SystemClock } from "../src/clock.ts";
import { Refusal } from "../src/errors.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";
import { FakeClock } from "./helpers/clock.ts";

const ctx = new Place("/a", {
	async commonDir() {
		throw new Error("Unexpected git");
	},
});
const options = [{ label: "First" }, { label: "Second" }];
const ask = (board: Board, key: string) =>
	board.questionAsk({
		actor: "tester",
		key,
		text: "Which?",
		options,
		recommended: 1,
	});

async function fixture() {
	const clock = new FakeClock();
	const store = await Store.memory(clock);
	await store.write({
		actor: "owner",
		resolve: async () => null,
		apply: (tx, now) =>
			addProject(tx, now, "owner", { key: "A", name: "A", directory: "/a" }),
	});
	const board = new Board(store);
	await board.taskAdd(ctx, { actor: "tester", title: "Task" });
	return { clock, store, board };
}

test("questions preserve a live claim; answering after expiry emits expiry once before the answer", async () => {
	const { clock, store, board } = await fixture();
	try {
		const claimed = await board.taskClaim({
			actor: "worker",
			key: "A-1",
			minutes: 1,
		});
		const asked = await ask(board, "A-1");
		expect(asked.task).toMatchObject({
			status: "blocked",
			holder: "worker",
			ready: false,
		});
		expect((await board.taskRead({ key: "A-1" })).task.claim).toEqual(
			claimed.claim,
		);
		clock.advance(1);
		const before = await store.read((tx) => tx.event.count());
		expect(
			(await board.questionList(ctx, { project: "*" })).questions.map(
				(q) => q.id,
			),
		).toEqual(["Q1"]);
		expect(await store.read((tx) => tx.event.count())).toBe(before);
		const answer = await board.questionAnswer({
			actor: "main",
			question: "Q1",
			as: "delegate",
			text: "Custom answer",
		});
		expect(answer.task).toMatchObject({
			status: "ready",
			holder: null,
			ready: true,
		});
		const events = await store.read((tx) =>
			tx.event.findMany({
				where: { id: { in: answer.events } },
				orderBy: { id: "asc" },
			}),
		);
		expect(events.map((e) => e.kind)).toEqual([
			"claim_expired",
			"question_answered",
		]);
		expect(events[0]).toMatchObject({ actor: "board" });
		expect(JSON.parse(events[0]?.data ?? "null")).toMatchObject({
			holder: "worker",
			by: "main",
		});
		expect(answer.question.answer).toMatchObject({
			choice: null,
			text: "Custom answer",
			as: "delegate",
		});
		await board.questionValidate({ actor: "owner", question: "Q1" });
		expect(
			await store.read((tx) =>
				tx.event.count({ where: { kind: "claim_expired" } }),
			),
		).toBe(1);
	} finally {
		await board.close();
	}
});

test("concurrent validation and owner override commit one decision and retain the replaced answer", async () => {
	const { store, board } = await fixture();
	try {
		await ask(board, "A-1");
		const delegate = await board.questionAnswer({
			actor: "delegate",
			question: "Q1",
			as: "delegate",
			choice: 1,
			text: "Previous",
		});
		const decisions = await Promise.allSettled([
			board.questionAnswer({
				actor: "owner",
				question: "Q1",
				as: "owner",
				text: "Replacement",
			}),
			board.questionValidate({ actor: "checker", question: "Q1" }),
		]);
		expect(decisions.filter((d) => d.status === "fulfilled")).toHaveLength(1);
		const rejected = decisions.find((d) => d.status === "rejected");
		expect(rejected?.status).toBe("rejected");
		if (rejected?.status !== "rejected") throw new Error("Expected refusal");
		expect(rejected.reason).toBeInstanceOf(Refusal);
		const question = (await board.questionList(ctx, { state: "all" }))
			.questions[0];
		const events = await store.read((tx) =>
			tx.event.findMany({
				where: { id: { gt: delegate.events.at(-1) } },
				orderBy: { id: "asc" },
			}),
		);
		expect(events).toHaveLength(1);
		if (question?.answer?.as === "owner") {
			expect(question.answer).toMatchObject({
				choice: null,
				text: "Replacement",
				by: "owner",
			});
			expect(question.validated).toBeNull();
			expect(rejected.reason.error.code).toBe("invalid_transition");
			expect(JSON.parse(events[0]?.data ?? "null").overrides).toEqual(
				delegate.question.answer,
			);
		} else {
			expect(question?.answer).toEqual(delegate.question.answer);
			expect(question?.validated).toMatchObject({ by: "checker" });
			expect(rejected.reason.error.code).toBe("already_answered");
			expect(events[0]?.kind).toBe("question_validated");
		}
		expect(
			(await board.questionList(ctx, { project: "*", state: "to_validate" }))
				.questions,
		).toEqual([]);
	} finally {
		await board.close();
	}
});

test("two Bun writers asking on different projects share one question sequence", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice4-question-writers-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	const children: Array<
		ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
	> = [];
	try {
		await Store.create(env, SystemClock, "owner", async (tx, now) => {
			for (const key of ["A", "B"])
				await addProject(tx, now, "owner", {
					key,
					name: key,
					directory: `/${key.toLowerCase()}`,
				});
		});
		const board = new Board(await Store.open(env, SystemClock));
		try {
			for (const project of ["A", "B"])
				await board.taskAdd(ctx, { actor: "owner", project, title: "Task" });
		} finally {
			await board.close();
		}
		const script = join(dir, "writer.ts");
		writeFileSync(
			script,
			`import { Board } from ${JSON.stringify(join(import.meta.dir, "..", "src", "board.ts"))};\nimport { Store } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store", "store.ts"))};\nimport { SystemClock } from ${JSON.stringify(join(import.meta.dir, "..", "src", "clock.ts"))};\nconst [file,key,at]=process.argv.slice(2);\nconst board=new Board(await Store.open({dir:"",file,boardDirSet:true},SystemClock));\ntry {await Bun.sleep(Math.max(0,Number(at)-Date.now())); console.log(JSON.stringify(await board.questionAsk({actor:key,key,text:"Which?",options:[{label:"First"},{label:"Second"}],recommended:1})));} finally {await board.close();}\n`,
		);
		const at = String(Date.now() + 500);
		for (const key of ["A-1", "B-1"])
			children.push(
				Bun.spawn([process.execPath, script, env.file, key, at], {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
		const results = await Promise.all(
			children.map(async (child) => ({
				code: await child.exited,
				out: await new Response(child.stdout).text(),
				err: await new Response(child.stderr).text(),
			})),
		);
		expect(results.map(({ code, err }) => ({ code, err }))).toEqual([
			{ code: 0, err: "" },
			{ code: 0, err: "" },
		]);
		expect(results.map((r) => JSON.parse(r.out).question.id).sort()).toEqual([
			"Q1",
			"Q2",
		]);
		expect(results.map((r) => JSON.parse(r.out).task.status)).toEqual([
			"blocked",
			"blocked",
		]);
		const store = await Store.open(env, SystemClock);
		try {
			expect(await store.read((tx) => tx.question.count())).toBe(2);
			expect(
				await store.read((tx) =>
					tx.event.count({ where: { kind: "question_asked" } }),
				),
			).toBe(2);
		} finally {
			await store.close();
		}
	} finally {
		for (const child of children) {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);
