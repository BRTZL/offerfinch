import { describe, expect, it } from "vitest";
import { experienceRecords } from "../src/tailor/profile-rules";

/**
 * A role saved with no location (onboarding writes `- **Location:** ` then `## What I did`): the
 * field is empty. It used to take the next line, so drafts showed "## What I did" as the place.
 */
describe("experience records", () => {
	it("reads an empty location as empty, not as the next line", () => {
		const [record] = experienceRecords({
			files: [
				{
					path: "experience/2025-tidewater-health.md",
					content:
						"# Tidewater Health — Senior Frontend Engineer\n\n- **Dates:** Jan 2025 – Present\n- **Location:** \n\n## What I did\n\n- Built things.\n",
				},
			],
		} as never);
		expect(record?.locationParts).toEqual([]);
		expect(record?.dates).toMatch(/Jan 2025/);
	});

	it("still reads a location on its line", () => {
		const [record] = experienceRecords({
			files: [
				{
					path: "experience/2022-northwind.md",
					content:
						"# Northwind — Engineer\n\n- **Dates:** Mar 2022 – Dec 2024\n- **Location:** Lisbon · Hybrid\n",
				},
			],
		} as never);
		expect(record?.locationParts).toEqual(["Lisbon", "Hybrid"]);
	});
});
