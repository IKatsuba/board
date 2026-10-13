import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GitRun,
	type GitRunner,
	gitAnswer,
	ProcessGitRunner,
} from "../src/place/git.ts";
import { Place, realDirectory } from "../src/place/place.ts";
import { projectAt } from "../src/place/project-at.ts";

describe("projectAt", () => {
	const app = { key: "APP", directory: "/p/app" };
	const inner = { key: "IN", directory: "/p/app/pkg" };
	const two = { key: "TWO", directory: "/p/app-two" };

	test.each([
		["the directory itself", [app], "/p/app", "APP"],
		["a path below", [app], "/p/app/src/x", "APP"],
		["a sibling sharing a prefix is not below", [app], "/p/app-two/src", null],
		["a shorter path is not below", [app], "/p", null],
		["the sibling project itself", [app, two], "/p/app-two/src", "TWO"],
		["nested, outer first: the deepest", [app, inner], "/p/app/pkg/a", "IN"],
		["nested, inner first: the deepest", [inner, app], "/p/app/pkg/a", "IN"],
		["nested, above the inner one", [inner, app], "/p/app/other", "APP"],
		["no match", [app, inner, two], "/q", null],
		["no projects", [], "/p/app", null],
	] as const)("%s", (_, projects, path, key) => {
		expect(projectAt(projects, path)?.key ?? null).toBe(key);
	});
});

describe("the root rule", () => {
	const ok = (stdout: string): GitRun => ({
		kind: "exit",
		code: 0,
		stdout: `${stdout}\n`,
		stderr: "",
	});

	test.each([
		["the repository root", "/w/app", ".git", "/w/app"],
		["a subdirectory", "/w/app/a/b", "../../.git", "/w/app"],
		["a linked worktree", "/w/app-wt/sub", "/w/app/.git", "/w/app"],
		["inside .git", "/w/app/.git", ".", "/w/app"],
	])("%s gives the main root", (_, cwd, stdout, root) => {
		expect(gitAnswer(cwd, ok(stdout))).toEqual({
			git: "found",
			root,
			reason: null,
		});
	});

	test.each([
		["a bare repository", "/w/app.git", ".", "/w/app.git"],
		["a separate git dir", "/w/sep", "/w/sep.gitdir", "/w/sep.gitdir"],
		[
			"a submodule",
			"/w/app/sub",
			"/w/app/.git/modules/sub",
			"/w/app/.git/modules/sub",
		],
	])("%s gives no root and says why", (_, cwd, stdout, common) => {
		const answer = gitAnswer(cwd, ok(stdout));
		expect(answer.git).toBe("found");
		expect(answer.root).toBeNull();
		expect(answer.reason).toContain(common);
	});

	test("a root holding a newline is kept whole", () => {
		expect(gitAnswer("/w/wt", ok("/w/a\nb/.git"))).toEqual({
			git: "found",
			root: "/w/a\nb",
			reason: null,
		});
	});

	test("a git that cannot be started is failed, with why", () => {
		expect(gitAnswer("/w", { kind: "unstartable", message: "EACCES" })).toEqual(
			{
				git: "failed",
				root: null,
				reason: "git could not be started: EACCES",
			},
		);
	});

	test("outside git is not_a_repo with git's line", () => {
		expect(
			gitAnswer("/w", {
				kind: "exit",
				code: 128,
				stdout: "",
				stderr:
					"fatal: not a git repository (or any of the parent directories): .git\n",
			}),
		).toEqual({
			git: "not_a_repo",
			root: null,
			reason:
				"fatal: not a git repository (or any of the parent directories): .git",
		});
	});

	test("another 128, a stub's exit, a timeout and no git are reported, not worked around", () => {
		expect(
			gitAnswer("/w", {
				kind: "exit",
				code: 128,
				stdout: "",
				stderr: "fatal: detected dubious ownership in repository at '/w'\n",
			}),
		).toMatchObject({
			git: "failed",
			reason: expect.stringContaining("dubious"),
		});
		expect(
			gitAnswer("/w", { kind: "exit", code: 1, stdout: "", stderr: "" }),
		).toMatchObject({ git: "failed", reason: "git exited 1" });
		expect(gitAnswer("/w", { kind: "timeout", seconds: 3 })).toMatchObject({
			git: "failed",
			reason: "git did not answer in 3 s",
		});
		expect(gitAnswer("/w", { kind: "missing" })).toMatchObject({
			git: "missing",
		});
	});
});

/** A runner whose answers a test releases by hand. */
class FakeRunner implements GitRunner {
	calls = 0;
	private release: Array<(run: GitRun) => void> = [];

	commonDir(): Promise<GitRun> {
		this.calls++;
		return new Promise((resolve) => this.release.push(resolve));
	}

	answer(run: GitRun) {
		for (const release of this.release.splice(0)) release(run);
	}
}

