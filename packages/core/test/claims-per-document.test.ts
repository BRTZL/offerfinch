import { describe, expect, it } from "vitest";

import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	candidateSide,
	clearedFlags,
	type StoredFlag,
	SYSTEM_PROMPT,
	segmentDocuments,
	skippable,
	verifyClaims,
} from "../src/tailor/claims";
import { ASKED_QUESTION_PREFIX } from "../src/tailor/profile-rules";
import { formAnswersText } from "../src/tailor/tailor";

/**
 * A different checker for each document (user decision, 2026-11-03). Every CV line is a claim
 * about the candidate. In the cover letter and the form answers only statements about the
 * candidate are: a sentence about the company, the role or the posting, or about why the
 * candidate applies, needs no evidence. The regression scenarios cover the role's own description, a motivation quoting the
 * company's audience, and a line backed by the user's "yes in my all companies basically". The
 * candidate and employer names in this fixture are fictional.
 */

const ROLE_LINE =
	"The Senior Frontend Engineer role is a zero-to-one, AI-first build with no legacy constraints.";
const WHY_LINE =
	"Defining a modern frontend stack from scratch for an audience of 100M+ people is the reason I'm applying.";
const TEAMS_LINE =
	"At Bluefin and Northwind I mentored engineers, and I have worked with Trunk Based Development and Continuous Delivery.";

const BLUEFIN_MENTORING = "Mentored two junior engineers on the checkout team.";
const NORTHWIND_MENTORING =
	"Mentored three engineers through their first year on the team.";
const EVERY_COMPANY_YES = "yes in my all companies basically";

/** The real run's evidence for the practices: a CV line the user confirmed, naming no employer. */
const CONFIRMED_PRACTICES =
	"- Confirmed as true by the user: Ships to production several times a week and has worked with Trunk Based Development and Continuous Delivery.";

/** answers.md, with the user's answer to the practices question. */
const answersWith = (practices: string) => `# Answers

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Trunk Based Development and Continuous Delivery (for example, merging small changes to the main branch daily and releasing continuously)? If so, at which company or project?
- Answer: ${practices}
- Source: user, 2026-11-01

## Confirmed lines

${CONFIRMED_PRACTICES}

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you worked with Docker and Kubernetes?
- Answer: yes, with Docker
- Source: user, 2026-11-01
`;

const profileWith = (practices: string) => ({
	files: [
		{
			path: "experience/2023-bluefin.md",
			content: `# Bluefin — Senior Frontend Engineer

- **Dates:** Mar 2023 – Dec 2024
- **Location:** Remote

## What I did

- Built the checkout flow in React and TypeScript.
- ${BLUEFIN_MENTORING}
`,
		},
		{
			path: "experience/2025-northwind.md",
			content: `# Northwind — Senior Frontend Engineer

- **Dates:** Jan 2025 – Present
- **Location:** Berlin

## What I did

- Built product pages in React, TypeScript and Next.js.
- ${NORTHWIND_MENTORING}
`,
		},
		{
			path: "skills.md",
			content:
				"# Skills\n\n- React, TypeScript, Next.js, Go, AI tooling\n- Claude Code and Codex daily through the terminal\n",
		},
		{ path: "answers.md", content: answersWith(practices) },
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n",
		},
	],
});

const profile = profileWith(EVERY_COMPANY_YES);

const POSTING = `Senior Frontend Engineer

MrBeast is building an AI-first platform from zero to one, with no legacy constraints. You will define a modern frontend stack from scratch for an audience of 100M+ people.

What you bring:
- React and TypeScript
- Trunk Based Development and Continuous Delivery
- Mentoring engineers`;

function input(docs: {
	cv?: string;
	letter?: string;
	answers?: { question: string; answer: string }[];
	practices?: string;
}): ClaimsInput {
	const answers = docs.answers ?? [];
	return {
		documents: {
			cv: docs.cv ?? "# Ada Example",
			cover_letter: docs.letter ?? "",
			form_answers: formAnswersText(answers),
		},
		formAnswers: answers,
		profile: docs.practices ? profileWith(docs.practices) : profile,
		context: { companyName: "MrBeast", jobTitle: "Senior Frontend Engineer" },
		postingText: POSTING,
	};
}

const letter = (...paragraphs: string[]) =>
	`Dear MrBeast team,\n\n${paragraphs.join("\n\n")}\n\nBest regards,\\\nAda Example`;

