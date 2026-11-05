import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFilterSettings } from "../src/filter/settings";
import { NoopNotifier } from "../src/notify/ntfy";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { loadProfileFromDir } from "../src/profile/load-node";
import type { ProfileSnapshot } from "../src/profile/types";
import { FakeLlmProvider } from "../src/scoring/fake";
import {
	computeScore,
	type FitAssessment,
	type FitPreference,
	type FitRequirement,
	fitBlockers,
	fitSettings,
	PREFERENCE_PENALTY,
	SCORE_CAP,
	scoreFit,
	verifyAssessment,
} from "../src/scoring/fit";
import type { GenerateObjectRequest, LlmProvider } from "../src/scoring/llm";
import { FIXTURES, fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

const req = (
	status: FitRequirement["status"],
	kind: FitRequirement["kind"] = "skill_or_experience",
	importance: FitRequirement["importance"] = "must",
	note = "",
): FitRequirement => ({
	requirement: kind ?? "r",
	kind,
	importance,
	status,
	evidence: [],
	note,
});

const TEN_SKILLS = Array.from({ length: 10 }, () => req("met"));

const IN_TURKIYE = parseFilterSettings({
	livesIn: "Türkiye",
	languages: ["English", "Turkish"],
});

describe("hard limits cap the fit score", () => {
	it("ends a US-citizen, cleared job below the minimum however many skills match, naming the blocker", () => {
		const requirements = [
			...TEN_SKILLS,
			req(
				"not_met",
				"citizenship",
				"must",
				"Requires US citizenship; your citizenship is Türkiye",
			),
			req("not_met", "clearance", "must", "Requires a DoD security clearance."),
		];
		// The old weighted average: 10 of 12 musts met.
		expect(computeScore(TEN_SKILLS)).toBe(100);
		const score = computeScore(requirements, { minScore: 50 });
		expect(score).toBeLessThan(50);
		expect(score).toBeLessThanOrEqual(SCORE_CAP);
		expect(fitBlockers(requirements)).toEqual([
			"Requires US citizenship; your citizenship is Türkiye.",
			"Requires a DoD security clearance.",
		]);
		// A low minimum still ends it: the cap is the lower of SCORE_CAP and minimum - 1.
		expect(computeScore(requirements, { minScore: 10 })).toBe(9);
		// A minimum of 0 keeps every job, as the user asked.
		expect(computeScore(requirements, { minScore: 0 })).toBe(0);
	});

	it("caps only a must-have hard limit that is not met; skills, nice-to-haves and unknowns never cap", () => {
		for (const kind of [
			"work_authorization",
			"location",
			"citizenship",
			"clearance",
			"language",
		] as const)
			expect(
				computeScore([...TEN_SKILLS, req("not_met", kind)]),
				kind,
			).toBeLessThanOrEqual(SCORE_CAP);
		expect(computeScore([...TEN_SKILLS, req("not_met")])).toBe(91);
		expect(
			computeScore([...TEN_SKILLS, req("not_met", "language", "nice")]),
		).toBe(95);
		expect(computeScore([...TEN_SKILLS, req("unknown", "location")])).toBe(93);
		expect(computeScore([...TEN_SKILLS, req("partial", "location")])).toBe(95);
		// A fit stored before kinds existed reads as skills: no cap.
		const { kind: _, ...old } = req("not_met", "citizenship");
		expect(computeScore([...TEN_SKILLS, old])).toBe(91);
	});
});

describe("verification", () => {
	const PROFILE = {
		files: [
			{
				path: "skills.md",
				content: "# Skills\n\n- TypeScript, React, Node.js",
			},
		],
	} as unknown as ProfileSnapshot;
	const assessment = (
		requirements: FitAssessment["requirements"],
	): FitAssessment => ({ requirements, summary: "s" });

	it("accepts a work-rights, place or language judgement with no quote, from the user's settings", () => {
		const { requirements, dropped } = verifyAssessment(
			assessment([
				{
					requirement: "Authorized to work in Türkiye",
					kind: "work_authorization",
					importance: "must",
					status: "met",
					evidence: [],
					note: "You may work in Türkiye.",
				},
				{
					requirement: "Remote within Türkiye",
					kind: "location",
					importance: "must",
					status: "met",
					evidence: [{ file: "work_rights", quote: "Lives in: Türkiye" }],
					note: "You live there.",
				},
				{
					requirement: "Fluent English",
					kind: "language",
					importance: "must",
					status: "partial",
					evidence: [{ file: "job_search", quote: "English" }],
					note: "",
				},
			]),
			PROFILE,
		);
		expect(requirements.map((r) => r.status)).toEqual([
			"met",
			"met",
			"partial",
		]);
		expect(requirements.every((r) => r.evidence.length === 0)).toBe(true);
		expect(dropped).toEqual([]);
	});

	it("still verifies quotes from profile files, for every kind, and needs one for a skill", () => {
		const { requirements, dropped } = verifyAssessment(
			assessment([
				{
					requirement: "TypeScript",
					kind: "skill_or_experience",
					importance: "must",
					status: "met",
					evidence: [{ file: "skills.md", quote: "TypeScript, React" }],
					note: "",
				},
				{
					requirement: "Go",
					kind: "skill_or_experience",
					importance: "must",
					status: "met",
					evidence: [{ file: "skills.md", quote: "Go, Rust" }],
					note: "",
				},
				{
					requirement: "Kubernetes",
					kind: "skill_or_experience",
					importance: "must",
					status: "met",
					evidence: [{ file: "work_rights", quote: "Lives in: Türkiye" }],
					note: "",
				},
				{
					requirement: "Fluent German",
					kind: "language",
					importance: "must",
					status: "met",
					evidence: [{ file: "skills.md", quote: "Fluent German" }],
					note: "",
				},
			]),
			PROFILE,
		);
		expect(requirements.map((r) => r.status)).toEqual([
			"met",
			"unknown",
			"unknown",
			"met",
		]);
		expect(requirements[0]?.evidence).toHaveLength(1);
		expect(dropped.map((d) => [d.requirement, d.reason])).toEqual([
			["Go", "quote not found in file"],
			["Kubernetes", "file not in profile"],
			["Fluent German", "quote not found in file"],
		]);
	});
});

describe("review findings (2026-11-05)", () => {
	const JOB = {
		companyName: "Acme",
		title: "Engineer",
		locations: ["Remote"],
		workplaceType: "remote" as const,
		descriptionText: "Build things.",
	};
	const PROFILE = {
		files: [{ path: "skills.md", content: "# Skills\n\n- TypeScript" }],
	} as unknown as ProfileSnapshot;

	it("requires a kind on every fresh requirement, so a not-met work right always caps", async () => {
		const answer = {
			requirements: [
				{
					requirement: "US citizenship",
					importance: "must",
					status: "not_met",
					evidence: [],
					note: "",
				},
			],
			summary: "s",
		} as unknown as FitAssessment;
		await expect(
			scoreFit(new Capturing(answer), { job: JOB, profile: PROFILE }),
		).rejects.toThrow();
	});

	it("does not let a skill tagged as a hard limit pass as met with no quote", () => {
		const { requirements } = verifyAssessment(
			{
				requirements: [
					{
						requirement: "Kubernetes",
						kind: "language",
						importance: "must",
						status: "met",
						evidence: [{ file: "job_search", quote: "Kubernetes" }],
						note: "Fluent English, remote in Türkiye.",
					},
					{
						requirement: "5+ years of Go",
						kind: "location",
						importance: "must",
						status: "partial",
						evidence: [],
						note: "",
					},
					{
						requirement: "Fluent Turkish",
						kind: "language",
						importance: "must",
						status: "met",
						evidence: [],
						note: "",
					},
					{
						requirement: "Must be based in Germany",
						kind: "location",
						importance: "must",
						status: "met",
						evidence: [],
						note: "",
					},
				],
				summary: "s",
			},
			PROFILE,
		);
		expect(requirements.map((r) => r.status)).toEqual([
			"unknown",
			"unknown",
			"met",
			"met",
		]);
		// A mis-tagged not-met hard limit still caps: it can only lower the job's own score.
		expect(
			fitBlockers([req("not_met", "location", "must", "Kubernetes")]),
		).toEqual(["Kubernetes."]);
	});

	it("counts each preference topic once, the strictest judgement winning", async () => {
		const prefs = fitSettings(
			parseFilterSettings({ seniority: ["Senior"] }),
		).prefs;
		const three: FitPreference[] = ["match", "mismatch", "mismatch"].map(
			(status) => ({
				topic: "seniority",
				status: status as FitPreference["status"],
				note: status,
			}),
		);
		expect(computeScore(TEN_SKILLS, { preferences: three, prefs })).toBe(85);
		const fit = await scoreFit(
			new Capturing({
				requirements: [
					{
						requirement: "TypeScript",
						kind: "skill_or_experience",
						importance: "must",
						status: "met",
						evidence: [{ file: "skills.md", quote: "TypeScript" }],
						note: "",
					},
				],
				preferences: three,
				summary: "s",
			}),
			{
				job: JOB,
				profile: PROFILE,
				...fitSettings(parseFilterSettings({ seniority: ["Senior"] })),
			},
		);
		expect(fit.preferences).toEqual([
			{ topic: "seniority", status: "mismatch", note: "mismatch" },
		]);
		expect(fit.score).toBe(85);
	});
});

describe("preferences", () => {
	const prefs = fitSettings(
		parseFilterSettings({
			seniority: ["Senior"],
			unwantedRoleTypes: ["People management"],
			preferredIndustries: ["Fintech"],
			companySizes: ["Startup"],
			minSalary: 60000,
			salaryCurrency: "EUR",
		}),
	).prefs;
	const pref = (
		topic: FitPreference["topic"],
		status: FitPreference["status"],
	): FitPreference => ({ topic, status, note: `${topic} ${status}` });

	it("takes fixed points off for each mismatch; a match or unknown changes nothing", () => {
		expect(PREFERENCE_PENALTY).toEqual({
			seniority: 15,
			role_type: 15,
			industry: 15,
			company_size: 5,
		});
		const score = (preferences: FitPreference[]) =>
			computeScore(TEN_SKILLS, { preferences, prefs });
		expect(
			score([pref("seniority", "match"), pref("industry", "unknown")]),
		).toBe(100);
		expect(score([pref("seniority", "mismatch")])).toBe(85);
		expect(
			score([
				pref("role_type", "mismatch"),
				pref("industry", "mismatch"),
				pref("company_size", "mismatch"),
			]),
		).toBe(65);
	});

	it("caps a stated salary below the minimum like a hard limit, and an unknown salary is neutral", () => {
		expect(
			computeScore(TEN_SKILLS, {
				preferences: [pref("salary", "mismatch")],
				prefs,
				minScore: 50,
			}),
		).toBe(SCORE_CAP);
		expect(
			fitBlockers(TEN_SKILLS, [pref("salary", "mismatch")], prefs),
		).toEqual(["salary mismatch."]);
		expect(
			computeScore(TEN_SKILLS, {
				preferences: [pref("salary", "unknown")],
				prefs,
			}),
		).toBe(100);
	});

	it("ignores a judgement on a preference the user did not set", () => {
		const none = fitSettings(parseFilterSettings({})).prefs;
		const all = (
			["seniority", "industry", "company_size", "salary"] as const
		).map((t) => pref(t, "mismatch"));
		expect(computeScore(TEN_SKILLS, { preferences: all, prefs: none })).toBe(
			100,
		);
		expect(fitBlockers(TEN_SKILLS, all, none)).toEqual([]);
	});
});

/** Records each request, answering like the fake. */
class Capturing implements LlmProvider {
	readonly name = "capturing";
	readonly requests: GenerateObjectRequest<unknown>[] = [];
	constructor(private readonly answer: FitAssessment) {}
	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		this.requests.push(request as GenerateObjectRequest<unknown>);
		return request.schema.parse(this.answer);
	}
}

