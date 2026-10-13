import { expect, test } from "bun:test";
import { installArgv } from "../src/upgrade/argv.ts";
import { detectManager } from "../src/upgrade/detect.ts";

test("overlapping layout markers use table precedence rather than their location in the path", () => {
	const npm =
		"/lib/node_modules/@chorded/board/node_modules/@chorded/board-darwin-x64";
	const yarn = "/yarn/global/node_modules/@chorded/board-darwin-arm64";
	const pnpm =
		"/global/v11/hash-0/node_modules/.pnpm/@chorded+board-darwin-arm64@1.2.3";
	const bun = "/install/global/node_modules/@chorded/board-darwin-arm64";
	expect(detectManager(`/prefix${npm}${yarn}/bin/board`)).toBe("yarn");
	expect(detectManager(`/prefix${yarn}${pnpm}/bin/board`)).toBe("pnpm");
	expect(detectManager(`/prefix${pnpm}${bun}/bin/board`)).toBe("bun");
	for (const cache of [
		"/_npx/cache/node_modules/@chorded/board-darwin-arm64",
		"/bunx-cache/node_modules/@chorded/board-darwin-arm64",
	]) {
		expect(detectManager(`/prefix${bun}${cache}/bin/board`)).toBeNull();
		expect(detectManager(`/prefix${cache}${npm}/bin/board`)).toBeNull();
	}
});

test("nearby package names and unsupported extra layout levels never guess a manager", () => {
	for (const path of [
		"/prefix/install/global/node_modules/@chorded/board/bin/board",
		"/prefix/install/global/node_modules/@chorded/board-darwinish-arm64/bin/board",
		"/prefix/lib/node_modules/@chorded/board-darwin-arm64/bin/board",
		"/prefix/global/v11/team/hash/node_modules/.pnpm/@chorded+board-darwin-arm64@1.2.3/bin/board",
		"/prefix/yarn/global/node_modules/@another/board-darwin-arm64/bin/board",
		"/prefix/lib/node_modules/@chorded/board/node_modules/@chorded/Board-darwin-arm64/bin/board",
	])
		expect(detectManager(path)).toBeNull();
});

test("each manager keeps an exact prerelease/build version in one argv element and returns independent arrays", () => {
	const version = "2.0.0-rc.1+build.17";
	for (const manager of ["npm", "bun", "pnpm", "yarn"] as const) {
		const first = installArgv(manager, version);
		expect(first.at(-1)).toBe(`@chorded/board@${version}`);
		expect(
			first.filter((arg) => arg.startsWith("@chorded/board@")),
		).toHaveLength(1);
		expect(first).not.toContain("--force");
		expect(first).not.toContain("--silent");
		expect(first.join(" ")).not.toMatch(/@\*|@latest/);
		first[0] = "mutated";
		expect(installArgv(manager, version)[0]).toBe(manager);
	}
});
