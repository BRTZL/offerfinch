import type { SiteStop } from "./read";

/**
 * When a source that stopped may run again (sites, and job-board search's DuckDuckGo pages).
 * Kept apart from the providers so both can use it without importing each other.
 */

export interface SiteStopRecord extends SiteStop {
	at: string;
	/** Transient stops: runs in a row that stopped this way (absent on records before backoff). */
	failures?: number;
	/** Transient stops: the first scan at or after this time tries again. */
	retryAt?: string;
}

/**
 * Stops the user has to act on: a check to solve, a sign-in, or (LinkedIn) an account warning.
 * They hold the source (and notify) until cleared in Settings › Sources. Everything else (a layout change, a one-off refusal, an
 * unexpected page) is transient: the next scheduled scan tries again, waiting longer after each
 * stop in a row (1 hour, 2, 4, ... at most a day).
 */
export const HELD_STOP_KINDS: ReadonlySet<string> = new Set([
	"captcha",
	"security_check",
	"login_wall",
	"warning",
]);

export function isHeldStop(stop: { kind: string }): boolean {
	return HELD_STOP_KINDS.has(stop.kind);
}

const HOUR_MS = 3_600_000;
const MAX_BACKOFF_MS = 24 * HOUR_MS;

/** The record for a new stop, counting on from the stop before it when that was transient. */
export function stopRecord(
	stop: SiteStop,
	previous: SiteStopRecord | null,
	now: Date,
): SiteStopRecord {
	const at = now.toISOString();
	if (isHeldStop(stop)) return { ...stop, at };
	const failures =
		previous && !isHeldStop(previous) ? (previous.failures ?? 1) + 1 : 1;
	const wait = Math.min(MAX_BACKOFF_MS, HOUR_MS * 2 ** (failures - 1));
	// A scan starts on the hour: a minute's slack keeps "one hour" the next scan, not the one after.
	const retryAt = new Date(now.getTime() + wait - 60_000).toISOString();
	return { ...stop, at, failures, retryAt };
}

/** A transient stop whose wait is over (records from before backoff are due at once). */
export function retryDue(stop: SiteStopRecord, now: Date): boolean {
	if (isHeldStop(stop)) return false;
	return !stop.retryAt || new Date(stop.retryAt).getTime() <= now.getTime();
}

/** Where a source's stop is kept (in its Settings › Sources row). */
export interface StopStore {
	stopped(userId: string, source: string): Promise<SiteStopRecord | null>;
	stop(userId: string, source: string, stop: SiteStopRecord): Promise<void>;
	/** A run read the source again without a stop: the transient stop is over. */
	clearStop(userId: string, source: string): Promise<void>;
}

/** The record's wait, for a problem line: "the first scan after 2 Nov, 20:58". */
export function clock(iso: string): string {
	return new Date(iso).toLocaleString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		day: "numeric",
		month: "short",
	});
}
