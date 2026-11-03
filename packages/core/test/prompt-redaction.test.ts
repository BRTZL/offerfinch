import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadProfileFromDir } from "../src/profile/load-node";
import { redactContact } from "../src/profile/types";
import { FakeLlmProvider } from "../src/scoring/fake";
import { MeteredLlm, type SpendStore } from "../src/scoring/metered";
import { OpenAiProvider } from "../src/scoring/openai";
import { buildClaimsPrompt } from "../src/tailor/claims";
import { checkQuote, ruleSet } from "../src/tailor/profile-rules";
import { tailorPromptParts } from "../src/tailor/tailor";
import { FIXTURES } from "./helpers";

/**
 * Codex review, 2026-10-31: saved answers were escaped but not redacted, so an answer with an
 * email or phone reached the tailoring prompt. Question history and previous-issue text are now
 * redacted, and every outgoing prompt gets a last redaction pass, which must leave dates, job ids
 * and salary ranges alone (an earlier version took dates for phone numbers).
 */

const PROFILE = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));
const EMAIL = "ada.private@example.test";
const PHONE = "+90 555 011 22 33";

const job = {
	companyName: "Acme",
	title: "Engineer",
	url: "https://boards.greenhouse.io/acme/jobs/4567890123",
	locations: ["Remote"],
	workplaceType: "remote" as const,
	descriptionText:
		"Salary €60 000 - 80 000. Apply by 31.10.2026 or 2026-11-30. Contact hr@acme.example.",
};

describe("redacting what goes to the models", () => {
	it("redacts saved answers and previous issues in the tailoring prompt", () => {
		const { prompt } = tailorPromptParts(
			{
				job,
				profile: PROFILE,
				today: "2026-10-31",
				askedQuestions: [
					{
						question: `Can we reach you at ${EMAIL}?`,
						status: "answered",
						answer: `Yes, ${EMAIL} or ${PHONE}`,
					},
				],
				previousIssues: [
					{
						rule: "unsupported_claim",
						document: "cover_letter",
						message: `Unsupported claim: call me on ${PHONE}`,
						excerpt: `Write to ${EMAIL}`,
					},
				],
			},
			ruleSet(PROFILE),
		);
		expect(prompt).not.toContain(EMAIL);
		expect(prompt).not.toContain("532 111");
		expect(prompt).toContain("[email]");
		expect(prompt).toContain("[phone]");
	});

	it("keeps dates, job ids and salary ranges, and still redacts contacts", () => {
		expect(redactContact(job.url)).toBe(job.url);
		expect(redactContact("Apply by 31.10.2026.")).toBe("Apply by 31.10.2026.");
		expect(redactContact("Salary €60 000 - 80 000 a year")).toBe(
			"Salary €60 000 - 80 000 a year",
		);
		expect(redactContact("Keystone, 2019 - 2021")).toBe(
			"Keystone, 2019 - 2021",
		);
		expect(redactContact(`call ${PHONE} or ${EMAIL}`)).toBe(
			"call [phone] or [email]",
		);
		expect(redactContact("call +90 555 000 000")).toBe("call [phone]");
	});

	it("redacts every prompt a metered call sends, before it is sent", async () => {
		const inner = new FakeLlmProvider({ x: () => ({ ok: true }) });
		const store: SpendStore = {
			reserveSpend: async () => ({ ok: true, id: "r1" }),
			listCapPausedJobIds: async () => [],
			spendingStatus: async () => ({
				enabled: true,
				capMicros: 1,
				spentMicros: 0,
				reservedMicros: 0,
			}),
			settleSpend: async () => {},
			holdSpend: async () => {},
			recordRefusal: async () => {},
			subscriptionBudget: async () => ({ budget: 40, used: 0, resetsAt: null }),
			clearExtraUsageConfirmation: async () => {},
		};
		const llm = new MeteredLlm(inner, store, {
			userId: "u1",
			applicationId: null,
		});
		await llm.generateObject({
			task: "x",
			system: `System ${EMAIL}`,
			promptPrefix: `Prefix ${PHONE}`,
			prompt: `${job.descriptionText} ${job.url} Reach ${EMAIL}`,
			schema: z.object({ ok: z.boolean() }),
		});
		const sent = inner.calls[0];
		const all = `${sent?.system} ${sent?.prompt}`;
		expect(all).not.toContain(EMAIL);
		expect(all).not.toContain("hr@acme.example");
		expect(all).not.toContain("532 111");
		expect(all).toContain("31.10.2026");
		expect(all).toContain("2026-11-30");
		expect(all).toContain("€60 000 - 80 000");
		expect(all).toContain(job.url);
	});

	it("redacts what the OpenAI provider sends even without metering", async () => {
		const bodies: string[] = [];
		const llm = new OpenAiProvider({
			apiKey: "sk-test",
			model: "model-x",
			fetch: async (_url: string, init?: RequestInit) => {
				bodies.push(String(init?.body));
				return new Response(
					JSON.stringify({
						status: "completed",
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: '{"ok":true}' }],
							},
						],
					}),
				);
			},
		});
		await llm.generateObject({
			task: "x",
			system: "Check.",
			prompt: `Answer: ${EMAIL}, ${PHONE}`,
			schema: z.object({ ok: z.boolean() }),
		});
		expect(bodies[0]).not.toContain(EMAIL);
		expect(bodies[0]).not.toContain("532 111");
	});
});

