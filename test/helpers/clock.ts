import type { Clock } from "../../src/clock.ts";

/** A clock tests move by hand. */
export class FakeClock implements Clock {
	private time: number;

	constructor(at = "2026-10-12T09:00:00.000Z") {
		this.time = Date.parse(at);
	}

	now(): Date {
		return new Date(this.time);
	}

	advance(minutes: number): void {
		this.time += minutes * 60_000;
	}
}
