import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

test.skipIf(process.env.BOARD_BIN === undefined)(
	"compiled nested upgrade help and root version work with invalid board configuration and fake-only manager PATH",
	() => {
		const dir = mkdtempSync("/private/tmp/board-slice7-binary-help-");
		const bin = join(dir, "bin");
		const log = join(dir, "manager.log");
		mkdirSync(bin);
		try {
			for (const manager of ["npm", "bun", "pnpm", "yarn"])
				writeFileSync(
					join(bin, manager),
					`#!/bin/sh\nprintf '%s\\n' '${manager}' >> "$FAKE_LOG"\n`,
					{ mode: 0o755 },
				);
			for (const args of [["upgrade", "help"], ["-V"]]) {
				const result = Bun.spawnSync(
					[process.env.BOARD_BIN as string, ...args],
					{
						cwd: dir,
						env: {
							PATH: bin,
							BOARD_DIR: "relative/invalid",
							FAKE_LOG: log,
							NO_COLOR: "1",
						},
					},
				);
				expect(result.exitCode).toBe(0);
				expect(result.stderr.toString()).toBe("");
				expect(result.stdout.toString()).not.toContain("\u001b");
				if (args[0] === "upgrade") {
					expect(result.stdout.toString()).toContain("--list-versions");
					expect(result.stdout.toString()).not.toContain("--registry");
				} else expect(result.stdout.toString()).toContain(pkg.version);
			}
			expect(existsSync(log)).toBe(false);
			expect(existsSync(join(dir, "relative"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
