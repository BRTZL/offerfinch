import { describe, expect, it } from "vitest";

import type { ProfileSnapshot } from "../src/profile/types";
import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	segmentDocuments,
	verifyClaims,
} from "../src/tailor/claims";

/**
 * Tailoring eval, 2026-11-03: a CV line copied word for word from the profile failed with "Not
 * in the profile files its claims cite: Node.js, PostgreSQL" because the profile sentence ends
 * "without duplicate payouts", and a sentence with any negation stated nothing. "without"
 * negates what follows it; the words before it are stated. Any other negation still blanks the
 * sentence.
 */

const EXPERIENCE = "experience/refunds.md";

function profileWith(bullet: string): ProfileSnapshot {
	return {
		files: [
			{
				path: "personal.md",
				content: "# Personal\n\n- **Name:** Sam Example\n",
			},
			{
				path: EXPERIENCE,
				content: `# Ledgerline — Senior Software Engineer\n\n- **Dates:** Mar 2022 – Present\n- **Location:** Remote\n\n## What I did\n\n- ${bullet}\n`,
			},
		],
	};
}

const HEADING = "### Senior Software Engineer — Ledgerline";

function check(cvLine: string, bullet: string) {
	const input: ClaimsInput = {
		documents: {
			cv: `# Sam Example\n\n## Experience\n\n${HEADING}\n*Remote · Mar 2022 – Present*\n\n- ${cvLine}\n`,
			cover_letter: "",
			form_answers: "",
		},
		formAnswers: [],
		profile: profileWith(bullet),
		context: { companyName: "Acme", jobTitle: "Backend Engineer" },
		postingText: "",
	};
	const segments = segmentDocuments(input);
	const quoteFor = (text: string) =>
		text.startsWith("Senior Software Engineer")
			? "# Ledgerline — Senior Software Engineer"
			: text.includes("Mar 2022")
				? "Mar 2022 – Present"
				: bullet;
	const output: ClaimsCheckOutput = {
		claims: segments.map((s) => ({
			segments: [s.id],
			document: s.document,
			text: s.text,
			supported: true,
			evidence: [{ file: EXPERIENCE, quote: quoteFor(s.text) }],
			note: "Stated in the experience file.",
		})),
		skipped: [],
	};
	const report = verifyClaims(output, input, "test");
	return report.issues.filter(
		(i) => i.rule === "unchecked_line" && i.excerpt === cvLine,
	);
}

describe("a profile sentence with 'without' still states what comes before it", () => {
	const BULLET =
		"Built a refunds service in Node.js and PostgreSQL that handles 40,000 refunds a day without duplicate payouts.";

	it("passes the line copied from the profile", () => {
		expect(check(BULLET, BULLET)).toEqual([]);
	});

	it("passes a shorter line naming the technologies before 'without'", () => {
		expect(
			check("Built a refunds service in Node.js and PostgreSQL.", BULLET),
		).toEqual([]);
	});

	it("still fails a name that only follows 'without'", () => {
		const issues = check(
			"Built a refunds service in Node.js with Kafka.",
			"Built a refunds service in Node.js without Kafka.",
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/Kafka/);
	});

	it("still fails a name in a sentence with another negation before 'without'", () => {
		const issues = check(
			"Ran Kubernetes clusters in production.",
			"Never ran Kubernetes clusters in production without supervision.",
		);
		expect(issues).toHaveLength(1);
	});

	it("still fails a name next to a plain negation", () => {
		const issues = check(
			"Built services with Kubernetes.",
			"Built services; no Kubernetes.",
		);
		expect(issues).toHaveLength(1);
	});
});

/**
 * Tailoring eval, final run: "Senior Software Engineer · Next.js, React, Node.js, headless CMS"
 * failed with "Not in the profile files its claims cite: CMS" while the cited line said "headless
 * CMSs". An acronym's plural states the acronym; nothing else is singularised.
 */
describe("an acronym's plural in the profile states the acronym", () => {
	it("passes CMS against a line that says CMSs", () => {
		expect(
			check(
				"Built client sites on a headless CMS.",
				"Built client sites on headless CMSs (Contentful, Sanity).",
			),
		).toEqual([]);
	});

	it("still fails an acronym the line does not name", () => {
		const issues = check(
			"Built client sites on a headless CMS with an ORM.",
			"Built client sites on headless CMSs.",
		);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toMatch(/ORM/);
	});
});
