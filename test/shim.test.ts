// The npm shim, run by a real Node over a platform package whose binary is
// board from source, so it runs in every `bun run check`; test/npm.test.ts
// runs it over the built binaries after `npm pack`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = join(import.meta.dir, "..");

/** The first `node` on PATH that is Node itself, not `bun run`'s stand-in. */
function realNode(): string | null {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir.includes("bun-node-")) continue;
		const node = join(dir, "node");
		if (existsSync(node)) return node;
	}
	return null;
}

const node = realNode();
let dir: string;
let shim: string;
let env: Record<string, string | undefined>;

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-shim-")));
	const pkg = join(dir, "node_modules", "@chorded", "board");
	const platform = join(
		dir,
		"node_modules",
		"@chorded",
		`board-${process.platform}-${process.arch}`,
	);
	mkdirSync(join(pkg, "bin"), { recursive: true });
	mkdirSync(join(platform, "bin"), { recursive: true });
	shim = join(pkg, "bin", "board.js");
	copyFileSync(join(root, "npm", "board", "bin", "board.js"), shim);
	writeFileSync(
		join(platform, "package.json"),
		JSON.stringify({
			name: `@chorded/board-${process.platform}-${process.arch}`,
		}),
	);
	// exec, so the binary the shim spawns is board's own process.
	writeFileSync(
		join(platform, "bin", "board"),
		`#!/bin/sh\nexec '${process.execPath}' '${join(root, "src", "main.ts")}' "$@"\n`,
	);
	chmodSync(join(platform, "bin", "board"), 0o755);
	mkdirSync(join(dir, "app"));
	env = { ...process.env, BOARD_DIR: join(dir, "b") };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function through(...argv: string[]) {
	const run = Bun.spawnSync([node as string, shim, ...argv], {
		cwd: join(dir, "app"),
		env,
	});
	return {
		code: run.exitCode,
		signal: run.signalCode,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe.skipIf(node === null)("the npm shim", () => {
	test("a write and a read with --json; a refusal's 1 and a usage error's 64 kept", () => {
		expect(through("project", "add", "S", "--actor", "owner").code).toBe(0);
		const added = through(
			"add",
			"--actor",
			"npm",
			"--title",
			"through the shim",
			"--json",
		);
		expect(added.code).toBe(0);
		expect(JSON.parse(added.stdout).task.key).toBe("S-1");
		const listed = through("ls", "--json");
		expect(JSON.parse(listed.stdout)).toMatchObject({ project: "S", total: 1 });
		const refused = through("show", "S-9");
		expect(refused.code).toBe(1);
		expect(refused.stderr).toStartWith("board: not_found: ");
		const usage = through("claim", "S-1", "--actor", "npm");
		expect(usage.code).toBe(64);
		expect(usage.stderr).toBe(
			'board: usage: Missing required option "--minutes".\n',
		);
	}, 30_000);

	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		test(`${signal} to the shim alone reaches the binary; the shim ends by it; no child is left`, async () => {
			if (!existsSync(join(dir, "b", "board.db"))) {
				expect(through("project", "add", "S", "--actor", "owner").code).toBe(0);
			}
			// Detached: its own process group, so only the shim gets the signal.
			const watching = Bun.spawn([node as string, shim, "watch", "--follow"], {
				cwd: join(dir, "app"),
				env,
				stdout: "pipe",
				stderr: "pipe",
				detached: true,
			});
			let children: number[] = [];
			try {
				const deadline = Date.now() + 10_000;
				while (children.length === 0 && Date.now() < deadline) {
					await Bun.sleep(100);
					children = Bun.spawnSync(["pgrep", "-P", String(watching.pid)])
						.stdout.toString()
						.trim()
						.split("\n")
						.filter(Boolean)
						.map(Number);
				}
				expect(children).toHaveLength(1);
				// Let the watcher attach before it is signalled.
				await Bun.sleep(1_000);
				watching.kill(signal);
				await watching.exited;
				expect(watching.signalCode).toBe(signal);
				const gone = Date.now() + 5_000;
				while (children.some(alive) && Date.now() < gone) await Bun.sleep(50);
				expect(children.filter(alive)).toEqual([]);
			} finally {
				for (const pid of children.filter(alive)) process.kill(pid, "SIGKILL");
				if (watching.exitCode === null && watching.signalCode === null) {
					watching.kill("SIGKILL");
				}
			}
		}, 30_000);
	}

	test("the binary's exit status comes back as the shim's", () => {
		expect(through("sql", "SELECT 1/0 AS x, nonsense").code).toBe(1);
		expect(through("--version").code).toBe(0);
	});
});