describe("Place", () => {
	const repo: GitRun = { kind: "exit", code: 0, stdout: ".git\n", stderr: "" };

	test("concurrent calls share one pending git", async () => {
		const runner = new FakeRunner();
		const place = new Place("/nowhere/app", runner);
		const both = Promise.all([place.git(), place.git()]);
		runner.answer(repo);
		const [a, b] = await both;
		expect(runner.calls).toBe(1);
		expect(a).toEqual(b);
		expect(a).toMatchObject({ git: "found", root: "/nowhere/app" });
	});

	test("git is asked again on the next call, after a failure or an answer", async () => {
		const runner = new FakeRunner();
		const place = new Place("/nowhere/app", runner);
		const first = place.git();
		runner.answer({ kind: "timeout", seconds: 3 });
		expect((await first).git).toBe("failed");
		const second = place.git();
		runner.answer(repo);
		expect((await second).git).toBe("found");
		const third = place.git();
		runner.answer(repo);
		await third;
		expect(runner.calls).toBe(3);
	});
});

describe("ProcessGitRunner", () => {
	let dir: string;

	beforeAll(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "board-place-")));
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("a git that does not answer is killed at the timeout", async () => {
		const slow = join(dir, "slow-git");
		writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n");
		chmodSync(slow, 0o755);
		const started = Date.now();
		// The runner reports a timeout only from the child's own SIGKILL exit.
		const run = await new ProcessGitRunner(slow, 300).commonDir(dir);
		expect(run).toEqual({ kind: "timeout", seconds: 0.3 });
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("a git that is not executable is unstartable", async () => {
		const plain = join(dir, "plain-git");
		writeFileSync(plain, "#!/bin/sh\n");
		chmodSync(plain, 0o644);
		const run = await new ProcessGitRunner(plain).commonDir(dir);
		expect(run.kind).toBe("unstartable");
	});

	test("no git on PATH is missing", async () => {
		const run = await new ProcessGitRunner(join(dir, "no-such-git")).commonDir(
			dir,
		);
		expect(run).toEqual({ kind: "missing" });
	});

	const hasGit = Bun.which("git") !== null;

	test.skipIf(!hasGit)("against real git", async () => {
		const git = (cwd: string, ...args: string[]) => {
			const out = Bun.spawnSync(["git", "-C", cwd, ...args], {
				env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
			});
			if (out.exitCode !== 0) throw new Error(out.stderr.toString());
		};
		const main = join(dir, "main");
		mkdirSync(join(main, "a", "b"), { recursive: true });
		git(main, "init", "-q");
		git(
			main,
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
		git(main, "worktree", "add", "-q", join(dir, "wt"));
		mkdirSync(join(dir, "wt", "sub"));
		git(dir, "init", "-q", "--bare", "bare.git");
		mkdirSync(join(dir, "sep"));
		git(
			join(dir, "sep"),
			"init",
			"-q",
			"--separate-git-dir",
			join(dir, "sep.gitdir"),
		);
		mkdirSync(join(dir, "outside"));

		const answer = async (cwd: string) =>
			new Place(cwd, new ProcessGitRunner()).git();
		for (const cwd of [
			main,
			join(main, "a", "b"),
			join(dir, "wt", "sub"),
			join(main, ".git"),
		]) {
			expect(await answer(cwd)).toEqual({
				git: "found",
				root: main,
				reason: null,
			});
		}
		for (const cwd of [join(dir, "bare.git"), join(dir, "sep")]) {
			expect(await answer(cwd)).toMatchObject({ git: "found", root: null });
		}
		const odd = join(dir, "odd\nname");
		mkdirSync(odd);
		git(odd, "init", "-q");
		git(
			odd,
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
		git(odd, "worktree", "add", "-q", join(dir, "odd-wt"));
		expect(await answer(join(dir, "odd-wt"))).toEqual({
			git: "found",
			root: odd,
			reason: null,
		});
		const outside = await answer(join(dir, "outside"));
		// The temp directory may itself sit inside a checkout on some machines.
		if (outside.git !== "found") expect(outside.git).toBe("not_a_repo");
	});
});

describe("realDirectory", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "board-real-"));
		mkdirSync(join(dir, "Case", "Inner"), { recursive: true });
		symlinkSync(join(dir, "Case"), join(dir, "link"));
		writeFileSync(join(dir, "file"), "");
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("a symlink, /tmp and a mis-cased spelling collapse to one path", () => {
		const real = realpathSync(join(dir, "Case", "Inner"));
		expect(realDirectory(join(dir, "link", "Inner"))).toBe(real);
		expect(realDirectory(`${join(dir, "Case", "Inner")}/`)).toBe(real);
		if (process.platform === "darwin") {
			expect(real.startsWith("/private/")).toBe(
				dir.startsWith("/var/") || dir.startsWith("/tmp/"),
			);
			expect(realDirectory(join(dir, "case", "inner"))).toBe(real);
			expect(realDirectory("/tmp")).toBe("/private/tmp");
		}
	});

	test("a missing path or a file is not a directory", () => {
		expect(realDirectory(join(dir, "missing"))).toBeNull();
		expect(realDirectory(join(dir, "file"))).toBeNull();
	});
});
