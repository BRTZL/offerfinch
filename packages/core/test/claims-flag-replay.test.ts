import { describe, expect, it } from "vitest";

import {
	type ClaimsCheckOutput,
	type ClaimsInput,
	segmentDocuments,
	verifyClaims,
	withoutExpansions,
} from "../src/tailor/claims";
import { formAnswersText } from "../src/tailor/tailor";

/**
 * The second real run (Tessera, 2026-10-31) ended `failed` on seven flags. Four were false alarms
 * and are accepted now: an acronym's spelled-out form ("MCP (Model Context Protocol)"), a question
 * put to the reader, a sentence only about the company, and a motivation the profile records ("In
 * my own words, …"). The real catches stay: facts merged across two projects ("Both use …"), and
 * whatever the checker itself refuses. The lines below have the shape of the real profile's lines,
 * with a fabricated identity.
 */

const PROJECTS = `# Projects

## Personal AI apps: Fabula and Reelkit (2025 – 2026)

- **storia-server** (79 commits, sole author): Hono on Cloudflare Workers, Drizzle, PostgreSQL, fal.ai.
  - Video jobs go through a Cloudflare Queue with a dead-letter queue (\`storia-video-dlq\`).
  - RevenueCat calls send an \`Idempotency-Key\` header.
- **clipzy-server** (98 commits, sole author): Hono, Drizzle, PostgreSQL, Cloudflare Workflows (generation and template translation), RevenueCat.
`;

const CORVID = `# Corvid AI — Senior Software Engineer

- **Dates:** Feb 2026 – Present
- **Team / product:** DirectorAI, the studio's AI video app
- **Stack:** TypeScript, Go, Cloudflare (Workers, Workflows, Queues), PostgreSQL, MCP

## What I did

- Built its MCP server (\`packages/api/src/mcp/server.ts\`; authored by me). It exposes the style catalog and generations as tools, so an agent can pick a style and check the result without the UI.
`;

const EDUCATION = `# Education

- **Computer Science**, Aegean Institute of Technology — 2020 – 2025
- **Before that:** started building in high school with a friend (user, 2026-10-30). Motivation in the user's words: genuinely loves creating products and solving problems.
`;

const profile = {
	files: [
		{ path: "projects.md", content: PROJECTS },
		{ path: "experience/2026-corvid-ai.md", content: CORVID },
		{ path: "education.md", content: EDUCATION },
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 000 00 00\n",
		},
	],
};

const POSTING = `Senior Full-Stack Developer

Own features across our TypeScript/React front end and API back end.

Tessera is a cloud-based ERP (SaaS) for ship suppliers: "Run your entire ship supply operation in one place." Clients, procurement, inventory and accounting share one set of data.`;

const context = {
	companyName: "Tessera",
	jobTitle: "Senior Full-Stack Developer",
};

function input(docs: {
	cv?: string;
	letter?: string;
	answers?: { question: string; answer: string }[];
	posting?: string;
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
		postingText: docs.posting ?? POSTING,
	};
}

/** The segment ids of a text, in order, so a test can write claims and skips against them. */
function ids(i: ClaimsInput, text: string): string[] {
	return segmentDocuments(i)
		.filter((s) => s.text === text)
		.map((s) => s.id);
}

/** What the claims check says about lines; letter length and names are other tests' business. */
function issuesFor(i: ClaimsInput, output: ClaimsCheckOutput) {
	return verifyClaims(output, i, "test").issues.filter(
		(x) => x.rule !== "length" && x.rule !== "name_spelling",
	);
}

const MCP_LINE =
	"Built DirectorAI's MCP (Model Context Protocol) server, exposing the style catalog and generations as tools for agents.";
const MCP_QUOTE =
	"Built its MCP server (`packages/api/src/mcp/server.ts`; authored by me). It exposes the style catalog and generations as tools, so an agent can pick a style and check the result without the UI.";

