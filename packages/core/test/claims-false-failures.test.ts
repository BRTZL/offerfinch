import { describe, expect, it } from "vitest";

import { redactContact } from "../src/profile/types";
import { buildClaimsPrompt, verifyClaims } from "../src/tailor/claims";
import {
	ASKED_QUESTION_PREFIX,
	checkQuote,
	citableText,
} from "../src/tailor/profile-rules";

/**
 * The first real run (Tessera, 2026-10-31) failed honest drafts: the claims check quoted "[phone]"
 * where the profile has a date, refused true facts whose provenance aside says a detail "isn't
 * recorded", and the pipeline's question text in answers.md was citable. The lines below have
 * the shape of the real profile's lines.
 */
const SKILLS = `# Skills

## Data

- **Monorepos:** Nx, Turborepo and plain workspaces, all in production (user, 2026-10-27; which project used which isn't recorded).
- **Architecture:** **Clean Architecture and DDD** in production code (user, 2026-10-27; which projects isn't recorded).
- **Stripe:** production use at Brightloom, in client contract work and in own apps, "multiple times so far" (user, 2026-10-27).
- **Payments:** Polar, RevenueCat, credits and billing systems *(used in: The Flex, before 2026-10-27)*
- **Python:** don't list on CVs.
- Which projects used Kafka isn't recorded.

## Don't claim (no evidence)

- ClickHouse, BigQuery
`;

const PROJECTS = `# Projects

## Freelance and side projects

- Orders and inventory: built in e-commerce/client work (user, 2026-10-27; which project isn't recorded, likely trendmall-api). No invoicing, accounting or multi-currency work.
`;

const ANSWERS = `# Answers

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you mentored mid-level developers (not only juniors), and at which company?
- Answer: yes at brightloom and rivermode I worked with engineers below me and mentored them and teached them stuff. onboarded etc.
- Source: dashboard question inbox, 2026-10-31
`;

const profile = {
	files: [
		{ path: "skills.md", content: SKILLS },
		{ path: "projects.md", content: PROJECTS },
		{ path: "answers.md", content: ANSWERS },
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 000 00 00\n",
		},
	],
};

describe("contact redaction keeps dates", () => {
	it("redacts phones and emails but not ISO dates or year ranges", () => {
		expect(redactContact("(user, 2026-10-27)")).toBe("(user, 2026-10-27)");
		expect(redactContact("Keystone, 2019 - 2021 (3 years)")).toBe(
			"Keystone, 2019 - 2021 (3 years)",
		);
		expect(redactContact("call +90 555 000 00 00 or ada@example.test")).toBe(
			"call [phone] or [email]",
		);
	});

	it("shows the checker the dates it must quote", () => {
		const prompt = buildClaimsPrompt({
			documents: { cv: "# Ada Example", cover_letter: "", form_answers: "" },
			formAnswers: [],
			profile,
			context: {
				companyName: "Tessera",
				jobTitle: "Senior Full-Stack Developer",
			},
			postingText: "",
		});
		expect(prompt).toContain("(user, 2026-10-27; which project used which");
		expect(prompt).toContain("Source: dashboard question inbox, 2026-10-31");
		expect(prompt).not.toContain("(user, [phone]");
		expect(prompt).not.toContain("+90 555");
	});
});

describe("true facts beside a provenance aside are evidence", () => {
	it.each([
		["skills.md", "Nx, Turborepo and plain workspaces, all in production"],
		["skills.md", "Clean Architecture and DDD in production code"],
		[
			"skills.md",
			'production use at Brightloom, in client contract work and in own apps, "multiple times so far" (user, 2026-10-27).',
		],
		["projects.md", "Orders and inventory: built in e-commerce/client work"],
		["projects.md", "No invoicing, accounting or multi-currency work."],
		[
			"answers.md",
			"at brightloom and rivermode I worked with engineers below me and mentored them",
		],
	])("%s: %s", (file, quote) => {
		expect(checkQuote(profile, file, quote)).toMatchObject({ ok: true });
	});

	// The checker quoted whole lines, aside included; the aside is dropped from the evidence.
	it.each([
		[
			"skills.md",
			"**Monorepos:** Nx, Turborepo and plain workspaces, all in production (user, 2026-10-27; which project used which isn't recorded).",
			"**Monorepos:** Nx, Turborepo and plain workspaces, all in production.",
		],
		[
			"skills.md",
			"**Clean Architecture and DDD** in production code (user, 2026-10-27; which projects isn't recorded).",
			"**Clean Architecture and DDD** in production code.",
		],
		[
			"projects.md",
			"Orders and inventory: built in e-commerce/client work (user, 2026-10-27; which project isn't recorded, likely trendmall-api).",
			"Orders and inventory: built in e-commerce/client work.",
		],
	])("whole line %s: %s", (file, quote, evidence) => {
		expect(checkQuote(profile, file, quote)).toMatchObject({
			ok: true,
			quote: evidence,
		});
	});

	it("puts those facts in the citable text the named-terms check reads", () => {
		const skills = citableText(profile, "skills.md");
		expect(skills).toContain("nx, turborepo");
		expect(skills).toContain("clean architecture and ddd");
		expect(skills).not.toContain("python");
		expect(skills).not.toContain("kafka");
	});
});

