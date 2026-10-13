import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
	type GitRunner,
	gitAnswer,
	ProcessGitRunner,
} from "../src/place/git.ts";
import { Place } from "../src/place/place.ts";

test("successful git output preserves leading and trailing path spaces", () => {
	expect(
		gitAnswer("/worktree", {
			kind: "exit",
			code: 0,
			stdout: "/repo with space /.git\n",
			stderr: "",
		}),
	).toEqual({ git: "found", root: "/repo with space ", reason: null });
});

test("a rejected runner is shared only while pending and may be retried", async () => {
	let calls = 0;
	const runner: GitRunner = {
		async commonDir() {
			calls++;
			if (calls === 1) throw new Error("Runner failure");
			return { kind: "missing" };
		},
	};
	const place = new Place("/nowhere", runner);
	const pending = place.git();
	expect(place.git()).toBe(pending);
	await expect(pending).rejects.toThrow("Runner failure");
	expect(await place.git()).toMatchObject({ git: "missing", root: null });
	expect(calls).toBe(2);
});

test("Place canonicalizes a git root reported through a symlink", async () => {
	const dir = mkdtempSync("/private/tmp/board-slice1-root-");
	try {
		mkdirSync(join(dir, "main"));
		symlinkSync(join(dir, "main"), join(dir, "alias"));
		const place = new Place(dir, {
			async commonDir() {
				return {
					kind: "exit",
					code: 0,
					stdout: `${join(dir, "alias", ".git")}\n`,
					stderr: "",
				};
			},
		});
		expect(await place.git()).toEqual({
			git: "found",
			root: realpathSync(join(dir, "main")),
			reason: null,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(Bun.which("git") === null)(
	"real submodules and bare linked worktrees yield no supported root",
	async () => {
		const dir = realpathSync(mkdtempSync("/private/tmp/board-slice1-layouts-"));
		const git = (cwd: string, ...args: string[]) => {
			const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
				env: {
					...process.env,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
			});
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		};
		const commit = (cwd: string) =>
			git(
				cwd,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"--allow-empty",
				"-qm",
				"Initial test commit",
			);
		try {
			for (const name of ["main", "child"]) {
				mkdirSync(join(dir, name));
				git(join(dir, name), "init", "-q");
				commit(join(dir, name));
			}
			git(
				join(dir, "main"),
				"-c",
				"protocol.file.allow=always",
				"submodule",
				"add",
				"-q",
				join(dir, "child"),
				"sub",
			);
			git(
				dir,
				"clone",
				"--bare",
				"-q",
				join(dir, "main"),
				join(dir, "bare.git"),
			);
			git(
				join(dir, "bare.git"),
				"worktree",
				"add",
				"-q",
				"-b",
				"fixture",
				join(dir, "bare-wt"),
			);
			mkdirSync(join(dir, "bare-wt", "subdir"));
			for (const cwd of [
				join(dir, "main", "sub"),
				join(dir, "bare-wt", "subdir"),
			]) {
				const answer = await new Place(cwd, new ProcessGitRunner()).git();
				expect(answer.git).toBe("found");
				expect(answer.root).toBeNull();
				expect(answer.reason).toContain("not a .git inside a checkout");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
