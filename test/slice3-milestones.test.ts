import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../src/board.ts";
import { SystemClock } from "../src/clock.ts";
import { Refusal } from "../src/errors.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";

const ctx = new Place("/test", {
	async commonDir() {
		throw new Error("Unexpected git");
	},
});

async function fixture() {
	const store = await Store.memory({
		now: () => new Date("2026-10-13T12:00:00.000Z"),
	});
	await store.write({
		actor: "owner",
		resolve: async () => null,
		apply: (tx, now) =>
			addProject(tx, now, "owner", {
				key: "A",
				name: "Test",
				directory: "/test",
			}),
	});
	return { store, board: new Board(store) };
}

test("a refused combined rename, description and move changes no chain rows or history", async () => {
	const { store, board } = await fixture();
	try {
		for (const name of ["v1", "v2", "v3"])
			await board.milestoneAdd(ctx, { actor: "tester", name, delivers: name });
		const snapshot = () =>
			store.read(async (tx) => ({
				rows: await tx.milestone.findMany({ orderBy: { id: "asc" } }),
				events: await tx.event.findMany({ orderBy: { id: "asc" } }),
			}));
		const before = await snapshot();
		for (const anchor of ["v9", "V1"]) {
			try {
				await board.milestoneUpdate(ctx, {
					actor: "tester",
					milestone: "v1",
					name: "renamed",
					delivers: "Changed",
					before: anchor,
				});
				throw new Error("Expected refusal");
			} catch (error) {
				expect(error).toBeInstanceOf(Refusal);
				if (!(error instanceof Refusal)) throw error;
				expect(error.error.code).toBe(
					anchor === "v9" ? "not_found" : "invalid_argument",
				);
			}
			expect(await snapshot()).toEqual(before);
		}
	} finally {
		await board.close();
	}
});

test("renaming affects task references and deleting an empty milestone preserves its event history", async () => {
	const { store, board } = await fixture();
	try {
		const name = "a".repeat(40);
		await board.milestoneAdd(ctx, {
			actor: "tester",
			name,
			delivers: "Boundary name",
		});
		await board.taskAdd(ctx, {
			actor: "tester",
			title: "Linked",
			milestone: name,
		});
		await board.milestoneUpdate(ctx, {
			actor: "tester",
			milestone: name,
			name: "renamed",
		});
		expect((await board.taskRead({ key: "A-1" })).task.milestone).toBe(
			"renamed",
		);
		const empty = await board.milestoneAdd(ctx, {
			actor: "tester",
			name: "empty",
			delivers: "Empty",
		});
		const rows = await store.read((tx) =>
			tx.event.findMany({ where: { id: { in: empty.events } } }),
		);
		const id = rows[0]?.milestone_id;
		const removed = await board.milestoneDelete(ctx, {
			actor: "tester",
			milestone: "EMPTY",
		});
		expect(removed.chain).toEqual(["renamed"]);
		const history = await store.read((tx) =>
			tx.event.findMany({
				where: { milestone_id: id },
				orderBy: { id: "asc" },
			}),
		);
		expect(history.map((event) => event.kind)).toEqual([
			"milestone_added",
			"milestone_deleted",
		]);
		expect(history.map((event) => JSON.parse(event.data).name)).toEqual([
			"empty",
			"empty",
		]);
		expect(
			await store.read((tx) =>
				tx.milestone.count({ where: { name: "empty" } }),
			),
		).toBe(0);
	} finally {
		await board.close();
	}
});

test("two writer processes inserting before one anchor retain both milestones and contiguous positions", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice3-chain-writers-");
	const env = { dir, file: join(dir, "board.db"), boardDirSet: true };
	const children: Array<
		ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
	> = [];
	try {
		await Store.create(env, SystemClock, "owner", (tx, now) =>
			addProject(tx, now, "owner", { key: "A", name: "Test", directory: dir }),
		);
		const board = new Board(await Store.open(env, SystemClock));
		try {
			await board.milestoneAdd(ctx, {
				actor: "owner",
				project: "A",
				name: "anchor",
				delivers: "Anchor",
			});
		} finally {
			await board.close();
		}
		const script = join(dir, "writer.ts");
		writeFileSync(
			script,
			`import {Board} from ${JSON.stringify(join(import.meta.dir, "..", "src", "board.ts"))};\nimport {Store} from ${JSON.stringify(join(import.meta.dir, "..", "src", "store", "store.ts"))};\nimport {SystemClock} from ${JSON.stringify(join(import.meta.dir, "..", "src", "clock.ts"))};\nimport {Place} from ${JSON.stringify(join(import.meta.dir, "..", "src", "place", "place.ts"))};\nconst [file,name,at]=process.argv.slice(2);\nconst board=new Board(await Store.open({dir:"",file,boardDirSet:true},SystemClock));\ntry {await Bun.sleep(Math.max(0,Number(at)-Date.now())); await board.milestoneAdd(new Place("/",{commonDir:async()=>{throw new Error("Unexpected git")}}),{actor:name,project:"A",name,delivers:name,before:"anchor"});} finally {await board.close();}\n`,
		);
		const at = String(Date.now() + 500);
		for (const name of ["first", "second"])
			children.push(
				Bun.spawn([process.execPath, script, env.file, name, at], {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
		expect(
			await Promise.all(
				children.map(async (child) => ({
					code: await child.exited,
					err: await new Response(child.stderr).text(),
				})),
			),
		).toEqual([
			{ code: 0, err: "" },
			{ code: 0, err: "" },
		]);
		const opened = await Store.open(env, SystemClock);
		try {
			const rows = await opened.read((tx) =>
				tx.milestone.findMany({ orderBy: { position: "asc" } }),
			);
			expect(rows.map((row) => row.position)).toEqual([1, 2, 3]);
			expect(rows.map((row) => row.name).sort()).toEqual([
				"anchor",
				"first",
				"second",
			]);
			expect(rows[2]?.name).toBe("anchor");
			expect(
				await opened.read((tx) =>
					tx.event.count({ where: { kind: "milestone_added" } }),
				),
			).toBe(3);
		} finally {
			await opened.close();
		}
	} finally {
		for (const child of children) {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);
