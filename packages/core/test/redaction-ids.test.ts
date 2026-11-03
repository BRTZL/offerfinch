import { describe, expect, it } from "vitest";

import { redactContact } from "../src/profile/types";
import { checkQuote } from "../src/tailor/profile-rules";

/**
 * A profile record id can hold a phone-like run of digits ("8f57b868-5318-4ad1-…"). Redacting it
 * as "[phone]" made the claims check cite "experience/8f57b[phone]ad1-….md" and reject every
 * quote of that role as "file not in profile" (seen on real data). Contact details are fictional.
 */
const ID = "8f57b868-5318-4ad1-b75a-fc02b2f5af52";
const PATH = `experience/${ID}.md`;
const profile = {
	files: [
		{
			path: "personal.md",
			content:
				"# Personal\n\n- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555 010 01 99\n",
		},
		{
			path: PATH,
			content:
				"# Bablworld — Lead Software Engineer\n\n- Built the NestJS + Prisma + PostgreSQL backend.\n",
		},
	],
};

describe("phone redaction and record ids", () => {
	it("leaves an id with digit runs alone", () => {
		expect(redactContact(PATH)).toBe(PATH);
		expect(redactContact(`<file path="${PATH}">`)).toContain(ID);
	});

	it("still redacts phone numbers", () => {
		for (const text of [
			"Call +90 555 640 92 91 today",
			"Phone 555-123-4567.",
			"(555) 123 4567",
			"Reach me at +1 (415) 555 0199.",
		])
			expect(redactContact(text)).toContain("[phone]");
		expect(redactContact("+90 555 010 01 99", ["+90 555 010 01 99"])).toBe(
			"[phone]",
		);
	});

	it("resolves a cited path that came back redacted to its one file", () => {
		const cited = "experience/8f57b[phone]ad1-b75a-fc02b2f5af52.md";
		expect(
			checkQuote(
				profile,
				cited,
				"Built the NestJS + Prisma + PostgreSQL backend.",
			),
		).toMatchObject({ ok: true, file: PATH });
		expect(checkQuote(profile, "experience/[phone].md", "Built the")).toEqual({
			ok: false,
			reason: "file not in profile",
		});
	});
});
