import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadProfileFromDir } from "../src/profile/load-node";
import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	factTokens,
	scopeTokens,
	segmentDocuments,
	segmentKey,
	verifyClaims,
} from "../src/tailor/claims";
import { formAnswersText } from "../src/tailor/tailor";
import { FIXTURES } from "./helpers";

/**
 * Codex phase 3 review, finding 3: a segment passed when its claims repeated 70% of its words,
 * so "and Rust" appended to a covered CV bullet went through, and two-letter words ("Go", "No")
 * were never counted. Every fact in a segment must be covered by its claims, and the facts must be
 * in the files the claims cite. The honest case below is written the way a checker model answers
 * (paraphrased, split, third person) and must still pass.
 */

const base = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));
const profile = {
	files: [
		...base.files,
		{
			path: "answers.md",
			content:
				"# Answers\n\n## What is your notice period?\n\nFour weeks from signing the offer.\n\n- Source: dashboard question inbox, 2026-10-30\n",
		},
	],
};

const CV = `# Ada Example

Senior Full-Stack Engineer\\
Izmir, Turkey · ada@example.test · +90 555 000 00 00 · linkedin.com/in/adaexample · ada.example · github.com/adaexample

## Summary

Senior full-stack engineer with 7 years of building and owning production systems end to end, from PostgreSQL data models and APIs to React and React Native apps. Remote since 2020, ships to production several times a week.

## Experience

### Senior Software Engineer — Corvid AI
*Remote · Contract · Feb 2026 – Present*

- Designed its PostgreSQL data model (Drizzle, Hyperdrive) for job status, provider errors, cost per job and webhook delivery state, with a Next.js dashboard for debugging production jobs.

### Senior Software Engineer — Brightloom
*United States · Remote · Jan 2023 – Oct 2025*

- Fixed slow PostgreSQL queries with targeted indexes and query rewrites.
- Led the Communities web rewrite from CRA to Next.js, Tailwind and ShadCN, adding SSR and dynamic theming for faster loads and a smoother UX.

## Education

**Computer Science**, Aegean Institute of Technology (AIT) — 2020 – 2025`;

const LETTER = `Ada Example\\
ada@example.test · +90 555 000 00 00 · linkedin.com/in/adaexample

October 30, 2026

Dear Hiring Team at Acme Robotics,

I am applying for the Senior Full-Stack Engineer role at Acme Robotics. Your posting asks for TypeScript, React and Next.js together with PostgreSQL query tuning, and that combination describes my recent work.

At Brightloom I fixed slow PostgreSQL queries with targeted indexes and query rewrites. I also led the Communities web rewrite from CRA to Next.js, Tailwind and ShadCN, adding SSR and dynamic theming for faster loads. Notification systems are on your list too: I shipped more granular notification controls that cut cancellation rates by 25%. On mobile, I improved performance by cleaning up render paths and navigation. I also moved parts of the backend from serverless Lambdas and Hasura to Ruby on Rails.

At Corvid AI I am the main author of AFC, the studio's event-driven generation service, which runs on durable Cloudflare Workflows. I designed its PostgreSQL data model with Drizzle and Hyperdrive, and built a Next.js dashboard for debugging production jobs. I made job intake and delivery safe to retry with idempotency keys, a transactional outbox and a dead-letter queue.

My background is not only web. At Fieldline I built Java backend services and a web control panel for LPWAN devices.

I have worked remotely since 2020 and ship to production several times a week, owning systems end to end, from PostgreSQL data models and APIs to React and React Native apps.

I would welcome a conversation about the Senior Full-Stack Engineer role at Acme Robotics.

Best regards,\\
Ada Example`;

const ANSWERS = [
	{
		question: "Why do you want to work at Acme Robotics?",
		answer:
			"Acme Robotics builds fleet software for warehouse robots, and that is the work I want to do next.",
	},
	{
		question: "What is your notice period?",
		answer: "Four weeks from signing the offer.",
	},
];

