import { describe, expect, it } from "vitest";

import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	segmentDocuments,
	verifyClaims,
} from "../src/tailor/claims";
import {
	ASKED_QUESTION_PREFIX,
	BOARD_QUESTION_PREFIX,
	checkQuote,
} from "../src/tailor/profile-rules";
import { formAnswersText } from "../src/tailor/tailor";

/**
 * The third real Tessera run (2026-10-31) ended `claims_flagged` with 13 flags; replayed from its
 * saved review with no model call. False alarms accepted here: a courtesy line, plain interest
 * with no fact, sentences about the company or the role, "own" restating "sole developer", the
 * user's own answers from the question inbox (English level; mentoring and onboarding at two
 * employers), and a confirmed profile line refused for a caution about one other word. Every
 * real catch stays flagged. The profile below has the real lines' shape with a fabricated identity.
 */

const ALPHA = "experience/2023-alpha.md";
const BETA = "experience/2025-beta.md";

const ANSWERS = `# Answers

The user's own answers from the question inbox, with date and source. Each question was asked once; its answer settles the topic.

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} What is your English level (e.g. professional working proficiency, C1)?
- Answer: professional working proficiency
- Source: user, 2026-10-31

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you mentored mid-level developers (not only juniors), and at which company?
- Answer: yes at alpha and beta I worked with engineers below me and mentored them and teached them stuff. onboarded etc.
- Source: user, 2026-10-31

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Have you mentored anyone at Alpha?
- Answer: yes at alpha I mentored two engineers. onboarded them too.
- Source: user, 2026-10-31

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} What is your Rust level?
- Answer: not really used it
- Source: user, 2026-10-31

## Answer to a question from tailoring

${ASKED_QUESTION_PREFIX} Which company did you use Rust at?
- Answer: alpha
- Source: user, 2026-10-31

## Answer to a job board's form question (greenhouse)

${BOARD_QUESTION_PREFIX} What is your German level?
- Answer: professional working proficiency
- Source: user, 2026-10-31
`;

const EVENT_LINE =
	'- **Event-driven backend work** (user, 2026-10-28): Sidekiq background jobs, AWS SQS / Lambda event handlers, analytics/tracking events. No volumes recorded; don\'t claim "large-scale". This settles where Sidekiq was used.';

const profile = {
	files: [
		{
			path: ALPHA,
			content: `# Alpha — Senior Software Engineer

- **Dates:** Jan 2023 – Oct 2025
- **Location:** Remote

## What I did

- Owned the billing service.
${EVENT_LINE}
`,
		},
		{
			path: BETA,
			content: `# Beta — Senior Software Engineer

- **Dates:** Nov 2025 – Present
- **Location:** Remote

## What I did

- Built the checkout pages in React.
`,
		},
		{
			path: "projects.md",
			content: `# Projects

## Tablo: restaurant reservation platform (May 2026 – present)

- **CV wording:** "sole developer", no commit counts.
- **Multi-tenant:** restaurant-scoped data, staff roles.
`,
		},
		{ path: "answers.md", content: ANSWERS },
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 123 45 67\n",
		},
	],
};

const context = {
	companyName: "Tessera",
	jobTitle: "Senior Full-Stack Developer",
};
const POSTING = `Senior Full-Stack Developer

Own features across our TypeScript/React front end and API back end.

- Design and ship product features end-to-end across the web app and API
- Model complex ERP domains into clean, reliable code
- Review code, raise the engineering bar, and mentor mid-level developers
- Comfortable owning ambiguous problems in a small team; English working proficiency

Tessera is a cloud-based ERP for ship suppliers and port agents. Ship agency, procurement, inventory and accounting: seven modules sharing one set of data.`;

