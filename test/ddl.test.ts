import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { DDL } from "../src/store/ddl.ts";

test("Appendix A is 22 statements, each run on its own", () => {
	expect(DDL).toHaveLength(22);
	const db = new Database(":memory:", { strict: true });
	for (const statement of DDL) db.run(statement);
	const objects = db
		.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master")
		.get();
	expect(objects?.n).toBe(28);
	expect(
		db.query<{ application_id: number }, []>("PRAGMA application_id").get()
			?.application_id,
	).toBe(0x424f5244);
	expect(
		db.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version,
	).toBe(1);
	db.close();
});
