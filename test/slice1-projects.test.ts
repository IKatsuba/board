import { expect, test } from "bun:test";
import { Board } from "../src/board.ts";
import { stamp } from "../src/clock.ts";
import { Place } from "../src/place/place.ts";
import { chain } from "../src/rules/milestones.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";

const now = new Date("2026-10-13T12:00:00.000Z");

async function fixture() {
	const store = await Store.memory({ now: () => now });
	await store.write({
		actor: "owner",
		resolve: async () => null,
		apply: (tx, at) =>
			addProject(tx, at, "owner", {
				key: "T",
				name: "Test",
				directory: "/work/main",
			}),
	});
	return { store, board: new Board(store) };
}

test("git runs after rollback and the retry sees a project removed during git", async () => {
	const { store, board } = await fixture();
	let calls = 0;
	const place = new Place("/work/linked/sub", {
		async commonDir() {
			calls++;
			// A second transaction can run only if the resolving read has ended.
			await store.write({
				actor: "owner",
				resolve: async () => null,
				apply: async (tx) => {
					await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
					await tx.project.delete({ where: { key: "T" } });
					await tx.event.deleteMany({ where: { project_id: 1 } });
				},
			});
			return { kind: "exit", code: 0, stdout: "/work/main/.git\n", stderr: "" };
		},
	});
	try {
		expect(await board.projectList(place)).toEqual({
			projects: [],
			here: null,
		});
		expect(calls).toBe(1);
	} finally {
		await board.close();
	}
});

test("cwd matching uses freshly read directories on the next call without git", async () => {
	const { store, board } = await fixture();
	const place = new Place("/work/main/sub", {
		async commonDir() {
			throw new Error("cwd should have matched");
		},
	});
	try {
		expect((await board.projectList(place)).here).toBe("T");
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: (tx, at) =>
				addProject(tx, at, "owner", {
					key: "N",
					name: "Nested",
					directory: "/work/main/sub",
				}),
		});
		expect((await board.projectList(place)).here).toBe("N");
	} finally {
		await board.close();
	}
});

test("empty milestones remain open and an all-closed chain has no current", async () => {
	const { store, board } = await fixture();
	try {
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: async (tx) => {
				for (let position = 1; position <= 3; position++) {
					await tx.milestone.create({
						data: {
							id: position,
							project_id: 1,
							name: `v${position}`,
							delivers: "Fixture",
							position,
							created_at: stamp(now),
							created_by: "owner",
						},
					});
				}
				for (const [number, status, milestone_id] of [
					[1, "done", 1],
					[2, "cancelled", 1],
					[3, "done", 3],
				] as const) {
					await tx.task.create({
						data: {
							project_id: 1,
							number,
							title: "Closed",
							status,
							milestone_id,
							created_at: stamp(now),
							created_by: "owner",
						},
					});
				}
			},
		});
		expect(
			(await store.read((tx) => chain(tx, 1))).map((link) => link.status),
		).toEqual(["done", "current", "done"]);
		const place = new Place("/work/main", {
			async commonDir() {
				throw new Error("Unexpected git");
			},
		});
		expect((await board.projectList(place)).projects[0]?.current).toEqual({
			name: "v2",
			position: 2,
			of: 3,
			left: 0,
		});
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: (tx) =>
				tx.task.create({
					data: {
						project_id: 1,
						number: 4,
						title: "Cancelled",
						status: "cancelled",
						milestone_id: 2,
						created_at: stamp(now),
						created_by: "owner",
					},
				}),
		});
		expect((await board.projectList(place)).projects[0]).toMatchObject({
			open: 0,
			closed: 4,
			current: null,
		});
	} finally {
		await board.close();
	}
});
