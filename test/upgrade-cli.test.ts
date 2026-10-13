// `board upgrade` end to end, in a subprocess (cliffy exits the process),
// through test/helpers/upgrade-cli.ts: a pretend install path, fake managers
// in a temporary directory that is the whole PATH, and providers whose
// listing is canned. Nothing here reaches the registry, a real manager or a
// global install.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const helper = join(root, "test", "helpers", "upgrade-cli.ts");

// Records its argv, then exits as FAKE_STATUS says: a number, or SLEEP to
// wait to be interrupted.
const FAKE = `#!/bin/sh
printf '%s\\n' "\${0##*/} $*" >> "$FAKE_LOG"
if [ "$FAKE_STATUS" = SLEEP ]; then /bin/sleep 30; fi
exit "\${FAKE_STATUS:-0}"
`;

const plat = "@chorded/board-darwin-arm64/bin/board";
const layouts = {
	npm: `/lib/node_modules/@chorded/board/node_modules/${plat}`,
	bun: `/.bun/install/global/node_modules/${plat}`,
	pnpm: `/pnpm/global/5/node_modules/.pnpm/@chorded+board-darwin-arm64@0.1.0/node_modules/${plat}`,
	yarn: `/.config/yarn/global/node_modules/${plat}`,
} as const;
const argvOf = {
	npm: "npm install --global @chorded/board@0.2.0",
	bun: "bun add --global @chorded/board@0.2.0",
	pnpm: "pnpm add --global @chorded/board@0.2.0",
	yarn: "yarn global add @chorded/board@0.2.0",
} as const;
const listed = JSON.stringify({
	latest: "0.2.0",
	versions: ["0.2.0", "0.1.0"],
});
const offline = JSON.stringify({ offline: "Unable to connect." });

let dir: string;
let bin: string;
let empty: string;
let n = 0;

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-upgrade-cli-")));
	bin = join(dir, "bin");
	empty = join(dir, "empty");
	mkdirSync(bin);
	mkdirSync(empty);
	for (const manager of ["npm", "bun", "pnpm", "yarn"]) {
		writeFileSync(join(bin, manager), FAKE);
		chmodSync(join(bin, manager), 0o755);
	}
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function envFor(log: string, extra: Record<string, string> = {}) {
	return {
		PATH: bin,
		HOME: join(dir, "home"),
		FAKE_LOG: log,
		...extra,
	};
}

/** Runs the helper once; answers its output and what the fakes recorded. */
function run(
	install: string,
	versions: string,
	argv: string[],
	extra: Record<string, string> = {},
) {
	const log = join(dir, `log-${n++}`);
	const out = Bun.spawnSync(
		[process.execPath, helper, install, versions, ...argv],
		{ cwd: dir, env: envFor(log, extra) },
	);
	return {
		code: out.exitCode,
		stdout: out.stdout.toString(),
		stderr: out.stderr.toString(),
		log: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
	};
}

const at = (manager: keyof typeof layouts) => `${dir}${layouts[manager]}`;

