import { expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { errorShape, outputs } from "../src/schemas.ts";
import { expectValid } from "./helpers/schema.ts";

const root = join(import.meta.dir, "..");
const node = (process.env.PATH ?? "")
	.split(delimiter)
	.filter((dir) => !dir.includes("bun-node-"))
	.map((dir) => join(dir, "node"))
	.find(existsSync);

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "board-slice8-shim-")));
	const pkg = join(dir, "node_modules", "@chorded", "board");
	const platform = join(
		dir,
		"node_modules",
		"@chorded",
		`board-${process.platform}-${process.arch}`,
	);
	mkdirSync(join(pkg, "bin"), { recursive: true });
	mkdirSync(join(platform, "bin"), { recursive: true });
	const shim = join(pkg, "bin", "board.js");
	copyFileSync(join(root, "npm", "board", "bin", "board.js"), shim);
	writeFileSync(
		join(pkg, "package.json"),
		readFileSync(join(root, "npm", "board", "package.json")),
	);
	writeFileSync(
		join(platform, "package.json"),
		JSON.stringify({
			name: `@chorded/board-${process.platform}-${process.arch}`,
		}),
	);
	const binary = join(platform, "bin", "board");
	return {
		dir,
		shim,
		binary,
		env: { ...process.env, BOARD_DIR: join(dir, "board") },
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test.skipIf(!node)(
	"the shim forwards exact arguments, inherited streams and arbitrary child statuses",
	() => {
		const f = fixture();
		try {
			writeFileSync(
				f.binary,
				'#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "%s\\n" "$SLICE8_MARK" >&2\nexit "$SLICE8_STATUS"\n',
			);
			chmodSync(f.binary, 0o755);
			const args = [
				"literal 'quotes' \"double\" $HOME `ticks`",
				"-dash",
				"with\nnewline",
			];
			for (const code of [0, 1, 64, 141]) {
				const result = Bun.spawnSync([node as string, f.shim, ...args], {
					cwd: f.dir,
					env: {
						...f.env,
						SLICE8_STATUS: String(code),
						SLICE8_MARK: "inherited stderr",
					},
					stdin: "ignore",
				});
				expect(result.exitCode).toBe(code);
				expect(result.stdout.toString()).toBe(`${args.join("\n")}\n`);
				expect(result.stderr.toString()).toBe("inherited stderr\n");
			}
		} finally {
			f.cleanup();
		}
	},
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	test.skipIf(!node)(
		`the shim alone forwards ${signal} and reaps the child before re-raising it`,
		async () => {
			const f = fixture();
			const pidFile = join(f.dir, "child.pid");
			const received = join(f.dir, "received");
			let child:
				| ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
				| undefined;
			let pid: number | undefined;
			const alive = (id: number) => {
				try {
					process.kill(id, 0);
					return true;
				} catch {
					return false;
				}
			};
			try {
				writeFileSync(
					f.binary,
					`#!${node}\nconst fs = require('node:fs');\nfor (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal, () => { fs.writeFileSync(process.env.SLICE8_RECEIVED, signal); process.removeAllListeners(signal); process.kill(process.pid, signal); });\nfs.writeFileSync(process.env.SLICE8_PID, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
				);
				chmodSync(f.binary, 0o755);
				child = Bun.spawn([node as string, f.shim], {
					cwd: f.dir,
					env: { ...f.env, SLICE8_PID: pidFile, SLICE8_RECEIVED: received },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					detached: true,
				});
				const deadline = Date.now() + 5000;
				while (!existsSync(pidFile) && Date.now() < deadline)
					await Bun.sleep(20);
				expect(existsSync(pidFile)).toBe(true);
				pid = Number(readFileSync(pidFile, "utf8"));
				expect(alive(pid)).toBe(true);
				child.kill(signal);
				await child.exited;
				expect(child.signalCode).toBe(signal);
				expect(readFileSync(received, "utf8")).toBe(signal);
				expect(alive(pid)).toBe(false);
				expect(await new Response(child.stderr).text()).toBe("");
			} finally {
				if (child) {
					if (child.exitCode === null) child.kill("SIGKILL");
					await child.exited;
				}
				if (pid && alive(pid)) process.kill(pid, "SIGKILL");
				f.cleanup();
			}
		},
		10000,
	);
}

test.skipIf(!node || !process.env.BOARD_BIN)(
	"a locally packed and offline-installed shim runs the real binary and preserves exits",
	async () => {
		const dir = realpathSync(
			mkdtempSync(join(tmpdir(), "board-slice8-packed-shim-")),
		);
		try {
			const mainPkg = join(dir, "main");
			const platformPkg = join(dir, "platform");
			const installed = join(dir, "installed");
			mkdirSync(join(mainPkg, "bin"), { recursive: true });
			mkdirSync(join(platformPkg, "bin"), { recursive: true });
			mkdirSync(installed);
			copyFileSync(
				join(root, "npm", "board", "package.json"),
				join(mainPkg, "package.json"),
			);
			copyFileSync(
				join(root, "npm", "board", "bin", "board.js"),
				join(mainPkg, "bin", "board.js"),
			);
			copyFileSync(
				join(
					root,
					"npm",
					`board-${process.platform}-${process.arch}`,
					"package.json",
				),
				join(platformPkg, "package.json"),
			);
			copyFileSync(
				process.env.BOARD_BIN as string,
				join(platformPkg, "bin", "board"),
			);
			chmodSync(join(platformPkg, "bin", "board"), 0o755);
			const npm = Bun.which("npm");
			expect(npm).not.toBeNull();
			const npmEnv = {
				...process.env,
				npm_config_offline: "true",
				npm_config_cache: join(dir, "cache"),
				PATH: `${join(node as string, "..")}${delimiter}${process.env.PATH ?? ""}`,
			};
			const pack = (cwd: string) => {
				const r = Bun.spawnSync(
					[
						npm as string,
						"pack",
						"--json",
						"--ignore-scripts",
						"--pack-destination",
						dir,
					],
					{ cwd, env: npmEnv },
				);
				expect(r.exitCode).toBe(0);
				return join(dir, JSON.parse(r.stdout.toString())[0].filename);
			};
			const mainTar = pack(mainPkg);
			const platformTar = pack(platformPkg);
			writeFileSync(
				join(installed, "package.json"),
				JSON.stringify({ name: "slice8-fixture", private: true }),
			);
			const install = Bun.spawnSync(
				[
					npm as string,
					"install",
					"--offline",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--omit=optional",
					mainTar,
					platformTar,
				],
				{ cwd: installed, env: npmEnv },
			);
			expect(install.exitCode).toBe(0);
			const shim = join(
				installed,
				"node_modules",
				"@chorded",
				"board",
				"bin",
				"board.js",
			);
			const boardDir = join(dir, "board");
			const run = (...argv: string[]) =>
				Bun.spawnSync([node as string, shim, ...argv], {
					cwd: installed,
					env: { ...process.env, BOARD_DIR: boardDir },
					stdin: "ignore",
				});
			const json = (name: keyof typeof outputs, ...argv: string[]) => {
				const r = run(...argv, "--json");
				expect(r.exitCode).toBe(0);
				expect(r.stderr.toString()).toBe("");
				const v = JSON.parse(r.stdout.toString());
				expectValid(outputs[name], v);
				return v;
			};
			json("project add", "project", "add", "T", "--actor", "@shim");
			json(
				"add",
				"add",
				"--actor",
				"@shim",
				"--title",
				"Through installed shim",
			);
			expect(json("show", "show", "T-1").task.created_by).toBe("@shim");
			const refused = run("show", "T-99", "--json");
			expect(refused.exitCode).toBe(1);
			expect(refused.stdout.toString()).toBe("");
			expectValid(errorShape, JSON.parse(refused.stderr.toString()));
			const usage = run("claim", "T-1", "--actor", "@shim", "--json");
			expect(usage.exitCode).toBe(64);
			expect(usage.stdout.toString()).toBe("");
			expect(usage.stderr.toString()).toStartWith("board: usage: ");
			json(
				"edit",
				"edit",
				"T-1",
				"--actor",
				"@shim",
				"--body",
				"😀".repeat(20000),
			);
			const pipe = Bun.spawnSync(
				[
					"bash",
					"-c",
					// biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expands its pipeline status.
					'"$@" | head -c 1 >/dev/null; exit "${PIPESTATUS[0]}"',
					"slice8",
					node as string,
					shim,
					"show",
					"T-1",
					"--json",
				],
				{ cwd: installed, env: { ...process.env, BOARD_DIR: boardDir } },
			);
			expect(pipe.exitCode).toBe(141);
			expect(pipe.stderr.toString()).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	30000,
);
