import { describe, expect, it } from "vitest";

import { submissionModeForSource } from "../src/apply/modes";
import { parseJobSource, sourceMismatch } from "../src/domain/source";
import { JOB_SOURCES } from "../src/domain/types";

/**
 * The real Tessera job was added with `dev:seed-job`, which labelled every job Greenhouse: its page
 * showed "Greenhouse" and its hand-off pointed at a boards.greenhouse.io form that does not
 * exist. A seeded job is now `manual` unless told otherwise, and a label its URL contradicts is
 * reported.
 */
describe("a job's source", () => {
	it("defaults a seeded job to the neutral manual source, a hand-off source", () => {
		expect(JOB_SOURCES).toContain("manual");
		expect(parseJobSource(undefined)).toBe("manual");
		expect(parseJobSource("scrape")).toBe("scrape");
		expect(() => parseJobSource("monster")).toThrow(/ashby, greenhouse/);
		expect(submissionModeForSource("manual", null).mode).toBe("handoff");
	});

	it("reports a board label whose URL is not on that board", () => {
		expect(
			sourceMismatch(
				"greenhouse",
				"https://example.invalid/dev-fixture-tessera/1793393926336",
			),
		).toMatch(/not on Greenhouse/);
		expect(
			sourceMismatch("greenhouse", "https://tessera.example/careers/x"),
		).toMatch(/tessera\.example/);
		expect(
			sourceMismatch(
				"greenhouse",
				"https://job-boards.greenhouse.io/acme/jobs/42",
			),
		).toBeNull();
		expect(sourceMismatch("lever", "https://jobs.lever.co/acme/1")).toBeNull();
		expect(
			sourceMismatch("manual", "https://tessera.example/careers/x"),
		).toBeNull();
		expect(
			sourceMismatch("scrape", "https://tessera.example/careers/x"),
		).toBeNull();
	});
});
