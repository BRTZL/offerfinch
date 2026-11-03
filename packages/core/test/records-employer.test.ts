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

/**
 * Two stints at one company: a junior role, then a senior role years later. Each CV role must be
 * tied to its own experience file, found by title as well as company.
 */
describe("the employer rule with two roles at one company", () => {
	const EARLY =
		"Built the first version of the Harbor Mills booking widget in Vue.";
	const LATER = "Led the move of the checkout service to Kotlin and gRPC.";
	const twice: ProfileRecord[] = [
		records[0] as ProfileRecord,
		role("harbor-early", {
			company: "Harbor Mills",
			title: "Software Developer",
			start: "Mar 2016",
			end: "Sep 2018",
			bullet: EARLY,
		}),
		role("harbor-later", {
			company: "Harbor Mills",
			title: "Senior Software Engineer",
			start: "Apr 2023",
			end: "Present",
			bullet: LATER,
		}),
	];
	const twiceProfile = { files: renderRecords(twice) };
	const twiceCv = (first: string, second: string) => `# Avery Quinn

Lisbon, Portugal

## Experience

### Senior Software Engineer — Harbor Mills
*Remote · Apr 2023 – Present*

- ${first}

### Software Developer — Harbor Mills
*Remote · Mar 2016 – Sep 2018*

- ${second}`;
	const twiceInput = (doc: string): ClaimsInput => ({
		...input(doc),
		profile: twiceProfile,
	});
	/** Each line cited from the file it came from; a role's heading and dates from its own file. */
	function twiceOutput(i: ClaimsInput): ClaimsCheckOutput {
		const early = "experience/harbor-early.md";
		const later = "experience/harbor-later.md";
		const exact: Record<string, [string, string]> = {
			[EARLY]: [early, EARLY],
			[LATER]: [later, LATER],
			"Avery Quinn": ["personal.md", "Avery Quinn"],
			"Lisbon, Portugal": ["personal.md", "Lisbon, Portugal"],
			"Software Developer — Harbor Mills": [
				early,
				"Harbor Mills — Software Developer",
			],
			"Senior Software Engineer — Harbor Mills": [
				later,
				"Harbor Mills — Senior Software Engineer",
			],
		};
		const cite = (text: string): [string, string] | null =>
			exact[text] ??
			(text.includes("Apr 2023")
				? [later, "Apr 2023 – Present"]
				: text.includes("Mar 2016")
					? [early, "Mar 2016 – Sep 2018"]
					: null);
		return {
			claims: segmentDocuments(i).flatMap((s) => {
				const found = cite(s.text);
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

	it("passes each bullet under its own stint", () => {
		const i = twiceInput(twiceCv(LATER, EARLY));
		const report = verifyClaims(twiceOutput(i), i, "openai:checker");
		expect(report.issues.filter((x) => x.document === "cv")).toEqual([]);
	});

	it("flags a bullet moved to the other stint", () => {
		const i = twiceInput(twiceCv(EARLY, LATER));
		const report = verifyClaims(twiceOutput(i), i, "openai:checker");
		const about = (text: string) =>
			report.issues.find(
				(x) => x.rule === "unchecked_line" && x.excerpt === text,
			)?.message;
		expect(about(EARLY)).toMatch(/is not about Harbor Mills/);
		expect(about(LATER)).toMatch(/is not about Harbor Mills/);
	});

	it("flags a stint whose title or dates are not its file's", () => {
		const i = twiceInput(
			twiceCv(LATER, EARLY).replace(
				"Mar 2016 – Sep 2018",
				"Mar 2016 – Sep 2019",
			),
		);
		const messages = verifyClaims(twiceOutput(i), i, "openai:checker")
			.issues.filter((x) => x.rule === "experience_record")
			.map((x) => x.message);
		expect(messages).toEqual([
			'Harbor Mills dates must be "Mar 2016 – Sep 2018" (experience/harbor-early.md header).',
		]);
	});
});
