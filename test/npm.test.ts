// The npm packages, as a user installs them: assembled from npm/ and the
// built binaries, packed, installed from the tarballs into a scratch
// project, and run through the shim. Skipped unless BOARD_NPM names a
// directory holding the real `node` and `npm` (npm runs the shim with the
// user's Node, not Bun), and both binaries are built under build/.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmDir = process.env.BOARD_NPM;
const root = join(import.meta.dir, "..");
const built = (arch: string) => join(root, "build", `darwin-${arch}`, "board");

describe.skipIf(npmDir === undefined)("the npm packages", () => {
	let dir: string;
	let scratch: string;
	const env = () => ({
		...(process.env as Record<string, string>),
		PATH: `${npmDir}:${process.env.PATH}`,
		BOARD_DIR: join(dir, "board"),
	});
	const shim = () => join(scratch, "node_modules", ".bin", "board");
	const node = () => join(npmDir as string, "node");

	function sh(cwd: string, ...command: string[]) {
		const out = Bun.spawnSync(command, { cwd, env: env() });
		if (out.exitCode !== 0) {
			throw new Error(`${command.join(" ")}: ${out.stderr.toString()}`);
		}
		return out.stdout.toString();
	}

	beforeAll(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "board-npm-")));
		sh(
			root,
			process.execPath,
			"tool/npm-assemble.ts",
			join(dir, "pkg"),
			built("arm64"),
			built("x64"),
		);
		mkdirSync(join(dir, "tgz"));
		for (const name of ["board", "board-darwin-arm64", "board-darwin-x64"]) {
			sh(
				join(dir, "pkg", name),
				join(npmDir as string, "npm"),
				"pack",
				"--pack-destination",
				join(dir, "tgz"),
			);
		}
		scratch = join(dir, "scratch");
		mkdirSync(scratch);
		sh(scratch, join(npmDir as string, "npm"), "init", "-y");
		const tarballs = readdirSync(join(dir, "tgz"))
			.filter((f) => !f.includes(process.arch === "arm64" ? "x64" : "arm64"))
			.map((f) => join(dir, "tgz", f));
		sh(
			scratch,
			join(npmDir as string, "npm"),
			"install",
			"--no-audit",
			"--no-fund",
			...tarballs,
		);
		mkdirSync(join(dir, "repo"));
	}, 120_000);

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("the three packages pack; the installed binary is the built one, 0755, not quarantined", () => {
		const { version } = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		);
		expect(readdirSync(join(dir, "tgz")).sort()).toEqual([
			`chorded-board-${version}.tgz`,
			`chorded-board-darwin-arm64-${version}.tgz`,
			`chorded-board-darwin-x64-${version}.tgz`,
		]);
		const installed = join(
			scratch,
			"node_modules",
			"@chorded",
			`board-darwin-${process.arch}`,
			"bin",
			"board",
		);
		expect(
			readFileSync(installed).equals(readFileSync(built(process.arch))),
		).toBe(true);
		expect(statSync(installed).mode & 0o777).toBe(0o755);
		expect(sh(scratch, "xattr", installed)).not.toContain(
			"com.apple.quarantine",
		);
		const main = JSON.parse(
			readFileSync(
				join(scratch, "node_modules", "@chorded", "board", "package.json"),
				"utf8",
			),
		);
		expect(main.optionalDependencies).toEqual({
			"@chorded/board-darwin-arm64": main.version,
			"@chorded/board-darwin-x64": main.version,
		});
	});

	test("board runs through the shim", () => {
		const added = Bun.spawnSync(
			[
				shim(),
				"project",
				"add",
				"--actor",
				"owner",
				"T",
				"--dir",
				join(dir, "repo"),
			],
			{ env: env() },
		);
		expect(added.exitCode).toBe(0);
		const listed = Bun.spawnSync([shim(), "ls", "--json"], {
			cwd: join(dir, "repo"),
			env: env(),
		});
		expect(JSON.parse(listed.stdout.toString())).toMatchObject({ total: 0 });
	}, 30_000);

	test("the shim keeps the binary's exit status and re-raises its signal", async () => {
		const refused = Bun.spawnSync([shim(), "show", "T-9"], { env: env() });
		expect(refused.exitCode).toBe(1);
		const usage = Bun.spawnSync([shim(), "show", "nope"], { env: env() });
		expect(usage.exitCode).toBe(64);
		const watching = Bun.spawn([node(), shim(), "watch", "--follow"], {
			env: env(),
			stdout: "pipe",
		});
		await Bun.sleep(1_500);
		// Ctrl-C reaches the whole foreground group: the binary the shim runs
		// and the shim itself. Sending it to the shim alone would leave the
		// binary watching after the test.
		const children = Bun.spawnSync(["pgrep", "-P", String(watching.pid)])
			.stdout.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		try {
			expect(children).toHaveLength(1);
			for (const pid of children) process.kill(pid, "SIGINT");
			watching.kill("SIGINT");
			await watching.exited;
			// The binary is reparented once the shim exits and is reaped a moment
			// later; give it that moment before asking whether it is gone.
			const deadline = Date.now() + 5_000;
			while (children.some(alive) && Date.now() < deadline) await Bun.sleep(50);
			expect(children.filter(alive)).toEqual([]);
			expect(watching.signalCode).toBe("SIGINT");
			expect(existsSync(join(dir, "board", "board.db"))).toBe(true);
		} finally {
			// Never leave a watcher behind on a board the test removes.
			for (const pid of children.filter(alive)) process.kill(pid, "SIGKILL");
			if (watching.exitCode === null && watching.signalCode === null) {
				watching.kill("SIGKILL");
			}
		}
	}, 30_000);
});
