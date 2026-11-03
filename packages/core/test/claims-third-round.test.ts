import { describe, expect, it } from "vitest";

import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	segmentDocuments,
	segmentKey,
	verifyClaims,
} from "../src/tailor/claims";
import { formAnswersText } from "../src/tailor/tailor";

/**
 * Third round of counterexamples (Codex review, 2026-10-31) against the claims check's text
 * heuristics. When a heuristic cannot be made safe, the line goes to the flagged review instead:
 * a false flag costs the user a click, a missed false claim can reach an employer.
 */

const ALPHA = "experience/2022-alpha.md";
const BETA = "experience/2024-beta.md";

const profile = {
	files: [
		{
			path: ALPHA,
			content: `# Alpha — Engineer

- **Dates:** Jan 2022 – Dec 2023
- **Location:** Remote

## What I did

- Built the billing service in Go.
`,
		},
		{
			path: BETA,
			content: `# Beta — Engineer

- **Dates:** Jan 2024 – Present
- **Location:** Remote

## What I did

- Ran the checkout team's on-call rota.
`,
		},
		{
			path: "skills.md",
			content: `# Skills

- Alpha uses React. Beta uses Go.
- Alpha and Beta both use TypeScript.
- Delivery: CD (compact disc) mastering for a music label.
- Release: CI (Continuous Integration) on every push.
`,
		},
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 123 45 67\n",
		},
	],
};

const context = { companyName: "Tessera", jobTitle: "Senior Engineer" };
const POSTING = "Tessera is hiring a Senior Engineer for procurement software.";

function input(docs: {
	cv?: string;
	answers?: { question: string; answer: string }[];
}): ClaimsInput {
	const answers = docs.answers ?? [];
	return {
		documents: {
			cv: docs.cv ?? "# Ada Example",
			cover_letter: "",
			form_answers: formAnswersText(answers),
		},
		formAnswers: answers,
		profile,
		context,
		postingText: POSTING,
	};
}

function idOf(i: ClaimsInput, text: string): string {
	const found = segmentDocuments(i).find((s) => s.text === text);
	if (!found) throw new Error(`no segment "${text}"`);
	return found.id;
}

/** One supported claim for one line, citing the given quotes. */
function claimFor(
	i: ClaimsInput,
	text: string,
	evidence: [string, string][],
	document: "cv" | "form_answers" = "cv",
): ClaimsCheckOutput["claims"][number] {
	return {
		segments: [idOf(i, text)],
		document,
		text,
		supported: true,
		evidence: evidence.map(([file, quote]) => ({ file, quote })),
		note: "Stated in the cited profile text.",
	};
}

/** Issues about this line only. */
function flagsOn(i: ClaimsInput, output: ClaimsCheckOutput, text: string) {
	return verifyClaims(output, i, "test").issues.filter(
		(x) => x.excerpt === text,
	);
}

describe("a subordinate heading keeps the role's employer", () => {
	const LINE = "Built the billing service in Go.";
	const CV = `# Ada Example

## Experience

### Engineer — Beta
*Remote · Jan 2024 – Present*

#### Projects

- ${LINE}`;

	it("flags Alpha's line under Beta's nested Projects heading", () => {
		const i = input({ cv: CV });
		const issues = flagsOn(
			i,
			{ claims: [claimFor(i, LINE, [[ALPHA, LINE]])], skipped: [] },
			LINE,
		);
		expect(issues.map((x) => x.message).join(" ")).toMatch(/is not about Beta/);
	});

	it("keeps the employer and the whole heading path in the segment's identity", () => {
		const segment = segmentDocuments(input({ cv: CV })).find(
			(s) => s.text === LINE,
		);
		expect(segment).toMatchObject({
			employer: "Beta",
			context: "Experience › Engineer — Beta › Projects",
		});
		const underAlpha = segmentDocuments(
			input({ cv: CV.replace("Engineer — Beta", "Engineer — Alpha") }),
		).find((s) => s.text === LINE);
		expect(underAlpha?.employer).toBe("Alpha");
		expect(segmentKey(underAlpha ?? { document: "", text: "" })).not.toBe(
			segmentKey(segment ?? { document: "", text: "" }),
		);
	});

	it("still passes the line under its own employer, and clears at a sibling role", () => {
		const own = input({
			cv: CV.replace("Engineer — Beta", "Engineer — Alpha"),
		});
		expect(
			flagsOn(
				own,
				{ claims: [claimFor(own, LINE, [[ALPHA, LINE]])], skipped: [] },
				LINE,
			),
		).toEqual([]);
		const sibling = segmentDocuments(
			input({
				cv: `${CV}\n\n### Engineer — Alpha\n*Remote · Jan 2022 – Dec 2023*\n\n- Ran the checkout team's on-call rota.`,
			}),
		).find((s) => s.text === "Ran the checkout team's on-call rota.");
		expect(sibling).toMatchObject({
			employer: "Alpha",
			context: "Experience › Engineer — Alpha",
		});
	});

	it("flags a line under an employer the profile has no file for", () => {
		const cv = CV.replace("Engineer — Beta", "Engineer — Gamma");
		const i = input({ cv });
		const issues = flagsOn(
			i,
			{ claims: [claimFor(i, LINE, [[ALPHA, LINE]])], skipped: [] },
			LINE,
		);
		expect(issues.map((x) => x.message).join(" ")).toMatch(/Gamma/);
	});
});

