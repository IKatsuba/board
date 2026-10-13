// The second party of the Store tests: a separate process, because the lock
// tests are about processes, and a Worker would share this one.
//   hold FILE MS          take the write lock, say "held", keep it MS ms
//   lock FILE             say "free" or SQLite's code, without waiting
//   add DIR KEY DIRECTORY START_AT   a first `project add`, started at START_AT
//   write FILE ACTOR      one empty write; print the ids its sweep appended
//   tasks FILE ACTOR N    N task_adds in project A
//   claim FILE KEY HOLDER START_AT   one task_claim at START_AT; prints its outcome
import { Database } from "bun:sqlite";
import { Board } from "../../src/board.ts";
import { SystemClock, stamp } from "../../src/clock.ts";
import { Refusal } from "../../src/errors.ts";
import { ProcessGitRunner } from "../../src/place/git.ts";
import { Place } from "../../src/place/place.ts";
import { Store } from "../../src/store/store.ts";

const [mode, ...args] = process.argv.slice(2);

if (mode === "hold") {
	const [file, ms] = args as [string, string];
	const db = new Database(file);
	db.run("BEGIN IMMEDIATE");
	console.log("held");
	await Bun.sleep(Number(ms));
	db.run("ROLLBACK");
	db.close();
} else if (mode === "lock") {
	const db = new Database(args[0] as string);
	try {
		db.run("BEGIN IMMEDIATE");
		db.run("ROLLBACK");
		console.log("free");
	} catch (error) {
		console.log((error as { code?: string }).code);
	}
	db.close();
} else if (mode === "add") {
	const [dir, key, directory, startAt] = args as [
		string,
		string,
		string,
		string,
	];
	await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));
	try {
		await Store.create(
			{ dir, file: `${dir}/board.db`, boardDirSet: true },
			SystemClock,
			"owner",
			async (tx, now) => {
				const project = await tx.project.create({
					data: {
						key,
						name: key,
						directory,
						created_at: stamp(now),
						created_by: "owner",
					},
				});
				await tx.event.create({
					data: {
						at: stamp(now),
						actor: "owner",
						kind: "project_added",
						project_id: project.id,
						data: JSON.stringify({ key, name: key, directory }),
					},
				});
			},
		);
		console.log("added");
	} catch (error) {
		console.log(error instanceof Refusal ? error.error.code : String(error));
	}
} else if (mode === "write") {
	const [file, actor] = args as [string, string];
	const store = await Store.open(
		{ dir: "", file, boardDirSet: true },
		SystemClock,
	);
	const { swept } = await store.write({
		actor,
		resolve: async () => null,
		apply: async () => null,
	});
	console.log(JSON.stringify(swept));
	await store.close();
} else if (mode === "tasks") {
	const [file, actor, n] = args as [string, string, string];
	const store = await Store.open(
		{ dir: "", file, boardDirSet: true },
		SystemClock,
	);
	const board = new Board(store);
	const ctx = new Place("/", new ProcessGitRunner());
	for (let i = 0; i < Number(n); i++) {
		await board.taskAdd(ctx, { actor, project: "A", title: `${actor} ${i}` });
	}
	await board.close();
} else if (mode === "claim") {
	const [file, key, holder, startAt] = args as [string, string, string, string];
	const store = await Store.open(
		{ dir: "", file, boardDirSet: true },
		SystemClock,
	);
	const board = new Board(store);
	await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));
	try {
		await board.taskClaim({ actor: holder, key, minutes: 30 });
		console.log("claimed");
	} catch (error) {
		console.log(error instanceof Refusal ? error.error.code : String(error));
	}
	await board.close();
}
