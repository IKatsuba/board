import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const helper = join(import.meta.dir, "helpers", "upgrade-cli.ts");
const listed = JSON.stringify({
	latest: "9.8.7",
	versions: ["9.8.7", pkg.version],
});
const offline = JSON.stringify({ offline: "Listing must not run" });

function fixture() {
	const dir = mkdtempSync("/private/tmp/board-slice7-cli-tests-");
	const bin = join(dir, "bin");
	mkdirSync(bin);
	let n = 0;
	for (const manager of ["npm", "bun", "pnpm", "yarn"])
		writeFileSync(
			join(bin, manager),
			`#!/bin/sh\nprintf '%s\\n' "\${0##*/} $*" >> "$FAKE_LOG"\n`,
			{ mode: 0o755 },
		);
	const install = join(
		dir,
		"pnpm",
		"global",
		"v11",
		"hash-0",
		"node_modules",
		".pnpm",
		"@chorded+board-darwin-arm64@0.1.0",
		"node_modules",
		"@chorded",
		"board-darwin-arm64",
		"bin",
		"board",
	);
	return {
		dir,
		install,
		run(args: string[], versions = listed, extra: Record<string, string> = {}) {
			const log = join(dir, `log-${n++}`);
			const result = Bun.spawnSync(
				[process.execPath, helper, install, versions, ...args],
				{
					cwd: dir,
					env: {
						PATH: bin,
						BOARD_DIR: join(dir, "missing-board"),
						FAKE_LOG: log,
						NO_COLOR: "1",
						...extra,
					},
				},
			);
			return {
				code: result.exitCode,
				out: result.stdout.toString(),
				err: result.stderr.toString(),
				log: existsSync(log)
					? readFileSync(log, "utf8").trim().split("\n")
					: [],
			};
		},
		close() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("the CLI listing-count matrix installs one exact target and lists without invoking any manager", () => {
	const f = fixture();
	try {
		for (const [args, count, installs] of [
			[["upgrade", "--version", "9.8.7"], 1, true],
			[["upgrade", "-f"], 1, true],
			[["upgrade", "-f", "--version", "9.8.7"], 0, true],
			[["upgrade", "-l"], 1, false],
		] as const) {
			const result = f.run([...args]);
			expect(result.code).toBe(0);
			expect(result.log.filter((line) => line === "getVersions")).toHaveLength(
				count,
			);
			expect(result.log.filter((line) => line !== "getVersions")).toEqual(
				installs ? ["pnpm add --global @chorded/board@9.8.7"] : [],
			);
			expect(result.out).not.toContain("\u001b");
			expect(result.err).not.toContain("\u001b");
			if (installs) {
				expect(
					result.out.indexOf("From now on, each board command"),
				).toBeLessThan(result.out.indexOf("Successfully upgraded"));
				expect(result.out).toContain(
					`which is 9.8.7 if PATH leads to the install just upgraded. A running board watch --follow keeps ${pkg.version} until it is restarted.`,
				);
			}
		}
		expect(existsSync(join(f.dir, "missing-board"))).toBe(false);
	} finally {
		f.close();
	}
});

test("a forced exact upgrade succeeds on an invalid BOARD_DIR and leaves damaged board bytes and mtime untouched", () => {
	const f = fixture();
	try {
		const damaged = join(f.dir, "damaged-board");
		mkdirSync(damaged);
		const file = join(damaged, "board.db");
		const bytes = Buffer.from(
			"This is not SQLite; an upgrade must not open it.",
		);
		writeFileSync(file, bytes);
		const before = statSync(file).mtimeMs;
		for (const boardDir of [damaged, "relative/invalid"]) {
			const result = f.run(["upgrade", "-f", "--version", "9.8.7"], offline, {
				BOARD_DIR: boardDir,
			});
			expect(result.code).toBe(0);
			expect(result.err).toBe("");
			expect(result.log).toEqual(["pnpm add --global @chorded/board@9.8.7"]);
		}
		expect(readFileSync(file)).toEqual(bytes);
		expect(statSync(file).mtimeMs).toBe(before);
		expect(existsSync(`${file}-wal`)).toBe(false);
		expect(existsSync(`${file}-shm`)).toBe(false);
		expect(existsSync(join(f.dir, "relative"))).toBe(false);
	} finally {
		f.close();
	}
});

test("nested help, short help and short root version avoid listings; an offline list refusal is visible text", () => {
	const f = fixture();
	try {
		for (const args of [
			["upgrade", "help"],
			["upgrade", "-h"],
			["status", "-h"],
			["-V"],
		]) {
			const result = f.run(args, offline);
			expect(result.code).toBe(0);
			expect(result.log).toEqual([]);
			expect(result.out).not.toContain("\u001b");
			expect(result.err).not.toContain("\u001b");
		}
		const help = f.run(["upgrade", "help"], offline);
		expect(help.out).not.toContain("--registry");
		expect(help.out).not.toContain("--output");
		const failed = f.run(
			["upgrade", "-l"],
			JSON.stringify({ offline: "offline\u001b[2J\u009b" }),
		);
		expect(failed.code).toBe(1);
		expect(failed.out).toBe("");
		expect(failed.err).toContain("offline\\u001b[2J\\u009b");
		expect(failed.err).not.toContain("\u001b");
		expect(failed.err).not.toContain("Report it");
		expect(failed.log).toEqual(["getVersions"]);
	} finally {
		f.close();
	}
});
