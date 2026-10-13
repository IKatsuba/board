import type { Database } from "bun:sqlite";
import type { Clock } from "../clock.ts";
import { stamp } from "../clock.ts";
import { refuse } from "../errors.ts";
import type { Kind } from "../schemas.ts";
import {
	expiring,
	type Warned,
	type WatchedClaim,
	type WatchKind,
	type WatchLine,
} from "./derive.ts";

/** What a watcher looks for; every filter given must match (they intersect). */
export interface WatchOptions {
	follow: boolean;
	since: number | null;
	/** Project keys; empty watches every project. */
	projects: readonly string[];
	kinds: readonly WatchKind[];
	/** Task keys. */
	tasks: readonly string[];
	/** --expiring-within, minutes; null for the default threshold. */
	expiringWithin: number | null;
}

/** One page of the drain, as the design has it. */
export const PAGE = 500;

type Row = {
	id: number;
	at: string;
	actor: string;
	kind: Kind;
	project: string | null;
	task: string | null;
	milestone: string | null;
	data: string;
};

/**
 * The polling side of `board watch`, step by step on one read-only
 * connection: attach once, then tick. It holds no read transaction between
 * polls, so WAL checkpoints are never starved, and it notices other
 * processes' commits through `PRAGMA data_version`.
 */
export class Watcher {
	private version = 0;
	private cursor = 0;
	/**
	 * Watched projects still there: key → its id and the id of its
	 * project_added event, which tells its own removal from an older one.
	 */
	private readonly projects = new Map<string, { id: number; added: number }>();
	private claims: WatchedClaim[] = [];
	private readonly warned: Warned = new Map();
	private readonly kinds: ReadonlySet<string>;
	private readonly tasks: ReadonlySet<string>;

	constructor(
		private readonly db: Database,
		private readonly options: WatchOptions,
		private readonly clock: Clock,
		private readonly out: (line: WatchLine) => Promise<void> | void,
	) {
		this.kinds = new Set(options.kinds);
		this.tasks = new Set(options.tasks.map((k) => k.toUpperCase()));
	}

	/** Whether a narrowed watcher has lost every project it watched. */
	get done(): boolean {
		return this.options.projects.length > 0 && this.projects.size === 0;
	}

	/**
	 * Attach, in this order: data_version kept, the cursor set, the live
	 * claims read, the claims already inside their window warned about.
	 * Each `-p` key becomes its project's id once; an unknown key is
	 * not_found before anything is watched.
	 */
	async attach(): Promise<void> {
		// One short read transaction, so the keys, data_version, the cursor
		// and the claims are one cut: a commit after it moves data_version
		// and is read at the next tick, and none falls between two reads.
		this.db.run("BEGIN");
		try {
			this.version = this.dataVersion();
			for (const key of this.options.projects) {
				const row = this.db
					.query<{ id: number; key: string; added: number }, [string]>(
						`SELECT p.id, p.key,
						        (SELECT e.id FROM event e
						         WHERE e.project_id = p.id AND e.kind = 'project_added') AS added
						 FROM project p WHERE p.key = ?`,
					)
					.get(key);
				if (row === null) {
					refuse({
						code: "not_found",
						message: `No project ${key.toUpperCase()} on this machine.`,
						next: "`board project ls` lists the keys there are.",
						details: { what: "project", id: key.toUpperCase() },
					});
				}
				this.projects.set(row.key, { id: row.id, added: row.added });
			}
			this.cursor =
				this.options.since ??
				(this.options.follow
					? (this.db
							.query<{ id: number | null }, []>(
								"SELECT max(id) AS id FROM event",
							)
							.get()?.id ?? 0)
					: 0);
			if (this.options.follow) this.claims = this.liveClaims();
		} finally {
			this.db.run("COMMIT");
		}
		if (this.options.follow) {
			// --since in follow mode starts after an old id: what is already
			// there is read now, not at the next commit.
			if (this.options.since !== null) await this.drain();
			await this.warn();
		}
	}

	/**
	 * One tick: when data_version moved, keep the new value before draining,
	 * so a commit that lands during the drain is read on the next tick; then
	 * re-read the live claims. Finally, on every tick, the claims due.
	 */
	async tick(): Promise<void> {
		const version = this.dataVersion();
		if (version !== this.version) {
			this.version = version;
			await this.drain();
			this.claims = this.liveClaims();
		}
		await this.warn();
	}

