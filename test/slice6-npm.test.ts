import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const npmDir = process.env.BOARD_NPM;

test("package assembly copies bytes unchanged and derives all versions and exact optional dependencies from the repository", () => {
	const dir = mkdtempSync("/private/tmp/board-slice6-assemble-");
	try {
		const arm = join(dir, "arm with spaces");
		const x64 = join(dir, "x64 with spaces");
		const a = Buffer.from([0, 255, 17, 0, 128]);
		const b = Buffer.from([1, 254, 16, 0, 127]);
		writeFileSync(arm, a, { mode: 0o600 });
		writeFileSync(x64, b, { mode: 0o600 });
		const out = join(dir, "packages with spaces");
		const result = Bun.spawnSync([
			process.execPath,
			join(root, "tool", "npm-assemble.ts"),
			out,
			arm,
			x64,
		]);
		expect(result.exitCode).toBe(0);
		const version = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		).version;
		const main = JSON.parse(
			readFileSync(join(out, "board", "package.json"), "utf8"),
		);
		expect(main.version).toBe(version);
		expect(main.optionalDependencies).toEqual({
			"@chorded/board-darwin-arm64": version,
			"@chorded/board-darwin-x64": version,
		});
		for (const [arch, bytes] of [
			["arm64", a],
			["x64", b],
		] as const) {
			const pkg = JSON.parse(
				readFileSync(join(out, `board-darwin-${arch}`, "package.json"), "utf8"),
			);
			expect(pkg.version).toBe(version);
			expect(pkg.os).toEqual(["darwin"]);
			expect(pkg.cpu).toEqual([arch]);
			const bin = join(out, `board-darwin-${arch}`, "bin", "board");
			expect(readFileSync(bin)).toEqual(bytes);
			expect(statSync(bin).mode & 0o777).toBe(0o755);
		}
		const shim = join(out, "board", "bin", "board.js");
		expect(readFileSync(shim)).toEqual(
			readFileSync(join(root, "npm", "board", "bin", "board.js")),
		);
		expect(statSync(shim).mode & 0o777).toBe(0o755);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(npmDir === undefined)(
	"real Node shim reports missing or unstartable platform binaries and re-raises a child's signal",
	() => {
		const dir = mkdtempSync("/private/tmp/board-slice6-shim-");
		const node = join(npmDir as string, "node");
		try {
			const platform = Bun.spawnSync([
				node,
				"-p",
				"process.platform+'-'+process.arch",
			]);
			expect(platform.exitCode).toBe(0);
			const name = `@chorded/board-${platform.stdout.toString().trim()}`;
			const shimDir = join(dir, "node_modules", "@chorded", "board", "bin");
			mkdirSync(shimDir, { recursive: true });
			const shim = join(shimDir, "board.js");
			writeFileSync(
				shim,
				readFileSync(join(root, "npm", "board", "bin", "board.js")),
			);
			const run = () =>
				Bun.spawnSync([node, shim], {
					cwd: dir,
					env: { ...process.env, BOARD_DIR: join(dir, "board") },
				});
			const missing = run();
			expect(missing.exitCode).toBe(1);
			expect(missing.stdout.toString()).toBe("");
			expect(missing.stderr.toString()).toContain(`no ${name} is installed`);
			const binDir = join(dir, "node_modules", name, "bin");
			mkdirSync(binDir, { recursive: true });
			const binary = join(binDir, "board");
			writeFileSync(binary, "#!/bin/sh\nexit 7\n", { mode: 0o644 });
			const unstartable = run();
			expect(unstartable.exitCode).toBe(1);
			expect(unstartable.stderr.toString()).toContain("did not start");
			chmodSync(binary, 0o755);
			expect(run().exitCode).toBe(7);
			writeFileSync(binary, "#!/bin/sh\nkill -TERM $$\n");
			const signalled = run();
			expect(signalled.signalCode).toBe("SIGTERM");
			expect(signalled.exitCode).toBeNull();
			expect(signalled.stderr.toString()).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
