// The built binary's one smoke test, skipped unless BOARD_BIN names a built
// `board`. BOARD_BIN_ARCH=x86_64 runs it under `arch -x86_64` (Rosetta), as
// the release self-tests the x64 build on the arm64 Mac.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const built = process.env.BOARD_BIN;
const arch = process.env.BOARD_BIN_ARCH;

describe.skipIf(built === undefined)("the built binary", () => {
	let dir: string;
	let repo: string;
	let worktree: string;
	const boardDir = () => join(dir, "board");

	beforeAll(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "board-bin-")));
		repo = join(dir, "repo");
		worktree = join(dir, "wt");
		mkdirSync(repo);
		const git = (...args: string[]) => {
			const out = Bun.spawnSync(["git", "-C", repo, ...args]);
			if (out.exitCode !== 0) throw new Error(out.stderr.toString());
		};
		git("init", "-q");
		git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"x",
		);
		git("worktree", "add", "-q", worktree);
		mkdirSync(join(worktree, "sub"));
		// Nothing sits beside the binary: it runs through a symlink and as a
		// copy alone in another directory.
		mkdirSync(join(dir, "links"));
		symlinkSync(realpathSync(built as string), join(dir, "links", "board"));
		mkdirSync(join(dir, "copy"));
		copyFileSync(built as string, join(dir, "copy", "board"));
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const command = (bin: string, ...args: string[]) =>
		arch === undefined ? [bin, ...args] : ["arch", `-${arch}`, bin, ...args];

	function run(bin: string, cwd: string, ...args: string[]) {
		const out = Bun.spawnSync(command(bin, ...args), {
			cwd,
			env: { ...process.env, BOARD_DIR: boardDir() },
		});
		return {
			code: out.exitCode,
			stdout: out.stdout.toString(),
			stderr: out.stderr.toString(),
		};
	}

	/** A shell line that runs this binary, under `arch` when asked. */
	const shellBin = (bin: string) =>
		(arch === undefined ? [bin] : ["arch", `-${arch}`, bin])
			.map((word) => `'${word}'`)
			.join(" ");

	function sh(cwd: string, script: string, env: Record<string, string> = {}) {
		const out = Bun.spawnSync(["/bin/sh", "-c", script], {
			cwd,
			env: { ...process.env, BOARD_DIR: boardDir(), ...env },
		});
		return {
			code: out.exitCode,
			stdout: out.stdout.toString(),
			stderr: out.stderr.toString(),
		};
	}

	// Quotes in pairs: macOS's /bin/sh (bash 3.2) misreads a lone ' in a
	// heredoc inside "$(…)".
	const BODY =
		"Says 'quoted' and \"double\", costs $5, has a `tick` and a \\backslash.";

	for (const how of ["links", "copy"] as const) {
		test(`run ${how === "links" ? "through a symlink" : "as a copy"}: the eight steps`, async () => {
			rmSync(boardDir(), { recursive: true, force: true });
			const bin = join(dir, how, "board");

			// 1. A project added with --actor.
			const added = run(
				bin,
				dir,
				"project",
				"add",
				"T",
				"--actor",
				"smoke",
				"--dir",
				repo,
			);
			expect(added.code).toBe(0);

			// 2. From a linked worktree's subdirectory, no -p, through the shell's
			// own heredoc: the project comes from git.
			const filed = sh(
				join(worktree, "sub"),
				`${shellBin(bin)} add --actor smoke --title 'Smoke 100% done' --json --body "$(cat <<'EOF'\n${BODY}\nEOF\n)"`,
			);
			expect(filed.stderr).toBe("");
			expect(filed.code).toBe(0);
			expect(JSON.parse(filed.stdout).task.key).toBe("T-1");

			// 3. Found by a substring with a %, and its body back byte for byte.
			const found = run(
				bin,
				dir,
				"ls",
				"-p",
				"T",
				"--contains",
				"100%",
				"--json",
			);
			expect(
				JSON.parse(found.stdout).tasks.map((t: { key: string }) => t.key),
			).toEqual(["T-1"]);
			const shown = run(bin, dir, "show", "T-1", "--json");
			expect(JSON.parse(shown.stdout).task.body).toBe(BODY);

			// 4. A claim, the same claim again, a claim without --minutes.
			expect(
				run(bin, dir, "claim", "T-1", "--actor", "smoke", "--minutes", "5")
					.code,
			).toBe(0);
			const again = run(
				bin,
				dir,
				"claim",
				"T-1",
				"--actor",
				"smoke",
				"--minutes",
				"5",
			);
			expect(again.code).toBe(1);
			expect(again.stderr).toStartWith("board: claim_held: ");
			const before = JSON.parse(
				run(bin, dir, "status", "-p", "T", "--json").stdout,
			).last_event;
			const usage = run(bin, dir, "claim", "T-1", "--actor", "smoke");
			expect(usage.code).toBe(64);
			expect(usage.stderr).toBe(
				'board: usage: Missing required option "--minutes".\n',
			);
			expect(
				JSON.parse(run(bin, dir, "status", "-p", "T", "--json").stdout)
					.last_event,
			).toBe(before);

			// 5. Five processes claim one fresh task at once.
			const fresh = JSON.parse(
				run(
					bin,
					dir,
					"add",
					"-p",
					"T",
					"--actor",
					"smoke",
					"--title",
					"Contested",
					"--json",
				).stdout,
			).task.key as string;
			const claimants = ["a", "b", "c", "d", "e"].map((who) =>
				Bun.spawn(
					command(bin, "claim", fresh, "--actor", `@${who}`, "--minutes", "5"),
					{
						cwd: dir,
						env: { ...process.env, BOARD_DIR: boardDir() },
						stdout: "pipe",
						stderr: "pipe",
					},
				),
			);
			const results = await Promise.all(
				claimants.map(async (child) => ({
					code: await child.exited,
					stderr: await new Response(child.stderr).text(),
				})),
			);
			expect(results.map((r) => r.code).sort()).toEqual([0, 1, 1, 1, 1]);
			for (const r of results.filter((r) => r.code === 1)) {
				expect(r.stderr).toStartWith("board: claim_held: ");
			}

			// 6. A reader that closes stdout ends board quietly with 141. A log
			// larger than a pipe's buffer, so board is still writing when head
			// has gone.
			const big = run(
				bin,
				dir,
				"add",
				"-p",
				"T",
				"--actor",
				"smoke",
				"--title",
				"Big",
				"--body",
				"😀".repeat(20_000),
			);
			expect(big.code).toBe(0);
			const bash = Bun.spawnSync(
				[
					"bash",
					"-c",
					`${shellBin(bin)} watch --json 2>'${join(dir, "watch.err")}' | head -c 1 >/dev/null; echo "\${PIPESTATUS[0]}"`,
				],
				{ cwd: dir, env: { ...process.env, BOARD_DIR: boardDir() } },
			);
			expect(bash.stdout.toString().trim()).toBe("141");
			expect(await Bun.file(join(dir, "watch.err")).text()).toBe("");

			// 7. The guide needs no board at all.
			const missing = join(dir, "no-such-board");
			const guide = sh(dir, `${shellBin(bin)} skill`, { BOARD_DIR: missing });
			expect(guide.code).toBe(0);
			expect(guide.stdout).toStartWith("# Working on a board\n");
			expect(existsSync(missing)).toBe(false);

			// 8. sql reads the task back and says which SQLite it ran on.
			const read = run(
				bin,
				dir,
				"sql",
				"SELECT title FROM task WHERE number = 1",
				"--json",
			);
			expect(read.code).toBe(0);
			expect(JSON.parse(read.stdout)).toEqual([{ title: "Smoke 100% done" }]);
			const version = run(
				bin,
				dir,
				"sql",
				"SELECT sqlite_version() AS v",
				"--json",
			);
			console.log(
				`${how}: ${arch ?? process.arch}, SQLite ${JSON.parse(version.stdout)[0].v}`,
			);
		}, 60_000);
	}

	// The command is mounted and its imports survive --compile. Help never
	// reads the registry (decision 41), and nothing here upgrades.
	test("board upgrade --help", () => {
		const help = run(join(dir, "copy", "board"), dir, "upgrade", "--help");
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("--list-versions");
		expect(help.stdout).not.toContain("--registry");
	});
});
