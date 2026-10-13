// A dense acyclic web of waits, then one more wait into it that closes no
// loop: run in its own process, so that a walk exponential in the routes is
// killed by the test's timeout instead of hanging the suite.
import { Board } from "../../src/board.ts";
import { SystemClock } from "../../src/clock.ts";
import { ProcessGitRunner } from "../../src/place/git.ts";
import { Place } from "../../src/place/place.ts";
import { addProject } from "../../src/rules/projects.ts";
import { Store } from "../../src/store/store.ts";

const n = Number(process.argv[2] ?? 27);
const store = await Store.memory(SystemClock);
const board = new Board(store);
await store.write({
	actor: "owner",
	resolve: async () => null,
	apply: (tx, now) =>
		addProject(tx, now, "owner", { key: "A", name: "a", directory: "/w/a" }),
});
const ctx = new Place("/w/a", new ProcessGitRunner());
// A-k waits for every A-j with j < k, so A-n reaches A-1 by 2^(n-2) routes.
for (let k = 1; k <= n; k++) {
	const waits = Array.from({ length: k - 1 }, (_, j) => `A-${j + 1}`);
	await board.taskAdd(ctx, {
		actor: "main",
		project: "A",
		title: `t${k}`,
		waits,
	});
}
console.log("seeded");
const started = performance.now();
await board.taskAdd(ctx, { actor: "main", project: "A", title: "last" });
const got = await board.taskUpdate({
	actor: "main",
	key: `A-${n + 1}`,
	waits_add: [`A-${n}`],
});
console.log(
	`${got.changed.join(",")} ${Math.round(performance.now() - started)}ms`,
);
await board.close();
