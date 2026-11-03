import { describe, expect, it } from "vitest";

import { markdownToPreviewHtml } from "../src/export/render";
import {
	BLOCKING_RULES,
	buildFlags,
	CONFIRMABLE_RULES,
	changeFlaggedLine,
	type FlagDocuments,
	locateFlag,
} from "../src/tailor/flags";

const CV = `# Ada Example

## Experience

### Senior Software Engineer — Corvid AI
*Remote · Feb 2026 – Present*

- **Built** DirectorAI's MCP server for agents.
- Ran Kubernetes clusters for 300 services at Google.

## Education

**Computer Science**, Aegean Institute of Technology — 2020 – 2025`;

const LETTER = `Dear Hiring Team at Tessera,

I am applying for the Senior Full-Stack Developer role at Tessera. I hold a Bachelor's degree in Computer Science. I built billing at Corvid AI.

Best regards,\\
Ada Example`;

const docs: FlagDocuments = {
	cv: CV,
	cover_letter: LETTER,
	form_answers: [
		{
			question: "Why Tessera?",
			answer: "Tessera builds an ERP. I love creating products.",
		},
		{ question: "Notice period?", answer: "Four weeks" },
	],
};

describe("flags", () => {
	it("merges reasons per line; a fixed rule makes the line edit-or-delete only", () => {
		const flags = buildFlags([
			{
				rule: "unsupported_claim",
				document: "cover_letter",
				message: "Unsupported claim: no degree in the profile.",
				excerpt: "I hold a degree.",
				lines: ["I hold a Bachelor's degree in Computer Science."],
			},
			{
				rule: "banned_term",
				document: "cover_letter",
				message: '"Bachelor\'s" must not be claimed (did not graduate).',
				excerpt: "I hold a Bachelor's degree in Computer Science.",
			},
			{
				rule: "unchecked_line",
				document: "cv",
				message: "The claims check did not cover this.",
				excerpt: "Ran Kubernetes clusters for 300 services at Google.",
				lines: ["Ran Kubernetes clusters for 300 services at Google."],
			},
			{
				rule: "length",
				document: "cover_letter",
				message: "Cover letter has 40 words; it must be 250 to 400.",
			},
			{
				rule: "unsupported_number",
				document: "cv",
				message: '"300" does not appear in the profile.',
				excerpt: "- Ran Kubernetes clusters for 300 services at Google.",
			},
		]);
		expect(flags).toHaveLength(3);
		const degree = flags.find((f) => f.text?.includes("Bachelor"));
		expect(degree?.reasons.map((r) => r.rule)).toEqual([
			"unsupported_claim",
			"banned_term",
		]);
		expect(degree?.confirmable).toBe(false);
		// The number rule quoted the raw bullet; it lands on the same line as the claim's flag.
		const k8s = flags.find((f) => f.text?.startsWith("Ran Kubernetes"));
		expect(k8s?.reasons.map((r) => r.rule)).toEqual([
			"unchecked_line",
			"unsupported_number",
		]);
		expect(k8s?.confirmable).toBe(true);
		expect(flags.find((f) => f.text === null)?.confirmable).toBe(false);
		expect(BLOCKING_RULES.filter((r) => CONFIRMABLE_RULES.includes(r))).toEqual(
			[],
		);
	});

	it("puts a fixed rule on the same line as the claim flag when the stored line has emphasis", () => {
		const line = "Built Rust services for billing.";
		const flags = buildFlags(
			[
				{
					rule: "unsupported_claim",
					document: "cv",
					message: "Unsupported claim: no Rust in the profile.",
					lines: [line],
				},
				{
					rule: "banned_term",
					document: "cv",
					message: '"Rust" must not be claimed (skills.md: Don\'t claim).',
					excerpt: "- Built **Rust** services for billing.",
				},
			],
			[],
			[{ document: "cv", text: line }],
		);
		expect(flags).toHaveLength(1);
		expect(flags[0]).toMatchObject({ text: line, confirmable: false });
	});

	it("keeps a confirmation only while the line is flagged for nothing new", () => {
		const issue = {
			rule: "unchecked_line" as const,
			document: "cv" as const,
			message: "The claims check did not cover this.",
			lines: ["Ran Kubernetes clusters for 300 services at Google."],
		};
		const [first] = buildFlags([issue]);
		if (!first) throw new Error("no flag");
		const confirmed = [
			{ ...first, state: "confirmed" as const, confirmedAt: "2026-10-31" },
		];
		expect(buildFlags([issue], confirmed)[0]?.state).toBe("confirmed");
		expect(
			buildFlags(
				[
					issue,
					{
						...issue,
						rule: "banned_term",
						message: '"Kubernetes" must not be claimed.',
					},
				],
				confirmed,
			)[0]?.state,
		).toBe("open");
	});

	it("finds and edits a CV bullet whose stored line has emphasis", () => {
		const flag = {
			document: "cv" as const,
			text: "Built DirectorAI's MCP server for agents.",
		};
		expect(locateFlag(docs, flag)).toMatchObject({ wholeLine: true });
		const edited = changeFlaggedLine(docs, flag, "Built an MCP server.");
		expect(edited.kind).toBe("cv");
		expect(edited.content).toContain("\n- Built an MCP server.\n");
		const deleted = changeFlaggedLine(docs, flag, null);
		expect(deleted.content).not.toContain("MCP");
		expect(deleted.content).toContain(
			"*Remote · Feb 2026 – Present*\n\n- Ran Kubernetes",
		);
	});

	it("edits or deletes one sentence of a letter paragraph", () => {
		const flag = {
			document: "cover_letter" as const,
			text: "I hold a Bachelor's degree in Computer Science.",
		};
		expect(changeFlaggedLine(docs, flag, null).content).toContain(
			"role at Tessera. I built billing at Corvid AI.",
		);
		expect(
			changeFlaggedLine(docs, flag, "I studied Computer Science.\nAt AIT.")
				.content,
		).toContain("role at Tessera. I studied Computer Science. At AIT. I built");
	});

	it("edits a form answer's sentence, and a short answer checked with its question", () => {
		const sentence = changeFlaggedLine(
			docs,
			{ document: "form_answers", text: "I love creating products." },
			null,
		);
		expect(JSON.parse(sentence.content)[0]).toEqual({
			question: "Why Tessera?",
			answer: "Tessera builds an ERP.",
		});
		const short = changeFlaggedLine(
			docs,
			{ document: "form_answers", text: "Notice period? Four weeks" },
			"Two weeks",
		);
		expect(JSON.parse(short.content)[1]).toEqual({
			question: "Notice period?",
			answer: "Two weeks",
		});
	});

	it("refuses a line that is missing, repeated, or a whole-document flag", () => {
		expect(() =>
			changeFlaggedLine(docs, { document: "cv", text: "Not there." }, null),
		).toThrow(/Cannot find this line/);
		expect(() =>
			changeFlaggedLine(
				{
					...docs,
					cv: `${CV}\n- Ran Kubernetes clusters for 300 services at Google.`,
				},
				{
					document: "cv",
					text: "Ran Kubernetes clusters for 300 services at Google.",
				},
				null,
			),
		).toThrow(/exactly once/);
		expect(() =>
			changeFlaggedLine(docs, { document: "cover_letter", text: null }, null),
		).toThrow(/whole document/);
	});
});

