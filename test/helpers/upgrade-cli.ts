// `board upgrade` in a subprocess, since cliffy exits the process after a
// failure and after -l. Builds Deps as src/main.ts does, except for what
// comes from the arguments:
//   upgrade-cli.ts EXEC_PATH VERSIONS ARGV…
// EXEC_PATH is the install path to pretend to run from. VERSIONS is "-" for
// the production providers, or JSON for test providers that override only
// getVersions: {"latest", "versions"} to answer, {"offline": REASON} to fail
// as the registry refusal. Each test getVersions appends "getVersions" to
// $FAKE_LOG, so a test can count the fetches that would have been made.
import { appendFileSync } from "node:fs";
import type { Versions } from "@cliffy/upgrade";
import { setColorEnabled } from "@jsr/std__fmt/colors";
import { runCli } from "../../src/cli/root.ts";
import { SystemClock } from "../../src/clock.ts";
import { boardEnv } from "../../src/env.ts";
import { Refusal, registryError } from "../../src/errors.ts";
import { ProcessGitRunner } from "../../src/place/git.ts";
import {
	BunManager,
	managerProviders,
	NpmManager,
	PnpmManager,
	YarnManager,
} from "../../src/upgrade/providers.ts";

type Canned = { latest: string; versions: string[] } | { offline: string };

const [execPath, versions, ...argv] = process.argv.slice(2) as [
	string,
	string,
	...string[],
];
const env = process.env;

const answer: Canned | null =
	versions === "-" ? null : (JSON.parse(versions) as Canned);

function listing(): Promise<Versions> {
	appendFileSync(env.FAKE_LOG as string, "getVersions\n");
	if (answer === null || "offline" in answer) {
		return Promise.reject(
			new Refusal(registryError(new Error(answer?.offline ?? "none"))),
		);
	}
	return Promise.resolve(answer);
}

class TestNpm extends NpmManager {
	override getVersions(_name: string) {
		return listing();
	}
}
class TestBun extends BunManager {
	override getVersions(_name: string) {
		return listing();
	}
}
class TestPnpm extends PnpmManager {
	override getVersions(_name: string) {
		return listing();
	}
}
class TestYarn extends YarnManager {
	override getVersions(_name: string) {
		return listing();
	}
}

const deps = {
	io: {
		out: (text: string) => process.stdout.write(`${text}\n`),
		err: (text: string) => process.stderr.write(`${text}\n`),
		errRaw: (chunk: Uint8Array | string) => process.stderr.write(chunk),
	},
	env: boardEnv(env),
	clock: SystemClock,
	runner: new ProcessGitRunner(),
	cwd: process.cwd(),
	colors: process.stdout.isTTY === true,
	exitCode: 0,
	environment: env,
	upgrade: {
		execPath,
		providers:
			answer === null
				? managerProviders(env)
				: {
						npm: new TestNpm(env),
						bun: new TestBun(env),
						pnpm: new TestPnpm(env),
						yarn: new TestYarn(env),
					},
	},
};

setColorEnabled(deps.colors);
process.exitCode = await runCli(argv, deps);