describe("cautions, the Don't claim list and questions stay refused", () => {
	it("does not let an aside's guess source a name: Trendmall stays unchecked", () => {
		const report = verifyClaims(
			{
				claims: [
					{
						segments: ["cv-1"],
						document: "cv",
						text: "Built orders and inventory for Trendmall API",
						supported: true,
						evidence: [
							{
								file: "projects.md",
								quote:
									"Orders and inventory: built in e-commerce/client work (user, 2026-10-27; which project isn't recorded, likely trendmall-api).",
							},
						],
						note: "The projects line.",
					},
				],
				skipped: [],
			},
			{
				documents: {
					cv: "- Built orders and inventory for Trendmall API",
					cover_letter: "",
					form_answers: "",
				},
				formAnswers: [],
				profile,
				context: { companyName: "Tessera", jobTitle: "Senior Developer" },
				postingText: "",
			},
			"fake",
		);
		const cv = report.issues.filter((i) => i.document === "cv");
		expect(cv).toHaveLength(1);
		expect(cv[0]).toMatchObject({ rule: "unchecked_line" });
		expect(cv[0]?.message).toMatch(/Trendmall/);
	});

	it.each([
		["skills.md", "Python", "quote is from a caution line"],
		["skills.md", "Kafka", "quote is from a caution line"],
		["skills.md", "ClickHouse", "quote is from the Don't claim list"],
		// The aside's own words are not a fact.
		[
			"projects.md",
			"which project isn't recorded, likely trendmall-api",
			"quote is from a caution line",
		],
		[
			"answers.md",
			"Have you mentored mid-level developers",
			"quote is a question, not the candidate's answer",
		],
	])("%s: %s", (file, quote, reason) => {
		expect(checkQuote(profile, file, quote)).toEqual({ ok: false, reason });
	});

	it("refuses a quote stitched across a question and its answer", () => {
		expect(
			checkQuote(
				profile,
				"answers.md",
				"mid-level developers (not only juniors), and at which company? - Answer: yes at brightloom",
			).ok,
		).toBe(false);
	});
});

describe("an answer is evidence, attributed to the user", () => {
	const input = (cv: string) => ({
		documents: { cv, cover_letter: "", form_answers: "" },
		formAnswers: [],
		profile,
		context: {
			companyName: "Tessera",
			jobTitle: "Senior Full-Stack Developer",
		},
		postingText: "",
	});

	it("supports mentoring at Brightloom and Rivermode from the user's answer", () => {
		const report = verifyClaims(
			{
				claims: [
					{
						segments: ["cv-1"],
						document: "cv",
						text: "Mentored and onboarded engineers at Brightloom and Rivermode",
						supported: true,
						evidence: [
							{
								file: "answers.md",
								quote:
									"yes at brightloom and rivermode I worked with engineers below me and mentored them and teached them stuff. onboarded etc.",
							},
						],
						note: "The user's answer.",
					},
				],
				skipped: [],
			},
			input("- Mentored and onboarded engineers at Brightloom and Rivermode"),
			"fake",
		);
		// Only the CV is under test; the empty letter breaks its own length rules.
		expect(report.issues.filter((i) => i.document === "cv")).toEqual([]);
		expect(report.claims[0]).toMatchObject({ supported: true, rejected: [] });
	});

	it("never counts the question's wording ('mid-level') as evidence", () => {
		const report = verifyClaims(
			{
				claims: [
					{
						segments: ["cv-1"],
						document: "cv",
						text: "Mentored mid-level developers at Brightloom and Rivermode",
						supported: true,
						evidence: [
							{
								file: "answers.md",
								quote: "Have you mentored mid-level developers",
							},
							{
								file: "answers.md",
								quote:
									"at brightloom and rivermode I worked with engineers below me",
							},
						],
						note: "Question and answer.",
					},
				],
				skipped: [],
			},
			input("- Mentored mid-level developers at Brightloom and Rivermode"),
			"fake",
		);
		expect(report.claims[0]?.rejected).toEqual([
			{
				file: "answers.md",
				quote: "Have you mentored mid-level developers",
				reason: "quote is a question, not the candidate's answer",
			},
		]);
		expect(report.claims[0]?.evidence.map((e) => e.quote)).toEqual([
			"at brightloom and rivermode I worked with engineers below me",
		]);
	});
});
