import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const version = "9.8.7";

function releaseFixture(initial: "arm64" | "x64" = "arm64") {
	const dir = mkdtempSync("/private/tmp/board-brd12-release-test-");
	const repo = join(dir, "repo");
	const steps = join(repo, "tool", "release");
	const bin = join(dir, "bin");
	const log = join(dir, "calls.log");
	const state = join(dir, "state");
	mkdirSync(steps, { recursive: true });
	mkdirSync(bin);
	mkdirSync(state);
	for (const name of ["lib", "preflight"])
		writeFileSync(
			join(steps, `${name}.sh`),
			readFileSync(join(root, "tool", "release", `${name}.sh`)),
			{ mode: 0o755 },
		);
	writeFileSync(
		join(repo, "tool", "release.sh"),
		readFileSync(join(root, "tool", "release.sh")),
	);
	writeFileSync(join(repo, ".gitignore"), "build/\n");
	writeFileSync(join(repo, "package.json"), JSON.stringify({ version }));
	const tgz = join(repo, "build", "release", "tgz");
	mkdirSync(tgz, { recursive: true });
	for (const name of ["board-darwin-arm64", "board-darwin-x64", "board"])
		writeFileSync(join(tgz, `chorded-${name}-${version}.tgz`), "fixture");
	for (const args of [
		["init", "-q"],
		["add", "."],
		[
			"-c",
			"user.name=Tester",
			"-c",
			"user.email=tester@example.invalid",
			"commit",
			"-qm",
			"fixture",
		],
	]) {
		const result = Bun.spawnSync(["git", "-C", repo, ...args]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	writeFileSync(
		join(bin, "npm"),
		`#!/bin/bash
set -eu
printf 'npm %s\\n' "$*" >> "$TASK_CALLS"
case "$1" in
whoami) echo tester ;;
view)
  case "$2" in
  @chorded/board@9.8.7) echo 'npm error code E404' >&2; exit 1 ;;
  @chorded/board-darwin-$TASK_INITIAL@9.8.7) echo 9.8.7; exit 0 ;;
  @chorded/board-darwin-*@9.8.7) ;;
  *) echo 'unexpected package' >&2; exit 99 ;;
  esac
  if [ -f "$TASK_STATE/published" ]; then
    count=0
    [ ! -f "$TASK_STATE/count" ] || count=$(cat "$TASK_STATE/count")
    count=$((count + 1))
    echo "$count" > "$TASK_STATE/count"
    case "$TASK_MODE" in
    ready) echo 9.8.7; exit 0 ;;
    delayed) [ "$count" -lt 3 ] || { echo 9.8.7; exit 0; } ;;
    empty) [ "$count" -lt 3 ] || { echo 9.8.7; exit 0; }; exit 0 ;;
    network) echo 'npm error code ECONNRESET' >&2; exit 1 ;;
    unexpected) echo 9.8.6; exit 0 ;;
    timeout) ;;
    *) exit 99 ;;
    esac
  fi
  echo 'npm error code E404' >&2; exit 1 ;;
publish)
  case "$4" in
  */chorded-board-darwin-*.tgz) touch "$TASK_STATE/published" ;;
  */chorded-board-9.8.7.tgz) ;;
  *) echo 'unexpected tarball' >&2; exit 99 ;;
  esac ;;
*) echo 'unexpected npm operation' >&2; exit 99 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(bin, "sleep"),
		'#!/bin/bash\nprintf "sleep %s\\n" "$*" >> "$TASK_CALLS"\n[ "$*" = 15 ]\n',
		{ mode: 0o755 },
	);
	return {
		run(mode: string) {
			writeFileSync(log, "");
			const result = Bun.spawnSync(["bash", join(repo, "tool", "release.sh")], {
				cwd: repo,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					TASK_CALLS: log,
					TASK_STATE: state,
					TASK_INITIAL: initial,
					TASK_MODE: mode,
				},
			});
			return {
				code: result.exitCode,
				stdout: result.stdout.toString(),
				stderr: result.stderr.toString(),
				calls: readFileSync(log, "utf8").trim().split("\n"),
			};
		},
		close() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const mainPublish = /npm publish .*\/chorded-board-9\.8\.7\.tgz$/;

for (const initial of ["arm64", "x64"] as const) {
	for (const mode of ["delayed", "empty"]) {
		test(`BRD-12 resumes with ${initial} live and waits through ${mode} visibility before publishing main`, () => {
			const f = releaseFixture(initial);
			try {
				const result = f.run(mode);
				const missing = initial === "arm64" ? "x64" : "arm64";
				expect(result.code).toBe(0);
				expect(result.stdout.trim().split("\n").at(-1)).toBe(version);
				expect(result.stderr).toContain(
					`waiting for @chorded/board-darwin-${missing}@${version}`,
				);
				const publishes = result.calls.filter((line) =>
					line.startsWith("npm publish"),
				);
				expect(publishes).toHaveLength(2);
				expect(publishes[0]).toEndWith(
					`chorded-board-darwin-${missing}-${version}.tgz`,
				);
				expect(publishes[1]).toMatch(mainPublish);
				const mainIndex = result.calls.findIndex((line) =>
					mainPublish.test(line),
				);
				expect(result.calls.slice(mainIndex - 3, mainIndex)).toEqual(
					initial === "x64"
						? [
								`npm view @chorded/board-darwin-arm64@${version} version`,
								`npm view @chorded/board-darwin-x64@${version} version`,
								`npm view @chorded/board@${version} version`,
							]
						: [
								"sleep 15",
								`npm view @chorded/board-darwin-x64@${version} version`,
								`npm view @chorded/board@${version} version`,
							],
				);
				expect(result.calls.filter((line) => line === "sleep 15")).toHaveLength(
					2,
				);
			} finally {
				f.close();
			}
		});
	}
}

test("BRD-12 times out at 60 attempts without main publication and a rerun resumes", () => {
	const f = releaseFixture();
	try {
		const result = f.run("timeout");
		expect(result.code).toBe(1);
		expect(result.calls.some((line) => mainPublish.test(line))).toBe(false);
		expect(result.calls.filter((line) => line === "sleep 15")).toHaveLength(59);
		expect(result.stderr.match(/waiting for /g)).toHaveLength(60);
		expect(result.stderr).toContain("@chorded/board-darwin-x64@9.8.7");
		expect(result.stderr).toContain("(60/60)");
		expect(result.stderr).toContain("Rerun tool/release.sh");
		expect(result.stdout.trim().split("\n").at(-1)).not.toBe(version);
		const resumed = f.run("ready");
		expect(resumed.code).toBe(0);
		expect(resumed.stdout.trim().split("\n").at(-1)).toBe(version);
		expect(
			resumed.calls.filter((line) => line.startsWith("npm publish")),
		).toHaveLength(1);
		expect(resumed.calls.some((line) => mainPublish.test(line))).toBe(true);
	} finally {
		f.close();
	}
});

for (const [mode, diagnostic] of [
	["network", "ECONNRESET"],
	["unexpected", 'answered "9.8.6"'],
]) {
	test(`BRD-12 stops immediately on ${mode} registry failure during the wait`, () => {
		const f = releaseFixture();
		try {
			const result = f.run(mode as string);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(diagnostic as string);
			expect(result.calls.some((line) => line.startsWith("sleep "))).toBe(
				false,
			);
			expect(result.calls.some((line) => mainPublish.test(line))).toBe(false);
			expect(result.stderr).not.toContain("Rerun");
		} finally {
			f.close();
		}
	});
}
