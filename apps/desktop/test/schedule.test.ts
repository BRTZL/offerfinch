import { describe, expect, it } from "vitest";

import { nextScan } from "../src/worker/schedule";

const base = {
	now: new Date("2026-11-01T14:20:00Z"),
	paused: false,
	hasProfile: true,
	scheduleOff: false,
	thisHourRan: true,
};

describe("nextScan", () => {
	it("is the next clock hour once this hour's scan ran", () => {
		expect(nextScan(base).at).toBe("2026-11-01T15:00:00.000Z");
	});
	it("is within the 5-minute tick when this hour's scan has not run", () => {
		expect(nextScan({ ...base, thisHourRan: false }).at).toBe(
			"2026-11-01T14:25:00.000Z",
		);
	});
	it("has no time while paused, before a profile, or in test runs", () => {
		expect(nextScan({ ...base, paused: true }).at).toBe(null);
		expect(nextScan({ ...base, hasProfile: false }).note).toMatch(/profile/);
		expect(nextScan({ ...base, scheduleOff: true }).at).toBe(null);
	});
});