const POSTING =
	"Requirements\n- TypeScript, React and Next.js\n- PostgreSQL query tuning\n- Notification systems\nAcme Robotics builds fleet software for warehouse robots.\nPlease tell us your notice period.";

function input(cv = CV, answers = ANSWERS, letter = LETTER): ClaimsInput {
	return {
		documents: {
			cv,
			cover_letter: letter,
			form_answers: formAnswersText(answers),
		},
		formAnswers: answers,
		profile,
		context: {
			companyName: "Acme Robotics",
			jobTitle: "Senior Full-Stack Engineer",
		},
		postingText: POSTING,
	};
}

type Claim = ClaimsCheckOutput["claims"][number];
const BRIGHTLOOM = "experience/2023-brightloom.md";
const CORVID = "experience/2026-corvid-ai.md";
const FIELDLINE = "experience/2019-fieldline.md";
const QUERIES =
	"Fixed slow PostgreSQL queries with targeted indexes and query rewrites.";

/** What a careful checker model returns for these documents: paraphrased, split, third person. */
function honestOutput(i: ClaimsInput): ClaimsCheckOutput {
	const segments = segmentDocuments(i);
	const id = (start: string) => {
		const found = segments.find((s) => s.text.startsWith(start));
		if (!found) throw new Error(`no segment starts with ${start}`);
		return found.id;
	};
	const claim = (
		segment: string,
		document: Claim["document"],
		text: string,
		evidence: [string, string][],
	): Claim => ({
		segments: [id(segment)],
		document,
		text,
		supported: true,
		evidence: evidence.map(([file, quote]) => ({ file, quote })),
		note: "Stated in the cited profile text.",
	});
	const summary =
		"Senior full-stack engineer with 7 years of building and owning production systems end to end, from PostgreSQL data models and APIs to React and React Native apps.";
	return {
		claims: [
			claim(
				"Senior Full-Stack Engineer",
				"cv",
				"Candidate is a senior full-stack engineer.",
				[["summary.md", "Senior full-stack engineer"]],
			),
			claim(
				"Senior full-stack engineer with 7",
				"cv",
				"Has 7 years of experience building and owning production systems end to end.",
				[["summary.md", summary]],
			),
			claim(
				"Senior full-stack engineer with 7",
				"cv",
				"Works across PostgreSQL data models, APIs, React and React Native apps.",
				[["summary.md", summary]],
			),
			claim(
				"Remote since 2020",
				"cv",
				"Has worked remotely since 2020 and ships to production several times per week.",
				[
					[
						"summary.md",
						"Remote since 2020, ships to production several times a week.",
					],
				],
			),
			claim(
				"Senior Software Engineer — Corvid AI",
				"cv",
				"Senior Software Engineer at Corvid AI.",
				[[CORVID, "Corvid AI — Senior Software Engineer"]],
			),
			claim(
				"Remote · Contract · Feb 2026",
				"cv",
				"Remote contract role at Corvid AI from Feb 2026 to the present.",
				[
					[CORVID, "Feb 2026 – Present"],
					[CORVID, "Remote · Contract"],
				],
			),
			claim(
				"Designed its PostgreSQL",
				"cv",
				"Designed the PostgreSQL data model (Drizzle, Hyperdrive) for job status, provider errors, cost per job and webhook delivery state.",
				[
					[
						CORVID,
						"Designed its PostgreSQL data model (Drizzle, Hyperdrive) for job status, provider errors, cost per job and webhook delivery state",
					],
				],
			),
			claim(
				"Designed its PostgreSQL",
				"cv",
				"Built a Next.js dashboard used to debug production jobs.",
				[[CORVID, "with a Next.js dashboard for debugging production jobs"]],
			),
			claim(
				"Senior Software Engineer — Brightloom",
				"cv",
				"Senior Software Engineer at Brightloom.",
				[[BRIGHTLOOM, "Brightloom — Senior Software Engineer"]],
			),
			claim(
				"United States · Remote",
				"cv",
				"Worked remotely for Brightloom (United States) between Jan 2023 and Oct 2025.",
				[
					[BRIGHTLOOM, "Jan 2023 – Oct 2025"],
					[BRIGHTLOOM, "United States · Remote"],
				],
			),
			claim(
				"Fixed slow PostgreSQL",
				"cv",
				"Fixed slow PostgreSQL queries using targeted indexes and rewritten queries.",
				[[BRIGHTLOOM, QUERIES]],
			),
			claim(
				"Led the Communities",
				"cv",
				"Led the Communities web rewrite from CRA to Next.js, Tailwind and ShadCN.",
				[
					[
						BRIGHTLOOM,
						"Led the Communities web rewrite from CRA to Next.js, Tailwind and ShadCN",
					],
				],
			),
			claim(
				"Led the Communities",
				"cv",
				"Added SSR and dynamic theming, giving faster loads and a smoother UX.",
				[
					[
						BRIGHTLOOM,
						"adding SSR and dynamic theming for faster loads and a smoother UX",
					],
				],
			),
			claim(
				"Computer Science, Aegean",
				"cv",
				"Studied Computer Science at Aegean Institute of Technology (AIT), 2020 – 2025.",
				[
					[
						"education.md",
						"Aegean Institute of Technology (AIT) — 2020 – 2025",
					],
				],
			),
			claim(
				"Your posting asks",
				"cover_letter",
				"TypeScript, React, Next.js and PostgreSQL query tuning describe the candidate's recent work.",
				[
					[BRIGHTLOOM, QUERIES],
					[BRIGHTLOOM, "Led the Communities web rewrite from CRA to Next.js"],
					["skills.md", "TypeScript, JavaScript"],
				],
			),
			claim(
				"At Brightloom I fixed",
				"cover_letter",
				"At Brightloom, fixed slow PostgreSQL queries with targeted indexes and query rewrites.",
				[[BRIGHTLOOM, QUERIES]],
			),
			claim(
				"I also led the Communities",
				"cover_letter",
				"Led the Communities web rewrite from CRA to Next.js, Tailwind and ShadCN, adding SSR and dynamic theming for faster loads.",
				[
					[
						BRIGHTLOOM,
						"Led the Communities web rewrite from CRA to Next.js, Tailwind and ShadCN, adding SSR and dynamic theming for faster loads",
					],
				],
			),
			claim(
				"Notification systems are",
				"cover_letter",
				"Shipped more granular notification controls that cut cancellation rates by 25% (notification systems).",
				[
					[
						BRIGHTLOOM,
						"Shipped more granular notification controls that cut cancellation rates by 25%.",
					],
				],
			),
			claim(
				"On mobile, I improved",
				"cover_letter",
				"Improved mobile performance by cleaning up render paths and navigation.",
				[
					[
						BRIGHTLOOM,
						"Improved mobile performance by cleaning up render paths and navigation",
					],
				],
			),
			claim(
				"I also moved parts",
				"cover_letter",
				"Moved parts of the backend from serverless Lambdas and Hasura to Ruby on Rails.",
				[
					[
						BRIGHTLOOM,
						"Moved parts of the backend from serverless Lambdas and Hasura (GraphQL) to Ruby on Rails",
					],
				],
			),
			claim(
				"At Corvid AI I am",
				"cover_letter",
				"At Corvid AI, main author of AFC, the studio's event-driven generation service running on durable Cloudflare Workflows.",
				[
					[
						CORVID,
						"Main author of AFC (AI Film Compute), the studio's event-driven generation service: durable Cloudflare Workflows",
					],
				],
			),
			claim(
				"I designed its PostgreSQL",
				"cover_letter",
				"Designed AFC's PostgreSQL data model with Drizzle and Hyperdrive and built a Next.js dashboard for debugging production jobs.",
				[
					[CORVID, "Designed its PostgreSQL data model (Drizzle, Hyperdrive)"],
					[CORVID, "with a Next.js dashboard for debugging production jobs"],
				],
			),
			claim(
				"I made job intake",
				"cover_letter",
				"Made job intake and delivery safe to retry using idempotency keys, a transactional outbox and a dead-letter queue.",
				[
					[
						CORVID,
						"Made job intake and delivery safe to retry: idempotency keys on job requests, a Postgres transactional outbox",
					],
					[CORVID, "a dead-letter queue"],
				],
			),
			claim(
				"My background is not only web",
				"cover_letter",
				"Background is not only web development.",
				[
					[
						FIELDLINE,
						"Built Java backend services and a web control panel for LPWAN devices.",
					],
				],
			),
			claim(
				"At Fieldline I built",
				"cover_letter",
				"At Fieldline, built Java backend services and a web control panel for LPWAN devices.",
				[
					[
						FIELDLINE,
						"Built Java backend services and a web control panel for LPWAN devices.",
					],
				],
			),
			claim(
				"I have worked remotely",
				"cover_letter",
				"Has worked remotely since 2020 and ships to production several times a week.",
				[
					[
						"summary.md",
						"Remote since 2020, ships to production several times a week.",
					],
				],
			),
			claim(
				"I have worked remotely",
				"cover_letter",
				"Owns systems end to end, from PostgreSQL data models and APIs to React and React Native apps.",
				[["summary.md", summary]],
			),
			claim(
				"Four weeks",
				"form_answers",
				"Notice period is four weeks from signing the offer.",
				[["answers.md", "Four weeks from signing the offer."]],
			),
		],
		skipped: [
			{
				segment: id("I am applying for"),
				category: "about_company_or_role",
				note: "Names the role and the company.",
			},
			{
				segment: id("I would welcome"),
				category: "greeting_or_signoff",
				note: "Closing line.",
			},
			{
				segment: id("Acme Robotics builds fleet"),
				category: "about_company_or_role",
				note: "About the company.",
			},
		],
	};
}

