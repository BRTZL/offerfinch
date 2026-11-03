import { evidenceProfile, normalizeForMatch } from "../profile-rules";
import { type Contact, parseContact } from "../tailor";
import { factTokens } from "./tokens";
import type { CheckedDocument, ClaimsInput } from "./types";

/* ------------------------------------------------------------ segments */

/** One unit of a document that must be accounted for: a CV line or bullet, or a prose sentence. */
export interface Segment {
	id: string;
	document: CheckedDocument;
	text: string;
	/**
	 * Where the segment sits, which can change what it claims: in the CV its section and role
	 * headings ("Experience › Senior Engineer — Brightloom"), in the letter its paragraph, in a form
	 * answer its question and paragraph. Moving a line or editing a heading changes it.
	 */
	context: string;
	/** Earlier segments with the same document, context and text: tells repeated lines apart. */
	occurrence: number;
	/** The employer of the CV role the segment sits under (`### Title — Company` in Experience). */
	employer?: string;
	/** That role's title: tells two stints at one employer apart. */
	role?: string;
}

/** A segment's identity across versions: document, context, text and occurrence. */
export function segmentKey(segment: {
	document: string;
	text: string;
	context?: string | null;
	occurrence?: number;
}): string {
	return [
		segment.document,
		segment.context ?? "",
		segment.text,
		String(segment.occurrence ?? 0),
		// Stored in jsonb (claims' segmentKeys), which refuses U+0000.
	].join("\u001f");
}

/** The segments the check covers: all of them, or the `checkOnly` ones of an edit in review. */
export function checkedSegments(input: ClaimsInput): Segment[] {
	const all = segmentDocuments(input);
	if (!input.checkOnly) return all;
	const only = new Set(input.checkOnly);
	return all.filter((s) => only.has(segmentKey(s)));
}

/** A CV role heading: `### Title — Company`. */
const ROLE_HEADING = /^(.+?)\s+[—–-]\s+(.+)$/;

export interface LineContext {
	context: string;
	employer?: string;
	role?: string;
}

/**
 * The context of every line of a document (see `Segment.context`), so segmenting and finding a
 * flagged line agree. A heading's own context is the one above it. In the CV the context is the
 * heading path, and a heading below a role (`#### Projects` under `### Engineer — Beta`) keeps
 * the role's employer: only a heading at the role's level or above ends it.
 */
