import { describe, expect, it } from "vitest";
import type { ProfileSnapshot } from "../src/profile/types";
import {
	computeScore,
	type FitRequirement,
	fitAssessmentSchema,
	verifyAssessment,
} from "../src/scoring/fit";

const PROFILE = { files: [] } as unknown as ProfileSnapshot;

describe("the fit-score answer", () => {
	const requirement = {
		requirement: "TypeScript",
		kind: "skill_or_experience",
		importance: "must",
		evidence: [],
		note: "Not in the profile.",
	};

	it("keeps a requirement without a status, shown as unknown with no credit, not a failed call", () => {
		const parsed = fitAssessmentSchema.parse({
			requirements: [requirement],
			summary: "s",
		});
		const { requirements } = verifyAssessment(parsed, PROFILE);
		expect(requirements[0]).toMatchObject({
			status: "unknown",
			statusOmitted: true,
		});
		expect(requirements[0]?.note).toMatch(/No status given/);
		expect(computeScore(requirements)).toBe(0);
	});

	it("scores an omitted status like not_met, below an unknown one", () => {
		const req = (status: FitRequirement["status"]): FitRequirement => ({
			requirement: "r",
			kind: "skill_or_experience",
			importance: "must",
			status,
			evidence: [],
			note: "",
		});
		const met = [req("met"), req("met"), req("met"), req("met")];
		const omitted = verifyAssessment(
			fitAssessmentSchema.parse({ requirements: [requirement], summary: "s" }),
			PROFILE,
		).requirements;
		expect(computeScore([...met, ...omitted])).toBe(80);
		expect(computeScore([...met, req("not_met")])).toBe(80);
		expect(computeScore([...met, req("unknown")])).toBe(84);
		// Unverified, straight from the parse: no status, no credit (never NaN).
		const parsed = fitAssessmentSchema.parse({
			requirements: [requirement],
			summary: "s",
		});
		expect(
			computeScore(parsed.requirements as unknown as FitRequirement[]),
		).toBe(0);
	});

	it("still refuses every other missing or invalid field", () => {
		for (const key of ["requirement", "importance", "evidence", "note"]) {
			const { [key as keyof typeof requirement]: _, ...rest } = requirement;
			expect(
				fitAssessmentSchema.safeParse({
					requirements: [{ ...rest, status: "met" }],
					summary: "s",
				}).success,
			).toBe(false);
		}
		expect(
			fitAssessmentSchema.safeParse({
				requirements: [{ ...requirement, status: "maybe" }],
				summary: "s",
			}).success,
		).toBe(false);
		expect(
			fitAssessmentSchema.safeParse({ requirements: [requirement] }).success,
		).toBe(false);
	});
});
