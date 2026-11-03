import { type CheckedDocument, lineContexts, segmentKey } from "./claims";
import type { RuleIssue, SegmentPlace } from "./profile-rules";
import type { FormAnswer } from "./tailor";

/**
 * Flagged review (2026-10-31): a draft the claims check still flags after the automatic redraft
 * goes to the user instead of `failed`. Each flagged line is shown with its reasons; the user
 * edits it, deletes it, or confirms it is true. Approval stays refused until no flag is open.
 */

/**
 * What the user may confirm as true: the checker could not tie the line to the profile. A
 * confirmation is saved to the user's profile with its date and source, and is evidence later.
 */
export const CONFIRMABLE_RULES: readonly RuleIssue["rule"][] = [
	"unsupported_claim",
	"unchecked_line",
	"unsupported_number",
	"empty_claim",
	"unanchored_claim",
];

/**
 * Fixed rules a confirmation cannot lift; the line can only be edited or deleted: degree wording
 * and the profile's "Don't claim" list (banned_term), Tablewise's wording, CV roles against their
 * experience file headers, leftover placeholders, letter and CV length, the company and role
 * names, and the PDF's ATS check.
 */
export const BLOCKING_RULES: readonly RuleIssue["rule"][] = [
	"banned_term",
	"cv_wording",
	"experience_record",
	"placeholder",
	"length",
	"name_spelling",
	"ats",
];

/** Rules that come from the claims model's answer, carried between versions for unchanged lines. */
export const MODEL_RULES: readonly RuleIssue["rule"][] = [
	"unsupported_claim",
	"unchecked_line",
	"empty_claim",
	"unanchored_claim",
];

export type ReviewStatus = "passed" | "failed" | "claims_flagged";

export interface FlagReason {
	rule: RuleIssue["rule"];
	message: string;
}

export interface ReviewFlag {
	/**
	 * Stable for the same document, line, context and occurrence, so a confirmation survives an
	 * unrelated edit but not a move under another employer or into another paragraph.
	 */
	id: string;
	document: RuleIssue["document"];
	/** The flagged line as checked (a CV line or a sentence); null for a whole-document problem. */
	text: string | null;
	/** Where the line is (`Segment.context`); absent on flags made before contexts existed. */
	context?: string;
	occurrence?: number;
	reasons: FlagReason[];
	/** False when any reason is a fixed rule: then only an edit or a deletion clears it. */
	confirmable: boolean;
	state: "open" | "confirmed";
	confirmedAt?: string;
}

/** A segment as checked, kept on the review so the next version re-checks only changed lines. */
export interface CheckedSegment {
	document: CheckedDocument;
	text: string;
	/** Absent on reviews made before contexts existed: every line then counts as changed. */
	context?: string;
	occurrence?: number;
}

/** FNV-1a, 32 bit: short stable ids without async crypto. */
function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function flagId(
	document: string,
	text: string | null,
	place?: SegmentPlace,
): string {
	const where = place ? `\u0000${place.context}\u0000${place.occurrence}` : "";
	return `${document}-${hash(`${document}\u0000${text ?? ""}${where}`)}`;
}

/** The key of the segment a flag is on (see `segmentKey`). */
export function flagKey(
	flag: Pick<ReviewFlag, "document" | "text" | "context" | "occurrence">,
): string {
	return segmentKey({
		document: flag.document,
		text: flag.text ?? "",
		context: flag.context,
		occurrence: flag.occurrence,
	});
}

/**
 * One flag per flagged line, with every reason given for it. An issue names its lines (the
 * segments it is about) when the claims check produced it; a fixed rule names the line it matched;
 * a whole-document rule (letter length) names none.
 */