describe("claims coverage of facts", () => {
	it("passes an honest application checked the way a model paraphrases it", () => {
		const i = input();
		const report = verifyClaims(honestOutput(i), i, "openai:checker");
		expect(
			report.issues.map((x) => `${x.rule}: ${x.excerpt}: ${x.message}`),
		).toEqual([]);
		expect(report.passed).toBe(true);
	});

	const planted = QUERIES.replace("rewrites.", "rewrites and Rust.");

	it("fails 'and Rust' appended to a covered CV bullet when the checker leaves it out", () => {
		const i = input(CV.replace(QUERIES, planted));
		const output = honestOutput(i);
		// The checker restates the bullet as the profile has it, without "and Rust".
		const target = output.claims.find((c) =>
			c.text.startsWith("Fixed slow PostgreSQL"),
		) as Claim;
		target.text = QUERIES;
		const report = verifyClaims(output, i, "openai:checker");
		expect(report.passed).toBe(false);
		expect(report.issues).toContainEqual(
			expect.objectContaining({ rule: "unchecked_line", excerpt: planted }),
		);
	});

	it("fails 'and Rust' when the checker repeats it but cites a quote without it", () => {
		const i = input(CV.replace(QUERIES, planted));
		const output = honestOutput(i);
		const target = output.claims.find((c) =>
			c.text.startsWith("Fixed slow PostgreSQL"),
		) as Claim;
		target.text = planted;
		const report = verifyClaims(output, i, "openai:checker");
		expect(report.passed).toBe(false);
		expect(report.issues.map((x) => x.excerpt)).toContain(planted);
	});

	it("counts two-letter skill names: 'in Go' left out by the checker fails", () => {
		const withGo = QUERIES.replace("rewrites.", "rewrites in Go.");
		const i = input(CV.replace(QUERIES, withGo));
		const output = honestOutput(i);
		const target = output.claims.find((c) =>
			c.text.startsWith("Fixed slow PostgreSQL"),
		) as Claim;
		target.text = QUERIES;
		const report = verifyClaims(output, i, "openai:checker");
		expect(report.passed).toBe(false);
		expect(report.issues).toContainEqual(
			expect.objectContaining({ rule: "unchecked_line", excerpt: withGo }),
		);
	});

	it("checks the polarity of a short answer: 'No' cannot be covered by a claim saying yes", () => {
		const answers = [
			...ANSWERS,
			{ question: "Do you have the right to work in Turkey?", answer: "No" },
		];
		const i = input(CV, answers);
		const output = honestOutput(i);
		output.claims.push({
			segments: [
				segmentDocuments(i).find((s) => s.text.endsWith("Turkey? No"))?.id ??
					"",
			],
			document: "form_answers",
			text: "You have the right to work in Turkey",
			supported: true,
			evidence: [{ file: "personal.md", quote: "Izmir, Turkey" }],
			note: "Lives in Izmir, Turkey.",
		});
		const report = verifyClaims(output, i, "openai:checker");
		expect(report.passed).toBe(false);
		expect(report.issues).toContainEqual(
			expect.objectContaining({
				rule: "unchecked_line",
				excerpt: "Do you have the right to work in Turkey? No",
			}),
		);
	});
});