function segmentOf(i: ClaimsInput, text: string) {
	const found = segmentDocuments(i).find((s) => s.text === text);
	if (!found) throw new Error(`no segment "${text}"`);
	return found;
}

/** Every issue on a line; numbers and line checks alike. */
function flagsOn(i: ClaimsInput, output: ClaimsCheckOutput, text: string) {
	return verifyClaims(output, i, "test").issues.filter(
		(x) => x.excerpt === text,
	);
}

/** The skip-and-coverage check alone, whatever the number check says. */
function lineFlagsOn(i: ClaimsInput, output: ClaimsCheckOutput, text: string) {
	return flagsOn(i, output, text).filter((x) => x.rule === "unchecked_line");
}

const CATEGORIES = [
	"about_company_or_role",
	"motivation_only",
	"greeting_or_signoff",
] as const;

function skipped(
	i: ClaimsInput,
	text: string,
	category: (typeof CATEGORIES)[number],
): ClaimsCheckOutput {
	return {
		claims: [],
		skipped: [
			{
				segment: segmentOf(i, text).id,
				category,
				note: "No fact about the candidate.",
			},
		],
	};
}

function claimFor(
	i: ClaimsInput,
	text: string,
	evidence: [string, string][],
	document: "cv" | "cover_letter" | "form_answers" = "cover_letter",
): ClaimsCheckOutput {
	return {
		claims: [
			{
				segments: [segmentOf(i, text).id],
				document,
				text,
				supported: true,
				evidence: evidence.map(([file, quote]) => ({ file, quote })),
				note: "Stated in the cited profile text.",
			},
		],
		skipped: [],
	};
}

const TEAMS_EVIDENCE: [string, string][] = [
	["experience/2023-bluefin.md", BLUEFIN_MENTORING],
	["experience/2025-northwind.md", NORTHWIND_MENTORING],
	["answers.md", EVERY_COMPANY_YES],
];

/** What the real review's claim cited: mentoring at both, and the confirmed practices line. */
const REAL_TEAMS_EVIDENCE: [string, string][] = [
	["experience/2023-bluefin.md", BLUEFIN_MENTORING],
	["experience/2025-northwind.md", NORTHWIND_MENTORING],
	["answers.md", CONFIRMED_PRACTICES],
];

describe("the three real false flags pass", () => {
	const i = input({ letter: letter(ROLE_LINE, WHY_LINE, TEAMS_LINE) });

	it("accepts the role's own description skipped as about the role", () => {
		expect(
			flagsOn(i, skipped(i, ROLE_LINE, "about_company_or_role"), ROLE_LINE),
		).toEqual([]);
	});

	it("accepts the motivation whose number is the company's audience", () => {
		expect(
			flagsOn(i, skipped(i, WHY_LINE, "motivation_only"), WHY_LINE),
		).toEqual([]);
	});

	it("accepts mentoring and practices at both employers on a yes 'in my all companies'", () => {
		expect(
			flagsOn(i, claimFor(i, TEAMS_LINE, TEAMS_EVIDENCE), TEAMS_LINE),
		).toEqual([]);
	});

	it("accepts it on the real run's citations: the yes is in the profile, the claim cites the confirmed line", () => {
		expect(
			flagsOn(i, claimFor(i, TEAMS_LINE, REAL_TEAMS_EVIDENCE), TEAMS_LINE),
		).toEqual([]);
	});

	// The practices in the clause that names both employers: done at each of them.
	const AT_BOTH =
		"At Bluefin and Northwind I mentored engineers and worked with Trunk Based Development and Continuous Delivery.";

	it("accepts practices placed at both employers on a yes 'in my all companies'", () => {
		const both = input({ letter: letter(AT_BOTH) });
		expect(
			flagsOn(both, claimFor(both, AT_BOTH, REAL_TEAMS_EVIDENCE), AT_BOTH),
		).toEqual([]);
	});

	it("still flags practices placed at both employers when the yes holds only 'in all my teams', in the line's words", () => {
		const teams = input({
			letter: letter(AT_BOTH),
			practices: "yes in all my teams",
		});
		const issues = flagsOn(
			teams,
			claimFor(teams, AT_BOTH, REAL_TEAMS_EVIDENCE),
			AT_BOTH,
		);
		expect(issues.map((x) => x.message).join(" ")).toContain(
			"Trunk Based Development, Continuous Delivery",
		);
		expect(issues.map((x) => x.message).join(" ")).not.toMatch(
			/continuou\b|\bbas\b/,
		);
	});
});