function input(docs: {
	cv?: string;
	letter?: string;
	answers?: { question: string; answer: string }[];
}): ClaimsInput {
	const answers = docs.answers ?? [];
	return {
		documents: {
			cv: docs.cv ?? "# Ada Example",
			cover_letter: docs.letter ?? "",
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

/** Issues about this line only. */
function flagsOn(i: ClaimsInput, output: ClaimsCheckOutput, text: string) {
	return verifyClaims(output, i, "test").issues.filter(
		(x) => x.excerpt === text,
	);
}

/** The checker skipped every segment of the letter with this category. */
function allSkipped(
	i: ClaimsInput,
	category: ClaimsCheckOutput["skipped"][number]["category"],
): ClaimsCheckOutput {
	return {
		claims: [],
		skipped: segmentDocuments(i).map((s) => ({
			segment: s.id,
			category,
			note: "No fact about the candidate.",
		})),
	};
}

/** One supported claim for one line, citing the given quotes. */
function claimFor(
	i: ClaimsInput,
	text: string,
	evidence: [string, string][],
	document: "cv" | "cover_letter" | "form_answers" = "cover_letter",
): ClaimsCheckOutput {
	return {
		claims: [
			{
				segments: [idOf(i, text)],
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

const letter = (...paragraphs: string[]) =>
	`Dear Hiring Team at Tessera,\n\n${paragraphs.join("\n\n")}\n\nBest regards,\\\nAda Example`;

describe("a courtesy line from a closed list is not a claim", () => {
	it("accepts 'Thank you for your time.' sharing a line with another sentence", () => {
		const i = input({
			letter: letter(
				"I would be glad to talk through the role. Thank you for your time.",
			),
		});
		expect(
			flagsOn(
				i,
				allSkipped(i, "greeting_or_signoff"),
				"Thank you for your time.",
			),
		).toEqual([]);
	});

	it("still flags a thank-you that carries a fact", () => {
		const line = "Thank you for considering my Rust expertise.";
		const i = input({ letter: letter(line) });
		expect(flagsOn(i, allSkipped(i, "greeting_or_signoff"), line)).not.toEqual(
			[],
		);
	});
});

describe("a sentence about the company or the role", () => {
	const ROLE =
		"The Senior Full-Stack Developer role at Tessera stands out because ship agency, procurement, inventory and accounting share one set of data.";
	const THAT =
		"That makes careful data modeling central to the work, and the role pairs it with owning features across the TypeScript/React front end and the API.";

	it("reads the role's subject with the posting's names masked", () => {
		const i = input({ letter: letter(`${ROLE} ${THAT}`) });
		expect(flagsOn(i, allSkipped(i, "about_company_or_role"), ROLE)).toEqual(
			[],
		);
	});

	it("accepts 'That …' continuing a sentence about the role", () => {
		const i = input({ letter: letter(`${ROLE} ${THAT}`) });
		expect(flagsOn(i, allSkipped(i, "about_company_or_role"), THAT)).toEqual(
			[],
		);
	});

	it("flags 'That …' continuing a sentence about the candidate", () => {
		const that = "That makes data modeling central to the work.";
		const i = input({
			letter: letter(`I built Rust services at Alpha. ${that}`),
		});
		expect(
			flagsOn(i, allSkipped(i, "about_company_or_role"), that),
		).not.toEqual([]);
	});

	it("accepts the role's duties naming the hire's colleagues ('other developers')", () => {
		const line =
			"The role combines that domain work with owning features across the web app and API in a small team, and with mentoring other developers.";
		const i = input({ answers: [{ question: "Why Tessera?", answer: line }] });
		expect(flagsOn(i, allSkipped(i, "about_company_or_role"), line)).toEqual(
			[],
		);
	});

	it("still flags a role sentence describing the hire", () => {
		for (const line of [
			"The role suits a senior developer who owns features across the web app and API.",
			"The role suits other developers like the one writing this.",
			"Tessera gains other developers through this hire.",
		]) {
			const i = input({
				answers: [{ question: "Why Tessera?", answer: line }],
			});
			expect(
				flagsOn(i, allSkipped(i, "about_company_or_role"), line),
				line,
			).not.toEqual([]);
		}
	});
});

describe("plain interest with no fact", () => {
	it("accepts interest pointing back at experience stated elsewhere", () => {
		const line =
			"I would be glad to talk through how that experience fits Tessera's team.";
		const i = input({ letter: letter(line) });
		expect(flagsOn(i, allSkipped(i, "motivation_only"), line)).toEqual([]);
	});

	it("accepts 'would most like': a preference, not a scope", () => {
		const line = "Those are the parts of the job I would most like to take on.";
		const i = input({ answers: [{ question: "Why Tessera?", answer: line }] });
		expect(flagsOn(i, allSkipped(i, "motivation_only"), line)).toEqual([]);
	});

	it("still flags interest that brings, places or scopes the experience", () => {
		for (const line of [
			"I would be glad to bring that experience to Tessera.",
			"I would be glad to talk through how that experience at Alpha fits.",
			"I would be glad to talk through my seven years of experience.",
			"I would most like to keep owning all of the billing work.",
		]) {
			const i = input({ letter: letter(line) });
			expect(
				flagsOn(i, allSkipped(i, "motivation_only"), line),
				line,
			).not.toEqual([]);
		}
	});
});

describe("'own' as a verb and 'on my own'", () => {
	const SOLE = [
		[
			"projects.md",
			"## Tablo: restaurant reservation platform (May 2026 – present)",
		],
		["projects.md", '- **CV wording:** "sole developer", no commit counts.'],
		["projects.md", "- **Multi-tenant:** restaurant-scoped data, staff roles."],
	] as [string, string][];

	it("accepts 'I own … end-to-end' on a quote saying 'sole developer'", () => {
		const line =
			"In Tablo, where I am the sole developer, I own a multi-tenant reservation platform end-to-end.";
		const i = input({ answers: [{ question: "Why you?", answer: line }] });
		const output = claimFor(i, line, SOLE, "form_answers");
		expect(flagsOn(i, output, line)).toEqual([]);
	});

	it("does not take a quote's verb 'own' for 'on my own'", () => {
		const line = "Ran the billing service on my own.";
		const cv = `# Ada Example\n\n## Experience\n\n### Senior Software Engineer — Alpha\n\n- ${line}`;
		const i = input({ cv });
		const output = claimFor(
			i,
			line,
			[[ALPHA, "- Owned the billing service."]],
			"cv",
		);
		expect(
			flagsOn(i, output, line)
				.map((x) => x.message)
				.join(" "),
		).toMatch(/not in the cited quotes/);
	});

	it("does not take a quote's 'own' for 'sole'", () => {
		const line = "Sole owner of the billing service.";
		const cv = `# Ada Example\n\n## Experience\n\n### Senior Software Engineer — Alpha\n\n- ${line}`;
		const i = input({ cv });
		const output = claimFor(
			i,
			line,
			[[ALPHA, "- Owned the billing service."]],
			"cv",
		);
		expect(flagsOn(i, output, line)).not.toEqual([]);
	});
});

describe("the user's answers from the question inbox are evidence", () => {
	const ENGLISH = [
		["answers.md", "- Answer: professional working proficiency"],
	] as [string, string][];

	it("names the topic of a what-question for its answer: 'My English is …'", () => {
		const line = "My English is at professional working proficiency.";
		const i = input({ answers: [{ question: "Why you?", answer: line }] });
		expect(
			flagsOn(i, claimFor(i, line, ENGLISH, "form_answers"), line),
		).toEqual([]);
	});

	it("still flags a line the answer does not state, or a board's question", () => {
		for (const line of [
			"My English is fluent.",
			"My German is at professional working proficiency.",
		]) {
			const i = input({ letter: letter(line) });
			const quote = line.includes("German")
				? ([["answers.md", "- Answer: professional working proficiency"]] as [
						string,
						string,
					][])
				: ENGLISH;
			expect(flagsOn(i, claimFor(i, line, quote), line), line).not.toEqual([]);
		}
	});

	it("never names the topic for a negative answer", () => {
		const line = "I have used Rust in production.";
		const i = input({ letter: letter(line) });
		const output = claimFor(i, line, [
			["answers.md", "- Answer: not really used it"],
		]);
		expect(flagsOn(i, output, line)).not.toEqual([]);
	});

	it("never takes a name the question presupposes: 'Which company did you use Rust at?'", () => {
		const line = "Used Rust at Alpha.";
		const cv = `# Ada Example\n\n## Experience\n\n### Senior Software Engineer — Alpha\n\n- ${line}`;
		const i = input({ cv });
		const output = claimFor(i, line, [["answers.md", "- Answer: alpha"]], "cv");
		expect(
			flagsOn(i, output, line)
				.map((x) => x.message)
				.join(" "),
		).toMatch(/Rust/);
	});

	const MENTORING =
		"- Answer: yes at alpha and beta I worked with engineers below me and mentored them and teached them stuff. onboarded etc.";

	it("reads a sentence of an answer naming no employer with the one before it", () => {
		const line =
			"On mentoring, at Alpha and Beta I worked with engineers below me, mentored them and onboarded them.";
		const i = input({ letter: letter(line) });
		expect(
			flagsOn(i, claimFor(i, line, [["answers.md", MENTORING]]), line),
		).toEqual([]);
	});

	it("matches another inflection of the answer's word: 'taught' for 'teached'", () => {
		const line = "At Alpha and Beta I mentored engineers and taught them.";
		const i = input({ letter: letter(line) });
		expect(
			flagsOn(i, claimFor(i, line, [["answers.md", MENTORING]]), line),
		).toEqual([]);
	});

	it("still flags a second employer an answer does not name", () => {
		const line = "At Alpha and Beta I mentored engineers and onboarded them.";
		const i = input({ letter: letter(line) });
		const output = claimFor(i, line, [
			[
				"answers.md",
				"- Answer: yes at alpha I mentored two engineers. onboarded them too.",
			],
		]);
		expect(
			flagsOn(i, output, line)
				.map((x) => x.message)
				.join(" "),
		).toMatch(/Beta/);
	});
});

describe("a caution about one word does not refuse the facts beside it", () => {
	const LINE =
		"Worked on event-driven backend code: Sidekiq background jobs, AWS SQS / Lambda event handlers and analytics/tracking events.";
	const cv = (line: string) =>
		`# Ada Example\n\n## Experience\n\n### Senior Software Engineer — Alpha\n\n- ${line}`;

	it("keeps the whole line's clean sentences as the quote", () => {
		const result = checkQuote(profile, ALPHA, EVENT_LINE);
		expect(result).toMatchObject({ ok: true });
		const clean = checkQuote(
			profile,
			ALPHA,
			"- **Event-driven backend work** (user, 2026-10-28): Sidekiq background jobs, AWS SQS / Lambda event handlers, analytics/tracking events.",
		);
		expect(clean).toMatchObject({ ok: true });
		if (!result.ok || !clean.ok) return;
		expect(result.quote.startsWith(clean.quote)).toBe(true);
		expect(result.quote).not.toMatch(/large-scale|don't/);
	});

	it("still refuses a quote that is only the caution", () => {
		expect(
			checkQuote(
				profile,
				ALPHA,
				'No volumes recorded; don\'t claim "large-scale".',
			),
		).toMatchObject({ ok: false });
	});

	it("accepts the confirmed Sidekiq line on the whole bullet", () => {
		const i = input({ cv: cv(LINE) });
		expect(
			flagsOn(i, claimFor(i, LINE, [[ALPHA, EVENT_LINE]], "cv"), LINE),
		).toEqual([]);
	});

	it("flags the word the cited line says not to claim, however it is quoted", () => {
		const line = "Ran large-scale Sidekiq background jobs.";
		const i = input({ cv: cv(line) });
		for (const quote of [
			EVENT_LINE,
			"Sidekiq background jobs, AWS SQS / Lambda event handlers, analytics/tracking events.",
		])
			expect(
				flagsOn(i, claimFor(i, line, [[ALPHA, quote]], "cv"), line)
					.map((x) => x.message)
					.join(" "),
				quote,
			).toMatch(/large-scale/);
	});
});