export function buildFlags(
	issues: RuleIssue[],
	previous: ReviewFlag[] = [],
	segments: CheckedSegment[] = [],
): ReviewFlag[] {
	const byId = new Map<string, ReviewFlag>();
	for (const raw of issues) {
		if (raw.document === "notes") continue;
		const issue = raw.lines?.length ? raw : narrowed(raw, segments);
		// A fixed rule quotes the raw line: its bullet or heading marks are not part of the text.
		const lines = issue.lines?.length
			? issue.lines
			: [
					issue.excerpt
						?.trim()
						.replace(LINE_PREFIX, "")
						.replace(/\\$/, "")
						.trim() || null,
				];
		const places = lines.flatMap((text, index) => {
			const named = issue.at?.[index];
			if (named) return [{ text, place: named as SegmentPlace | undefined }];
			// A fixed rule quotes a line: it is on every segment with that text.
			const found = segments.filter(
				(s) =>
					s.document === issue.document &&
					s.text === text &&
					s.context !== undefined,
			);
			return found.length > 0
				? found.map((s) => ({
						text,
						place: { context: s.context ?? "", occurrence: s.occurrence ?? 0 },
					}))
				: [{ text, place: undefined }];
		});
		for (const { text, place } of places) {
			const id = flagId(issue.document, text, place);
			const flag = byId.get(id) ?? {
				id,
				document: issue.document,
				text,
				...(place
					? { context: place.context, occurrence: place.occurrence }
					: {}),
				reasons: [],
				confirmable: true,
				state: "open" as const,
			};
			if (
				!flag.reasons.some(
					(r) => r.rule === issue.rule && r.message === issue.message,
				)
			)
				flag.reasons.push({ rule: issue.rule, message: issue.message });
			flag.confirmable =
				text !== null &&
				flag.reasons.every((r) => CONFIRMABLE_RULES.includes(r.rule));
			byId.set(id, flag);
		}
	}
	// A confirmation stays when the line is flagged for nothing new.
	for (const flag of byId.values()) {
		const before = previous.find((p) => p.id === flag.id);
		if (
			before?.state === "confirmed" &&
			flag.confirmable &&
			flag.reasons.every((r) =>
				before.reasons.some(
					(b) => b.rule === r.rule && b.message === r.message,
				),
			)
		) {
			flag.state = "confirmed";
			flag.confirmedAt = before.confirmedAt;
		}
	}
	return [...byId.values()];
}

/**
 * A fixed rule quotes the whole raw line, which in a letter is a paragraph. When the paragraph
 * holds several checked sentences, the flag goes on the one with the quoted term ("degree", "300"),
 * so it lands on the same line as the claims check's flag for that sentence.
 */
function narrowed(issue: RuleIssue, segments: CheckedSegment[]): RuleIssue {
	// Segments are checked without Markdown emphasis; the rule quotes the stored line.
	const excerpt = issue.excerpt
		? stripMarkdown(issue.excerpt.replace(/…$/, ""))
		: "";
	if (!excerpt) return issue;
	// A quote cut at 200 characters ends inside a sentence: that sentence is in it too.
	const tail = issue.excerpt?.endsWith("…")
		? excerpt.slice(excerpt.lastIndexOf(". ") + 2)
		: "";
	const inside = segments.filter(
		(s) =>
			s.document === issue.document &&
			(excerpt.includes(s.text) ||
				(tail.length > 3 && s.text.startsWith(tail))),
	);
	const term = issue.message.match(/^"([^"]+)"/)?.[1]?.toLowerCase();
	let hit = term
		? inside.filter((s) => s.text.toLowerCase().includes(term))
		: [];
	// The term is past the 200-character cut: find it in the sentences of the paragraph the
	// quote starts.
	if (hit.length === 0 && term && issue.excerpt?.endsWith("…"))
		hit = segments.filter(
			(s) =>
				s.document === issue.document &&
				s.text.toLowerCase().includes(term) &&
				(s.context ?? "").startsWith(excerpt.slice(0, 80)),
		);
	return hit.length > 0 ? { ...issue, lines: hit.map((s) => s.text) } : issue;
}

/** The model's issues a flag stands for, to carry it to the next version. */
export function modelIssues(flag: ReviewFlag): RuleIssue[] {
	return flag.reasons
		.filter((r) => MODEL_RULES.includes(r.rule))
		.map((r) => ({
			rule: r.rule,
			document: flag.document,
			message: r.message,
			...(flag.text ? { excerpt: flag.text, lines: [flag.text] } : {}),
			...(flag.text && flag.context !== undefined
				? {
						at: [{ context: flag.context, occurrence: flag.occurrence ?? 0 }],
					}
				: {}),
		}));
}

export function openFlags(flags: ReviewFlag[]): ReviewFlag[] {
	return flags.filter((f) => f.state === "open");
}

/* ------------------------------------------------- finding and changing a line */

export interface FlagDocuments {
	cv: string;
	cover_letter: string;
	form_answers: FormAnswer[];
}

interface Span {
	/** cv and cover_letter: 0. form_answers: the answer's index. */
	index: number;
	start: number;
	end: number;
	/** The span is a whole line's text: deleting it removes the line. */
	wholeLine: boolean;
}

const LINE_PREFIX = /^(\s*(?:[-*+]|\d+[.)])\s+|#{1,6}\s+)/;

