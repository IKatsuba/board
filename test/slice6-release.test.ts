import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("individual release steps refuse absent arguments before any signing or output assembly", () => {
	for (const step of ["sign", "selftest", "packages"]) {
		const result = Bun.spawnSync([
			"bash",
			join(root, "tool", "release", `${step}.sh`),
		]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toContain("usage:");
	}
});

test.skipIf(process.env.BOARD_SHELLCHECK === undefined)(
	"release entrypoint and individual steps pass static ShellCheck",
	() => {
		const result = Bun.spawnSync([
			process.env.BOARD_SHELLCHECK as string,
			"-x",
			"-P",
			"SCRIPTDIR",
			join(root, "tool", "release.sh"),
			...["lib", "preflight", "sign", "selftest", "notarise", "packages"].map(
				(name) => join(root, "tool", "release", `${name}.sh`),
			),
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toBe("");
	},
);

function preflightFixture() {
	const dir = mkdtempSync("/private/tmp/board-slice6-preflight-test-");
	const repo = join(dir, "repo");
	const steps = join(repo, "tool", "release");
	const bin = join(dir, "bin");
	const log = join(dir, "npm.log");
	mkdirSync(steps, { recursive: true });
	mkdirSync(bin);
	for (const name of ["lib", "preflight"])
		writeFileSync(
			join(steps, `${name}.sh`),
			readFileSync(join(root, "tool", "release", `${name}.sh`)),
		);
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ version: "9.8.7" }),
	);
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", repo, ...args]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	git("init", "-q");
	git("add", ".");
	git(
		"-c",
		"user.name=Tester",
		"-c",
		"user.email=tester@example.invalid",
		"commit",
		"-qm",
		"fixture",
	);
	writeFileSync(
		join(bin, "npm"),
		`#!/bin/bash
printf '%s\\n' "$*" >> "$TASK_NPM_LOG"
case "$1" in
view)
  case "$TASK_NPM_MODE" in
  network) echo 'npm error code ECONNRESET' >&2; exit 1 ;;
  unexpected) echo 'another-version'; exit 0 ;;
  main) [ "$2" = '@chorded/board@9.8.7' ] && { echo 9.8.7; exit 0; } ;;
  arm) [ "$2" = '@chorded/board-darwin-arm64@9.8.7' ] && { echo 9.8.7; exit 0; } ;;
  x64) [ "$2" = '@chorded/board-darwin-x64@9.8.7' ] && { echo 9.8.7; exit 0; } ;;
  esac
  echo 'npm error code E404' >&2; exit 1 ;;
whoami)
  [ "$TASK_NPM_MODE" = login ] && { echo 'npm error code E401' >&2; exit 1; }
  echo tester ;;
*) echo 'unexpected npm operation' >&2; exit 99 ;;
esac
`,
		{ mode: 0o755 },
	);
	return {
		repo,
		git,
		log,
		run(mode: string, ...args: string[]) {
			return Bun.spawnSync(["bash", join(steps, "preflight.sh"), ...args], {
				cwd: repo,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					TASK_NPM_MODE: mode,
					TASK_NPM_LOG: log,
				},
			});
		},
		close() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("standalone read-only preflight rejects untracked and tracked dirt before querying npm", () => {
	const f = preflightFixture();
	try {
		writeFileSync(join(f.repo, "untracked.txt"), "Untracked");
		const untracked = f.run("fresh");
		expect(untracked.exitCode).toBe(1);
		expect(untracked.stderr.toString()).toContain("?? untracked.txt");
		expect(existsSync(f.log)).toBe(false);
		rmSync(join(f.repo, "untracked.txt"));
		writeFileSync(
			join(f.repo, "package.json"),
			JSON.stringify({ version: "9.8.8" }),
		);
		const tracked = f.run("fresh");
		expect(tracked.exitCode).toBe(1);
		expect(tracked.stderr.toString()).toContain(" M package.json");
		expect(existsSync(f.log)).toBe(false);
	} finally {
		f.close();
	}
});

test("preflight reads the version, recognizes either partial platform publish and refuses a dry-run resume", () => {
	const f = preflightFixture();
	try {
		const fresh = f.run("fresh");
		expect(fresh.exitCode).toBe(0);
		expect(fresh.stdout.toString()).toBe("fresh 9.8.7\n");
		expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual([
			"view @chorded/board@9.8.7 version",
			"view @chorded/board-darwin-arm64@9.8.7 version",
			"view @chorded/board-darwin-x64@9.8.7 version",
			"whoami",
		]);
		for (const mode of ["arm", "x64"]) {
			const resumed = f.run(mode);
			expect(resumed.exitCode).toBe(0);
			expect(resumed.stdout.toString()).toBe("resume 9.8.7\n");
			rmSync(f.log);
			const dry = f.run(mode, "--dry-run");
			expect(dry.exitCode).toBe(1);
			expect(dry.stderr.toString()).toContain("--dry-run does not resume");
			expect(readFileSync(f.log, "utf8")).not.toContain("whoami");
		}
		expect(f.run("fresh", "--dry-run").exitCode).toBe(0);
	} finally {
		f.close();
	}
});

test("preflight refuses published main, registry ambiguity, login failure and a missing version without treating them as absence", () => {
	const f = preflightFixture();
	try {
		for (const [mode, message] of [
			["main", "on npm already"],
			["network", "ECONNRESET"],
			["unexpected", "another-version"],
			["login", "E401"],
		]) {
			const result = f.run(mode as string);
			expect(result.exitCode).toBe(1);
			expect(result.stdout.toString()).toBe("");
			expect(result.stderr.toString()).toContain(message as string);
		}
		rmSync(f.log);
		writeFileSync(join(f.repo, "package.json"), "{}");
		f.git("add", "package.json");
		f.git(
			"-c",
			"user.name=Tester",
			"-c",
			"user.email=tester@example.invalid",
			"commit",
			"-qm",
			"missing version",
		);
		const missing = f.run("fresh");
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr.toString()).toContain("package.json has no version");
		expect(existsSync(f.log)).toBe(false);
	} finally {
		f.close();
	}
});