describe("flags know where their line is (Codex, 2026-10-31)", () => {
	const LINE = "Built payment services.";
	const cv = `# Ada Example

## Experience

### Senior Software Engineer — Corvid AI
*Remote · Feb 2026 – Present*

- ${LINE}

### Senior Software Engineer — Brightloom
*Remote · Jan 2023 – Oct 2025*

- ${LINE}`;
	const two: FlagDocuments = { cv, cover_letter: "", form_answers: [] };
	const brightloom = {
		document: "cv" as const,
		text: LINE,
		context: "Experience › Senior Software Engineer — Brightloom",
		occurrence: 0,
	};

	it("finds the same line under the right employer, and edits only that one", () => {
		const span = locateFlag(two, brightloom);
		expect(span?.start).toBe(cv.lastIndexOf(LINE));
		const changed = changeFlaggedLine(
			two,
			brightloom,
			"Built search services.",
		);
		expect(changed.content).toContain(
			`Corvid AI\n*Remote · Feb 2026 – Present*\n\n- ${LINE}`,
		);
		expect(changed.content.endsWith("- Built search services.")).toBe(true);
		// A flag from before contexts existed cannot tell them apart: edit the document instead.
		expect(locateFlag(two, { document: "cv", text: LINE })).toBeNull();
	});

	it("gives the same text under two employers two flags with their own ids", () => {
		const flags = buildFlags([
			{
				rule: "unsupported_claim",
				document: "cv",
				message: "Unsupported claim: no payment work.",
				lines: [LINE, LINE],
				at: [
					{
						context: "Experience › Senior Software Engineer — Corvid AI",
						occurrence: 0,
					},
					{ context: brightloom.context, occurrence: 0 },
				],
			},
		]);
		expect(flags).toHaveLength(2);
		expect(new Set(flags.map((f) => f.id)).size).toBe(2);
		// A confirmation under one employer does not carry to the line under the other.
		const confirmed = flags.map((f, i) =>
			i === 0
				? { ...f, state: "confirmed" as const, confirmedAt: "2026-10-31" }
				: f,
		);
		const again = buildFlags(
			[
				{
					rule: "unsupported_claim",
					document: "cv",
					message: "Unsupported claim: no payment work.",
					lines: [LINE],
					at: [{ context: brightloom.context, occurrence: 0 }],
				},
			],
			confirmed,
		);
		expect(again[0]?.state).toBe("open");
	});
});

