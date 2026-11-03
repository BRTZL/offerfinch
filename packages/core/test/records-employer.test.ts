import { describe, expect, it } from "vitest";

import { type ProfileRecord, renderRecords } from "../src/profile/records";
import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	segmentDocuments,
	verifyClaims,
} from "../src/tailor/claims";
import { formAnswersText } from "../src/tailor/tailor";

/**
 * The employer rule on a profile kept as records: a CV bullet under a role needs evidence from
 * that role's record, so two true bullets swapped between employers are flagged. Fabricated people
 * and companies only.
 */
const day = new Date("2026-11-01T00:00:00Z");
const role = (
	id: string,
	{
		company,
		title,
		start,
		end,
		bullet,
	}: {
		company: string;
		title: string;
		start: string;
		end: string;
		bullet: string;
	},
): ProfileRecord => ({
	id,
	kind: "experience",
	position: 0,
	source: "you",
	sourceDate: day,
	data: {
		company,
		title,
		location: "Remote",
		start,
		end,
		bullets: [bullet],
		more: "",
	},
});

const HARBOR =
	"Built the billing page in React and cut checkout errors by 30%.";
const LUMEN =
	"Wrote the product search service in Go with PostgreSQL full-text search.";
const records: ProfileRecord[] = [
	{
		id: "about",
		kind: "about",
		position: 0,
		source: "you",
		sourceDate: day,
		data: {
			name: "Avery Quinn",
			email: "",
			phone: "",
			location: "Lisbon, Portugal",
			linkedin: "",
			website: "",
			github: "",
			summary: "",
			more: "",
		},
	},
	role("harbor", {
		company: "Harbor Mills",
		title: "Frontend Engineer",
		start: "Jan 2021",
		end: "Mar 2024",
		bullet: HARBOR,
	}),
	role("lumen", {
		company: "Lumen Labs",
		title: "Software Engineer",
		start: "Jun 2018",
		end: "Dec 2020",
		bullet: LUMEN,
	}),
];
const profile = { files: renderRecords(records) };

const cv = (first: string, second: string) => `# Avery Quinn

Lisbon, Portugal

## Experience

### Frontend Engineer — Harbor Mills
*Remote · Jan 2021 – Mar 2024*

- ${first}

### Software Engineer — Lumen Labs
*Remote · Jun 2018 – Dec 2020*

- ${second}`;

const input = (doc: string): ClaimsInput => ({
	documents: { cv: doc, cover_letter: "", form_answers: formAnswersText([]) },
	formAnswers: [],
	profile,
	context: { companyName: "Acme", jobTitle: "Engineer" },
	postingText: "React, Go",
});

/** A careful checker: each line cited from the record it came from. */
function output(i: ClaimsInput): ClaimsCheckOutput {
	const cite: Record<string, [string, string]> = {
		[HARBOR]: ["experience/harbor.md", HARBOR],
		[LUMEN]: ["experience/lumen.md", LUMEN],
		"Avery Quinn": ["personal.md", "Avery Quinn"],
		"Lisbon, Portugal": ["personal.md", "Lisbon, Portugal"],
	};
	return {
		claims: segmentDocuments(i).flatMap((s) => {
			const found =
				cite[s.text] ??
				(s.text.includes("Harbor Mills")
					? ["experience/harbor.md", "Harbor Mills — Frontend Engineer"]
					: s.text.includes("Lumen Labs")
						? ["experience/lumen.md", "Lumen Labs — Software Engineer"]
						: s.text.includes("Jan 2021")
							? ["experience/harbor.md", "Jan 2021 – Mar 2024"]
							: s.text.includes("Jun 2018")
								? ["experience/lumen.md", "Jun 2018 – Dec 2020"]
								: null);
			if (!found) return [];
			return [
				{
					segments: [s.id],
					document: s.document,
					text: s.text,
					supported: true,
					evidence: [{ file: found[0], quote: found[1] }],
					note: "Stated in the cited record.",
				},
			];
		}),
		skipped: [],
	};
}

describe("the employer rule on records", () => {
	it("passes each bullet under its own role", () => {
		const i = input(cv(HARBOR, LUMEN));
		const report = verifyClaims(output(i), i, "openai:checker");
		// The empty letter breaks the letter's own rules; the CV has no issue.
		expect(report.issues.filter((x) => x.document !== "cover_letter")).toEqual(
			[],
		);
	});

	it("flags two true bullets swapped between employers", () => {
		const i = input(cv(LUMEN, HARBOR));
		const report = verifyClaims(output(i), i, "openai:checker");
		const about = (text: string) =>
			report.issues.find(
				(x) => x.rule === "unchecked_line" && x.excerpt === text,
			)?.message;
		expect(about(LUMEN)).toMatch(/is not about Harbor Mills/);
		expect(about(HARBOR)).toMatch(/is not about Lumen Labs/);
	});
});