describe("an acronym's spelled-out form is not a new name", () => {
	it("drops the spelled-out words in either order, and only when the initials match", () => {
		expect(withoutExpansions(MCP_LINE)).toBe(
			"Built DirectorAI's MCP server, exposing the style catalog and generations as tools for agents.",
		);
		expect(
			withoutExpansions("Built a Model Context Protocol (MCP) server."),
		).toBe("Built a MCP server.");
		expect(withoutExpansions("Used MCP (Rust Go Protocol) daily.")).toBe(
			"Used MCP (Rust Go Protocol) daily.",
		);
	});

	it("accepts the MCP line the real run refused for 'context, protocol'", () => {
		const cv = `# Ada Example\n\n## Experience\n\n- ${MCP_LINE}`;
		const i = input({ cv });
		expect(
			issuesFor(i, {
				claims: [
					{
						segments: ids(i, MCP_LINE),
						document: "cv",
						text: MCP_LINE,
						supported: true,
						evidence: [
							{ file: "experience/2026-corvid-ai.md", quote: MCP_QUOTE },
						],
						note: "The DirectorAI record states the server and exposed tools.",
					},
				],
				skipped: [],
			}),
		).toEqual([]);
	});

	it("still refuses a parenthesis that is not the acronym's spelled-out form", () => {
		const line =
			"Built DirectorAI's MCP (Rust Gateway Proxy) server, exposing the style catalog and generations as tools for agents.";
		const cv = `# Ada Example\n\n## Experience\n\n- ${line}`;
		const i = input({ cv });
		const issues = issuesFor(i, {
			claims: [
				{
					segments: ids(i, line),
					document: "cv",
					text: line,
					supported: true,
					evidence: [
						{ file: "experience/2026-corvid-ai.md", quote: MCP_QUOTE },
					],
					note: "",
				},
			],
			skipped: [],
		});
		expect(issues.map((x) => x.message).join(" ")).toMatch(/rust/i);
	});
});

const LETTER_BODY = (sentence: string) =>
	`Dear Hiring Team at Tessera,\n\nI am applying for the Senior Full-Stack Developer role at Tessera.\n\n${sentence}\n\nBest regards,\\\nAda Example`;

/** Claims for the opening line, so only the sentence under test can fail. */
function letterOutput(
	i: ClaimsInput,
	sentence: string,
	category: ClaimsCheckOutput["skipped"][number]["category"],
): ClaimsCheckOutput {
	const opening =
		"I am applying for the Senior Full-Stack Developer role at Tessera.";
	return {
		claims: [],
		skipped: [
			...ids(i, opening).map((segment) => ({
				segment,
				category: "about_company_or_role" as const,
				note: "",
			})),
			...ids(i, sentence).map((segment) => ({ segment, category, note: "" })),
		],
	};
}

describe("a question to the reader states nothing about the candidate", () => {
	it("accepts 'Are you available for a call …?' skipped", () => {
		const sentence =
			"Are you available for a call to discuss the Senior Full-Stack Developer role?";
		const i = input({ letter: LETTER_BODY(sentence) });
		expect(
			issuesFor(i, letterOutput(i, sentence, "about_company_or_role")),
		).toEqual([]);
	});

	it("refuses a question that carries a candidate fact", () => {
		for (const sentence of [
			"Would you like to hear how I cut latency by 40%?",
			"Do you need someone who has shipped Rust services?",
			"Are you looking for someone available to relocate, as I am?",
		]) {
			const i = input({ letter: LETTER_BODY(sentence) });
			const issues = issuesFor(
				i,
				letterOutput(i, sentence, "about_company_or_role"),
			);
			expect(
				issues.some((x) => x.excerpt === sentence),
				sentence,
			).toBe(true);
		}
	});
});

describe("a sentence only about the company or the role is skippable", () => {
	const ABOUT =
		"Tessera brings a ship supply operation's clients, procurement, inventory and accounting into one cloud ERP built on one shared set of data.";
	const question = "Why do you want to work at Tessera?";

	it("accepts the real run's description of Tessera's product", () => {
		const i = input({ answers: [{ question, answer: ABOUT }] });
		expect(
			issuesFor(i, letterOutput(i, ABOUT, "about_company_or_role")),
		).toEqual([]);
	});

	it("accepts a claim about the company in a name the profile does not hold", () => {
		// Flagged before 2026-11-03: a company sentence had to use the posting's names. Now only a
		// name from the candidate's side (an employer, a word of the profile) makes it theirs.
		const answer = "Tessera runs its entire ERP on Rust.";
		const i = input({ answers: [{ question, answer }] });
		expect(
			issuesFor(i, letterOutput(i, answer, "about_company_or_role")),
		).toEqual([]);
	});

	it("refuses one that brings in the candidate: first person, a profile name, a number", () => {
		for (const answer of [
			"Tessera brings procurement into one cloud ERP, which I built at Fabula.",
			"Tessera built one cloud ERP for procurement, as Fabula did.",
			"Tessera brings procurement into one cloud ERP across 40 ports.",
			"The team built one cloud ERP, and we shipped it.",
			"Tessera would gain an engineer with seven years of TypeScript.",
			"This role suits someone who owned every migration.",
		]) {
			const i = input({ answers: [{ question, answer }] });
			const issues = issuesFor(
				i,
				letterOutput(i, answer, "about_company_or_role"),
			);
			expect(
				issues.some((x) => x.excerpt === answer),
				answer,
			).toBe(true);
		}
	});
});