	/** Every row after the cursor, page by page until a short page. */
	async drain(): Promise<void> {
		for (;;) {
			const rows = this.page();
			for (const row of rows) {
				// The cursor moves past every row read, printed or not, so a
				// narrowed watcher never re-reads another project's burst.
				this.cursor = row.id;
				await this.consider(row);
				if (this.done) return;
			}
			if (rows.length < PAGE) return;
		}
	}

	get position(): number {
		return this.cursor;
	}

	private async consider(row: Row): Promise<void> {
		const data = JSON.parse(row.data) as Record<string, unknown>;
		// Only the removal of the project attached to stops the watch: one
		// logged after its project_added. An older removal of the same key
		// was of another project.
		const watched = this.projects.get(String(data.key));
		const removed =
			row.kind === "project_removed" &&
			watched !== undefined &&
			row.id > watched.added
				? String(data.key)
				: null;
		const line: WatchLine = {
			id: row.id,
			derived: false,
			at: row.at,
			actor: row.actor,
			kind: row.kind,
			project: row.project,
			task: row.task,
			milestone: row.milestone,
			data,
		};
		// A narrowed watcher matches project_removed, which has no project,
		// on data.key; an unnarrowed one prints every removal.
		const ours =
			this.options.projects.length === 0 ||
			row.kind !== "project_removed" ||
			watched !== undefined;
		if (ours && this.passes(line)) {
			await this.out(line);
		}
		// A removed project's key is no longer watched: a project added
		// again under it is a new project.
		if (removed !== null) this.projects.delete(removed);
	}

	private passes(line: WatchLine): boolean {
		if (this.kinds.size > 0 && !this.kinds.has(line.kind)) return false;
		if (
			this.tasks.size > 0 &&
			(line.task === null || !this.tasks.has(line.task))
		) {
			return false;
		}
		return true;
	}

	private async warn(): Promise<void> {
		if (!this.options.follow) return;
		const due = expiring(
			this.claims,
			this.clock.now(),
			this.warned,
			this.options.expiringWithin,
		);
		for (const line of due) if (this.passes(line)) await this.out(line);
	}

	private dataVersion(): number {
		return (
			this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()
				?.data_version ?? 0
		);
	}

	private page(): Row[] {
		const narrowed = this.options.projects.length > 0;
		const ids = [...this.projects.values()].map((p) => p.id);
		const where = narrowed
			? `e.id > ? AND (e.project_id IN (${ids.map(() => "?").join(", ") || "NULL"}) OR e.kind = 'project_removed')`
			: "e.id > ?";
		return this.db
			.query<Row, (number | string)[]>(
				`SELECT e.id, e.at, e.actor, e.kind, p.key AS project,
				        tp.key || '-' || t.number AS task, m.name AS milestone, e.data
				 FROM event e
				 LEFT JOIN project p ON p.id = e.project_id
				 LEFT JOIN task t ON t.id = e.task_id
				 LEFT JOIN project tp ON tp.id = t.project_id
				 LEFT JOIN milestone m ON m.id = e.milestone_id
				 WHERE ${where}
				 ORDER BY e.id
				 LIMIT ${PAGE}`,
			)
			.all(this.cursor, ...ids);
	}

	private liveClaims(): WatchedClaim[] {
		const ids = [...this.projects.values()].map((p) => p.id);
		const narrowed = this.options.projects.length > 0;
		return this.db
			.query<WatchedClaim, (number | string)[]>(
				`SELECT p.key AS project, p.key || '-' || t.number AS task,
				        c.holder, c.since, c.until
				 FROM claim c
				 JOIN task t ON t.id = c.task_id
				 JOIN project p ON p.id = t.project_id
				 WHERE c.until > ?${narrowed ? ` AND p.id IN (${ids.map(() => "?").join(", ") || "NULL"})` : ""}
				 ORDER BY c.until`,
			)
			.all(stamp(this.clock.now()), ...ids);
	}
}

/**
 * Runs a watcher: without --follow one drain from where it starts; with it,
 * a tick every `interval` until `stop` says so or a narrowed watcher has
 * nothing left to watch.
 */
export async function watch(
	watcher: Watcher,
	follow: boolean,
	sleep: (ms: number) => Promise<void>,
	stop: () => boolean = () => false,
	interval = 500,
): Promise<void> {
	await watcher.attach();
	if (!follow) {
		await watcher.drain();
		return;
	}
	while (!stop() && !watcher.done) {
		await watcher.tick();
		if (watcher.done) return;
		await sleep(interval);
	}
}
