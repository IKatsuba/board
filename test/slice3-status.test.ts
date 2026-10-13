import { expect, test } from "bun:test";
import { Board } from "../src/board.ts";
import { stamp } from "../src/clock.ts";
import { Place } from "../src/place/place.ts";
import { addProject } from "../src/rules/projects.ts";
import { Store } from "../src/store/store.ts";

const start = new Date("2026-10-13T12:00:00.000Z");
const ctx = new Place("/test", {
	async commonDir() {
		throw new Error("Unexpected git");
	},
});

test("status keeps question/claim precedence and all aggregates within the project without sweeping", async () => {
	let now = start;
	const store = await Store.memory({ now: () => now });
	const board = new Board(store);
	try {
		await store.write({
			actor: "owner",
			resolve: async () => null,
			apply: async (tx, at) => {
				await addProject(tx, at, "owner", {
					key: "A",
					name: "Test",
					directory: "/test",
				});
				await addProject(tx, at, "owner", {
					key: "B",
					name: "Other",
					directory: "/other",
				});
			},
		});
		for (const title of ["Live blocked", "Expired blocked", "Answered"])
			await board.taskAdd(ctx, { actor: "tester", title });
		await board.taskAdd(ctx, {
			actor: "tester",
			project: "B",
			title: "Other project",
		});
		await board.taskClaim({
			actor: "live",
			key: "A-1",
			minutes: 30,
			directory: "/informational",
			branch: "branch",
		});
		await board.taskClaim({ actor: "expired", key: "A-2", minutes: 10 });
		await board.taskClaim({ actor: "outside", key: "B-1", minutes: 60 });
		await store.write({
			actor: "seed",
			resolve: async () => null,
			apply: async (tx, at) => {
				for (const [task_id, kind] of [
					[1, "open"],
					[1, "open"],
					[2, "open"],
					[3, "delegate"],
					[3, "validated"],
					[3, "owner"],
					[3, "withdrawn"],
					[4, "open"],
					[4, "delegate"],
				] as const) {
					const answered =
						kind === "delegate" || kind === "validated" || kind === "owner";
					await tx.question.create({
						data: {
							task_id,
							text: kind,
							options: '[{"label":"A"},{"label":"B"}]',
							recommended: 1,
							asked_by: "tester",
							asked_at: stamp(at),
							status: answered
								? "answered"
								: kind === "withdrawn"
									? "withdrawn"
									: "open",
							...(answered
								? {
										choice: 1,
										answered_by: "tester",
										answered_at: stamp(at),
										answered_as: kind === "owner" ? "owner" : "delegate",
									}
								: {}),
							...(kind === "validated"
								? { validated_by: "owner", validated_at: stamp(at) }
								: {}),
						},
					});
				}
			},
		});
		const eventCount = await store.read((tx) => tx.event.count());
		const lastA = await store.read((tx) =>
			tx.event.findFirstOrThrow({
				where: { project_id: 1 },
				orderBy: { id: "desc" },
			}),
		);
		now = new Date("2026-10-13T12:10:00.000Z");
		const status = await board.boardStatus(ctx, {});
		expect(status.counts).toEqual({
			backlog: 0,
			ready: 1,
			active: 0,
			blocked: 2,
			done: 0,
			cancelled: 0,
		});
		expect(status.questions).toEqual({ open: 3, to_validate: 1 });
		expect(status.claims).toMatchObject([
			{
				key: "A-1",
				holder: "live",
				minutes_left: 20,
				directory: "/informational",
				branch: "branch",
			},
		]);
		expect(status.last_event).toBe(lastA.id);
		expect(await store.read((tx) => tx.claim.count())).toBe(3);
		expect(await store.read((tx) => tx.event.count())).toBe(eventCount);
		const other = await board.boardStatus(ctx, { project: "b" });
		expect(other.questions).toEqual({ open: 1, to_validate: 1 });
		expect(other.claims.map((claim) => claim.key)).toEqual(["B-1"]);
	} finally {
		await board.close();
	}
});

test("an event-free project reports a zero cursor and every zero count", async () => {
	const store = await Store.memory({ now: () => start });
	const board = new Board(store);
	try {
		await store.write({
			actor: "seed",
			resolve: async () => null,
			apply: (tx) =>
				tx.project.create({
					data: {
						key: "A",
						name: "Test",
						directory: "/test",
						created_at: stamp(start),
						created_by: "owner",
					},
				}),
		});
		expect(await board.boardStatus(ctx, {})).toMatchObject({
			last_event: 0,
			counts: {
				backlog: 0,
				ready: 0,
				active: 0,
				blocked: 0,
				done: 0,
				cancelled: 0,
			},
			milestones: [],
			current: null,
			claims: [],
			questions: { open: 0, to_validate: 0 },
		});
	} finally {
		await board.close();
	}
});