export function lineContexts(
	kind: CheckedDocument,
	body: string,
	question = "",
): LineContext[] {
	const lines = body.split("\n");
	if (kind === "cv") {
		let section = "";
		/** The headings below the section, outermost first. */
		let path: {
			level: number;
			title: string;
			employer?: string;
			role?: string;
		}[] = [];
		const here = (): LineContext => {
			const role = path.find((h) => h.employer);
			return {
				context: [section, ...path.map((h) => h.title)]
					.filter(Boolean)
					.join(" › "),
				...(role?.employer ? { employer: role.employer } : {}),
				...(role?.role ? { role: role.role } : {}),
			};
		};
		return lines.map((raw) => {
			const heading = raw.match(/^(#{2,6})\s+(.*)$/);
			if (heading?.[1] && heading[2] !== undefined) {
				const title = plain(heading[2]);
				const level = heading[1].length;
				if (level === 2) {
					section = title;
					path = [];
					return { context: "" };
				}
				path = path.filter((h) => h.level < level);
				const above = here();
				const roleHeading =
					/^experience\b|\bexperience$/i.test(section) && !above.employer
						? title.match(ROLE_HEADING)
						: null;
				const employer = roleHeading?.[2]?.trim();
				const role = roleHeading?.[1]?.trim();
				path.push({
					level,
					title,
					...(employer ? { employer } : {}),
					...(employer && role ? { role } : {}),
				});
				return above;
			}
			return here();
		});
	}
	// Prose: the paragraph (lines up to a blank line), under its question for a form answer.
	const out: LineContext[] = [];
	let start = 0;
	for (let i = 0; i <= lines.length; i++) {
		if (i < lines.length && lines[i]?.trim()) continue;
		const paragraph = lines
			.slice(start, i)
			.map((l) => plain(l))
			.join(" ")
			.trim();
		const context = question ? `${question} › ${paragraph}` : paragraph;
		for (let j = start; j < Math.min(i + 1, lines.length); j++)
			out[j] = { context: lines[j]?.trim() ? context : "" };
		start = i + 1;
	}
	return out;
}

const SEGMENT_PREFIX: Record<CheckedDocument, string> = {
	cv: "cv",
	cover_letter: "cl",
	form_answers: "fa",
};

const SECTION_HEADING =
	/^#{2,6}\s+(summary|profile|experience|work experience|professional experience|projects|skills|technical skills|education|languages|certifications)\s*$/i;

const GREETING = /^(dear|hello|hi)\b[^.!?]{0,80},$/i;

const SIGN_OFF =
	/^(best regards|kind regards|warm regards|regards|sincerely|best|thanks|thank you|yours sincerely|yours faithfully),?$/i;

const LETTER_DATE_LINE =
	/^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/;

function plain(line: string): string {
	return line
		.replace(/\\$/, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/^\*(.*)\*$/, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
}

export function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[\p{Lu}\d"“(])/u)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** A line made only of contact fields (location, email, phone, profile URLs) separated by "·" or "|". */
function isContactLine(line: string, contact: Contact): boolean {
	const fields = [
		contact.location,
		contact.email,
		contact.phone,
		contact.linkedin,
		contact.website,
		contact.github,
		"{{email}}",
		"{{phone}}",
	]
		.filter(Boolean)
		.map((f) => normalizeForMatch(f));
	const raw = line.split(/\s+[·|•]\s+|\s*·\s*/).filter((p) => p.trim());
	const parts = raw.map((p) => normalizeForMatch(p)).filter(Boolean);
	// The profile's location may carry a note ("Izmir, Turkey (GMT+3)"); parseContact drops it,
	// so a part matches with or without a trailing parenthetical.
	const matches = (part: string) =>
		fields.includes(normalizeForMatch(part)) ||
		fields.includes(normalizeForMatch(part.replace(/\s*\([^)]*\)\s*$/, "")));
	return (
		parts.length > 0 &&
		parts.some((p) => p.includes("@") || /\d{3}/.test(p)) &&
		raw.every(matches)
	);
}

/**
 * Whether a document line is structural (a heading, the name, the contact line, the letter's
 * date, greeting or sign-off): it holds no claim, so the check never segments it.
 */
export function isStructuralLine(
	kind: CheckedDocument,
	line: string,
	profile: ClaimsInput["profile"],
): boolean {
	return structural(kind, line, line, parseContact(evidenceProfile(profile)));
}

/** Structural lines code can recognize without a model: they hold no claim. */
function structural(
	kind: CheckedDocument,
	raw: string,
	text: string,
	contact: Contact,
): boolean {
	if (SECTION_HEADING.test(raw.trim())) return true;
	const name = normalizeForMatch(contact.name);
	if (name && normalizeForMatch(text.replace(/^#\s+/, "")) === name)
		return true;
	if (isContactLine(text, contact)) return true;
	if (kind === "cover_letter")
		return (
			LETTER_DATE_LINE.test(text) || GREETING.test(text) || SIGN_OFF.test(text)
		);
	return false;
}

/**
 * Splits every document into segments, deterministically. CV: each bullet and each other line
 * (headings included, prose split into sentences). Letter and form answers: sentences. Section
 * headings, the name, a line of contact fields, the letter date, greeting and sign-off are left
 * out; everything else must be covered by a claim or an accepted skip.
 */
export function segmentDocuments(input: ClaimsInput): Segment[] {
	const contact = parseContact(evidenceProfile(input.profile));
	const out: Segment[] = [];
	const push = (kind: CheckedDocument, text: string, where: LineContext) => {
		// Every line with a word or a number is a segment: "Go" and "C#" are facts too.
		if (!/[\p{L}\d]/u.test(text)) return;
		const n = out.filter((s) => s.document === kind).length + 1;
		const occurrence = out.filter(
			(s) =>
				s.document === kind && s.context === where.context && s.text === text,
		).length;
		out.push({
			id: `${SEGMENT_PREFIX[kind]}-${n}`,
			document: kind,
			text,
			context: where.context,
			occurrence,
			...(where.employer ? { employer: where.employer } : {}),
			...(where.role ? { role: where.role } : {}),
		});
	};
	const lines = (kind: CheckedDocument, body: string, question = "") => {
		const contexts = lineContexts(kind, body, question);
		body.split("\n").forEach((raw, index) => {
			if (!raw.trim()) return;
			const where = contexts[index] ?? { context: "" };
			const bullet = /^\s*[-*+]\s+/.test(raw);
			const text = plain(
				raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^#{1,6}\s+/, ""),
			);
			if (!text || structural(kind, raw, text, contact)) return;
			if (kind === "cv" && (bullet || /^#{1,6}\s/.test(raw)))
				push(kind, text, where);
			else for (const sentence of sentences(text)) push(kind, sentence, where);
		});
	};
	lines("cv", input.documents.cv);
	lines("cover_letter", input.documents.cover_letter);
	for (const answer of input.formAnswers) {
		// A short answer ("No", "Yes, 2") says nothing without its question: check them together.
		if (factTokens(answer.answer).size < 3 && answer.answer.trim())
			push("form_answers", `${answer.question} ${plain(answer.answer)}`, {
				context: answer.question,
			});
		else lines("form_answers", answer.answer, answer.question);
	}
	return out;
}
