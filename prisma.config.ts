import { defineConfig } from "prisma/config";

// build/schema.db is made from src/store/ddl.ts by `bun run schema:db`; the
// pull and the TypedSQL types are read from it, never from a user's board.
export default defineConfig({
	schema: "prisma/schema.prisma",
	datasource: { url: "file:./build/schema.db" },
});