/**
 * Codex re-check of 647487f, finding 1: "own" and "only" were filler, so "Built APIs on my own."
 * passed on a quote saying only "Built APIs." Scope words must be in the verified quotes.
 */
describe("scope qualifiers", () => {
	const scoped = (from: string, to: string, claimText: string) => {
		const i = input(CV.replace(QUERIES, to));
		const output = honestOutput(i);
		const target = output.claims.find((c) => c.text.startsWith(from)) as Claim;
		// The checker restates the scope word but cites the profile line, which lacks it.
		target.text = claimText;
		return verifyClaims(output, i, "openai:checker");
	};

	it("fails 'on my own' when the cited quote does not say it", () => {
		const own = QUERIES.replace("rewrites.", "rewrites on my own.");
		const report = scoped(
			"Fixed slow PostgreSQL",
			own,
			"Fixed slow PostgreSQL queries on their own with targeted indexes and query rewrites.",
		);
		expect(report.passed).toBe(false);
		expect(report.issues).toContainEqual(
			expect.objectContaining({ rule: "unchecked_line", excerpt: own }),
		);
	});

	it("fails 'only', 'sole', 'all' and 'every' the quote does not state", () => {
		for (const suffix of [
			", the only engineer to do so.",
			" as sole owner.",
			" across all services.",
			" for every service.",
		]) {
			const to = QUERIES.replace(".", suffix);
			const text = to;
			const report = scoped("Fixed slow PostgreSQL", to, text);
			expect(report.passed, to).toBe(false);
			expect(report.issues.map((x) => x.excerpt)).toContain(to);
		}
	});

	it("passes a scope word the quote does state", () => {
		const i = input();
		const report = verifyClaims(honestOutput(i), i, "openai:checker");
		// "Led the Communities web rewrite" cites a quote that says "Led".
		expect(report.passed).toBe(true);
	});
});