describe("a motivation skip is only an expression of interest", () => {
	const question = "Why do you want to work at Tessera?";
	const skipped = (i: ClaimsInput, text: string): ClaimsCheckOutput => ({
		claims: [],
		skipped: [
			{
				segment: idOf(i, text),
				category: "motivation_only",
				note: "A statement of motivation.",
			},
		],
	});

	it("refuses competence and self-description skipped as motivation", () => {
		for (const answer of [
			"I excel at procurement and inventory accounting.",
			"I thrive in procurement-heavy domains.",
			"I am detail-oriented and calm under pressure.",
			"I would love to bring my procurement expertise to Tessera.",
			"I am excited about procurement, which I know inside out.",
			"I apply TDD everywhere.",
			"I hope to keep using Rust, as I did at Brightloom.",
		]) {
			const i = input({ answers: [{ question, answer }] });
			expect(flagsOn(i, skipped(i, answer), answer).length, answer).toBe(1);
		}
	});

	it("accepts plain interest", () => {
		for (const answer of [
			"I want to work on procurement software next.",
			"I would love to join Tessera and learn the ship supply domain.",
			"I am excited about Tessera's mission and look forward to hearing from you.",
		]) {
			const i = input({ answers: [{ question, answer }] });
			expect(flagsOn(i, skipped(i, answer), answer), answer).toEqual([]);
		}
	});
});

describe("a line that names several employers needs evidence for each", () => {
	const SKILLS = "skills.md";

	it("flags React across Alpha and Beta when only Alpha's evidence states React", () => {
		const line = "React across Alpha and Beta.";
		const cv = `# Ada Example\n\n## Skills\n\n- ${line}`;
		const i = input({ cv });
		for (const evidence of [
			[[SKILLS, "Alpha uses React. Beta uses Go."]],
			[
				[SKILLS, "Alpha uses React."],
				[SKILLS, "Beta uses Go."],
			],
		] as [string, string][][]) {
			const issues = flagsOn(
				i,
				{ claims: [claimFor(i, line, evidence)], skipped: [] },
				line,
			);
			expect(issues.map((x) => x.message).join(" ")).toMatch(/Beta.*react/i);
		}
	});

	it("passes when one quote states the fact for both", () => {
		const line = "TypeScript across Alpha and Beta.";
		const i = input({ cv: `# Ada Example\n\n## Skills\n\n- ${line}` });
		expect(
			flagsOn(
				i,
				{
					claims: [
						claimFor(i, line, [
							[SKILLS, "Alpha and Beta both use TypeScript."],
						]),
					],
					skipped: [],
				},
				line,
			),
		).toEqual([]);
	});

	it("counts the role a CV line sits under as one of them", () => {
		const line = "Ran the on-call rota, as at Alpha.";
		const cv = `# Ada Example\n\n## Experience\n\n### Engineer — Beta\n*Remote · Jan 2024 – Present*\n\n- ${line}`;
		const i = input({ cv });
		const issues = flagsOn(
			i,
			{
				claims: [
					claimFor(i, line, [
						[BETA, "Ran the checkout team's on-call rota."],
						[SKILLS, "Alpha uses React."],
					]),
				],
				skipped: [],
			},
			line,
		);
		expect(issues.map((x) => x.message).join(" ")).toMatch(/Alpha/);
	});
});

describe("the profile's own meaning of an acronym wins over the trusted list", () => {
	it("flags CD (Continuous Deployment) when the profile's CD is a compact disc", () => {
		const line = "Ran CD (Continuous Deployment) for a music label.";
		const i = input({ cv: `# Ada Example\n\n## Skills\n\n- ${line}` });
		const issues = flagsOn(
			i,
			{
				claims: [
					claimFor(i, line, [
						["skills.md", "CD (compact disc) mastering for a music label."],
					]),
				],
				skipped: [],
			},
			line,
		);
		expect(issues.map((x) => x.message).join(" ")).toMatch(
			/continuous|deployment/i,
		);
	});

	it("still accepts the trusted meaning the profile also uses", () => {
		const line = "Ran CI (Continuous Integration) on every push.";
		const i = input({ cv: `# Ada Example\n\n## Skills\n\n- ${line}` });
		expect(
			flagsOn(
				i,
				{
					claims: [
						claimFor(i, line, [
							["skills.md", "CI (Continuous Integration) on every push."],
						]),
					],
					skipped: [],
				},
				line,
			),
		).toEqual([]);
	});
});
