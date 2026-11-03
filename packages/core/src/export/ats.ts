import { extractText } from "unpdf";

import type { ExperienceRecord, RuleIssue } from "../tailor/profile-rules";
import type { Contact } from "../tailor/tailor";

/**
 * The skill's `pdftotext` check, on the exported PDF, as an ATS parser would read it: text
 * extracts, reading order is name, contact, then sections in order, contact details are
 * readable text, each role's title, company and dates sit together, and the posting's
 * keywords survive extraction. Plus the page limit.
 */

export interface PdfText {
	text: string;
	pages: number;
}

export async function pdfText(pdf: Uint8Array): Promise<PdfText> {
	const { text, totalPages } = await extractText(new Uint8Array(pdf), {
		mergePages: true,
	});
	return { text, pages: totalPages };
}

function flat(text: string): string {
	return text.replace(/\s+/g, " ").replace(/[–—]/g, "-").toLowerCase();
}

export interface AtsInput {
	kind: "cv" | "cover_letter";
	markdown: string;
	contact: Contact;
	records: ExperienceRecord[];
	/** Posting keywords the Markdown contains; each must survive extraction. */
	keywords: string[];
	maxPages: number;
}

export function atsIssues(extracted: PdfText, input: AtsInput): RuleIssue[] {
	const issues: RuleIssue[] = [];
	const issue = (message: string, excerpt?: string) =>
		issues.push({ rule: "ats", document: input.kind, message, excerpt });
	const text = flat(extracted.text);
	if (text.trim().length < 200) {
		issue("Almost no text could be extracted from the PDF.");
		return issues;
	}
	if (extracted.pages > input.maxPages)
		issue(
			`The PDF has ${extracted.pages} pages; the limit is ${input.maxPages}.`,
		);
	for (const [label, value] of [
		["email", input.contact.email],
		["phone", input.contact.phone],
		["LinkedIn URL", input.contact.linkedin],
	] as const)
		if (value && !text.includes(flat(value)))
			issue(`The ${label} is not readable text in the PDF.`, value);
	if (input.kind === "cv") {
		const name = text.indexOf(flat(input.contact.name));
		const email = text.indexOf(flat(input.contact.email));
		if (name !== 0 && name > 50)
			issue("The name is not the first thing a parser reads.");
		const sections = [...input.markdown.matchAll(/^##\s+(.+)$/gm)].map((m) =>
			flat(m[1] ?? ""),
		);
		const positions = sections.map((s) => text.indexOf(s));
		if (email > -1 && positions[0] !== undefined && email > positions[0])
			issue("Contact details come after the first section.");
		positions.forEach((pos, i) => {
			if (pos === -1)
				issue(`Section "${sections[i]}" is missing from the text.`);
			else if (i > 0 && pos < (positions[i - 1] ?? 0))
				issue(`Section "${sections[i]}" is read out of order.`);
		});
		for (const match of input.markdown.matchAll(
			/^###\s+(.+?)\s+[—–-]\s+(.+)\n\*([^*\n]+)\*/gm,
		)) {
			const [title, company, meta] = [match[1], match[2], match[3]].map((v) =>
				flat(v ?? ""),
			);
			const dates = meta?.split("·").at(-1)?.trim() ?? "";
			const at = text.indexOf(`${title} - ${company}`);
			const window = at === -1 ? "" : text.slice(at, at + 250);
			if (at === -1 || !window.includes(dates))
				issue(
					`Role "${match[1]} — ${match[2]}" does not read as title, company and dates together.`,
				);
		}
	}
	const missing = input.keywords.filter((k) => !text.includes(flat(k)));
	if (missing.length > 0)
		issue(`Keywords lost in extraction: ${missing.join(", ")}.`);
	return issues;
}

/** Posting terms the document uses (so the check is about extraction, not keyword choice). */
export function documentKeywords(
	markdown: string,
	postingText: string,
	candidates: readonly string[],
): string[] {
	const has = (text: string, term: string) =>
		new RegExp(
			`(?<![\\p{L}\\d])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`,
			"iu",
		).test(text);
	return candidates.filter((k) => has(postingText, k) && has(markdown, k));
}
