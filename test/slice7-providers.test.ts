import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Versions } from "@cliffy/upgrade";
import { registryError } from "../src/errors.ts";
import { errorShape } from "../src/schemas.ts";
import { NpmManager } from "../src/upgrade/providers.ts";
import { expectValid } from "./helpers/schema.ts";

test("all fake managers inherit stdin/output and exactly the supplied environment; success follows their output", () => {
	const dir = mkdtempSync("/private/tmp/board-slice7-provider-stdio-");
	const version = "2.0.0-rc.1+build.17";
	try {
		for (const manager of ["npm", "bun", "pnpm", "yarn"] as const)
			writeFileSync(
				join(dir, manager),
				`#!/bin/sh
IFS= read -r input
printf 'manager stdout: %s\\n' "$input"
printf 'manager stderr progress\\n' >&2
printf '%s\\n' "$@" > "$TASK_ARGV"
printf '%s\\n' "$npm_config_prefix" "$npm_config_registry" "$BUN_INSTALL" "$PNPM_HOME" "\${TASK_EMPTY+set}:$TASK_EMPTY" "\${TASK_PARENT_ONLY-unset}" > "$TASK_ENV"
`,
				{ mode: 0o755 },
			);
		const script = join(dir, "runner.ts");
		writeFileSync(
			script,
			`import {managerProviders} from ${JSON.stringify(join(import.meta.dir, "..", "src", "upgrade", "providers.ts"))};
const [manager,dir,to]=process.argv.slice(2);
const env={PATH:dir,TASK_ARGV:dir+"/argv",TASK_ENV:dir+"/env",npm_config_prefix:dir+"/another prefix",npm_config_registry:"https://mirror.invalid/",BUN_INSTALL:dir+"/other bun",PNPM_HOME:dir+"/other pnpm",TASK_EMPTY:""};
const provider=managerProviders(env)[manager];
provider.setLogger({log:()=>{},info:message=>console.log(message),warn:message=>console.error(message),error:message=>console.error(message)});
await provider.upgrade({name:"board",from:"1.0.0",to});
`,
		);
		for (const manager of ["npm", "bun", "pnpm", "yarn"] as const) {
			const result = Bun.spawnSync(
				[process.execPath, script, manager, dir, version],
				{
					stdin: new TextEncoder().encode("answer 😀 with spaces\n"),
					env: { ...process.env, TASK_PARENT_ONLY: "must not inherit" },
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toBe(
				`manager stdout: answer 😀 with spaces\nFrom now on, each board command runs the board your PATH finds, which is ${version} if PATH leads to the install just upgraded. A running board watch --follow keeps 1.0.0 until it is restarted.\n`,
			);
			expect(result.stderr.toString()).toBe("manager stderr progress\n");
			const command =
				manager === "npm"
					? ["install", "--global"]
					: manager === "yarn"
						? ["global", "add"]
						: ["add", "--global"];
			expect(
				readFileSync(join(dir, "argv"), "utf8").trim().split("\n"),
			).toEqual([...command, `@chorded/board@${version}`]);
			expect(readFileSync(join(dir, "env"), "utf8").trim().split("\n")).toEqual(
				[
					join(dir, "another prefix"),
					"https://mirror.invalid/",
					join(dir, "other bun"),
					join(dir, "other pnpm"),
					"set:",
					"unset",
				],
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 15_000);

test("exact versions never list and latest is resolved freshly through the sole overridden getVersions", async () => {
	class Listed extends NpmManager {
		calls = 0;
		latest = "2.0.0-rc.1";
		override async getVersions(_name: string): Promise<Versions> {
			this.calls++;
			return { latest: this.latest, versions: [this.latest] };
		}
	}
	const provider = new Listed({ PATH: "/no-managers" });
	expect(await provider.hasRequiredPermissions()).toBe(false);
	expect(provider.calls).toBe(0);
	expect(await provider.resolveVersion("board", "1.2.3+build.4")).toBe(
		"1.2.3+build.4",
	);
	expect(provider.calls).toBe(0);
	expect(await provider.resolveVersion("board", "latest")).toBe("2.0.0-rc.1");
	expect(provider.calls).toBe(1);
	provider.latest = "2.0.0";
	expect(await provider.resolveVersion("board", "latest")).toBe("2.0.0");
	expect(provider.calls).toBe(2);
});

test("registry Error and plain reasons validate as a refusal, without contacting a registry", async () => {
	for (const reason of [new Error("connection refused"), "offline"]) {
		const error = registryError(reason);
		expect(error.code).toBe("registry");
		expect(error.details).toEqual({
			reason: reason instanceof Error ? reason.message : reason,
		});
		expectValid(errorShape, {
			error,
		});
		expect(error.next).toContain("nothing was changed");
	}
});
