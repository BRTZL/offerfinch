import { describe, expect, it } from "vitest";

import {
	nextScan,
	quietUntil,
	SCHEDULE_TICK_MS,
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

describe("nextScan and scheduledScanAllowed agree", () => {
	it("waits for the quiet hours after the interval, not the ones it is in now", () => {
		// Every 24 hours, Scan now Monday 23:00, quiet 22:00–07:00: at Tuesday 01:00 the interval
		// still has until Tuesday 23:00, inside the next quiet hours, so Wednesday 07:00.
		const next = nextScan({
			now: local(1, 0, 10),
			paused: false,
			hasProfile: true,
			scheduleOff: false,
			schedule: schedule(24, night),
			lastStartedAt: local(23, 0, 9),
		});
		expect(next).toEqual({
			at: local(7, 0, 11).toISOString(),
			note: "Every 24 hours while your Mac is awake, outside 22:00–07:00",
		});
	});

	/** Checks one case: the time given is allowed, and not later than it has to be. */
	function agrees(now: Date, plan: ScanSchedule, lastStartedAt: Date | null) {
		const input = { now, schedule: plan, lastStartedAt };
		const next = nextScan({
			...input,
			paused: false,
			hasProfile: true,
			scheduleOff: false,
		});
		const at = new Date(next.at as string);
		const label = `${plan.every}h, ${plan.quietHours.start}–${plan.quietHours.end}, now ${now.toString()}, last ${lastStartedAt?.toString()}`;
		expect(at.getTime(), label).toBeGreaterThanOrEqual(now.getTime());
		expect(scheduledScanAllowed({ ...input, now: at }), label).toBe(true);
		// A minute earlier (past the next 5-minute look), the scheduler would not start one either.
		const before = new Date(at.getTime() - 60_000);
		if (before.getTime() > now.getTime() + SCHEDULE_TICK_MS)
			expect(scheduledScanAllowed({ ...input, now: before }), label).toBe(
				false,
			);
	}

	it("gives a time the scheduler allows, and none it allows earlier", () => {
		const windows: ScanSchedule["quietHours"][] = [
			DEFAULT_SCAN_SCHEDULE.quietHours,
			night,
			{ enabled: true, start: "09:30", end: "17:15" },
			{ enabled: true, start: "00:00", end: "06:00" },
			{ enabled: true, start: "23:59", end: "00:01" },
			{ enabled: true, start: "12:00", end: "12:00" },
		];
		const everies: ScanSchedule["every"][] = [1, 3, 6, 12, 24];
		const agos = [null, 0.25, 0.9, 1.5, 5, 11.9, 23, 30];
		let checked = 0;
		// Every 7 minutes over two days, so the minutes just before each start are hit.
		for (let t = 0; t < 48 * 60; t += 7) {
			const now = new Date(local(0, 0).getTime() + t * 60_000);
			for (const quietHours of windows)
				for (const every of everies)
					for (const ago of agos) {
						agrees(
							now,
							{ every, quietHours },
							ago === null ? null : new Date(now.getTime() - ago * HOUR),
						);
						checked++;
					}
		}
		expect(checked).toBeGreaterThan(10_000);
	});
});

describe("scanScheduleSchema (what is written)", () => {
	it("takes a whole, valid schedule", () => {
		expect(scanScheduleSchema.parse(DEFAULT_SCAN_SCHEDULE)).toEqual(
			DEFAULT_SCAN_SCHEDULE,
		);
	});
	it("refuses an interval or a time it does not offer, or a field left out", () => {
		const ok = { every: 6, quietHours: night };
		expect(scanScheduleSchema.safeParse({ ...ok, every: 2 }).success).toBe(
			false,
		);
		expect(
			scanScheduleSchema.safeParse({
				...ok,
				quietHours: { ...night, start: "24:00" },
			}).success,
		).toBe(false);
		expect(
			scanScheduleSchema.safeParse({
				...ok,
				quietHours: { ...night, end: "7:00" },
			}).success,
		).toBe(false);
		expect(scanScheduleSchema.safeParse({ every: 6 }).success).toBe(false);
	});
});