describe("an employer's facts are those of the clause naming it", () => {
	const TOOLS = "Claude Code and Codex daily through the terminal";
	const evidence: [string, string][] = [
		["experience/2023-bluefin.md", BLUEFIN_MENTORING],
		["experience/2025-northwind.md", NORTHWIND_MENTORING],
		["skills.md", TOOLS],
	];

	it("checks a clause naming no employer against the whole profile", () => {
		const line =
			"I mentored engineers at Bluefin and Northwind, and use Claude Code and Codex daily.";
		const i = input({ letter: letter(line) });
		expect(flagsOn(i, claimFor(i, line, evidence), line)).toEqual([]);
	});

	it("still places a fact at each employer its clause names", () => {
		const line =
			"At Bluefin and Northwind I mentored engineers and used Claude Code daily.";
		const i = input({ letter: letter(line) });
		expect(
			flagsOn(i, claimFor(i, line, evidence), line)
				.map((x) => x.message)
				.join(" "),
		).toMatch(/do not state .*Claude Code/);
	});
});

describe("stored flags on the three lines clear at startup, with no model call", () => {
	it("clears exactly the three stored flags", () => {
		const i = input({ letter: letter(ROLE_LINE, WHY_LINE, TEAMS_LINE) });
		// The claims the review kept: the model's claim on the third line (the first two were
		// skipped, and skips are not stored).
		const { claims } = verifyClaims(
			claimFor(i, TEAMS_LINE, REAL_TEAMS_EVIDENCE),
			i,
			"test",
		);
		const stored = (text: string, message: string): StoredFlag => {
			const segment = segmentOf(i, text);
			return {
				document: segment.document,
				text,
				context: segment.context,
				occurrence: segment.occurrence,
				reasons: [{ rule: "unchecked_line", message }],
				state: "open",
			};
		};
		const flags = [
			stored(
				ROLE_LINE,
				"The claims check skipped this as about company or role, but it states a fact about the candidate.",
			),
			stored(
				WHY_LINE,
				"The claims check skipped this as motivation only, but it states a fact about the candidate.",
			),
			stored(
				TEAMS_LINE,
				"This line names Northwind and Bluefin; the cited quotes about Northwind do not state trunk, bas, development, continuou, delivery.",
			),
		];
		expect(clearedFlags(flags, claims, i)).toEqual(flags);
	});
});

describe("a statement about the candidate still needs evidence in a letter", () => {
	for (const line of [
		"I have built Go services for 5 years.",
		"The role needs Go, and I have led Go teams for 8 years.",
		"The candidate has 10 years of React.",
		"I am a certified AWS architect.",
		"I grew revenue 40%.",
		"I care deeply about accessibility.",
		"Having led five teams is the reason I'm applying.",
		"Five years of React is why I'm applying.",
		"I'm applying because I have shipped three apps.",
		"MrBeast gains an engineer with deep React experience.",
		"The team would benefit from someone who shipped checkout flows.",
		"Northwind's checkout served millions of users, which is why I'm applying.",
	])
		it(`flags "${line}" skipped in any category`, () => {
			const i = input({ letter: letter(line) });
			for (const category of CATEGORIES)
				expect(
					lineFlagsOn(i, skipped(i, line, category), line),
					category,
				).not.toEqual([]);
		});

	it("flags 'That …' continuing a sentence about the candidate", () => {
		const that = "That cut page load time across the product.";
		const i = input({
			letter: letter(`I rebuilt the product pages at Northwind. ${that}`),
		});
		expect(
			lineFlagsOn(i, skipped(i, that, "about_company_or_role"), that),
		).not.toEqual([]);
	});
});

describe("a letter's company, role and motivation sentences need no evidence", () => {
	for (const line of [
		"The role asks engineers to bring Kafka experience.",
		"MrBeast reaches an audience of 100M+ people with every upload.",
		"I'm excited about MrBeast's mission and look forward to hearing from you.",
		"The chance to define the stack from scratch is what draws me to the role.",
		"What draws me to the role is the chance to define a stack for 100M+ people.",
	])
		it(`accepts "${line}" skipped`, () => {
			const i = input({ letter: letter(line) });
			expect(
				flagsOn(i, skipped(i, line, "about_company_or_role"), line),
			).toEqual([]);
		});
});

