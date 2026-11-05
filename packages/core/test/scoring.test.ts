import { describe, expect, it } from "vitest";

import { loadProfileFromDir } from "../src/profile/load-node";
import { redactContact } from "../src/profile/types";
import { AnthropicProvider } from "../src/scoring/anthropic";
import { FakeLlmProvider } from "../src/scoring/fake";
import {
	buildFitPrompt,
	computeScore,
	type FitAssessment,
	scoreFit,
	verifyAssessment,
} from "../src/scoring/fit";
import { FIXTURES } from "./helpers";

const profile = await loadProfileFromDir(`${FIXTURES}/profile`);
const job = {
	companyName: "Acme",
	title: "Senior Full-Stack Engineer",
	locations: ["Remote"],
	workplaceType: "remote" as const,
	descriptionText:
		"Requirements\n- 5+ years with TypeScript and React\n- PostgreSQL\n- Python is a plus\n- Kubernetes in production",
};

describe("profile loading", () => {
	it("reads markdown files with relative paths", () => {
		expect(profile.files.map((f) => f.path)).toEqual([
			"experience/2024-acme.md",
			"skills.md",
			"summary.md",
		]);
	});
	it("redacts contact details from the scoring prompt", () => {
		const prompt = buildFitPrompt({ job, profile });
		expect(prompt).not.toContain("test@example.com");
		expect(prompt).not.toContain("555 000");
		expect(redactContact("call +90 555 000 00 00")).toBe("call [phone]");
	});
});

describe("evidence verification", () => {
	it("keeps verbatim citations and drops invented ones", () => {
		const assessment: FitAssessment = {
			summary: "s",
			requirements: [
				{
					requirement: "TypeScript",
					kind: "skill_or_experience",
					importance: "must",
					status: "met",
					evidence: [
						{ file: "skills.md", quote: "TypeScript, JavaScript, Go" },
					],
					note: "",
				},
				{
					requirement: "Kubernetes",
					kind: "skill_or_experience",
					importance: "must",
					status: "met",
					evidence: [
						{
							file: "skills.md",
							quote: "Runs Kubernetes clusters in production",
						},
					],
					note: "",
				},
				{
					requirement: "Python",
					kind: "skill_or_experience",
					importance: "nice",
					status: "met",
					evidence: [{ file: "experience/2023-python.md", quote: "Python" }],
					note: "",
				},
			],
		};
		const { requirements, dropped } = verifyAssessment(assessment, profile);
		expect(requirements[0]?.status).toBe("met");
		expect(requirements[1]?.status).toBe("unknown");
		expect(requirements[1]?.evidence).toEqual([]);
		expect(requirements[2]?.status).toBe("unknown");
		expect(dropped.map((d) => d.reason)).toEqual([
			"quote not found in file",
			"file not in profile",
		]);
	});

	it("matches quotes across markdown emphasis and whitespace", () => {
		const { requirements } = verifyAssessment(
			{
				summary: "",
				requirements: [
					{
						requirement: "x",
						kind: "skill_or_experience",
						importance: "must",
						status: "met",
						evidence: [
							{ file: "skills.md", quote: "Backend: Node.js,  NestJS" },
						],
						note: "",
					},
				],
			},
			profile,
		);
		expect(requirements[0]?.evidence).toHaveLength(1);
	});

	it("computes the score from verified statuses", () => {
		expect(computeScore([])).toBe(0);
		expect(
			computeScore([
				{
					requirement: "a",
					importance: "must",
					status: "met",
					evidence: [],
					note: "",
				},
				{
					requirement: "b",
					importance: "nice",
					status: "not_met",
					evidence: [],
					note: "",
				},
			]),
		).toBe(67);
	});
});

describe("fit scoring with the fake provider", () => {
	it("is deterministic and cites only profile text", async () => {
		const llm = new FakeLlmProvider();
		const first = await scoreFit(llm, { job, profile });
		const second = await scoreFit(llm, { job, profile });
		expect(first).toEqual(second);
		expect(first.droppedEvidence).toEqual([]);
		const byReq = Object.fromEntries(
			first.requirements.map((r) => [r.requirement, r]),
		);
		expect(byReq["5+ years with TypeScript and React"]?.status).toBe("met");
		expect(byReq["Kubernetes in production"]?.status).toBe("not_met");
		expect(byReq["Python is a plus"]?.importance).toBe("nice");
		for (const req of first.requirements) {
			for (const cite of req.evidence) {
				const file = profile.files.find((f) => f.path === cite.file);
				expect(file?.content).toContain(cite.quote);
			}
		}
	});
});

describe("AnthropicProvider", () => {
	it("streams structured output on claude-opus-5-5 by default", async () => {
		let captured: Record<string, unknown> | undefined;
		const client = {
			beta: {
				messages: {
					stream: (params: Record<string, unknown>) => {
						captured = params;
						return {
							finalMessage: async () => ({
								stop_reason: "end_turn",
								parsed_output: { requirements: [], summary: "ok" },
							}),
						};
					},
				},
			},
		};
		const provider = new AnthropicProvider({ client: client as never });
		const result = await scoreFit(provider, { job, profile });
		expect(result.provider).toBe("anthropic:claude-opus-5-5");
		expect(captured?.model).toBe("claude-opus-5-5");
		expect(captured?.thinking).toEqual({ type: "adaptive" });
		expect(
			(captured?.output_config as { format?: { type?: string } })?.format?.type,
		).toBe("json_schema");
		expect(captured?.fallbacks).toBe("default");
	});

	it("raises on a refusal instead of scoring", async () => {
		const client = {
			beta: {
				messages: {
					stream: () => ({
						finalMessage: async () => ({
							stop_reason: "refusal",
							stop_details: { explanation: "no" },
							parsed_output: null,
						}),
					}),
				},
			},
		};
		await expect(
			scoreFit(new AnthropicProvider({ client: client as never }), {
				job,
				profile,
			}),
		).rejects.toThrow(/declined/);
	});
});
