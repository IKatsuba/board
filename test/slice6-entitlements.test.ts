import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const entitlements = join(
	import.meta.dir,
	"..",
	"tool",
	"macos",
	"board.entitlements",
);
function plist(file: string) {
	const result = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", file]);
	expect(result.exitCode).toBe(0);
	return JSON.parse(result.stdout.toString());
}

test("the release entitlement plist grants exactly allow-jit", () => {
	expect(plist(entitlements)).toEqual({
		"com.apple.security.cs.allow-jit": true,
	});
});

test.skipIf(process.env.BOARD_SIGNED_BIN === undefined)(
	"signed binary verifies strictly, uses the owner's team and hardened runtime, and carries exactly the source entitlement",
	() => {
		const binary = process.env.BOARD_SIGNED_BIN as string;
		const dir = mkdtempSync("/private/tmp/board-slice6-signed-");
		try {
			const verified = Bun.spawnSync([
				"codesign",
				"--verify",
				"--strict",
				binary,
			]);
			expect(verified.exitCode).toBe(0);
			const identity = Bun.spawnSync([
				"codesign",
				"-dv",
				"--verbose=4",
				binary,
			]);
			expect(identity.exitCode).toBe(0);
			expect(identity.stderr.toString()).toContain("TeamIdentifier=YQ8ZD2KZ3T");
			expect(identity.stderr.toString()).toContain(
				"Identifier=dev.katsuba.board",
			);
			expect(identity.stderr.toString()).toContain("(runtime)");
			const readback = Bun.spawnSync([
				"codesign",
				"-d",
				"--entitlements",
				"-",
				"--xml",
				binary,
			]);
			expect(readback.exitCode).toBe(0);
			const file = join(dir, "actual.plist");
			writeFileSync(file, readback.stdout);
			expect(plist(file)).toEqual(plist(entitlements));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