describe("form answers: the same reading as the letter", () => {
	const question = "Why do you want to join MrBeast?";

	it("accepts the role's description and the motivation in an answer", () => {
		const i = input({
			answers: [{ question, answer: `${ROLE_LINE} ${WHY_LINE}` }],
		});
		for (const line of [ROLE_LINE, WHY_LINE])
			expect(
				flagsOn(i, skipped(i, line, "about_company_or_role"), line),
			).toEqual([]);
	});

	it("never skips a short answer read with its question: its 'you' is the candidate", () => {
		const i = input({
			answers: [
				{ question: "Do you have the right to work in the UK?", answer: "Yes" },
			],
		});
		const line = "Do you have the right to work in the UK? Yes";
		for (const category of CATEGORIES)
			expect(
				lineFlagsOn(i, skipped(i, line, category), line),
				category,
			).not.toEqual([]);
	});

	it("flags an answer that only lists names: the candidate's skills", () => {
		for (const line of [
			"React and TypeScript, mostly.",
			"Mostly React and TypeScript.",
		]) {
			const i = input({
				answers: [{ question: "Which stack do you use?", answer: line }],
			});
			expect(
				lineFlagsOn(i, skipped(i, line, "about_company_or_role"), line),
				line,
			).not.toEqual([]);
		}
	});

	it("flags an answer sentence about the candidate", () => {
		const line = "I have mentored engineers at Bluefin.";
		const i = input({ answers: [{ question, answer: line }] });
		expect(
			lineFlagsOn(i, skipped(i, line, "motivation_only"), line),
		).not.toEqual([]);
	});
});

describe("the CV is all claims", () => {
	const line = "Practices: Kubernetes";
	const i = input({ cv: `# Ada Example\n\n## Skills\n\n- ${line}` });

	it("flags a CV line skipped, whatever the category", () => {
		for (const category of CATEGORIES)
			expect(lineFlagsOn(i, skipped(i, line, category), line)).not.toEqual([]);
	});

	it("flags a CV line nothing covers", () => {
		expect(
			lineFlagsOn(i, { claims: [], skipped: [] }, line).map((x) => x.message),
		).toEqual(["The claims check did not cover this."]);
	});

	it("flags Kubernetes on a qualified yes ('yes, with Docker'), in the line's words", () => {
		const issues = lineFlagsOn(
			i,
			claimFor(i, line, [["answers.md", "yes, with Docker"]], "cv"),
			line,
		);
		expect(issues.map((x) => x.message)).toEqual([
			"Not in the profile files its claims cite: Kubernetes.",
		]);
	});
});

describe("the checker's instructions differ by document", () => {
	it("has a section for the CV and one for the letter and answers", () => {
		expect(SYSTEM_PROMPT).toContain("## The CV (cv-…)");
		expect(SYSTEM_PROMPT).toContain(
			"## The cover letter (cl-…) and the form answers (fa-…)",
		);
		expect(SYSTEM_PROMPT).toMatch(/Every CV segment is a claim/);
		expect(SYSTEM_PROMPT).toMatch(/Only statements about the candidate/);
	});
});

/**
 * Codex review, 2026-11-03: candidate facts a letter or answer skip let through, and two false
 * flags of the first version (a fact word in the company's clause, every fact placed at every
 * employer).
 */
