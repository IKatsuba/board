// The providers' upgrade() in process, against fake managers: shell scripts
// in a temporary directory that is the spawn's whole PATH. Nothing here
// reaches the registry, a real manager or a global install.
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
import type { Logger, Versions } from "@cliffy/upgrade";
import { registryError } from "../src/errors.ts";
import type { Manager } from "../src/upgrade/detect.ts";
import {
	managerProviders,
	NpmManager,
	type NpmManagerProvider,
} from "../src/upgrade/providers.ts";

// Records its argv and one variable of the environment it was given, then
// exits as FAKE_STATUS says: a number, or TERM to be killed by SIGTERM.
const FAKE = `#!/bin/sh
printf '%s\\n' "\${0##*/} $*" >> "$FAKE_LOG"
printf 'npm_config_registry=%s\\n' "$npm_config_registry" >> "$FAKE_LOG"
if [ "$FAKE_STATUS" = TERM ]; then kill -TERM $$; fi
exit "\${FAKE_STATUS:-0}"
`;

let dir: string;
let bin: string;
let empty: string;
let log: string;

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "board-upgrade-")));
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

function provider(
	manager: Manager,
	env: Record<string, string> = {},
): { provider: NpmManagerProvider; lines: Record<string, string[]> } {
	log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
	const lines: Record<string, string[]> = { log: [], info: [], error: [] };
	const logger: Logger = {
		log: (...data) => lines.log?.push(data.join(" ")),
		info: (...data) => lines.info?.push(data.join(" ")),
		warn: (...data) => lines.error?.push(data.join(" ")),
		error: (...data) => lines.error?.push(data.join(" ")),
	};
	const made = managerProviders({
		PATH: bin,
		FAKE_LOG: log,
		npm_config_registry: "http://127.0.0.1:9/",
		...env,
	})[manager];
	made.setLogger(logger);
	return { provider: made, lines };
}

const options = { name: "board", from: "0.1.0", to: "0.2.0" };
const recorded = () =>
	existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];

describe("upgrade()", () => {
	test.each([
		["npm", "npm install --global @chorded/board@0.2.0"],
		["bun", "bun add --global @chorded/board@0.2.0"],
		["pnpm", "pnpm add --global @chorded/board@0.2.0"],
		["yarn", "yarn global add @chorded/board@0.2.0"],
	] as const)(
		"%s: runs its manager with the environment as given",
		async (manager, argv) => {
			const { provider: made, lines } = provider(manager);
			expect(made.name).toBe(manager);
			await made.upgrade(options);
			expect(recorded()).toEqual([
				argv,
				"npm_config_registry=http://127.0.0.1:9/",
			]);
			expect(lines.log).toEqual([`$ ${argv}`]);
			expect(lines.info).toEqual([
				"From now on, each board command runs the board your PATH finds, which is 0.2.0 if PATH leads to the install just upgraded. A running board watch --follow keeps 0.1.0 until it is restarted.",
			]);
		},
	);

	test("a manager's non-zero exit is rejected, naming the argv and status", async () => {
		const { provider: made, lines } = provider("npm", { FAKE_STATUS: "3" });
		await expect(made.upgrade(options)).rejects.toThrow(
			"npm install --global @chorded/board@0.2.0 exited with status 3.",
		);
		expect(recorded()).toHaveLength(2);
		expect(lines.info).toEqual([]);
	});

	test("a manager killed by a signal is rejected, naming the signal", async () => {
		const { provider: made, lines } = provider("yarn", {
			FAKE_STATUS: "TERM",
		});
		await expect(made.upgrade(options)).rejects.toThrow(
			"yarn global add @chorded/board@0.2.0 was killed by SIGTERM.",
		);
		expect(lines.info).toEqual([]);
	});

	test("a manager missing from PATH says so", async () => {
		const { provider: made, lines } = provider("pnpm", { PATH: empty });
		await expect(made.upgrade(options)).rejects.toThrow(
			"pnpm is not on PATH. Install pnpm, or upgrade board with the manager that installed it (detected: pnpm).",
		);
		expect(lines.info).toEqual([]);
	});

	test("with no supported installation identified, it refuses and runs nothing", async () => {
		const { provider: made, lines } = provider("npm");
		made.unidentified = "/Users/me/src/board/build/darwin-arm64/board";
		await expect(made.upgrade(options)).rejects.toThrow(
			"board cannot identify a supported global installation from this executable path: /Users/me/src/board/build/darwin-arm64/board. If a package manager installed it, upgrade with that manager: npm install --global @chorded/board@0.2.0, bun add --global @chorded/board@0.2.0, pnpm add --global @chorded/board@0.2.0, or yarn global add @chorded/board@0.2.0. Not recognised: yarn with a custom --global-folder, npm link, and copies outside a manager's global directory.",
		);
		expect(recorded()).toEqual([]);
		expect(lines.log).toEqual([]);
	});
});

describe("the rest of the provider", () => {
	// Overrides only the listing, so nothing fetches.
	class Listed extends NpmManager {
		override getVersions(_name: string): Promise<Versions> {
			return Promise.resolve({ latest: "0.3.0", versions: ["0.3.0", "0.2.0"] });
		}
	}

	test("latest resolves to the exact latest version; any other passes through", async () => {
		const listed = new Listed({});
		expect(await listed.resolveVersion("board", "latest")).toBe("0.3.0");
		expect(await listed.resolveVersion("board", "0.2.0")).toBe("0.2.0");
	});

	test("hasRequiredPermissions answers false, so cliffy's version check never fetches", async () => {
		for (const made of Object.values(managerProviders({}))) {
			expect(await made.hasRequiredPermissions()).toBe(false);
		}
	});

	test("the registry refusal names the reason", () => {
		expect(
			registryError(
				new Error(
					"couldn't fetch the latest version - try again after sometime",
				),
			),
		).toEqual({
			code: "registry",
			message:
				"board could not read the versions of @chorded/board from registry.npmjs.org: couldn't fetch the latest version - try again after sometime",
			next: "Check the network and try again; nothing was changed.",
			details: {
				reason: "couldn't fetch the latest version - try again after sometime",
			},
		});
	});
});
