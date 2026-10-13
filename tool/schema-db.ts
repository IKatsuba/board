// Builds build/schema.db from DDL: the file `prisma db pull` and
// `prisma generate --sql` read, so the client is typed from Appendix A.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { DDL } from "../src/store/ddl.ts";

mkdirSync("build", { recursive: true });
rmSync("build/schema.db", { force: true });
const db = new Database("build/schema.db", { create: true, strict: true });
db.transaction(() => {
	for (const statement of DDL) db.run(statement);
})();
db.close();