describe("a skip cannot hide a candidate fact without 'I'", () => {
	for (const line of [
		// An implied subject in any clause, after any opening adverb or punctuation.
		"The role is exciting; led the migration at Acme.",
		"Previously led the migration at Acme.",
		"The role is exciting, previously led the migration at Acme.",
		"The role is exciting — also built the billing service.",
		"The role is exciting (led the migration at Acme).",
		"Leading the migration at Acme.",
		// Availability, notice and start date.
		"Available immediately.",
		"The role is exciting, and available to start in March.",
		"Start date: the first of next month.",
		// The candidate by their own name, in any case.
		"Ada is fluent in Japanese.",
		"ada is fluent in Japanese.",
		"Japanese is a language Ada Example speaks.",
		"The team would like Example's frontend work.",
		// Narrow re-review: an active verb before a preposition, and a coordinated predicate.
		"Previously worked at Acme.",
		"The role is exciting; worked at Acme.",
		"The role is exciting and previously led the migration at Acme.",
		"Based in Berlin.",
		"Worked at Acme, and the role is exciting.",
	])
		it(`flags "${line}" skipped in any category`, () => {
			const i = input({ letter: letter(line) });
			for (const category of CATEGORIES)
				expect(
					lineFlagsOn(i, skipped(i, line, category), line),
					category,
				).not.toEqual([]);
		});

	it("takes a lowercase common-word name as the candidate when it is a subject or an owner", () => {
		const hope = {
			files: [
				{
					path: "personal.md",
					content: "# Personal\n\n- **Name:** Hope Example\n",
				},
			],
		};
		const lines = [
			"hope is fluent in Japanese.",
			"hope's Japanese is fluent.",
			"I hope to join the team.",
			"We hope to hear from you soon.",
		];
		const i: ClaimsInput = {
			...input({ letter: letter(...lines) }),
			profile: hope,
		};
		const side = candidateSide(hope);
		const verdicts = segmentDocuments(i)
			.filter((x) => lines.includes(x.text))
			.map((x) => [x.text, skippable(x, i.context, POSTING, side)]);
		expect(verdicts).toEqual([
			["hope is fluent in Japanese.", false],
			["hope's Japanese is fluent.", false],
			["I hope to join the team.", true],
			["We hope to hear from you soon.", true],
		]);
	});

	it("takes a common word for a name only as written", () => {
		const hope = {
			files: [
				{
					path: "personal.md",
					content: "# Personal\n\n- **Name:** Hope Example\n",
				},
			],
		};
		const i: ClaimsInput = {
			...input({
				letter: letter("I hope to join the team.", "Hope speaks Japanese."),
			}),
			profile: hope,
		};
		const side = candidateSide(hope);
		const verdicts = segmentDocuments(i)
			.filter((x) => x.document === "cover_letter" && x.text !== "Ada Example")
			.map((x) => [x.text, skippable(x, i.context, POSTING, side)]);
		expect(verdicts).toEqual([
			["I hope to join the team.", true],
			["Hope speaks Japanese.", false],
		]);
	});

	it("accepts a company sentence opening on a participle that describes it", () => {
		for (const line of [
			"Built for creators, the platform reaches 100M+ people.",
			"Led by its founder, MrBeast publishes a video every week.",
			"Based in Greenville, the team ships a video every week.",
			"Distributed systems at scale are core to the role.",
			"The company grew fast and launched a new app.",
			"Excited about the role and its mission.",
		]) {
			const i = input({ letter: letter(line) });
			expect(
				flagsOn(i, skipped(i, line, "about_company_or_role"), line),
				line,
			).toEqual([]);
		}
	});
});

describe("every predicate of the candidate in a skipped sentence is interest", () => {
	for (const line of [
		"I want this role and live nearby.",
		"I am excited about the role and am punctual.",
		"I want this role, live nearby and speak German.",
		"I want to join and have shipped design systems before.",
		"I'm excited about the role but rarely miss a deadline.",
		// Narrow re-review: an earlier "to" does not carry a fact.
		"I want to join the team and live nearby.",
		"I hope to join the team but pay no income tax.",
	])
		it(`flags "${line}"`, () => {
			const i = input({ letter: letter(line) });
			for (const category of CATEGORIES)
				expect(
					lineFlagsOn(i, skipped(i, line, category), line),
					category,
				).not.toEqual([]);
		});

	for (const line of [
		"I'm excited about the product and the team.",
		"I would love to join MrBeast and learn how the team ships.",
		"I'm excited about MrBeast's mission and look forward to hearing from you.",
	])
		it(`accepts "${line}"`, () => {
			const i = input({ letter: letter(line) });
			expect(flagsOn(i, skipped(i, line, "motivation_only"), line)).toEqual([]);
		});
});

describe("fact words count only in the candidate's clause", () => {
	it("accepts a fact word in the company's clause of a motivation", () => {
		const line = "The role is a zero-to-one build, which is why I'm applying.";
		const i = input({ letter: letter(line) });
		expect(flagsOn(i, skipped(i, line, "motivation_only"), line)).toEqual([]);
	});

	for (const line of [
		"The role is a zero-to-one build, which is why I built my own stack.",
		"Shipping three apps alone is why I'm applying.",
		"What excites me is leading teams again.",
	])
		it(`still flags "${line}"`, () => {
			const i = input({ letter: letter(line) });
			expect(
				lineFlagsOn(i, skipped(i, line, "motivation_only"), line),
			).not.toEqual([]);
		});
});
