import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/cli/io.ts";
import { buildCli, runCli } from "../src/cli/root.ts";

test("the removed server command is usage before environment, git or storage", async () => {
	const dir = mkdtempSync(join(tmpdir(), "board-slice8-removal-"));
	try {
		for (const argv of [["mcp"], ["mcp", "-p", "T"], ["mcp", "--json"]]) {
			const out: string[] = [];
			const err: string[] = [];
			const deps: Deps = {
				io: { out: (text) => out.push(text), err: (text) => err.push(text) },
				get env(): Deps["env"] {
					throw new Error("Usage must not read the board environment");
				},
				clock: {
					now: () => {
						throw new Error("Usage must not read time");
					},
				},
				runner: {
					commonDir: async () => {
						throw new Error("Usage must not run git");
					},
				},
				cwd: dir,
				colors: false,
				exitCode: 0,
			};
			expect(
				buildCli(deps)
					.getCommands()
					.map((command) => command.getName()),
			).not.toContain("mcp");
			expect(await runCli(argv, deps)).toBe(64);
			expect(out).toEqual([]);
			expect(err).toHaveLength(1);
			expect(err[0]).toStartWith("board: ");
			expect(err[0]).not.toContain("Usage:");
			expect(() => JSON.parse(err[0] as string)).toThrow();
			expect(existsSync(join(dir, "board.db"))).toBe(false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the package surface removes both protocol packages and keeps Ajv in tests", () => {
	const root = join(import.meta.dir, "..");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const protocolScope = ["@model", "contextprotocol/"].join("");
	for (const packages of [pkg.dependencies, pkg.devDependencies]) {
		expect(
			Object.keys(packages).filter((name) => name.startsWith(protocolScope)),
		).toEqual([]);
	}
	const lock = readFileSync(join(root, "bun.lock"), "utf8");
	expect(lock).not.toContain(protocolScope);
	expect(pkg.dependencies.ajv).toBeUndefined();
	expect(pkg.devDependencies.ajv).toBe("8.20.0");
	expect(existsSync(join(root, "src", "mcp"))).toBe(false);
	expect(existsSync(join(root, "src", "cli", "mcp.ts"))).toBe(false);
});

test.skipIf(!process.env.BOARD_BIN)(
	"the binary refuses the removed command without creating a board",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "board-slice8-removal-bin-"));
		try {
			const boardDir = join(dir, "missing");
			const result = Bun.spawnSync([process.env.BOARD_BIN as string, "mcp"], {
				cwd: dir,
				env: { ...process.env, BOARD_DIR: boardDir },
				stdin: "ignore",
			});
			expect(result.exitCode).toBe(64);
			expect(result.stdout.toString()).toBe("");
			expect(result.stderr.toString()).toContain("mcp");
			expect(existsSync(boardDir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
