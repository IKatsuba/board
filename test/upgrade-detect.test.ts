import { describe, expect, test } from "bun:test";
import { installArgv } from "../src/upgrade/argv.ts";
import { detectManager } from "../src/upgrade/detect.ts";

const plat = "@chorded/board-darwin-arm64/bin/board";

describe("detectManager", () => {
	test.each([
		[
			"npm under nvm",
			`/Users/me/.nvm/versions/node/v24.13.0/lib/node_modules/@chorded/board/node_modules/${plat}`,
			"npm",
		],
		[
			"npm under Homebrew",
			`/opt/homebrew/lib/node_modules/@chorded/board/node_modules/${plat}`,
			"npm",
		],
		[
			"npm under /usr/local (x64)",
			"/usr/local/lib/node_modules/@chorded/board/node_modules/@chorded/board-darwin-x64/bin/board",
			"npm",
		],
		[
			"npm under a custom prefix",
			`/private/tmp/upg/npm-prefix/lib/node_modules/@chorded/board/node_modules/${plat}`,
			"npm",
		],
		[
			"npm under fnm",
			`/Users/me/.local/share/fnm/node-versions/v24.13.0/installation/lib/node_modules/@chorded/board/node_modules/${plat}`,
			"npm",
		],
		[
			"npm under Volta",
			`/Users/me/.volta/tools/image/node/24.13.0/lib/node_modules/@chorded/board/node_modules/${plat}`,
			"npm",
		],
		[
			"bun, default BUN_INSTALL",
			`/Users/me/.bun/install/global/node_modules/${plat}`,
			"bun",
		],
		[
			"bun, another BUN_INSTALL",
			`/opt/bun/install/global/node_modules/${plat}`,
			"bun",
		],
		[
			"pnpm 10",
			`/Users/me/Library/pnpm/global/5/node_modules/.pnpm/@chorded+board-darwin-arm64@0.2.0/node_modules/${plat}`,
			"pnpm",
		],
		[
			"pnpm 12",
			`/Users/me/Library/pnpm/global/v11/a1b2c3-0/node_modules/.pnpm/@chorded+board-darwin-arm64@0.2.0/node_modules/${plat}`,
			"pnpm",
		],
		[
			"yarn classic, default folder",
			`/Users/me/.config/yarn/global/node_modules/${plat}`,
			"yarn",
		],
		[
			"yarn classic under XDG_CONFIG_HOME",
			`/Users/me/.xdg/yarn/global/node_modules/${plat}`,
			"yarn",
		],
	] as const)("%s → %s", (_, path, manager) => {
		expect(detectManager(path)).toBe(manager);
	});

	test.each([
		["a development build", "/Users/me/src/board/build/darwin-arm64/board"],
		["a copy", "/Users/me/bin/board"],
		["a local install", `/Users/me/project/node_modules/${plat}`],
		["the bun executable", "/Users/me/.bun/bin/bun"],
		[
			"a Bun under a global node_modules",
			"/Users/me/.bun/install/global/node_modules/bun/bin/bun",
		],
		[
			"a Node under npm's lib",
			"/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
		],
		["npx", `/Users/me/.npm/_npx/0123abcd/node_modules/${plat}`],
		[
			"npx, nested under the main package",
			`/Users/me/.npm/_npx/0123abcd/node_modules/@chorded/board/node_modules/${plat}`,
		],
		[
			"bunx",
			`/private/var/folders/x/T/bunx-501-board@latest/node_modules/${plat}`,
		],
		// Row 2 is checked before the bun row: a bunx cache never reads as bun.
		[
			"bunx under a global-looking folder",
			`/Users/me/.bun/install/global/bunx-501-board/node_modules/${plat}`,
		],
		[
			"yarn with a custom global folder",
			`/Users/me/yarn-global/node_modules/${plat}`,
		],
	] as const)("%s → none", (_, path) => {
		expect(detectManager(path)).toBeNull();
	});
});

describe("installArgv", () => {
	test.each([
		["npm", ["npm", "install", "--global", "@chorded/board@0.2.0"]],
		["bun", ["bun", "add", "--global", "@chorded/board@0.2.0"]],
		["pnpm", ["pnpm", "add", "--global", "@chorded/board@0.2.0"]],
		["yarn", ["yarn", "global", "add", "@chorded/board@0.2.0"]],
	] as const)("%s", (manager, argv) => {
		expect(installArgv(manager, "0.2.0")).toEqual([...argv]);
	});

	test("no argv carries @* or @latest, nor --force or --silent", () => {
		for (const manager of ["npm", "bun", "pnpm", "yarn"] as const) {
			const argv = installArgv(manager, "1.2.3").join(" ");
			expect(argv).not.toMatch(/@\*|@latest|--force|--silent/);
			expect(argv).toContain("@chorded/board@1.2.3");
		}
	});
});
