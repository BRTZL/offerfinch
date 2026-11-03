import { describe, expect, it } from "vitest";

import {
	type ClaimsInput,
	clearedFlags,
	type StoredFlag,
	segmentDocuments,
} from "../src/tailor/claims";
import { formAnswersText } from "../src/tailor/tailor";

/**
 * The CV's contact line is structural, never a claim: also when the profile's location carries a
 * note in parentheses ("Izmir, Turkey (GMT+3)"), which the contact parser drops. Seen on real
 * data: the line was segmented, the model covered only the location, and the email and phone
 * were flagged as "left out". Contact details here are fictional.
 */

const PERSONAL = `# Personal

- **Name:** Ada Example
- **Email:** ada@example.test
- **Phone:** +90 555 010 01 99
- **Location:** Izmir, Turkey (GMT+3)
- **LinkedIn:** linkedin.com/in/ada-example
- **Website:** ada.example
- **GitHub:** github.com/ada-example
`;

const CONTACT =
	"Izmir, Turkey (GMT+3) · ada@example.test · +90 555 010 01 99 · linkedin.com/in/ada-example · ada.example · github.com/ada-example";

function input(cv: string): ClaimsInput {
	return {
		documents: { cv, cover_letter: "", form_answers: formAnswersText([]) },
		formAnswers: [],
		profile: { files: [{ path: "personal.md", content: PERSONAL }] },
		context: { companyName: "Acme", jobTitle: "Senior Engineer" },
		postingText: "Senior Engineer at Acme.",
	};
}

const CV = `# Ada Example

Senior Full-Stack Engineer · TypeScript, React\\
${CONTACT}

## Summary
Builds web apps.`;

describe("the CV contact line", () => {
	it("is not a segment, with or without the location's note", () => {
		for (const line of [CONTACT, CONTACT.replace(" (GMT+3)", "")]) {
			const texts = segmentDocuments(input(CV.replace(CONTACT, line))).map(
				(s) => s.text,
			);
			expect(texts.some((t) => t.includes("ada@example.test"))).toBe(false);
		}
	});

	it("still segments a line that adds a claim to the contact details", () => {
		const claimLine = `${CONTACT} · 10 years of Go`;
		const texts = segmentDocuments(input(CV.replace(CONTACT, claimLine))).map(
			(s) => s.text,
		);
		expect(texts.some((t) => t.includes("10 years of Go"))).toBe(true);
	});

	it("clears an older flag on the contact line at startup, and only that one", () => {
		const flag = (text: string): StoredFlag => ({
			document: "cv",
			text,
			context: "",
			occurrence: 0,
			reasons: [
				{
					rule: "unchecked_line",
					message:
						"The claims check covered only part of this; left out: example.test +90 555 010 01 99.",
				},
			],
			state: "open",
		});
		const contact = flag(CONTACT);
		const notInDocument = flag(
			"Elsewhere · ada@example.test · +90 555 010 01 99",
		);
		expect(clearedFlags([contact, notInDocument], [], input(CV))).toEqual([
			contact,
		]);
	});
});
