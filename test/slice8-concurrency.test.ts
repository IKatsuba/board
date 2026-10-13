import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorShape, outputs } from "../src/schemas.ts";
import { expectValid } from "./helpers/schema.ts";

const main = join(import.meta.dir, "..", "src", "main.ts");

function fixture(binary?: string) {
	const dir = realpathSync(
		mkdtempSync(join(tmpdir(), "board-slice8-concurrency-")),
	);
	const repo = join(dir, "repo");
	mkdirSync(repo);
	const boardDir = join(dir, "board");
	const children: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>[] = [];
	const start = (argv: string[]) => {
		const child = Bun.spawn(
			[...(binary ? [binary] : [process.execPath, main]), ...argv],
			{
				cwd: repo,
				env: { ...process.env, BOARD_DIR: boardDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		children.push(child);
		return child;
	};
	const finish = async (child: ReturnType<typeof start>) => {
		const [code, out, err] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, out, err };
	};
	const json = async (name: keyof typeof outputs, argv: string[]) => {
		const r = await finish(start([...argv, "--json"]));
		expect(r).toMatchObject({ code: 0, err: "" });
		const value = JSON.parse(r.out);
		expectValid(outputs[name], value);
		return value;
	};
	const cleanup = async () => {
		for (const child of children) {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		}
		rmSync(dir, { recursive: true, force: true });
	};
	return { dir, repo, boardDir, start, finish, json, cleanup };
}

test("concurrent removals, additions and disjoint field edits all survive on one task", async () => {
	const f = fixture();
	const a = ["--actor", "seed"];
	try {
		await f.json("project add", ["project", "add", "T", ...a]);
		for (const title of ["Target", "Remove", "Keep", "Add"])
			await f.json("add", ["add", ...a, "--title", title]);
		await f.json("edit", ["edit", "T-1", ...a, "--waits-add", "T-2,T-3"]);
		const commands = [
			["edit", "T-1", "--actor", "@remove", "--waits-remove", "T-2"],
			["edit", "T-1", "--actor", "@add", "--waits-add", "T-4"],
			["edit", "T-1", "--actor", "@title", "--title", "Edited title"],
			["edit", "T-1", "--actor", "@body", "--body", "Edited body"],
			["edit", "T-1", "--actor", "@priority", "--priority", "high"],
		];
		const children = commands.map((argv) => f.start([...argv, "--json"]));
		const results = await Promise.all(children.map(f.finish));
		for (const r of results) {
			expect(r).toMatchObject({ code: 0, err: "" });
			expectValid(outputs.edit, JSON.parse(r.out));
		}
		const shown = await f.json("show", ["show", "T-1"]);
		expect(shown.task).toMatchObject({
			title: "Edited title",
			body: "Edited body",
			priority: "high",
		});
		expect(shown.task.waits.map((task: { key: string }) => task.key)).toEqual([
			"T-3",
			"T-4",
		]);
		const events = shown.events.slice(2);
		expect(events).toHaveLength(5);
		expect(
			events.map((event: { actor: string }) => event.actor).sort(),
		).toEqual(["@add", "@body", "@priority", "@remove", "@title"]);
	} finally {
		await f.cleanup();
	}
}, 20000);

test("a concurrent rule refusal keeps the other process's edit and emits no event of its own", async () => {
	const f = fixture();
	const a = ["--actor", "seed"];
	try {
		await f.json("project add", ["project", "add", "T", ...a]);
		for (const title of ["First", "Second"])
			await f.json("add", ["add", ...a, "--title", title]);
		await f.json("edit", ["edit", "T-1", ...a, "--waits-add", "T-2"]);
		const children = [
			f.start([
				"edit",
				"T-2",
				"--actor",
				"@bad",
				"--waits-add",
				"T-1",
				"--json",
			]),
			f.start(["edit", "T-2", "--actor", "@good", "--title", "Kept", "--json"]),
		];
		const [bad, good] = await Promise.all(children.map(f.finish));
		expect(bad).toMatchObject({ code: 1, out: "" });
		expect(good).toMatchObject({ code: 0, err: "" });
		const error = JSON.parse(bad?.err as string);
		expectValid(errorShape, error);
		expect(error.error).toMatchObject({
			code: "cycle",
			details: { path: ["T-2", "T-1", "T-2"] },
		});
		const shown = await f.json("show", ["show", "T-2"]);
		expect(shown.task).toMatchObject({ title: "Kept", waits: [] });
		expect(shown.events.map((event: { actor: string }) => event.actor)).toEqual(
			["seed", "@good"],
		);
	} finally {
		await f.cleanup();
	}
}, 20000);

test("two CLI writers in different projects sweep one expired claim exactly once", async () => {
	const f = fixture();
	const a = ["--actor", "seed"];
	try {
		await f.json("project add", ["project", "add", "T", ...a]);
		const other = join(f.dir, "other");
		mkdirSync(other);
		await f.json("project add", ["project", "add", "O", ...a, "--dir", other]);
		await f.json("add", ["add", ...a, "--title", "Lapsed"]);
		await f.json("add", ["add", ...a, "--title", "Edit T"]);
		await f.json("add", ["add", ...a, "--title", "Edit O", "-p", "O"]);
		await f.json("claim", ["claim", "T-1", ...a, "--minutes", "1"]);
		const db = new Database(join(f.boardDir, "board.db"));
		try {
			db.exec(
				"UPDATE claim SET since = '2000-01-01T00:00:00.000Z', until = '2000-01-01T00:01:00.000Z'",
			);
		} finally {
			db.close();
		}
		const children = [
			f.start([
				"edit",
				"T-2",
				"--actor",
				"@t",
				"--title",
				"Changed T",
				"--json",
			]),
			f.start([
				"edit",
				"O-1",
				"--actor",
				"@o",
				"--title",
				"Changed O",
				"--json",
			]),
		];
		const results = await Promise.all(children.map(f.finish));
		const ids: number[] = [];
		for (const r of results) {
			expect(r).toMatchObject({ code: 0, err: "" });
			const value = JSON.parse(r.out);
			expectValid(outputs.edit, value);
			ids.push(...value.events);
		}
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
		const shown = await f.json("show", ["show", "T-1"]);
		const expired = shown.events.filter(
			(event: { kind: string }) => event.kind === "claim_expired",
		);
		expect(expired).toHaveLength(1);
		expect(expired[0]).toMatchObject({ project: "T", actor: "board" });
		expect(ids).toContain(expired[0].id);
		expect(shown.task).toMatchObject({ status: "ready", claim: null });
	} finally {
		await f.cleanup();
	}
}, 20000);

test.skipIf(!process.env.BOARD_BIN)(
	"five compiled CLI claimants retain one winner and four schema-valid refusals",
	async () => {
		const f = fixture(process.env.BOARD_BIN);
		const a = ["--actor", "seed"];
		try {
			await f.json("project add", ["project", "add", "T", ...a]);
			await f.json("add", ["add", ...a, "--title", "Race"]);
			const children = Array.from({ length: 5 }, (_, i) =>
				f.start([
					"claim",
					"T-1",
					"--actor",
					`@${i}`,
					"--minutes",
					"5",
					"--json",
				]),
			);
			const results = await Promise.all(children.map(f.finish));
			expect(results.map((r) => r.code).sort()).toEqual([0, 1, 1, 1, 1]);
			let winner: string | undefined;
			for (const r of results) {
				if (r.code === 0) {
					const value = JSON.parse(r.out);
					expectValid(outputs.claim, value);
					winner = value.claim.holder;
					expect(r.err).toBe("");
				} else {
					expect(r.out).toBe("");
					const error = JSON.parse(r.err);
					expectValid(errorShape, error);
					expect(error.error.code).toBe("claim_held");
				}
			}
			const shown = await f.json("show", ["show", "T-1"]);
			expect(shown.task.claim.holder).toBe(winner);
			expect(
				shown.events.filter(
					(event: { kind: string }) => event.kind === "claimed",
				),
			).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	},
	20000,
);
