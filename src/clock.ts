/** The one source of `now`, injected so tests move time by hand. */
export interface Clock {
	now(): Date;
}

export const SystemClock: Clock = { now: () => new Date() };

/**
 * UTC ISO 8601 with milliseconds and `Z`: fixed width, so text order is time
 * order in storage and in every interface.
 */
export function stamp(date: Date): string {
	return date.toISOString();
}