describe("the fit prompt", () => {
	const profile = {
		files: [{ path: "skills.md", content: "- TypeScript" }],
	} as unknown as ProfileSnapshot;
	const settings = parseFilterSettings({
		livesIn: "Türkiye",
		languages: ["English", "Turkish"],
		searchTitles: ["Frontend Engineer"],
		excludeTitleKeywords: ["intern"],
		seniority: ["Senior", "Staff"],
		wantedRoleTypes: ["Individual contributor"],
		unwantedRoleTypes: ["People management"],
		minSalary: 70000,
		salaryCurrency: "eur",
		companySizes: ["Scale-up"],
		preferredIndustries: ["Fintech"],
		avoidIndustries: ["Gambling"],
	});

	it("puts work rights and every preference in the cached prefix, the job alone after it, and no filter verdict", async () => {
		const llm = new Capturing({
			requirements: [],
			preferences: [
				{ topic: "industry", status: "mismatch", note: "Gambling." },
			],
			summary: "s",
		});
		const fit = await scoreFit(llm, {
			job: {
				companyName: "Acme",
				title: "Senior Frontend Engineer",
				locations: ["Remote"],
				workplaceType: "remote",
				descriptionText: "Build things <script>.",
			},
			profile,
			...fitSettings(settings),
		});
		const [request] = llm.requests;
		const prefix = request?.promptPrefix ?? "";
		for (const line of [
			"<work_rights>\nLives in: Türkiye\nCitizenship: Türkiye\nRight to work in: Türkiye\n</work_rights>",
			"Languages the candidate works in: English, Türkçe",
			"Target roles: Frontend Engineer, engineer",
			"Title words to avoid: intern",
			"Target levels: Senior, Staff",
			"Wanted role types: Individual contributor",
			"Unwanted role types: People management",
			"Minimum salary: 70000 EUR a year",
			"Company size or stage: Scale-up",
			"Preferred industries: Fintech",
			"Industries to avoid: Gambling",
		])
			expect(prefix).toContain(line);
		expect(request?.prompt).not.toMatch(
			/Location check|<job_search>\n|Gambling|Lives in/,
		);
		expect(request?.prompt).toContain("Build things ‹script›.");
		expect(request?.system).toMatch(/tag each requirement's kind/i);
		expect(fit.preferences).toEqual([
			{ topic: "industry", status: "mismatch", note: "Gambling." },
		]);
	});

	it("reads an empty preference as not set", async () => {
		const llm = new Capturing({ requirements: [], summary: "s" });
		await scoreFit(llm, {
			job: {
				companyName: "Acme",
				title: "Engineer",
				locations: [],
				workplaceType: "unknown",
				descriptionText: "x",
			},
			profile,
			...fitSettings(parseFilterSettings({})),
		});
		const prefix = llm.requests[0]?.promptPrefix ?? "";
		expect(prefix).toContain("Minimum salary: not set");
		expect(prefix).toContain("Industries to avoid: not set");
	});
});

describe("a blocked job in the flow", () => {
	it("ends as a low score whose reason names the blocker", async () => {
		const profile = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));
		const repo = new MemoryRepo(profile);
		repo.settings = IN_TURKIYE;
		repo.addCompany({ name: "Acme", source: "greenhouse", sourceKey: "acme" });
		const workflows = new LocalWorkflowStarter();
		const deps: PipelineDeps = {
			repo,
			sources: {
				greenhouse: {
					kind: "greenhouse",
					listJobs: async () => [
						{
							source: "greenhouse",
							externalId: "lm",
							url: "https://boards.greenhouse.io/acme/jobs/lm",
							title: "Senior Software Engineer",
							locations: ["Owego, NY"],
							workplaceType: "onsite",
							descriptionText:
								"Requirements\n- TypeScript and React\n- Node.js and PostgreSQL\n- Must be a US Citizen\n- This position will require a DoD security clearance",
						},
					],
				},
			},
			llm: new FakeLlmProvider(),
			claimsLlm: new FakeLlmProvider(),
			exporter: fakeExporter(),
			now: () => new Date("2026-10-30T12:00:00Z"),
			notifier: new NoopNotifier(),
			workflows,
		};
		workflows.bind(deps);
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		const [app] = repo.apps;
		expect(app?.state).toBe("scored");
		expect(app?.filter).toBeNull();
		expect(app?.fit?.score).toBeLessThanOrEqual(SCORE_CAP);
		expect(app?.endedReason).toBe(
			`Requires United States citizenship; your citizenship is Türkiye. Requires a security clearance; your profile and work rights show none. Fit score ${app?.fit?.score} is below the minimum of 50.`,
		);
	});
});