describe("a motivation the profile records is not a scope claim", () => {
	const MOTIVATION =
		"In my own words, I genuinely love creating products and solving problems.";
	const question = "Why do you want to work at Tessera?";

	// Third round (2026-10-31): "I love creating products" describes the candidate, so it is no
	// longer skippable as motivation; it passes as a claim citing the profile's record (below).
	it("refuses it skipped as motivation: it describes the candidate", () => {
		const i = input({ answers: [{ question, answer: MOTIVATION }] });
		expect(
			issuesFor(i, letterOutput(i, MOTIVATION, "motivation_only")).some(
				(x) => x.excerpt === MOTIVATION,
			),
		).toBe(true);
	});

	it("accepts it as a claim citing education.md", () => {
		const i = input({ answers: [{ question, answer: MOTIVATION }] });
		expect(
			issuesFor(i, {
				claims: [
					{
						segments: ids(i, MOTIVATION),
						document: "form_answers",
						text: "I genuinely love creating products and solving problems.",
						supported: true,
						evidence: [
							{
								file: "education.md",
								quote:
									"Motivation in the user's words: genuinely loves creating products and solving problems.",
							},
						],
						note: "Recorded in education.md.",
					},
				],
				skipped: [],
			}),
		).toEqual([]);
	});

	it("keeps 'on my own' a scope claim", () => {
		const answer = "I built the whole billing system on my own.";
		const i = input({ answers: [{ question, answer }] });
		const issues = issuesFor(i, letterOutput(i, answer, "motivation_only"));
		expect(issues.some((x) => x.excerpt === answer)).toBe(true);
	});
});

describe("facts merged across projects stay flagged", () => {
	it("refuses 'Both use …' when each quote states one project's part", () => {
		const bullet =
			"Sole author of storia-server and clipzy-server (Hono, Drizzle, PostgreSQL). Both use Cloudflare Workflows and Queues with a dead-letter queue, plus RevenueCat subscriptions.";
		const cv = `# Ada Example\n\n## Projects\n\n- ${bullet}`;
		const i = input({ cv });
		const issues = issuesFor(i, {
			claims: [
				{
					segments: ids(i, bullet),
					document: "cv",
					text: bullet,
					supported: true,
					evidence: [
						{
							file: "projects.md",
							quote:
								"**storia-server** (79 commits, sole author): Hono on Cloudflare Workers, Drizzle, PostgreSQL, fal.ai.",
						},
						{
							file: "projects.md",
							quote:
								"Video jobs go through a Cloudflare Queue with a dead-letter queue (`storia-video-dlq`).",
						},
						{
							file: "projects.md",
							quote:
								"**clipzy-server** (98 commits, sole author): Hono, Drizzle, PostgreSQL, Cloudflare Workflows (generation and template translation), RevenueCat.",
						},
					],
					note: "",
				},
			],
			skipped: [],
		});
		expect(issues.map((x) => x.message).join(" ")).toMatch(
			/Both \(not in the cited quotes\)/,
		);
	});
});

/**
 * Codex review, 2026-10-31: posting-word overlap cannot show that a sentence is only about the
 * company. A posting that uses every word of the sentence still leaves it a description of the
 * applicant, and a question can carry an accomplishment. Only narrow scheduling questions, and
 * company sentences with no applicant, competence or accomplishment in them, may be skipped.
 */
