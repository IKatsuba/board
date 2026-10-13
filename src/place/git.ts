import { basename, dirname, resolve } from "node:path";

/** What running `git -C <cwd> rev-parse --git-common-dir` came to. */
export type GitRun =
	| { kind: "exit"; code: number; stdout: string; stderr: string }
	| { kind: "missing" }
	| { kind: "timeout"; seconds: number }
	| { kind: "unstartable"; message: string };

/** The one seam to the outside world, injected so no test needs a git. */
export interface GitRunner {
	commonDir(cwd: string): Promise<GitRun>;
}

/** git's answer for a cwd, as resolution and `no_project` report it. */
export type GitAnswer =
	| { git: "found"; root: string; reason: null }
	| { git: "found"; root: null; reason: string }
	| { git: "not_a_repo" | "missing" | "failed"; root: null; reason: string };

/**
 * The root rule: the main checkout's root is the parent of git's common
 * directory when that directory is named `.git`. That covers the repository,
 * its subdirectories, its linked worktrees and standing inside `.git`. Any
 * other common directory (a bare repository, a separate git dir, a
 * submodule) gives no root; nothing is guessed about other layouts.
 */
export function gitAnswer(cwd: string, run: GitRun): GitAnswer {
	switch (run.kind) {
		case "missing":
			return {
				git: "missing",
				root: null,
				reason: "git was not found on PATH",
			};
		case "timeout":
			return {
				git: "failed",
				root: null,
				reason: `git did not answer in ${run.seconds} s`,
			};
		case "unstartable":
			return {
				git: "failed",
				root: null,
				reason: `git could not be started: ${run.message}`,
			};
	}
	const said = firstLine(run.stderr);
	if (run.code !== 0) {
		// Exit 128 is also dubious ownership and the like, which must not read
		// as "not a repository".
		return run.code === 128 && said.includes("not a git repository")
			? { git: "not_a_repo", root: null, reason: said }
			: { git: "failed", root: null, reason: said || `git exited ${run.code}` };
	}
	// A relative answer is relative to the directory git ran in. Only git's
	// line terminator is dropped: a path may hold any other character.
	const common = resolve(cwd, run.stdout.replace(/\n$/, ""));
	if (basename(common) === ".git") {
		return { git: "found", root: dirname(common), reason: null };
	}
	return {
		git: "found",
		root: null,
		reason: `git names ${common} as the common directory, which is not a .git inside a checkout`,
	};
}

function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

/** Runs the real git: 3 s, then SIGKILL, since a timer alone leaves it running. */
export class ProcessGitRunner implements GitRunner {
	constructor(
		private readonly command = "git",
		private readonly timeoutMs = 3_000,
	) {}

	async commonDir(cwd: string): Promise<GitRun> {
		let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
		try {
			child = Bun.spawn(
				[this.command, "-C", cwd, "rev-parse", "--git-common-dir"],
				{
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					timeout: this.timeoutMs,
					killSignal: "SIGKILL",
				},
			);
		} catch (error) {
			const { code, message } = error as { code?: string; message?: string };
			if (code === "ENOENT") return { kind: "missing" };
			return { kind: "unstartable", message: message ?? String(code) };
		}
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (child.signalCode === "SIGKILL") {
			return { kind: "timeout", seconds: this.timeoutMs / 1000 };
		}
		return { kind: "exit", code, stdout, stderr };
	}
}
