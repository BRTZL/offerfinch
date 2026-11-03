/**
 * When the scheduler starts the next scan: one scan per clock hour, checked every 5 minutes (and
 * on waking), never while paused or before a profile is saved. So this hour's, within minutes,
 * if it has not run; otherwise the next hour's, a few minutes past it.
 */
export function nextScan(input: {
	now: Date;
	paused: boolean;
	hasProfile: boolean;
	scheduleOff: boolean;
	thisHourRan: boolean;
}): { at: string | null; note: string } {
	if (input.scheduleOff)
		return { at: null, note: "Hourly scans are off in test runs" };
	if (input.paused) return { at: null, note: "Hourly scans are paused" };
	if (!input.hasProfile)
		return { at: null, note: "Hourly scans start once your profile is saved" };
	if (!input.thisHourRan)
		return {
			at: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
			note: "Due now: within 5 minutes while your Mac is awake",
		};
	const next = new Date(input.now);
	next.setUTCMinutes(0, 0, 0);
	next.setUTCHours(next.getUTCHours() + 1);
	return {
		at: next.toISOString(),
		note: "Every hour while your Mac is awake",
	};
}