describe("a skip cannot hide a description of the applicant", () => {
	const RICH = `${POSTING}

Tessera gains a lot from this hire. This role suits someone with extensive procurement and inventory accounting experience: an engineer who delivered a procurement migration. Would you discuss the role with us? We want an applicant with knowledge of ERP.`;
	const question = "Why do you want to work at Tessera?";
	/** A question goes in the letter; a statement answers the form's question. */
	const place = (sentence: string) =>
		sentence.endsWith("?")
			? input({ letter: LETTER_BODY(sentence), posting: RICH })
			: input({ answers: [{ question, answer: sentence }], posting: RICH });

	it("refuses company, role and reader sentences that describe the applicant, whatever the posting says", () => {
		for (const answer of [
			"Tessera gains an engineer with extensive procurement and inventory accounting experience.",
			"Would you discuss the procurement migration delivered by the applicant?",
			"This role suits someone with procurement experience.",
			"Tessera would benefit from deep knowledge of procurement and inventory accounting.",
			"Tessera gains extensive procurement and inventory accounting.",
			"The team gets a procurement migration delivered.",
			"Could you review the inventory accounting migration I delivered?",
		]) {
			const i = place(answer);
			const issues = issuesFor(
				i,
				letterOutput(i, answer, "about_company_or_role"),
			);
			expect(
				issues.some((x) => x.excerpt === answer),
				answer,
			).toBe(true);
		}
	});

	it("still accepts plain scheduling questions and the real run's product sentence", () => {
		for (const answer of [
			"Are you available for a call to discuss the Senior Full-Stack Developer role?",
			"Would you be open to a short call next week?",
			"Could we schedule a conversation about the role?",
			"Tessera brings a ship supply operation's clients, procurement, inventory and accounting into one cloud ERP built on one shared set of data.",
		]) {
			const i = place(answer);
			expect(
				issuesFor(i, letterOutput(i, answer, "about_company_or_role")),
				answer,
			).toEqual([]);
		}
	});
});

/**
 * Codex review, 2026-10-31: matching initials allowed false meanings. "MCP (Medical
 * Certification Program)" spells MCP and passed on a quote about the MCP server. An expansion is
 * dropped only when the profile states it, or it is on the trusted list of standard terms.
 */
describe("an expansion must be the profile's or a standard one", () => {
	const claimFor = (i: ClaimsInput, line: string): ClaimsCheckOutput => ({
		claims: [
			{
				segments: ids(i, line),
				document: "cv",
				text: line,
				supported: true,
				evidence: [{ file: "experience/2026-corvid-ai.md", quote: MCP_QUOTE }],
				note: "The DirectorAI record states the MCP server.",
			},
		],
		skipped: [],
	});

	it("refuses an expansion whose initials match but whose meaning is not the profile's", () => {
		for (const line of [
			"Built MCP (Medical Certification Program) server.",
			"Built a Medical Certification Program (MCP) server.",
		]) {
			const i = input({ cv: `# Ada Example\n\n## Experience\n\n- ${line}` });
			const issues = issuesFor(i, claimFor(i, line));
			expect(
				issues.some((x) => x.excerpt === line && /medical/i.test(x.message)),
				line,
			).toBe(true);
		}
		expect(
			withoutExpansions("Built MCP (Medical Certification Program) server."),
		).toBe("Built MCP (Medical Certification Program) server.");
	});

	it("accepts a trusted expansion and one the profile states", () => {
		expect(
			withoutExpansions("Ran CI (Continuous Integration) on every push."),
		).toBe("Ran CI on every push.");
		const line = "Built its MCP (Model Context Protocol) server.";
		const i = input({ cv: `# Ada Example\n\n## Experience\n\n- ${line}` });
		expect(issuesFor(i, claimFor(i, line))).toEqual([]);
		// Not on the trusted list, but spelled out in the profile: accepted with the profile.
		const own = "Built its MCP (Media Control Plane) server.";
		const stated = {
			...input({ cv: `# Ada Example\n\n## Experience\n\n- ${own}` }),
		};
		stated.profile = {
			files: stated.profile.files.map((f) =>
				f.path === "experience/2026-corvid-ai.md"
					? {
							...f,
							content: `${f.content}\n- The MCP here is the Media Control Plane.\n`,
						}
					: f,
			),
		};
		expect(issuesFor(stated, claimFor(stated, own))).toEqual([]);
	});
});