function stripMarkdown(text: string): string {
	return text
		.replace(/\\$/, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/^\*(.*)\*$/, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
}

function texts(docs: FlagDocuments, document: string): string[] {
	if (document === "cv") return [docs.cv];
	if (document === "cover_letter") return [docs.cover_letter];
	if (document === "form_answers")
		return docs.form_answers.map((a) => a.answer);
	return [];
}

/** Every occurrence of `needle` in the texts. */
function occurrences(all: string[], needle: string): Span[] {
	const out: Span[] = [];
	all.forEach((text, index) => {
		for (
			let at = text.indexOf(needle);
			at !== -1;
			at = text.indexOf(needle, at + 1)
		) {
			const lineStart = text.lastIndexOf("\n", at - 1) + 1;
			const lineEnd = text.indexOf("\n", at + needle.length);
			const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
			const body = line.replace(LINE_PREFIX, "").replace(/\\$/, "").trim();
			out.push({
				index,
				start: at,
				end: at + needle.length,
				wholeLine: body === needle.trim(),
			});
		}
	});
	return out;
}

/**
 * Where a flagged line is in the stored document: verbatim, or a whole Markdown line whose text
 * (bullet, heading marks and emphasis removed) is the flagged line, or a short form answer
 * checked together with its question. Null when it is not there or is there more than once.
 */
export function locateFlag(
	docs: FlagDocuments,
	flag: Pick<ReviewFlag, "document" | "text" | "context" | "occurrence">,
): Span | null {
	if (!flag.text) return null;
	const all = texts(docs, flag.document);
	const text = flag.text.replace(/…$/, "");
	const exact = occurrences(all, text);
	if (exact.length === 1 && !flag.text.endsWith("…")) return exact[0] ?? null;
	if (exact.length > 1) return placed(docs, flag, exact);
	const found: Span[] = [];
	all.forEach((doc, index) => {
		let offset = 0;
		for (const line of doc.split("\n")) {
			const prefix = line.match(LINE_PREFIX)?.[0] ?? "";
			const body = line.slice(prefix.length).replace(/\\$/, "").trimEnd();
			const plain = stripMarkdown(body);
			const matches = flag.text?.endsWith("…")
				? body.startsWith(text) || plain.startsWith(text)
				: plain === text;
			if (body && matches)
				found.push({
					index,
					start: offset + prefix.length,
					end: offset + prefix.length + body.length,
					wholeLine: true,
				});
			offset += line.length + 1;
		}
	});
	if (found.length === 0 && flag.document === "form_answers")
		docs.form_answers.forEach((a, index) => {
			if (
				a.answer.trim() &&
				flag.text === `${a.question} ${stripMarkdown(a.answer)}`
			)
				found.push({ index, start: 0, end: a.answer.length, wholeLine: true });
		});
	// A sentence checked without its Markdown ("**I built** payment services.").
	if (found.length === 0 && !flag.text.endsWith("…"))
		all.forEach((doc, index) => {
			found.push(...inPlainText(doc, text).map((s) => ({ ...s, index })));
		});
	return found.length === 1 ? (found[0] ?? null) : placed(docs, flag, found);
}

/** Emphasis and code marks, which `stripMarkdown` drops. */
const MARK = /^(?:\*\*|__|`)/;

/**
 * Where `needle` is in a document whose lines are read as `stripMarkdown` reads them: each line
 * without its emphasis and code marks and with links as their text, mapped back to the source.
 * A span is widened over the marks right around it, and kept only when its marks are balanced,
 * so a preview mark never cuts an emphasis in two; otherwise the line is not placed.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Flag matching keeps ordered text rules together so the first applicable match remains authoritative.
function inPlainText(doc: string, needle: string): Omit<Span, "index">[] {
	const out: Omit<Span, "index">[] = [];
	let offset = 0;
	for (const line of doc.split("\n")) {
		const prefix = line.match(LINE_PREFIX)?.[0] ?? "";
		let plain = "";
		const at: number[] = [];
		for (let i = prefix.length; i < line.length; ) {
			const rest = line.slice(i);
			const mark = rest.match(MARK)?.[0];
			if (mark) {
				i += mark.length;
				continue;
			}
			const target = rest.match(/^\]\([^)]*\)/)?.[0];
			if (target) {
				i += target.length;
				continue;
			}
			if (rest[0] === "[" && /^\[[^\]]*\]\(/.test(rest)) {
				i++;
				continue;
			}
			plain += line[i];
			at.push(i);
			i++;
		}
		for (
			let found = plain.indexOf(needle);
			found !== -1;
			found = plain.indexOf(needle, found + 1)
		) {
			let start = at[found] ?? 0;
			let end = (at[found + needle.length - 1] ?? 0) + 1;
			while (start > prefix.length && /[*_`[]/.test(line[start - 1] ?? ""))
				start--;
			for (;;) {
				const tail = line.slice(end).match(/^(?:\*\*|__|`|\]\([^)]*\))/)?.[0];
				if (!tail) break;
				end += tail.length;
			}
			const slice = line.slice(start, end);
			const balanced =
				(slice.match(/\*\*/g) ?? []).length % 2 === 0 &&
				(slice.match(/__/g) ?? []).length % 2 === 0 &&
				(slice.match(/`/g) ?? []).length % 2 === 0 &&
				(slice.match(/\[/g) ?? []).length ===
					(slice.match(/\]\(/g) ?? []).length;
			if (!balanced) continue;
			const body = line.slice(prefix.length).replace(/\\$/, "").trimEnd();
			out.push({
				start: offset + start,
				end: offset + end,
				wholeLine: slice === body,
			});
		}
		offset += line.length + 1;
	}
	return out;
}

