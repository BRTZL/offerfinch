import { describe, expect, it } from "vitest";
import { evaluateHardRequirements } from "../src/filter/rules";
import { parseFilterSettings } from "../src/filter/settings";
import {
	type DismissalSignal,
	profileYears,
	rankMatch,
	rankReason,
	requiredYears,
	seniorityLevel,
} from "../src/scoring/rank";

const IN_TURKEY = parseFilterSettings({
	livesIn: "Turkey",
	locationPrefilled: true,
});
const BODY =
	"We build web products with TypeScript and React and ship them to customers every week.";
const WEB_PROFILE =
	"# Experience\nBuilt React and Node.js web apps; TypeScript, PostgreSQL, AWS.";

function filterFor(locations: string[], workplaceType: "remote" | "onsite") {
	return evaluateHardRequirements(
		{
			title: "Software Engineer",
			locations,
			workplaceType,
			descriptionText: BODY,
		},
		IN_TURKEY,
	);
}

const base = {
	score: 80,
	job: { title: "Software Engineer", descriptionText: BODY },
	profileYears: 6,
	profileText: WEB_PROFILE,
};

describe("rank", () => {
	it("ranks an unclear location below a clear one with the same score", () => {
		const clear = rankMatch({
			...base,
			filter: filterFor(["Remote – Turkey"], "remote"),
		});
		const unclear = rankMatch({
			...base,
			filter: filterFor(["Remote (EMEA)"], "remote"),
		});
		expect(clear.rank).toBe(80);
		expect(clear.penalties).toEqual([]);
		expect(unclear.rank).toBeLessThan(clear.rank);
		expect(rankReason(unclear.penalties)).toBe(
			"Ranked lower: location unclear",
		);
		expect(rankReason(clear.penalties)).toBeNull();
	});

	it("lowers a role that asks for far more experience, or is far more junior", () => {
		const senior = rankMatch({
			...base,
			filter: null,
			profileYears: 3,
			job: {
				title: "Senior Software Engineer",
				descriptionText: `${BODY} You have 8+ years of professional experience.`,
			},
		});
		expect(senior.rank).toBeLessThan(80);
		expect(senior.penalties[0]?.reason).toBe(
			"asks for 8+ years; your profile shows about 3",
		);
		const staff = rankMatch({
			...base,
			filter: null,
			profileYears: 4,
			job: { title: "Principal Engineer", descriptionText: BODY },
		});
		expect(staff.penalties[0]?.kind).toBe("seniority");
		const junior = rankMatch({
			...base,
			filter: null,
			profileYears: 9,
			job: { title: "Junior Frontend Developer", descriptionText: BODY },
		});
		expect(junior.penalties[0]?.reason).toMatch(/junior role/);
	});

	it("lowers defense and embedded jobs for a web developer, not for someone who has done them", () => {
		const defense = {
			title: "Software Engineer",
			descriptionText:
				"Must be a US Citizen; this position will require a DoD government security clearance. Support military programs.",
		};
		const web = rankMatch({ ...base, filter: null, job: defense });
		expect(web.penalties.map((p) => p.reason)).toContain(
			"needs defense and security clearance, which your profile does not show",
		);
		const veteran = rankMatch({
			...base,
			filter: null,
			job: defense,
			profileText: `${WEB_PROFILE}\nBuilt tools for a defense contractor.`,
		});
		expect(veteran.penalties).toEqual([]);
		const rtos = rankMatch({
			...base,
			filter: null,
			job: {
				title: "Embedded Software Engineer",
				descriptionText:
					"Write firmware in embedded C on FreeRTOS for microcontrollers.",
			},
		});
		expect(rtos.penalties[0]?.reason).toMatch(/embedded systems and RTOS/);
	});

	it("lowers new matches like the ones the user passed on", () => {
		const passed = (
			reasons: DismissalSignal["reasons"],
			title: string,
			companyId = "other",
		): DismissalSignal => ({ companyId, reasons, title });
		const sameCompany = rankMatch({
			...base,
			filter: null,
			job: { ...base.job, companyId: "acme" },
			dismissals: [passed(["company"], "Backend Engineer", "acme")],
		});
		expect(sameCompany.penalties[0]?.kind).toBe("dismissed_company");
		const seniorJob = {
			title: "Senior Backend Engineer",
			descriptionText: BODY,
		};
		const manySenior = rankMatch({
			...base,
			filter: null,
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
			filter: null,
			job: seniorJob,
			dismissals: [passed(["seniority"], "Senior Frontend Engineer")],
		});
		expect(one.penalties).toEqual([]);
		const mid = rankMatch({
			...base,
			filter: null,
			dismissals: [
				passed(["seniority"], "Senior Frontend Engineer"),
				passed(["seniority"], "Senior Data Engineer"),
			],
		});
		expect(mid.penalties).toEqual([]);
	});

	it("lowers a match that prefers a clearance the user lacks, bounded and explained", () => {
		const descriptionText = `${BODY} Ability to obtain clearance preferred.`;
		const filter = evaluateHardRequirements(
			{
				title: "Software Engineer",
				locations: ["Remote - Worldwide"],
				workplaceType: "remote",
				descriptionText,
			},
			IN_TURKEY,
		);
		expect(filter.decision).toBe("keep");
		const ranked = rankMatch({
			...base,
			filter,
			job: { title: "Software Engineer", descriptionText },
		});
		expect(ranked.rank).toBe(72);
		expect(rankReason(ranked.penalties)).toBe(
			"Ranked lower: prefers a US security clearance, which you do not hold",
		);
		// Several preferred: 12 at most.
		const many = rankMatch({
			...base,
			filter: {
				...filter,
				preferred: [1, 2, 3].map(() => ({
					country: "United States",
					what: "a US security clearance",
					evidence: "",
				})),
			},
		});
		expect(many.rank).toBe(68);
		// A US citizen holds it: no penalty.
		const american = evaluateHardRequirements(
			{
				title: "Software Engineer",
				locations: ["Remote - Worldwide"],
				workplaceType: "remote",
				descriptionText,
			},
			parseFilterSettings({ livesIn: "United States" }),
		);
		expect(american.preferred).toBeUndefined();
	});

	it("lowers a match whose clearance is preferred in label form, citizenship waived", () => {
		const descriptionText = `${BODY} Citizenship: not required. Clearance: preferred.`;
		const filter = evaluateHardRequirements(
			{
				title: "Software Engineer",
				locations: ["Remote - Worldwide"],
				workplaceType: "remote",
				descriptionText,
			},
			IN_TURKEY,
		);
		expect(filter.decision).toBe("keep");
		const ranked = rankMatch({
			...base,
			filter,
			job: { title: "Software Engineer", descriptionText },
		});
		expect(ranked.penalties).toContainEqual({
			kind: "preferred",
			points: 8,
			reason: "prefers a US security clearance, which you do not hold",
		});
	});

	it("never goes below 0", () => {
		const result = rankMatch({
			...base,
			score: 10,
			filter: filterFor(["Remote (EMEA)"], "remote"),
			profileYears: 1,
			job: {
				title: "Principal Embedded Engineer",
				descriptionText:
					"10+ years of experience. Firmware, RTOS, microcontrollers, security clearance, DoD.",
			},
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

	it("reads the years a posting asks for", () => {
		expect(requiredYears("5+ years of experience with React")).toBe(5);
		expect(
			requiredYears(
				"3+ years of professional experience; 7 years' experience in Java preferred",
			),
		).toBe(7);
		expect(requiredYears("5-7 years experience")).toBe(5);
		expect(requiredYears("We have been around for 20 years.")).toBeNull();
		expect(
			requiredYears(
				"You'll be mentored by a tech lead with 15+ years of experience who cares about code quality.",
			),
		).toBeNull();
		expect(
			requiredYears(
				"Our team has 10+ years of experience. You have 3+ years of experience with React.",
			),
		).toBe(3);
	});

	it("adds up the profile's roles, overlaps once", () => {
		const now = new Date(Date.UTC(2026, 10, 1));
		const role = (dates: string, id: string) => ({
			path: `experience/${id}.md`,
			content: `# Co — Engineer\n\n- **Dates:** ${dates}\n- **Location:** Remote\n`,
		});
		expect(
			profileYears(
				{
					files: [
						role("Jan 2020 – Present", "a"),
						role("Jun 2021 – Dec 2022", "b"),
						role("2016 – 2018", "c"),
					],
				},
				now,
			),
		).toBeCloseTo(8.8, 0);
		expect(profileYears({ files: [] }, now)).toBeNull();
	});
});
