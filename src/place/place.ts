import { realpathSync, statSync } from "node:fs";
import { type GitAnswer, type GitRunner, gitAnswer } from "./git.ts";

/**
 * What a process looks from: its cwd, captured once as a real path, and git's
 * answer for it. git is asked again every time the fallback is needed, so a
 * repository created or a worktree moved after start is seen; concurrent
 * calls share the one pending git.
 */
export class Place {
	private pending: Promise<GitAnswer> | null = null;

	constructor(
		readonly cwd: string,
		private readonly runner: GitRunner,
	) {}

	git(): Promise<GitAnswer> {
		if (this.pending === null) {
			this.pending = this.ask().finally(() => {
				this.pending = null;
			});
		}
		return this.pending;
	}

	private async ask(): Promise<GitAnswer> {
		const answer = gitAnswer(this.cwd, await this.runner.commonDir(this.cwd));
		if (answer.root === null) return answer;
		// Compared byte for byte with stored real paths, so made real too.
		return { ...answer, root: realOr(answer.root) };
	}
}

function realOr(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * A directory as stored: `realpath(3)`, so symlinks, /tmp → /private/tmp and
 * the on-disk letter case of an APFS volume collapse to one spelling. Null
 * when it does not exist or is not a directory.
 */
export function realDirectory(path: string): string | null {
	try {
		const real = realpathSync.native(path);
		return statSync(real).isDirectory() ? real : null;
	} catch {
		return null;
	}
}
