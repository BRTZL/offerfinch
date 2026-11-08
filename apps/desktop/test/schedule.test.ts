import { describe, expect, it } from "vitest";

import {
	nextScan,
	quietUntil,
	scheduledScanAllowed,
} from "../src/worker/schedule";
import {
	DEFAULT_SCAN_SCHEDULE,
	type ScanSchedule,
	scanScheduleSchema,
} from "../src/worker/settings";

// Local times throughout: quiet hours are the Mac's clock, whatever the test runner's zone.
const local = (h: number, m = 0, day = 9) => new Date(2026, 10, day, h, m);
const HOUR = 3_600_000;
const night: ScanSchedule["quietHours"] = {
	enabled: true,
	start: "22:00",
	end: "07:00",
};
const schedule = (
	every: ScanSchedule["every"],
	quietHours = DEFAULT_SCAN_SCHEDULE.quietHours,
): ScanSchedule => ({ every, quietHours });

describe("quietUntil", () => {
	it("crosses midnight: quiet late at night and early in the morning, until the end", () => {
		expect(quietUntil(night, local(23, 30))).toEqual(local(7, 0, 10));
		expect(quietUntil(night, local(0, 0, 10))).toEqual(local(7, 0, 10));
		expect(quietUntil(night, local(6, 59, 10))).toEqual(local(7, 0, 10));
		expect(quietUntil(night, local(22, 0))).toEqual(local(7, 0, 10));
	});
	it("is not quiet outside the window, at its end, or just before its start", () => {
		expect(quietUntil(night, local(7, 0))).toBe(null);
		expect(quietUntil(night, local(12, 0))).toBe(null);
		expect(quietUntil(night, local(21, 59))).toBe(null);
	});
	it("handles a window within one day", () => {
		const lunch = { enabled: true, start: "12:00", end: "13:30" };
		expect(quietUntil(lunch, local(12, 45))).toEqual(local(13, 30));
		expect(quietUntil(lunch, local(13, 30))).toBe(null);
		expect(quietUntil(lunch, local(23, 0))).toBe(null);
	});
	it("is never quiet when off, or when start and end are the same", () => {
		expect(quietUntil({ ...night, enabled: false }, local(23, 30))).toBe(null);
		expect(
			quietUntil({ enabled: true, start: "08:00", end: "08:00" }, local(8, 0)),
		).toBe(null);
	});
});

describe("scheduledScanAllowed", () => {
	it("waits `every` hours after the last scan started", () => {
		const now = local(15, 0);
		const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);
		const allowed = (every: ScanSchedule["every"], hoursAgo: number | null) =>
			scheduledScanAllowed({
				now,
				schedule: schedule(every),
				lastStartedAt: hoursAgo === null ? null : at(hoursAgo),
			});
		expect(allowed(1, null)).toBe(true);
		expect(allowed(1, 0.5)).toBe(false);
		expect(allowed(1, 1)).toBe(true);
		expect(allowed(3, 2.9)).toBe(false);
		expect(allowed(3, 3)).toBe(true);
		expect(allowed(24, 23)).toBe(false);
		expect(allowed(24, 25)).toBe(true);
	});
	it("never starts a scan in quiet hours, however long ago the last one was", () => {
		const input = { schedule: schedule(1, night), lastStartedAt: null };
		expect(scheduledScanAllowed({ ...input, now: local(23, 30) })).toBe(false);
		expect(scheduledScanAllowed({ ...input, now: local(6, 30, 10) })).toBe(
			false,
		);
		expect(scheduledScanAllowed({ ...input, now: local(7, 0, 10) })).toBe(true);
	});
});

describe("nextScan", () => {
	const base = {
		now: local(14, 20),
		paused: false,
		hasProfile: true,
		scheduleOff: false,
		schedule: DEFAULT_SCAN_SCHEDULE,
		lastStartedAt: local(14, 0),
	};
	it("is `every` hours after the last scan started", () => {
		expect(nextScan(base)).toEqual({
			at: local(15, 0).toISOString(),
			note: "Every hour while your Mac is awake",
		});
		expect(nextScan({ ...base, schedule: schedule(6) }).at).toBe(
			local(20, 0).toISOString(),
		);
	});
	it("is within the 5-minute tick once due, or before the first scan", () => {
		expect(nextScan({ ...base, lastStartedAt: local(12, 0) }).at).toBe(
			local(14, 25).toISOString(),
		);
		expect(nextScan({ ...base, lastStartedAt: null }).note).toMatch(/Due now/);
	});
	it("moves to the end of quiet hours", () => {
		// Due at 23:00, inside 22:00–07:00: the next morning instead.
		const late = nextScan({
			...base,
			now: local(21, 0),
			lastStartedAt: local(20, 0),
			schedule: schedule(3, night),
		});
		expect(late.at).toBe(local(7, 0, 10).toISOString());
		expect(late.note).toBe(
			"Every 3 hours while your Mac is awake, outside 22:00–07:00",
		);
		expect(
			nextScan({ ...base, now: local(23, 0), schedule: schedule(1, night) }),
		).toEqual({
			at: local(7, 0, 10).toISOString(),
			note: "Quiet hours until 07:00",
		});
	});
	it("has no time while paused, before a profile, or in test runs", () => {
		expect(nextScan({ ...base, paused: true }).at).toBe(null);
		expect(nextScan({ ...base, hasProfile: false }).note).toMatch(/profile/);
		expect(nextScan({ ...base, scheduleOff: true }).at).toBe(null);
	});
});

describe("scanScheduleSchema", () => {
	it("fills every field left out, so an older or partial setting keeps the rest", () => {
		expect(scanScheduleSchema.parse({})).toEqual(DEFAULT_SCAN_SCHEDULE);
		expect(
			scanScheduleSchema.parse({ every: 6, quietHours: { enabled: true } }),
		).toEqual({
			every: 6,
			quietHours: { enabled: true, start: "22:00", end: "07:00" },
		});
	});
	it("refuses an interval or a time it does not offer", () => {
		expect(scanScheduleSchema.safeParse({ every: 2 }).success).toBe(false);
		expect(
			scanScheduleSchema.safeParse({ quietHours: { start: "24:00" } }).success,
		).toBe(false);
		expect(
			scanScheduleSchema.safeParse({ quietHours: { end: "7:00" } }).success,
		).toBe(false);
	});
});