/**
 * Codex re-check of 647487f, finding 2: segments were cut with a filter that drops words under
 * three characters, so a CV line "Go" or "C#" made no segment and passed without evidence.
 */
describe("short-token lines", () => {
	for (const line of ["Go", "C#", "- Go", "- C#, Go"]) {
		it(`makes a segment of the CV line "${line}" and fails it without a claim`, () => {
			const cv = CV.replace("## Education", `${line}\n\n## Education`);
			const i = input(cv);
			const text = line.replace(/^- /, "");
			expect(segmentDocuments(i).map((s) => s.text)).toContain(text);
			const report = verifyClaims(honestOutput(i), i, "openai:checker");
			expect(report.passed).toBe(false);
			expect(report.issues).toContainEqual(
				expect.objectContaining({ rule: "unchecked_line", excerpt: text }),
			);
		});
	}
});

/**
 * Codex review, finding 4: claims were matched to segments with words of three characters or
 * more, so a claim could never attach to a standalone "Go" or "C#" line, and an honest line with
 * a valid quote still failed as unchecked. The terms must also be in the files the claim cites.
 */
describe("evidenced short-token lines", () => {
	const DOTNET = "experience/2021-dotnet.md";
	const withCSharp = {
		files: [
			...profile.files,
			{
				path: DOTNET,
				content:
					"# Dotnet Co — Backend Developer\n\n- Built C# services for invoice billing.\n",
			},
		],
	};
	const shortLine = (
		line: string,
		claimText: string,
		evidence: [string, string],
	) => {
		// A skill line sits under Skills: under a role it would need that employer's evidence.
		const cv = CV.replace(
			"## Education",
			`## Skills\n\n- ${line}\n\n## Education`,
		);
		const i = { ...input(cv), profile: withCSharp };
		const output = honestOutput(i);
		const segment = segmentDocuments(i).find((s) => s.text === line);
		expect(segment).toBeDefined();
		output.claims.push({
			segments: [segment?.id ?? ""],
			document: "cv",
			text: claimText,
			supported: true,
			evidence: [{ file: evidence[0], quote: evidence[1] }],
			note: "Stated in the cited profile text.",
		});
		return { report: verifyClaims(output, i, "openai:checker"), line };
	};

	it("passes a standalone Go line backed by a quote that names Go", () => {
		const { report } = shortLine("Go", "Candidate works with Go.", [
			"skills.md",
			"TypeScript, JavaScript, Go, SQL",
		]);
		expect(report.issues).toEqual([]);
		expect(report.passed).toBe(true);
	});

	it("passes a standalone C# line backed by a quote that names C#", () => {
		const { report } = shortLine("C#", "Candidate built C# services.", [
			DOTNET,
			"Built C# services for invoice billing.",
		]);
		expect(report.issues).toEqual([]);
		expect(report.passed).toBe(true);
	});

	it("fails a Go line whose valid quote comes from a file without Go", () => {
		const { report, line } = shortLine("Go", "Candidate works with Go.", [
			FIELDLINE,
			"Built Java backend services and a web control panel for LPWAN devices.",
		]);
		expect(report.passed).toBe(false);
		expect(report.issues).toContainEqual(
			expect.objectContaining({ rule: "unchecked_line", excerpt: line }),
		);
	});

	it("fails a C# line whose valid quote comes from a file without C#", () => {
		const { report, line } = shortLine("C#", "Candidate built C# services.", [
			"skills.md",
			"TypeScript, JavaScript, Go, SQL",
		]);
		expect(report.passed).toBe(false);
		expect(report.issues).toContainEqual(
			expect.objectContaining({ rule: "unchecked_line", excerpt: line }),
		);
	});
});

