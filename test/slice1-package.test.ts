import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import manifest from "../package.json";
import config from "../prisma.config.ts";

test("the repository package cannot be published as the distribution package", () => {
	expect(manifest.private).toBe(true);
});

test("generation, checks and tests use the ordered design pipeline", () => {
	expect(manifest.scripts["schema:db"]).toBe("bun tool/schema-db.ts");
	expect(manifest.scripts["schema:pull"]).toBe("prisma db pull");
	expect(manifest.scripts.gen).toBe(
		"bun run schema:db && bun run schema:pull && prisma generate --sql",
	);
	expect(manifest.scripts.test).toBe("bun run gen && bun test");
	expect(manifest.scripts.check).toBe(
		"bun run gen && git diff --exit-code prisma/schema.prisma && tsc --noEmit && biome ci . && bun test",
	);
});

test("schema introspection targets the generated database rather than a board", () => {
	expect(config.schema).toBe("prisma/schema.prisma");
	expect(config.datasource?.url).toBe("file:./build/schema.db");
});

test("cliffy resolves through the JSR npm registry", () => {
	expect(
		readFileSync(new URL("../.npmrc", import.meta.url), "utf8").trim(),
	).toBe("@jsr:registry=https://npm.jsr.io");
	expect(manifest.dependencies["@cliffy/command"]).toBe(
		"npm:@jsr/cliffy__command@1.3.1",
	);
	expect(manifest.dependencies["@cliffy/table"]).toBe(
		"npm:@jsr/cliffy__table@1.3.1",
	);
});
