import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AnthropicProvider } from "../src/scoring/anthropic";
import { FakeLlmProvider } from "../src/scoring/fake";
import type { LlmUsage } from "../src/scoring/llm";
import { estimateCost } from "../src/scoring/pricing";
import { promptProfile, ruleSet } from "../src/tailor/profile-rules";
import {
	type TailorJob,
	tailorApplication,
	tailorPromptParts,
} from "../src/tailor/tailor";

/**
 * Tailoring cost $0.33-0.37 a call on the first real run, with no input cached and the whole
 * profile, old CV wording included, sent every time.
 */

const EXPERIENCE = `# Brightloom — Senior Software Engineer

- **Dates:** Jan 2023 – Dec 2024
- **Location:** Remote

## What I did

- Moved backend logic from Lambdas to Rails services.

### Bullet variants used in CVs (verbatim)

- Migrated serverless Lambdas to Ruby on Rails. *(used in: Acme)*

## Records used in CVs

- Senior Engineer | 2023 – 2024 | Remote *(used in: Acme)*

## Impact (numbers wherever possible)

- Cut cancellations by 25%.
`;

const SKILLS = `# Skills

## Languages

- TypeScript, Go

## Don't claim (no evidence)

- ClickHouse

## Skill lines used in CVs (verbatim)

- **Languages:** TypeScript, Go *(used in: Acme)*

## LinkedIn skills section (applied 2026-10-23)

React, Node.js
`;

const profile = {
	files: [
		{ path: "experience/2023-brightloom.md", content: EXPERIENCE },
		{ path: "skills.md", content: SKILLS },
	],
};

const job = (title: string): TailorJob => ({
	companyName: "Tessera",
	title,
	url: "https://example.test/jobs/1",
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: `${title}: TypeScript and PostgreSQL.`,
});

describe("what the models read", () => {
	it("leaves old CV wording and LinkedIn text out, and keeps every fact section and the Don't claim list", () => {
		const files = Object.fromEntries(
			promptProfile(profile).files.map((f) => [f.path, f.content]),
		);
		expect(files["experience/2023-brightloom.md"]).toContain(
			"Moved backend logic from Lambdas",
		);
		expect(files["experience/2023-brightloom.md"]).toContain(
			"Cut cancellations by 25%.",
		);
		expect(files["experience/2023-brightloom.md"]).not.toContain("used in");
		expect(files["skills.md"]).toContain("## Don't claim (no evidence)");
		expect(files["skills.md"]).toContain("- ClickHouse");
		expect(files["skills.md"]).not.toContain("Skill lines used in CVs");
		expect(files["skills.md"]).not.toContain("LinkedIn");
	});

	it("still bans what the full profile bans", () => {
		expect(ruleSet(profile).banned.map((b) => b.term)).toContain("ClickHouse");
	});
});

describe("prompt caching", () => {
	it("puts the profile in a prefix that is the same for every job", () => {
		const rules = ruleSet(profile);
		const a = tailorPromptParts(
			{ job: job("Senior Full-Stack Developer"), profile, today: "2026-10-31" },
			rules,
		);
		const b = tailorPromptParts(
			{
				job: job("Staff Engineer"),
				profile,
				today: "2026-11-01",
				questionsAllowed: 0,
				previousIssues: [
					{ rule: "unsupported_claim", document: "cv", message: "x" },
				],
			},
			rules,
		);
		expect(a.promptPrefix).toBe(b.promptPrefix);
		expect(a.promptPrefix).toContain("Moved backend logic");
		expect(a.promptPrefix).not.toContain("Senior Full-Stack Developer");
		expect(a.promptPrefix).not.toContain("2026-10-31");
		expect(a.prompt).toContain("Senior Full-Stack Developer");
	});

	it("sends one cache breakpoint after the profile, and reports cache reads and writes", async () => {
		let captured: Record<string, unknown> | undefined;
		const usage: LlmUsage[] = [];
		const client = {
			beta: {
				messages: {
					stream: (params: Record<string, unknown>) => {
						captured = params;
						return {
							finalMessage: async () => ({
								model: "claude-opus-5-5",
								stop_reason: "end_turn",
								usage: {
									input_tokens: 3_000,
									output_tokens: 9_000,
									cache_read_input_tokens: 20_000,
									cache_creation_input_tokens: 0,
								},
								parsed_output: { ok: true },
							}),
						};
					},
				},
			},
		};
		const provider = new AnthropicProvider({ client: client as never });
		const output = await provider.generateObject({
			task: "tailor",
			system: "system",
			promptPrefix: "<profile>stable</profile>",
			prompt: "<job>varies</job>",
			schema: z.object({ ok: z.boolean() }),
			onUsage: (u) => usage.push(u),
		});
		expect(output).toEqual({ ok: true });
		const messages = captured?.messages as {
			content: { type: string; text: string; cache_control?: unknown }[];
		}[];
		expect(messages[0]?.content).toEqual([
			{
				type: "text",
				text: "<profile>stable</profile>",
				cache_control: { type: "ephemeral" },
			},
			{ type: "text", text: "<job>varies</job>" },
		]);
		expect(usage[0]).toMatchObject({
			inputTokens: 3_000,
			cachedInputTokens: 20_000,
		});
	});

	it("tailorApplication sends the profile as the cached prefix", async () => {
		const llm = new FakeLlmProvider();
		const requests: { promptPrefix?: string }[] = [];
		const spy = {
			name: "fake",
			generateObject: async <T>(
				request: Parameters<typeof llm.generateObject<T>>[0],
			) => {
				requests.push(request);
				return llm.generateObject(request);
			},
		};
		await tailorApplication(spy, {
			job: job("Senior Full-Stack Developer"),
			profile,
			today: "2026-10-31",
		});
		expect(requests[0]?.promptPrefix).toMatch(/^<profile>/);
	});
});

describe("cache write prices", () => {
	const base = {
		model: "claude-opus-5-5",
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
	};

	it("charges a 5-minute write at 1.25 times the input rate and a 1-hour write at 2 times", () => {
		expect(estimateCost({ ...base, cacheWriteTokens: 1_000_000 }).micros).toBe(
			5_000_000,
		);
		expect(
			estimateCost({
				...base,
				cacheWriteTokens: 1_000_000,
				cacheWrite1hTokens: 1_000_000,
			}).micros,
		).toBe(8_000_000);
		expect(
			estimateCost({
				...base,
				cachedInputTokens: 1_000_000,
				cacheWriteTokens: 0,
			}).micros,
		).toBe(200_000);
	});
});
