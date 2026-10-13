import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/cli/io.ts";
import { buildCli, runCli } from "../src/cli/root.ts";
import { commandIndex, skillText } from "../src/cli/skill.ts";
import { errorShape } from "../src/schemas.ts";

function deps() {
	const out: string[] = [];
	const err: string[] = [];
	const dependencies: Deps = {
		io: { out: (text) => out.push(text), err: (text) => err.push(text) },
		get env(): Deps["env"] {
			throw new Error("Skill read the environment");
		},
		get cwd(): string {
			throw new Error("Skill read the cwd");
		},
		clock: {
			now: () => {
				throw new Error("Skill read the clock");
			},
		},
		runner: {
			commonDir: async () => {
				throw new Error("Skill ran git");
			},
		},
		colors: false,
		exitCode: 0,
	};
	return { out, err, dependencies };
}

test("skill succeeds without consulting environment, cwd, clock or git", async () => {
	const d = deps();
	expect(await runCli(["skill"], d.dependencies)).toBe(0);
	expect(d.err).toEqual([]);
	expect(d.out).toHaveLength(1);
	const text = d.out[0] as string;
	expect(text).toStartWith("# Working on a board");
	for (const code of errorShape.properties.error.properties.code.enum)
		expect(text).toContain(`| \`${code}\` |`);
	expect(text).toContain("main");
	expect(text).toContain("--actor");
	expect(text).toContain("--minutes");
	expect(text).toContain("--follow");
});

test("skill takes neither a role nor JSON and rejects both before consulting storage", async () => {
	for (const argv of [
		["skill", "main"],
		["skill", "--json"],
		["skill", "--role", "main"],
	]) {
		const d = deps();
		expect(await runCli(argv, d.dependencies)).toBe(64);
		expect(d.out).toEqual([]);
		expect(d.err).toHaveLength(1);
		expect(d.err[0]).toStartWith("board: usage: ");
		expect(() => JSON.parse(d.err[0] as string)).toThrow();
	}
});

test("the generated index names all 25 work commands once and follows nested additions", () => {
	const root = buildCli(deps().dependencies);
	const names = commandIndex(root)
		.split("\n")
		.map((line) => line.trim().split(/ {2,}/)[0]);
	const expected = [
		"project add",
		"project ls",
		"project edit",
		"project rm",
		"status",
		"ls",
		"show",
		"next",
		"add",
		"edit",
		"claim",
		"extend",
		"release",
		"comment",
		"handover",
		"ask",
		"questions",
		"answer",
		"validate",
		"milestone ls",
		"milestone add",
		"milestone edit",
		"milestone rm",
		"watch",
		"sql",
	].map((name) => `board ${name}`);
	// The index's spacing is a presentation detail; membership is the contract.
	expect(names.sort()).toEqual(expected.sort());
	expect(new Set(names).size).toBe(25);
	const project = root.getCommand("project");
	expect(project).toBeDefined();
	project?.command("probe", "A temporary nested leaf for the generator test.");
	const changed = commandIndex(root);
	expect(changed).toContain("board project probe");
	expect(changed).toContain("A temporary nested leaf for the generator test.");
	expect(skillText(root)).toContain(changed);
	expect(changed).not.toMatch(/board (help|upgrade|skill)\b/);
});

test.skipIf(!process.env.BOARD_BIN)(
	"compiled skill returns with open stdin and an unusable board location",
	async () => {
		const dir = realpathSync(
			mkdtempSync(join(tmpdir(), "board-slice8-skill-bin-")),
		);
		let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
		try {
			const missing = join(dir, "missing");
			child = Bun.spawn([process.env.BOARD_BIN as string, "skill"], {
				cwd: dir,
				env: { ...process.env, BOARD_DIR: missing, HOME: "" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, text, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(0);
			expect(error).toBe("");
			expect(text).toStartWith("# Working on a board");
			expect(existsSync(missing)).toBe(false);
			const d = deps();
			await runCli(["skill"], d.dependencies);
			expect(text).toBe(`${d.out[0]}\n`);
			const relative = Bun.spawnSync(
				[process.env.BOARD_BIN as string, "skill"],
				{
					cwd: dir,
					env: { ...process.env, BOARD_DIR: "relative", HOME: "" },
					stdin: "ignore",
				},
			);
			expect(relative.exitCode).toBe(0);
			expect(relative.stderr.toString()).toBe("");
			expect(relative.stdout.toString()).toBe(text);
			expect(existsSync(join(dir, "relative"))).toBe(false);
		} finally {
			if (child) {
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	},
	10000,
);
