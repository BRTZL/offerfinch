import type { QuietHours, ScanSchedule } from "./settings";

/** How often the scheduler looks whether a scan is due (and on waking, and at start). */
export const SCHEDULE_TICK_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

function minutesOf(clock: string): number {
	const [h, m] = clock.split(":").map(Number);
	return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * When the quiet hours `now` falls in end, in the Mac's local time; null outside them, when
 * they are off, or when start and end are the same (no window). A window whose start is after
 * its end crosses midnight (22:00–07:00 is quiet at 23:30 and at 06:59, not at 07:00).
 */
export function quietUntil(quiet: QuietHours, now: Date): Date | null {
	if (!quiet.enabled) return null;
	const start = minutesOf(quiet.start);
	const end = minutesOf(quiet.end);
	if (start === end) return null;
	const at = now.getHours() * 60 + now.getMinutes();
	const inside =
		start < end ? at >= start && at < end : at >= start || at < end;
	if (!inside) return null;
	const until = new Date(now);
	until.setHours(Math.floor(end / 60), end % 60, 0, 0);
	if (until.getTime() <= now.getTime()) until.setDate(until.getDate() + 1);
	return until;
}

/**
 * Whether the timer may start a scan now: outside quiet hours, and `every` hours or more since
 * the last scan started (timer or Scan now). Scan now itself is never held back.
 */
export function scheduledScanAllowed(input: {
	now: Date;
	schedule: ScanSchedule;
	lastStartedAt: Date | null;
}): boolean {
	if (quietUntil(input.schedule.quietHours, input.now)) return false;
	if (!input.lastStartedAt) return true;
	return (
		input.now.getTime() - input.lastStartedAt.getTime() >=
		input.schedule.every * HOUR_MS
	);
}

/** "Every hour", "Every 3 hours". */
function everyLabel(every: number): string {
	return every === 1 ? "Every hour" : `Every ${every} hours`;
}

/**
 * When the scheduler starts the next scan: `every` hours after the last one started (or the next
 * 5-minute look, once that has passed), then moved to the end of the quiet hours that time falls
 * in. Never while paused or before a profile is saved. The time given always passes
 * `scheduledScanAllowed`.
 */
export function nextScan(input: {
	now: Date;
	paused: boolean;
	hasProfile: boolean;
	scheduleOff: boolean;
	schedule: ScanSchedule;
	lastStartedAt: Date | null;
}): { at: string | null; note: string } {
	if (input.scheduleOff)
		return { at: null, note: "Scheduled scans are off in test runs" };
	if (input.paused) return { at: null, note: "Scans are paused" };
	if (!input.hasProfile)
		return { at: null, note: "Scans start once your profile is saved" };
	const { every, quietHours } = input.schedule;
	const now = input.now.getTime();
	// When the interval allows the next scan (the next 5-minute look, if that is already past),
	// then moved past the quiet hours it falls in: an interval that ends in them waits for their
	// end, even when quiet hours are not on yet.
	const due = input.lastStartedAt
		? input.lastStartedAt.getTime() + every * HOUR_MS
		: now;
	const candidate = due <= now ? now + SCHEDULE_TICK_MS : due;
	const quietThen = quietUntil(quietHours, new Date(candidate));
	const at = quietThen ? quietThen.getTime() : candidate;
	const quietNow = quietUntil(quietHours, input.now);
	if (quietNow && at === quietNow.getTime())
		return {
			at: new Date(at).toISOString(),
			note: `Quiet hours until ${quietHours.end}`,
		};
	if (!quietThen && due <= now)
		return {
			at: new Date(at).toISOString(),
			note: "Due now: within 5 minutes while your Mac is awake",
		};
	return {
		at: new Date(at).toISOString(),
		note: `${everyLabel(every)} while your Mac is awake${
			quietHours.enabled && quietHours.start !== quietHours.end
				? `, outside ${quietHours.start}–${quietHours.end}`
				: ""
		}`,
	};
}