describe("board upgrade", () => {
	test.each(Object.keys(layouts) as (keyof typeof layouts)[])(
		"%s's install upgrades through %s, with no versions read under -f --version",
		(manager) => {
			const ran = run(at(manager), offline, [
				"upgrade",
				"-f",
				"--version",
				"0.2.0",
			]);
			expect(ran.stderr).toBe("");
			expect(ran.code).toBe(0);
			expect(ran.log).toEqual([argvOf[manager]]);
			expect(ran.stdout).toBe(
				`From now on, each board command runs the board your PATH finds, which is 0.2.0 if PATH leads to the install just upgraded. A running board watch --follow keeps ${pkg.version} until it is restarted.\nSuccessfully upgraded board from version ${pkg.version} to 0.2.0! (https://npmjs.org/package/@chorded/board/v/0.2.0)\n`,
			);
		},
	);

	test("latest is upgraded to as its exact version", () => {
		const ran = run(at("bun"), listed, ["upgrade"]);
		expect(ran.code).toBe(0);
		// isOutdated, then resolveVersion.
		expect(ran.log).toEqual(["getVersions", "getVersions", argvOf.bun]);
	});

	test("-v shows the argv before the manager runs", () => {
		const ran = run(at("npm"), listed, ["upgrade", "-v"]);
		expect(ran.code).toBe(0);
		expect(ran.stdout).toContain(`$ ${argvOf.npm}\n`);
	});

	test("the manager's failure fails the upgrade, exit 1", () => {
		const ran = run(at("npm"), listed, ["upgrade"], { FAKE_STATUS: "3" });
		expect(ran.code).toBe(1);
		expect(ran.stdout).toBe("");
		expect(ran.stderr).toBe(
			`Failed to upgrade board from version ${pkg.version} to 0.2.0.\n${argvOf.npm} exited with status 3.\n`,
		);
	});

	test("a missing manager fails the upgrade, exit 1", () => {
		const ran = run(at("pnpm"), listed, ["upgrade"], { PATH: empty });
		expect(ran.code).toBe(1);
		expect(ran.stderr).toContain(
			"pnpm is not on PATH. Install pnpm, or upgrade board with the manager that installed it (detected: pnpm).\n",
		);
	});

	test("already the latest: a warning, no manager run, exit 0", () => {
		const latest = JSON.stringify({
			latest: pkg.version,
			versions: [pkg.version],
		});
		const ran = run(at("npm"), latest, ["upgrade"]);
		expect(ran.code).toBe(0);
		expect(ran.log).toEqual(["getVersions"]);
		expect(ran.stderr).toBe(
			`You're already using the latest available version ${pkg.version} of board.\n`,
		);
	});

	test("an unknown version: no manager run, exit 1", () => {
		const ran = run(at("npm"), listed, ["upgrade", "--version", "9.9.9"]);
		expect(ran.code).toBe(1);
		expect(ran.log).toEqual(["getVersions"]);
		expect(ran.stderr).toContain("9.9.9");
	});

	test("no supported installation: the refusal, nothing run, exit 1", () => {
		const ran = run(join(dir, "copy", "board"), offline, [
			"upgrade",
			"-f",
			"--version",
			"0.2.0",
		]);
		expect(ran.code).toBe(1);
		expect(ran.log).toEqual([]);
		expect(ran.stderr).toContain(
			`board cannot identify a supported global installation from this executable path: ${join(dir, "copy", "board")}.`,
		);
	});

	test("-l lists the versions, exit 0", () => {
		const ran = run(at("npm"), listed, ["upgrade", "-l"]);
		expect(ran.code).toBe(0);
		expect(ran.stdout).toContain("0.2.0");
		expect(ran.stdout).toContain("0.1.0");
	});

	test("-l offline is the registry refusal, exit 1", () => {
		const ran = run(at("npm"), offline, ["upgrade", "-l"]);
		expect(ran.code).toBe(1);
		expect(ran.stderr).toBe(
			"board: registry: board could not read the versions of @chorded/board from registry.npmjs.org: Unable to connect. Check the network and try again; nothing was changed.\n",
		);
	});

	test("offline during an upgrade: the refusal's message, exit 1", () => {
		const ran = run(at("npm"), offline, ["upgrade"]);
		expect(ran.code).toBe(1);
		expect(ran.log).toEqual(["getVersions"]);
		expect(ran.stderr).toBe(
			"board could not read the versions of @chorded/board from registry.npmjs.org: Unable to connect.\n",
		);
	});

	test("help shows no -r, and neither help nor --version reads the versions", () => {
		const help = run(at("npm"), offline, ["upgrade", "--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("--list-versions");
		expect(help.stdout).not.toContain("--registry");
		for (const argv of [
			["--help"],
			["ls", "--help"],
			["help"],
			["help", "upgrade"],
			["--version"],
		]) {
			const ran = run(at("npm"), offline, argv);
			expect(ran.code).toBe(0);
			expect(ran.log).toEqual([]);
		}
	});

	test("Ctrl-C during the install ends board and the manager by SIGINT", async () => {
		const log = join(dir, `log-${n++}`);
		const child = Bun.spawn(
			[process.execPath, helper, at("npm"), listed, "upgrade"],
			{
				cwd: dir,
				env: envFor(log, { FAKE_STATUS: "SLEEP" }),
				stdout: "ignore",
				stderr: "ignore",
				detached: true,
			},
		);
		try {
			const deadline = Date.now() + 10_000;
			while (
				!(existsSync(log) && readFileSync(log, "utf8").includes("npm ")) &&
				Date.now() < deadline
			) {
				await Bun.sleep(50);
			}
			const manager = Bun.spawnSync(["pgrep", "-g", String(child.pid), "sh"])
				.stdout.toString()
				.trim();
			expect(manager).not.toBe("");
			// The terminal sends Ctrl-C to the whole foreground group.
			process.kill(-child.pid, "SIGINT");
			await child.exited;
			expect(child.signalCode).toBe("SIGINT");
			const left = Bun.spawnSync(["pgrep", "-g", String(child.pid)])
				.stdout.toString()
				.trim();
			expect(left).toBe("");
		} finally {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}
	}, 20_000);

	test("bun src/main.ts upgrade: nothing identified, the refusal, nothing run", () => {
		const log = join(dir, `log-${n++}`);
		const out = Bun.spawnSync(
			[
				process.execPath,
				join(root, "src", "main.ts"),
				"upgrade",
				"-f",
				"--version",
				"0.2.0",
			],
			{ cwd: dir, env: envFor(log) },
		);
		expect(out.exitCode).toBe(1);
		expect(out.stderr.toString()).toContain(
			`board cannot identify a supported global installation from this executable path: ${realpathSync(process.execPath)}.`,
		);
		expect(existsSync(log)).toBe(false);
	});
});
