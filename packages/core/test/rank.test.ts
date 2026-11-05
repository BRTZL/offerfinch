import { describe, expect, it } from "vitest";
import {
	type DismissalSignal,
	rankMatch,
	rankReason,
	seniorityLevel,
} from "../src/scoring/rank";

const base = { score: 80, job: { title: "Software Engineer" } };

describe("rank", () => {
	it("is the fit score alone when the user passed on nothing like it", () => {
		const ranked = rankMatch(base);
		expect(ranked).toEqual({ rank: 80, penalties: [] });
		expect(rankReason(ranked.penalties)).toBeNull();
		// Place, seniority and domain are the fit score's to weigh, never a rank penalty.
		const abroad = rankMatch({
			score: 80,
			job: { title: "Principal Embedded Engineer" },
		});
		expect(abroad.rank).toBe(80);
	});

	it("lowers new matches like the ones the user passed on", () => {
		const passed = (
			reasons: DismissalSignal["reasons"],
			title: string,
			companyId = "other",
		): DismissalSignal => ({ companyId, reasons, title });
		const sameCompany = rankMatch({
			...base,
			job: { ...base.job, companyId: "acme" },
			dismissals: [passed(["company"], "Backend Engineer", "acme")],
		});
		expect(sameCompany.penalties[0]?.kind).toBe("dismissed_company");
		expect(rankReason(sameCompany.penalties)).toBe(
			"Ranked lower: you passed on a job at this company",
		);
		const seniorJob = { title: "Senior Backend Engineer" };
		const manySenior = rankMatch({
			...base,
			job: seniorJob,
			dismissals: [
				passed(["seniority"], "Senior Frontend Engineer"),
				passed(["seniority"], "Senior Data Engineer"),
				passed(["seniority"], "Lead Developer"),
			],
		});
		expect(manySenior.penalties[0]?.reason).toBe(
			"you passed on 3 similar senior roles for seniority",
		);
		// One dismissal is not a pattern; other levels are not penalized.
		const one = rankMatch({
			...base,
			job: seniorJob,
			dismissals: [passed(["seniority"], "Senior Frontend Engineer")],
		});
		expect(one.penalties).toEqual([]);
		const mid = rankMatch({
			...base,
			dismissals: [
				passed(["seniority"], "Senior Frontend Engineer"),
				passed(["seniority"], "Senior Data Engineer"),
			],
		});
		expect(mid.penalties).toEqual([]);
	});

	it("never goes below 0", () => {
		const result = rankMatch({
			score: 10,
			job: { title: "Backend Engineer", companyId: "acme" },
			dismissals: [
				{ companyId: "acme", reasons: ["company"], title: "Backend Engineer" },
			],
		});
		expect(result.rank).toBe(0);
	});
});

describe("seniority helpers", () => {
	it("reads levels from titles", () => {
		expect(seniorityLevel("Senior Software Engineer")).toBe("senior");
		expect(seniorityLevel("Staff Engineer")).toBe("staff");
		expect(seniorityLevel("Junior Developer")).toBe("junior");
		expect(seniorityLevel("Software Engineer II")).toBe("mid");
		expect(seniorityLevel("Head of Engineering")).toBe("executive");
	});
});