/** Follow-up to finding 1: a sentence whose only fact is its scope cannot be skipped. */
describe("scope words are never skippable", () => {
	it("fails a letter sentence with a scope word that the checker skips", () => {
		const sentence = "I took the whole migration on my own.";
		const letter = LETTER.replace(
			"I would welcome a conversation",
			`${sentence}\n\nI would welcome a conversation`,
		);
		const i = input(CV, ANSWERS, letter);
		const output = honestOutput(i);
		const segment = segmentDocuments(i).find((s) => s.text === sentence);
		expect(segment).toBeDefined();
		output.skipped.push({
			segment: segment?.id ?? "",
			category: "motivation_only",
			note: "A statement of motivation.",
		});
		const report = verifyClaims(output, i, "openai:checker");
		expect(report.passed).toBe(false);
		expect(report.issues).toContainEqual(
			expect.objectContaining({ rule: "unchecked_line", excerpt: sentence }),
		);
	});
});

/**
 * Codex review, 2026-10-31: segments were keyed by document and text, so two true bullets swapped
 * between employers kept their keys and their quotes. A CV line under a role now needs evidence
 * about that employer, and its context is part of its identity.
 */
describe("a CV line belongs to the role it sits under", () => {
	const CORVID =
		"Designed its PostgreSQL data model (Drizzle, Hyperdrive) for job status, provider errors, cost per job and webhook delivery state, with a Next.js dashboard for debugging production jobs.";
	const BRIGHTLOOM =
		"Fixed slow PostgreSQL queries with targeted indexes and query rewrites.";

	it("flags bullets swapped between employers on a full check", () => {
		const swapped = CV.replace(CORVID, "\u0001")
			.replace(BRIGHTLOOM, CORVID)
			.replace("\u0001", BRIGHTLOOM);
		const i = input(swapped);
		const report = verifyClaims(honestOutput(i), i, "openai:checker");
		const about = (text: string) =>
			report.issues.find(
				(x) => x.rule === "unchecked_line" && x.excerpt === text,
			)?.message;
		expect(about(BRIGHTLOOM)).toMatch(/is not about Corvid AI/);
		expect(about(CORVID)).toMatch(/is not about Brightloom/);
		// In place, the same output passes.
		const ok = input();
		expect(verifyClaims(honestOutput(ok), ok, "openai:checker").passed).toBe(
			true,
		);
	});

	it("gives each line its section and role, so a heading edit changes every line under it", () => {
		const before = segmentDocuments(input()).find((s) => s.text === BRIGHTLOOM);
		expect(before).toMatchObject({
			context: "Experience › Senior Software Engineer — Brightloom",
			employer: "Brightloom",
			occurrence: 0,
		});
		const renamed = segmentDocuments(
			input(CV.replace("— Brightloom", "— Brightloom Inc")),
		).find((s) => s.text === BRIGHTLOOM);
		expect(renamed?.context).not.toBe(before?.context);
		expect(
			segmentKey(renamed ?? before ?? { document: "", text: "" }),
		).not.toBe(segmentKey(before ?? { document: "", text: "" }));
	});

	it("tells a repeated line apart by its occurrence", () => {
		const twice = CV.replace(BRIGHTLOOM, `${BRIGHTLOOM}\n- ${BRIGHTLOOM}`);
		const same = segmentDocuments(input(twice)).filter(
			(s) => s.text === BRIGHTLOOM,
		);
		expect(same.map((s) => s.occurrence)).toEqual([0, 1]);
		expect(new Set(same.map(segmentKey)).size).toBe(2);
	});
});

