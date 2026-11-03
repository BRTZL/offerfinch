import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadProfileFromDir } from "../src/profile/load-node";
import { FakeLlmProvider } from "../src/scoring/fake";
import { candidateSide, type Segment, skippable } from "../src/tailor/claims";
import { tailorApplication } from "../src/tailor/tailor";
import { FIXTURES } from "./helpers";

/**
 * The tailoring prompt's writing rules, added after the tailoring eval of 2026-11-03
 * (apps/desktop/eval): letters restated the posting and the CV, answers repeated the letter, and
 * drafts dropped qualifiers, rounded durations up and gave the candidate feelings and traits the
 * profile never states. These pin the rules the drafts now rely on.
 */

const profile = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));

const job = {
	companyName: "Acme Robotics",
	title: "Senior Full-Stack Engineer",
	url: "https://jobs.example/acme/1",
	locations: ["Remote - Worldwide"],
	workplaceType: "remote" as const,
	descriptionText:
		"Our platform team of five keeps CI fast for 30 engineers.\nRequirements\n- TypeScript\n- PostgreSQL",
};

async function systemPrompt(): Promise<string> {
	const llm = new FakeLlmProvider();
	await tailorApplication(llm, { job, profile, today: "2026-11-03" });
	return llm.calls[0]?.system ?? "";
}

describe("the tailoring prompt's grounding rules", () => {
	it("keeps qualifiers, verbs and durations at the profile's scope", async () => {
		const system = await systemPrompt();
		expect(system).toContain("Keep every fact at the profile's exact scope");
		expect(system).toMatch(/"mostly in Next\.js"/);
		expect(system).toMatch(/round down/);
		expect(system).toMatch(/never "three years"/);
	});

	it("forbids invented feelings, lessons and traits, and the posting's words as candidate facts", async () => {
		const system = await systemPrompt();
		expect(system).toMatch(
			/Never give the candidate a feeling, preference, lesson, habit, intention or trait/,
		);
		expect(system).toMatch(/Never turn the posting's words into a fact/);
	});

	it("keeps the posting's title out of the CV headline", async () => {
		const system = await systemPrompt();
		expect(system).toMatch(
			/Never the posting's title unless the profile records it/,
		);
		expect(system).not.toContain("Headline written for this role");
	});
});

describe("the tailoring prompt's letter and answer rules", () => {
	it("asks for short paragraphs, a human opening and no clichés or em dashes", async () => {
		const system = await systemPrompt();
		expect(system).toContain("250 to 400 words in total");
		expect(system).toContain(
			"4 body paragraphs of 3 to 5 sentences and 60 to 90 words each",
		);
		expect(system).toMatch(/no paragraph under 60 words/);
		expect(system).toMatch(/Never open with a summary of the posting/);
		expect(system).toMatch(/at most a third of the sentences start with "I"/);
		expect(system).toContain("No em dashes in the letter or the answers");
		for (const cliche of [
			"I am excited to",
			"passionate",
			"I believe I would be a great fit",
			"resonates",
			"aligns with",
		])
			expect(system).toContain(`"${cliche}"`);
	});

	it("answers a value question from the profile or defers it, never with an invented number", async () => {
		const system = await systemPrompt();
		expect(system).toMatch(/never invent one, and no number at all/);
		expect(system).toContain(
			`"I'd like to discuss salary in a first conversation."`,
		);
		expect(system).toContain(
			"The first sentence answers exactly what was asked",
		);
		expect(system).toContain("Open questions take 40 to 100 words");
		expect(system).toMatch(/never one tacked on at the end/);
		expect(system).toMatch(/don't reuse the letter's sentences/);
	});
});

describe("the motivation forms the prompt recommends", () => {
	const side = candidateSide(profile);
	const context = { companyName: job.companyName, jobTitle: job.title };
	const segment = (text: string): Segment => ({
		id: "cl-1",
		document: "cover_letter",
		text,
		context: "",
		occurrence: 0,
	});
	const skips = (text: string) =>
		skippable(segment(text), context, job.descriptionText, side);

	it("are skipped by the claims check when they hold only posting details", () => {
		expect(
			skips(
				"I'm applying for the Senior Full-Stack Engineer role because your platform team of five keeps CI fast for 30 engineers.",
			),
		).toBe(true);
		expect(
			skips(
				"What draws me to Acme Robotics is a platform team of five that keeps CI fast for 30 engineers.",
			),
		).toBe(true);
	});

	it("are still checked as claims once they carry a candidate fact", () => {
		expect(
			skips(
				"I'm applying because I have kept CI fast for 30 engineers at Brightloom.",
			),
		).toBe(false);
		expect(
			skips(
				"What draws me to Acme Robotics is that I built PostgreSQL services for years.",
			),
		).toBe(false);
	});

	it("never let a salary sentence skip the check", () => {
		expect(skips("I'd like to discuss salary in a first conversation.")).toBe(
			false,
		);
	});
});