/**
 * The one span of several with the flag's context and occurrence: the same line under two
 * employers, or twice in one paragraph. Null for a flag made before contexts existed.
 */
function placed(
	docs: FlagDocuments,
	flag: Pick<ReviewFlag, "document" | "context" | "occurrence">,
	spans: Span[],
): Span | null {
	if (flag.context === undefined || spans.length === 0) return null;
	const contexts = texts(docs, flag.document).map((text, index) => {
		const question =
			flag.document === "form_answers"
				? (docs.form_answers[index]?.question ?? "")
				: "";
		return lineContexts(flag.document as CheckedDocument, text, question);
	});
	const here = spans.filter((span) => {
		const text = texts(docs, flag.document)[span.index] ?? "";
		const line = text.slice(0, span.start).split("\n").length - 1;
		return contexts[span.index]?.[line]?.context === flag.context;
	});
	return here[flag.occurrence ?? 0] ?? null;
}

export class FlagNotFoundError extends Error {
	constructor(text: string | null) {
		super(
			text
				? `Cannot find this line in the document exactly once ("${text.slice(0, 80)}"); edit the whole document instead`
				: "This flag is about the whole document; edit the document instead",
		);
		this.name = "FlagNotFoundError";
	}
}

function splice(text: string, span: Span, replacement: string | null): string {
	if (replacement !== null)
		return `${text.slice(0, span.start)}${replacement}${text.slice(span.end)}`;
	if (span.wholeLine) {
		const lineStart = text.lastIndexOf("\n", span.start - 1) + 1;
		const lineEnd = text.indexOf("\n", span.end);
		return lineEnd === -1
			? text.slice(0, Math.max(0, lineStart - 1))
			: `${text.slice(0, lineStart)}${text.slice(lineEnd + 1)}`;
	}
	// A sentence inside a paragraph: drop it and the space that joined it.
	const before = text.slice(0, span.start).replace(/[ \t]+$/, "");
	const after = text.slice(span.end).replace(/^[ \t]+/, "");
	const glue =
		before && !before.endsWith("\n") && after && !after.startsWith("\n")
			? " "
			: "";
	return `${before}${glue}${after}`;
}

/**
 * The document with the flagged line replaced (`replacement`) or removed (null). Returns the new
 * stored content of that one document: Markdown, or the form answers as JSON.
 */
export function changeFlaggedLine(
	docs: FlagDocuments,
	flag: Pick<ReviewFlag, "document" | "text">,
	replacement: string | null,
): { kind: "cv" | "cover_letter" | "form_answers"; content: string } {
	const span = locateFlag(docs, flag);
	if (!span) throw new FlagNotFoundError(flag.text);
	const line = replacement?.replace(/\s*\n\s*/g, " ").trim() ?? null;
	if (line === "")
		throw new Error("The new line is empty; delete the line instead");
	if (flag.document === "form_answers") {
		const answers = docs.form_answers.map((a, i) =>
			i === span.index
				? { ...a, answer: splice(a.answer, span, line).trim() }
				: a,
		);
		return { kind: "form_answers", content: JSON.stringify(answers, null, 2) };
	}
	const kind = flag.document === "cv" ? "cv" : "cover_letter";
	return { kind, content: splice(docs[kind], span, line) };
}