describe("a fixed rule past the quote's cut", () => {
	it("flags the sentence with the term even when the paragraph is longer than the quote", () => {
		const opening =
			`${"Built event-driven TypeScript workflows with queues, retries and webhooks for a fleet of services. ".repeat(3)}`.trim();
		const degree = "I hold a Bachelor's degree in Software Engineering.";
		const paragraph = `${opening} ${degree}`;
		const flags = buildFlags(
			[
				{
					rule: "banned_term",
					document: "cover_letter",
					message: '"Bachelor\'s" must not be claimed (did not graduate).',
					excerpt: `${paragraph.slice(0, 199)}…`,
				},
			],
			[],
			[
				{
					document: "cover_letter",
					text: degree,
					context: paragraph,
					occurrence: 0,
				},
			],
		);
		expect(flags.map((f) => f.text)).toEqual([degree]);
		expect(flags[0]?.confirmable).toBe(false);
	});
});

/**
 * Third round (2026-10-31): a flagged sentence with emphasis in it ("**I built** payment
 * services.") is checked without its Markdown, so it was not found in the stored text: the
 * rendered view lost its mark and the flag could not be edited or deleted.
 */
describe("a flagged sentence with Markdown inside it", () => {
	const letter = `Dear Hiring Team at Tessera,

I am applying for the role. **I built** payment services. I also wrote \`Go\` [tools](https://ada.example).

Best regards,\\
Ada Example`;
	const two: FlagDocuments = { ...docs, cover_letter: letter };

	it("is found over its Markdown, marked in the preview, and can be deleted", () => {
		const flag = {
			document: "cover_letter" as const,
			text: "I built payment services.",
		};
		const span = locateFlag(two, flag);
		expect(span && letter.slice(span.start, span.end)).toBe(
			"**I built** payment services.",
		);
		const html = markdownToPreviewHtml(letter, [
			{
				id: "f1",
				n: 1,
				start: span?.start ?? 0,
				end: span?.end ?? 0,
				open: true,
				title: "Not tied to the profile",
			},
		]);
		expect(html).toContain(
			"<sup>1</sup><strong>I built</strong> payment services.</a>",
		);
		expect(changeFlaggedLine(two, flag, null).content).toContain(
			"I am applying for the role. I also wrote",
		);
		const code = locateFlag(two, {
			document: "cover_letter",
			text: "I also wrote Go tools.",
		});
		expect(code && letter.slice(code.start, code.end)).toBe(
			"I also wrote `Go` [tools](https://ada.example).",
		);
	});

	it("is not placed when its emphasis starts in another sentence", () => {
		const across = {
			...docs,
			cover_letter: "Dear Hiring Team,\n\n**I built it. Then** more.",
		};
		expect(
			locateFlag(across, { document: "cover_letter", text: "Then more." }),
		).toBeNull();
	});
});