/**
 * The real Tessera review (2026-10-31) flagged "most" in "most recently as a senior engineer" and
 * "across" in "billing across its mobile app and admin dashboard". "Most recently" dates a role
 * and claims no share of anything; "across" joins two places the line names, which are its facts.
 * Scope words stay strict: "most of my seven years" still needs a quote that says "most".
 */
describe("scope words in the real Tessera review", () => {
	it("reads 'most recently' as no scope claim, and 'most of' as one", () => {
		expect(
			scopeTokens(
				"I have 7 years of experience building production web applications, most recently as a senior engineer with TypeScript, React and Node.js.",
			).has("most"),
		).toBe(false);
		expect(
			scopeTokens("I spent most of my seven years on payments.").has("most"),
		).toBe(true);
		expect(scopeTokens("I built the most used feature.").has("most")).toBe(
			true,
		);
	});

	it("does not require 'across' to be restated, but keeps what it joins", () => {
		const tokens = factTokens(
			"I also built DirectorAI's credits and billing across its mobile app and admin dashboard.",
		);
		expect(tokens.has("across")).toBe(false);
		for (const fact of ["mobile", "app", "admin", "dashboard", "billing"])
			for (const stemmed of factTokens(fact))
				expect(tokens.has(stemmed), fact).toBe(true);
		// A breadth claim is carried by its quantifier, which stays a scope word.
		expect(
			scopeTokens("I built billing across all of our apps.").has("all"),
		).toBe(true);
	});
});
