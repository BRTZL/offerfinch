import { describe, expect, it } from "vitest";

import {
	dayLabel,
	icsFileName,
	interviewIcs,
	isDay,
	localDay,
	stageClock,
	sweepDecision,
} from "../src/domain/tracking";

const DAY = 86_400_000;
const now = new Date("2026-11-03T10:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe("the follow-up and Ghosted rules", () => {
	it("reminds after 7 quiet days, once, and ghosts after 21, only while waiting", () => {
		const at = (stage: "applied" | "heard_back" | "offer", days: number) =>
			sweepDecision({ stage, clock: ago(days), remindedAt: null, now });
		expect(at("applied", 6)).toBeNull();
		expect(at("applied", 7)).toBe("remind");
		expect(at("heard_back", 20)).toBe("remind");
		expect(at("heard_back", 21)).toBe("ghost");
		expect(at("offer", 90)).toBeNull();
		expect(
			sweepDecision({
				stage: "applied",
				clock: ago(10),
				remindedAt: ago(3),
				now,
			}),
		).toBeNull();
	});

	it("counts from when a backdated move was recorded", () => {
		expect(stageClock({ occurredOn: "2026-10-04", createdAt: ago(1) })).toEqual(
			ago(1),
		);
	});
});

/** Runs `fn` with this process in another time zone (Node reads TZ again when it changes). */
function inZone<T>(zone: string, fn: () => T): T {
	const before = process.env.TZ;
	process.env.TZ = zone;
	try {
		return fn();
	} finally {
		process.env.TZ = before;
	}
}

describe("stage days in every time zone", () => {
	for (const zone of ["Pacific/Auckland", "America/Los_Angeles", "UTC"])
		it(`a picked day is the day shown and waited from, in ${zone}`, () =>
			inZone(zone, () => {
				expect(dayLabel("2026-11-03", "en-US")).toBe("Nov 3, 2026");
				expect(dayLabel("2026-12-31", "en-US")).toBe("Dec 31, 2026");
				// The wait starts at local midnight of that day.
				const start = new Date(2026, 10, 3);
				expect(
					stageClock({
						occurredOn: "2026-11-03",
						createdAt: new Date(start.getTime() - DAY),
					}),
				).toEqual(start);
			}));

	it("today is the local day: 09:00 on Nov 3 in Auckland is still Nov 2 in UTC", () => {
		const instant = new Date("2026-11-02T20:00:00Z");
		expect(inZone("Pacific/Auckland", () => localDay(instant))).toBe(
			"2026-11-03",
		);
		expect(inZone("America/Los_Angeles", () => localDay(instant))).toBe(
			"2026-11-02",
		);
	});

	it("knows a real day from a bad one", () => {
		expect(isDay("2026-02-28")).toBe(true);
		expect(isDay("2026-02-30")).toBe(false);
		expect(isDay("2026-2-3")).toBe(false);
	});
});

describe("an interview as an .ics file", () => {
	const text = interviewIcs({
		uid: "stage-1",
		start: new Date("2026-11-10T14:30:00Z"),
		company: "Acme, Inc; Robotics",
		title:
			"Senior Engineer — Platform & Infrastructure, Developer Experience team",
		round: 2,
		url: "https://jobs.example.com/acme/42",
		now,
	});

	it("is one event with UTC times, the job link and RFC 5545 escaping", () => {
		expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
		expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
		expect(text).toContain("\r\nUID:stage-1@offerfinch.app\r\n");
		expect(text).toContain("\r\nDTSTAMP:20261103T100000Z\r\n");
		expect(text).toContain("\r\nDTSTART:20261110T143000Z\r\n");
		expect(text).toContain("\r\nDTEND:20261110T153000Z\r\n");
		expect(text).toContain("\r\nURL:https://jobs.example.com/acme/42\r\n");
		const unfolded = text.replace(/\r\n /g, "");
		expect(unfolded).toContain(
			"SUMMARY:Interview (round 2): Senior Engineer — Platform & Infrastructure\\, Developer Experience team at Acme\\, Inc\\; Robotics",
		);
		expect(unfolded).toContain("DESCRIPTION:");
		expect(unfolded).toContain("\\nhttps://jobs.example.com/acme/42");
	});

	it("folds lines at 75 octets and uses CRLF only", () => {
		for (const line of text.split("\r\n"))
			expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
	});

	it("names the file after the company and round", () => {
		expect(icsFileName("Acme, Inc; Robotics", 2)).toBe(
			"interview-acme-inc-robotics-round-2.ics",
		);
		expect(icsFileName("東京", null)).toBe("interview-job.ics");
	});
});