/**
 * Third round (2026-10-31): protected spans hid phone digits. A messaging link's path or query is
 * a phone number, an amount or a year range can be the start of one, and the user's own email
 * and phone must go whatever the text around them looks like.
 */
describe("contact values survive no protected span", () => {
	const KNOWN = ["ada@example.test", "+90 555 123 45 67"];

	it("redacts phone numbers that kept spans used to hide", () => {
		for (const [text, leak] of [
			["https://api.whatsapp.com/send?phone=905551234567", "5551234567"],
			["https://wa.me/905551234567", "5551234567"],
			["https://t.me/+905551234567", "5551234567"],
			["Phone: $555 123 4567", "123 4567"],
			["call $555 123 4567 today", "123 4567"],
			["Phone: 2019-2021-123", "2021-123"],
			["- **Mobile:** 0555 123 45 67", "123 45 67"],
		] as const) {
			const out = redactContact(text);
			expect(out, text).not.toContain(leak);
			expect(out, text).toContain("[phone]");
		}
	});

	it("always removes the user's own email and phone, in any form", () => {
		for (const text of [
			"https://jobs.example.com/apply?ref=905551234567",
			"Reach me on 0555 123 45 67 or (555) 123-45-67.",
			"Write to ADA@example.test, 2026-10-27.",
			"Salary €5551234567.",
		]) {
			const out = redactContact(text, KNOWN);
			expect(out, text).not.toMatch(/123[\s-]?45[\s-]?67|ada@example/i);
		}
	});

	it("still keeps dates, ranges, links and amounts that hide nothing", () => {
		for (const text of [
			"Keystone, 2019 - 2021 (3 years)",
			"2026-10-27 - 2026-11-01",
			"Apply by 31.10.2026.",
			"https://boards.greenhouse.io/acme/jobs/4567890123",
			"Salary €60 000 - 80 000 a year",
		])
			expect(redactContact(text, KNOWN), text).toBe(text);
	});

	it("verifies a checker quote that carries the redacted phone", () => {
		const profile = {
			files: [
				{
					path: "personal.md",
					content:
						"# Personal\n\n- **Name:** Ada Example\n- **Phone:** +90 555 123 45 67\n- **WhatsApp:** https://wa.me/905551234567\n",
				},
			],
		};
		expect(
			checkQuote(profile, "personal.md", "WhatsApp: https://wa.me/[phone]").ok,
		).toBe(true);
	});

	it("keeps the user's phone out of the tailoring and claims prompts", () => {
		const profile = {
			files: [
				...PROFILE.files.filter((f) => f.path !== "personal.md"),
				{
					path: "personal.md",
					content:
						"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 123 45 67\n- **Contact:** https://api.whatsapp.com/send?phone=905551234567\n",
				},
			],
		};
		const { promptPrefix } = tailorPromptParts(
			{ job, profile, today: "2026-10-31" },
			ruleSet(profile),
		);
		const claims = buildClaimsPrompt({
			documents: {
				cv: "# Ada Example\n\nMessage me: https://jobs.example.com/x?ref=905551234567",
				cover_letter: "",
				form_answers: "",
			},
			formAnswers: [],
			profile,
			context: { companyName: "Acme", jobTitle: "Engineer" },
			postingText: "",
		});
		for (const text of [promptPrefix, claims])
			expect(text).not.toMatch(/5551234567|555 123 45 67/);
	});
});

/** Third round (2026-10-31): "Salary USD 100000 - 120000" became "Salary USD [phone]". */
describe("amounts are kept in every common form", () => {
	it("keeps ungrouped, prefixed, suffixed, decimal and ranged amounts", () => {
		for (const text of [
			"Salary USD 100000 - 120000",
			"Salary USD 100000 - USD 120000 a year",
			"Salary 100000 - 120000 EUR",
			"Salary $95,000.50 to $120,000",
			"Salary €60.000,00 - €80.000,00",
			"Rate 85.50 EUR per hour, 100000 - 120000 €",
			"Salary £60k - £80k",
			"Salary 60k - 80k",
		])
			expect(redactContact(text), text).toBe(text);
	});

	it("still redacts a phone number written after a currency", () => {
		expect(redactContact("USD 5551234567")).not.toContain("5551234567");
		expect(redactContact("$555 123 4567")).not.toContain("123 4567");
	});
});
