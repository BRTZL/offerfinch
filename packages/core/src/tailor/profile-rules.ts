import { normalizeLineEndings } from "../domain/line-endings";
import {
	contactValues,
	type ProfileDocument,
	type ProfileSnapshot,
	redactContact,
} from "../profile/types";
import type { ClaimRule } from "./rule-labels";

/**
 * Deterministic rules every generated document must follow, derived from the profile itself.
 * They run on every draft and every edit, whatever the model says, and a violation blocks review.
 */

export type DocumentKind = "notes" | "cv" | "cover_letter" | "form_answers";

export interface RuleIssue {
	rule: ClaimRule;
	document: DocumentKind;
	message: string;
	/** The offending text, quoted. */
	excerpt?: string;
	/** The document segments (lines or sentences, as checked) the issue is about. */
	lines?: string[];
	/** Where each of `lines` is (`Segment.context` and occurrence), when the claims check named it. */
	at?: SegmentPlace[];
}

export interface SegmentPlace {
	context: string;
	occurrence: number;
}

/* ------------------------------------------------------------ evidence */

/** `sources/` is an outdated raw export (LinkedIn, old PDF): never evidence, never sent to a model. */
export function isEvidencePath(path: string): boolean {
	return !/^(?:profile\/)?sources\//.test(path);
}

/** The profile with raw exports removed. */
export function evidenceProfile(profile: ProfileSnapshot): ProfileSnapshot {
	return {
		files: profile.files
			.filter((file) => isEvidencePath(file.path))
			.map((file) => ({
				...file,
				content: normalizeLineEndings(file.content),
			})),
	};
}

/**
 * Sections that keep wording already used elsewhere: CV variants ("Bullet variants used in CVs
 * (verbatim)", "Records used in CVs"), LinkedIn text and an original summary. On the first real
 * profile they were 44% of the text and held no number or fact the rest of the profile lacks.
 */
const OLD_WORDING_HEADING =
	/\bused in (?:cvs|resumes)\b|\bverbatim\b|\blinkedin (?:headline|about|skills|settings|summary|section)\b|\boriginal summary\b/i;

/**
 * The profile as the tailoring and claims-check models read it: evidence files without the
 * old-wording sections (a heading and everything under it, up to the next heading of the same
 * or a higher level). The Don't claim list and every rule stay; checks run on the full profile.
 */
export function promptProfile(profile: ProfileSnapshot): ProfileSnapshot {
	return {
		files: evidenceProfile(profile).files.map((file) => {
			const kept: string[] = [];
			let skipLevel = 0;
			for (const line of file.content.split("\n")) {
				const heading = line.match(/^(#{2,6})\s/);
				if (heading?.[1]) {
					const level = heading[1].length;
					if (skipLevel && level > skipLevel) continue;
					skipLevel =
						OLD_WORDING_HEADING.test(line) && !/don'?t claim/i.test(line)
							? level
							: 0;
					if (skipLevel) continue;
				} else if (skipLevel) continue;
				kept.push(line);
			}
			return { path: file.path, content: kept.join("\n") };
		}),
	};
}

/**
 * Lines that say what not to claim, or record wording known to be wrong, are not evidence even
 * though they contain the words: "Python: don't list on CVs" does not support "Python".
 */
const CAUTION =
	/\bdon'?t\b|\bdo not\b|\bnever (?:write|list|claim|use)\b|\bnot done\b|\bwrong\b|\bout of date\b|\bno evidence\b|\bdid not\b|\bisn'?t recorded\b|\bnot recorded\b|\bTODO\b/i;
/** "Records used in CVs" lines (`Title | Dates | Location *(used in: …)*`); the file header is authoritative. */
const CV_RECORD = /\|[^|\n]+\|.*\(used in:/;
/** How answers.md marks a job board's form label: the board's text, never evidence. */
export const BOARD_QUESTION_PREFIX =
	"- Board's question (third-party text, not evidence):";
/**
 * How answers.md marks the pipeline's own question: its wording may presuppose a fact ("mentored
 * mid-level developers", "was it trendmall-api"), so only the user's answer is evidence.
 */
export const ASKED_QUESTION_PREFIX =
	"- Question asked (the pipeline's wording, not evidence):";
/**
 * How answers.md marks a line the user confirmed as true in a flagged review: their own
 * confirmation of that exact text, with date and source, so it is evidence from then on.
 */
export const CONFIRMED_PREFIX = "- Confirmed as true by the user:";

/**
 * The role a CV line was confirmed under ("Senior Engineer — Brightloom"), from its flag's context
 * ("Experience › Senior Engineer — Brightloom"). Null for a letter or answer, or a line under no role.
 */
export function confirmedRole(flag: {
	document: string;
	context?: string | null;
}): string | null {
	if (flag.document !== "cv" || !flag.context) return null;
	const [section, role] = flag.context.split(" › ");
	return section && role && /experience/i.test(section) ? role : null;
}

/** `profile_facts.question` of a confirmation: what the Profile page shows, and its role. */
export function confirmationQuestion(input: {
	document: string;
	role: string | null;
	company: string;
	title: string;
}): string {
	const where = input.role ? ` under "${input.role.replace(/"/g, "'")}"` : "";
	return `Confirmed in the ${input.document.replace("_", " ")}${where} for ${input.company} (${input.title})`;
}

/**
 * The answers.md line of a confirmation. A CV line confirmed under a role names the role, so it
 * is evidence for that employer only: the same words moved under another employer are not.
 */
export function confirmationLine(question: string, text: string): string {
	const role = question.match(/^Confirmed in the cv under "([^"]+)"/)?.[1];
	const line = text.replace(/\s+/g, " ").trim();
	return role
		? `${CONFIRMED_PREFIX.slice(0, -1)}, in the CV under the role ${role}: ${line}`
		: `${CONFIRMED_PREFIX} ${line}`;
}
/** `profile_facts.question_source` of a confirmation. */
export const CONFIRMATION_SOURCE = "user confirmation";
const QUESTION_LINE =
	/^\s*-\s+(?:Board's question \(third-party text|Question asked \(the pipeline's wording)/i;

/**
 * A provenance aside such as "(user, 2026-10-27; which project used which isn't recorded)" says
 * where a fact came from and what detail is missing; it does not take the fact back. The caution
 * test ignores it, so "Nx, Turborepo … all in production (user, …; which project isn't recorded)"
 * stays citable, while a sentence that says the fact itself isn't recorded is still refused.
 */
const PROVENANCE_ASIDE = /\((?:user|repo)\b[^()]*\)/gi;

/**
 * Text without its provenance asides. A quote is matched, and kept as evidence, in this form, so
 * an aside's own words ("likely trendmall-api") never count as quoted or cited facts.
 */
export function withoutAsides(text: string): string {
	return text
		.replace(PROVENANCE_ASIDE, "")
		.replace(/\s+([.,;:!?])/g, "$1")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function cautious(text: string): boolean {
	return CAUTION.test(withoutAsides(text));
}

export function normalizeForMatch(text: string): string {
	return text
		.replace(/\*\*|__|`|\*/g, "")
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/‹/g, "<")
		.replace(/›/g, ">")
		.replace(/[–—]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export type QuoteCheck =
	/** `quote` is the quote as evidence: provenance asides removed. */
	| { ok: true; file: string; line: string; quote: string }
	| { ok: false; reason: string };

/** Sentences of a normalized line, with their offsets. Split on . ! ? followed by a new sentence. */
function sentenceSpans(line: string): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	let start = 0;
	for (const match of line.matchAll(/[.!?](?=\s+[a-z0-9*"(])/g)) {
		const end = (match.index ?? 0) + 1;
		spans.push({ start, end });
		start = end;
	}
	spans.push({ start, end: line.length });
	return spans;
}

/** The sentences of `line` that the quote overlaps, as text. */
function sentencesAround(line: string, needle: string): string {
	const at = line.indexOf(needle);
	return sentenceSpans(line)
		.filter((s) => s.start < at + needle.length && s.end > at)
		.map((s) => line.slice(s.start, s.end))
		.join(" ");
}

/** The sentences of a quote, as written. */
function quoteSentences(quote: string): string[] {
	return quote
		.split(/(?<=[.!?])\s+(?=[\p{L}\d*"(])/u)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Terms a profile line's caution says not to use: `don't claim "large-scale"`. A line citing
 * that line may not use them, whichever of its sentences the quote took.
 */
export function cautionTerms(line: string): string[] {
	return quoteSentences(withoutAsides(line))
		.filter((sentence) => CAUTION.test(normalizeForMatch(sentence)))
		.flatMap((sentence) =>
			[...sentence.matchAll(/["“]([^"”]{2,60})["”]/g)].map((m) =>
				(m[1] ?? "").trim(),
			),
		)
		.filter(Boolean);
}

/**
 * A quote counts as evidence only if it is verbatim in an allowed file, outside the Don't claim
 * list and old CV records, and the sentence around it has no caution ("don't list", "TODO",
 * "that's wrong"). A true fact sharing a line with a caution note stays citable, and every line
 * holding the quote is tried before it is refused. A quote of several sentences, some of them a
 * caution, keeps only the others, each of which must pass on its own: what quoting them alone
 * would give. The caution's own words are never evidence.
 */
/**
 * The profile file a citation names. The models saw the prompt with contact details redacted,
 * so a path can come back with "[phone]" or "[email]" in it (a record id once read as a phone
 * number): such a path names the one file it matches with those parts as wildcards, if
 * exactly one does.
 */
function profileFile(
	profile: ProfileSnapshot,
	path: string,
): ProfileSnapshot["files"][number] | undefined {
	const exact = profile.files.find((f) => f.path === path);
	if (exact || !/\[(?:phone|email)\]/.test(path)) return exact;
	// "[phone]" stood for a phone-like run of digits, "[email]" for an address; the rest of the
	// path must match exactly.
	const pattern = new RegExp(
		`^${path
			.split(/(\[(?:phone|email)\])/)
			.map((part) =>
				part === "[phone]"
					? "\\+?\\d[\\d\\s().-]{8,}\\d"
					: part === "[email]"
						? "[\\w.+-]+@[\\w.-]+"
						: part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			)
			.join("")}$`,
	);
	const matches = profile.files.filter((f) => pattern.test(f.path));
	return matches.length === 1 ? matches[0] : undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Profile rules keep evidence and issue emission in order so each finding retains its source context.
export function checkQuote(
	profile: ProfileSnapshot,
	file: string,
	quote: string,
): QuoteCheck {
	const wanted = file.replace(/^\.?\/*/, "").replace(/^profile\//, "");
	if (!isEvidencePath(wanted))
		return { ok: false, reason: "sources/ is not evidence" };
	const doc = profileFile(profile, wanted);
	if (!doc) return { ok: false, reason: "file not in profile" };
	// A quote of a whole line may carry its provenance aside: matched and kept without it.
	const evidence = withoutAsides(quote);
	const needle = normalizeForMatch(evidence);
	if (needle.length < 3) return { ok: false, reason: "quote too short" };
	// Caution words inside the quote itself are never evidence, whatever the sentence around it.
	if (CAUTION.test(needle)) {
		const all = quoteSentences(evidence);
		const clean = all.filter((s) => !CAUTION.test(normalizeForMatch(s)));
		if (clean.length === 0 || clean.length === all.length)
			return { ok: false, reason: "quote is from a caution line" };
		const verbatim = normalizeForMatch(
			normalizeLineEndings(doc.content)
				.split("\n")
				.filter((line) => !QUESTION_LINE.test(line))
				.map(withoutAsides)
				.join("\n"),
		).includes(needle);
		if (!verbatim) return { ok: false, reason: "quote not found in file" };
		const checks = clean.map((sentence) => checkQuote(profile, file, sentence));
		const kept: string[] = [];
		let line = "";
		for (const check of checks) {
			if (!check.ok) return check;
			kept.push(check.quote);
			line ||= check.line;
		}
		return { ok: true, file: doc.path, line, quote: kept.join(" … ") };
	}
	const section = dontClaimSection(doc);
	const known = contactValues(profile);
	let refusal: string | null = null;
	for (const line of normalizeLineEndings(doc.content).split("\n")) {
		// The models see contact details redacted, so a quote may carry "[email]" or "[phone]".
		let normalized = normalizeForMatch(withoutAsides(line));
		if (!normalized.includes(needle))
			normalized = normalizeForMatch(withoutAsides(redactContact(line, known)));
		if (!normalized.includes(needle)) continue;
		if (QUESTION_LINE.test(line))
			refusal ??= "quote is a question, not the candidate's answer";
		else if (section.has(line))
			refusal ??= "quote is from the Don't claim list";
		else if (CV_RECORD.test(line))
			refusal ??= "quote is from an old CV record; the header is authoritative";
		else if (cautious(sentencesAround(normalized, needle)))
			refusal ??= "quote is from a caution line";
		else return { ok: true, file: doc.path, line, quote: evidence };
	}
	if (refusal) return { ok: false, reason: refusal };
	// Quotes may span lines; accept them only when no caution text and no question is inside.
	const citable = normalizeLineEndings(doc.content)
		.split("\n")
		.filter((line) => !QUESTION_LINE.test(line))
		.map(withoutAsides)
		.join("\n");
	if (normalizeForMatch(citable).includes(needle))
		return { ok: true, file: doc.path, line: evidence, quote: evidence };
	return { ok: false, reason: "quote not found in file" };
}

/**
 * The text of a profile file that can be evidence: not in the Don't claim list, not a question,
 * not an old CV record, and only the sentences with no caution in them (the same test a quote
 * gets). What a claim's facts are checked against.
 */
export function citableText(profile: ProfileSnapshot, path: string): string {
	const doc = evidenceProfile(profile).files.find((f) => f.path === path);
	if (!doc) return "";
	const section = dontClaimSection(doc);
	return doc.content
		.split("\n")
		.filter(
			(line) =>
				!section.has(line) &&
				!QUESTION_LINE.test(line) &&
				!CV_RECORD.test(line),
		)
		.map((line) => {
			// Asides are left out: "likely trendmall-api" sources no named term.
			const normalized = normalizeForMatch(withoutAsides(line));
			return sentenceSpans(normalized)
				.map((s) => normalized.slice(s.start, s.end))
				.filter((sentence) => !cautious(sentence))
				.join(" ");
		})
		.join("\n");
}

function dontClaimSection(doc: ProfileDocument): Set<string> {
	const lines = new Set<string>();
	let inside = false;
	for (const line of normalizeLineEndings(doc.content).split("\n")) {
		if (/^#{1,6}\s/.test(line)) inside = /don'?t claim/i.test(line);
		else if (inside) lines.add(line);
	}
	return lines;
}

/* --------------------------------------------------------- banned terms */

export interface BannedTerm {
	term: string;
	pattern: RegExp;
	reason: string;
}

const DEGREE: BannedTerm = {
	term: "degree wording",
	pattern:
		/\b(?:bachelor'?s?|master'?s|b\.\s?sc\.?|bsc|m\.\s?sc\.?|msc|b\.s\.|m\.s\.|degree|graduated|graduate of|diploma|alumn(?:us|a|i))\b/i,
	reason: "education.md: did not graduate; list school, field and years only",
};

const GENERIC_SUFFIX = /\s+(?:integrations?|apis?|platforms?)$/i;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): RegExp {
	// Brand names are matched case-sensitively when capitalized ("Cursor", not "cursor").
	const caseSensitive = /^[A-Z]/.test(term) && term !== term.toUpperCase();
	return new RegExp(
		`(?<![\\p{L}\\d])${escapeRegExp(term)}(?![\\p{L}\\d])`,
		caseSensitive ? "u" : "iu",
	);
}

/** "Shopify/WooCommerce integrations" -> Shopify, WooCommerce; "carrier/logistics APIs" -> carrier APIs, logistics APIs. */
function expandListItem(item: string): string[] {
	const clean = item.replace(/\([^)]*\)/g, "").trim();
	if (!clean) return [];
	const parts = clean.split("/").map((p) => p.trim());
	if (parts.length === 1) return [clean];
	const last = parts.at(-1) ?? "";
	const suffix = last.match(GENERIC_SUFFIX)?.[0] ?? "";
	return parts.map((part, i) => {
		const base =
			i === parts.length - 1 ? part.replace(GENERIC_SUFFIX, "") : part;
		return /^[A-Z]/.test(base) ? base : `${base}${suffix}`;
	});
}

/** A profile line saying the user has no degree ("Did not graduate"), which bans degree wording. */
const NO_DEGREE =
	/\b(?:did not|didn'?t|never) (?:graduate|finish|complete)\b|\bno (?:university )?degree\b|\bnot graduated\b/i;

/**
 * Terms never to write, all read from this user's own profile: degree wording when a line says
 * they did not graduate, every item in a "Don't claim" list, and anything a line says not to
 * list ("Python: don't list on CVs"). Nothing here is fixed to one person, so another user's
 * degree or Python is not refused.
 */
export function bannedTerms(profile: ProfileSnapshot): BannedTerm[] {
	const evidence = evidenceProfile(profile).files;
	const noDegree = evidence.find((doc) => NO_DEGREE.test(doc.content));
	const terms: BannedTerm[] = noDegree
		? [
				{
					...DEGREE,
					reason: `${noDegree.path}: did not graduate; list school, field and years only`,
				},
			]
		: [];
	const add = (term: string, reason: string) => {
		if (term.length < 3 || terms.some((t) => t.term === term)) return;
		terms.push({ term, pattern: termPattern(term), reason });
	};
	for (const doc of evidence) {
		for (const line of dontClaimSection(doc)) {
			const items = line.replace(/^\s*[-*]\s*/, "").split(",");
			for (const item of items)
				for (const term of expandListItem(item))
					add(term, `${doc.path}: Don't claim list`);
		}
		for (const line of doc.content.split("\n")) {
			if (!/don'?t list/i.test(line)) continue;
			const subject = line
				.replace(/^\s*[-*]\s*/, "")
				.replace(/\*\*/g, "")
				.split(":")[0];
			for (const term of (subject ?? "").split(/,|\band\b/))
				if (/^[A-Z][\w.+#-]*$/.test(term.trim()))
					add(term.trim(), `${doc.path}: don't list`);
		}
	}
	return terms;
}

/* ------------------------------------------------------ experience records */

export interface ExperienceRecord {
	file: string;
	company: string;
	title: string;
	dates: string;
	locationParts: string[];
}

/** Each experience file's header (`# Company — Title`, Dates, Location) is the current record. */
export function experienceRecords(
	profile: ProfileSnapshot,
): ExperienceRecord[] {
	const records: ExperienceRecord[] = [];
	for (const doc of profile.files) {
		if (!doc.path.startsWith("experience/")) continue;
		const content = normalizeLineEndings(doc.content);
		const heading = content.match(/^#\s+(.+?)\s+[—–-]\s+(.+)$/m);
		// Within the line only: an empty field must not take the next line (a heading) as its value.
		const dates = content.match(/^-[ \t]+\*\*Dates:\*\*[ \t]+(.+)$/m)?.[1];
		const location = content.match(
			/^-[ \t]+\*\*Location:\*\*[ \t]+(.+)$/m,
		)?.[1];
		if (!heading?.[1] || !heading[2] || !dates) continue;
		records.push({
			file: doc.path,
			company: heading[1].trim(),
			title: heading[2].trim(),
			dates: normalizeDates(dates),
			locationParts: (location ?? "")
				.split("·")
				.map((p) => p.trim())
				.filter(Boolean),
		});
	}
	return records;
}

function normalizeDates(text: string): string {
	return text
		.replace(/\s*[–—-]\s*/g, " – ")
		.replace(/\bpresent\b/i, "Present")
		.trim();
}

export function nameKey(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/[’']/g, "'")
		.toLowerCase()
		.replace(/[^a-z0-9']+/g, " ")
		.trim();
}

/**
 * The experience records a CV role (`### Title — Company`) can be: those of its company, and when
 * the company has several (two stints there, years apart), those with the role's title. A title
 * that matches none keeps them all: which one it is is then unknown.
 */
export function roleRecords(
	records: ExperienceRecord[],
	company: string,
	title?: string,
): ExperienceRecord[] {
	const stints = records.filter((r) => nameKey(r.company) === nameKey(company));
	if (stints.length < 2 || title === undefined) return stints;
	const own = stints.filter((r) => nameKey(r.title) === nameKey(title));
	return own.length > 0 ? own : stints;
}

const DATE_RANGE =
	/^(?:[A-Z][a-z]{2} \d{4}|\d{4}) – (?:[A-Z][a-z]{2} \d{4}|\d{4}|Present)$/;

/** Roles under `## Experience` must match the header of their experience file: title, dates, location. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Profile rules keep evidence and issue emission in order so each finding retains its source context.
export function checkExperienceRecords(
	cv: string,
	records: ExperienceRecord[],
): RuleIssue[] {
	const issues: RuleIssue[] = [];
	const lines = normalizeLineEndings(cv).split("\n");
	let inExperience = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^##\s/.test(line)) inExperience = /^##\s+experience\b/i.test(line);
		if (!inExperience) continue;
		const heading = line.match(/^###\s+(.+?)\s+[—–-]\s+(.+)$/);
		if (!heading?.[1] || !heading[2]) continue;
		const [title, company] = [heading[1].trim(), heading[2].trim()];
		const meta = (lines[i + 1] ?? "").replace(/^\*|\*$/g, "").trim();
		const parts = meta.split("·").map((p) => p.trim());
		const dates = parts.map(normalizeDates).find((p) => DATE_RANGE.test(p));
		// Two stints at one company: the one with this title, else the one with these dates.
		const stints = roleRecords(records, company, title);
		const record = stints.find((r) => r.dates === dates) ?? stints[0];
		if (!record) {
			issues.push({
				rule: "experience_record",
				document: "cv",
				message: `No experience file for employer "${company}".`,
				excerpt: line,
			});
			continue;
		}
		if (title !== record.title)
			issues.push({
				rule: "experience_record",
				document: "cv",
				message: `${record.company} title must be "${record.title}" (${record.file} header).`,
				excerpt: line,
			});
		if (dates !== record.dates)
			issues.push({
				rule: "experience_record",
				document: "cv",
				message: `${record.company} dates must be "${record.dates}" (${record.file} header).`,
				excerpt: meta || line,
			});
		const allowed = record.locationParts.map((p) => p.toLowerCase());
		for (const part of parts) {
			if (!part || DATE_RANGE.test(normalizeDates(part))) continue;
			if (!allowed.includes(part.toLowerCase()))
				issues.push({
					rule: "experience_record",
					document: "cv",
					message: `${record.company}: "${part}" is not in the header location "${record.locationParts.join(" · ")}".`,
					excerpt: meta,
				});
		}
	}
	return issues;
}

/* ------------------------------------------------------------ text rules */

const PLACEHOLDER =
	/<[^<>\n]{1,80}>|\{\{[^}]*\}\}|\[(?:company|role|title|name|hiring manager|date|your [^\]]+)\]|\bTODO\b|\bTBD\b|\bXXX\b|lorem ipsum/i;

export function wordCount(text: string): number {
	return text.split(/\s+/).filter((w) => /[\p{L}\d]/u.test(w)).length;
}

export interface DocumentContext {
	companyName: string;
	jobTitle: string;
}

/**
 * A wording rule the profile states for one subject: a `- **CV wording:** "phrase", no commit
 * counts` line under the subject's heading (a project or a role). Read from the user's own
 * profile, so nothing here is fixed to one person.
 */
export interface WordingRule {
	/** The heading's name: "Tablewise" from "## Tablewise: restaurant booking platform (…)". */
	subject: string;
	/** The phrase to write, as quoted on the line ("sole developer"). */
	phrase: string;
	/** The line says to give no commit counts. */
	noCommitCounts: boolean;
	/** The file the rule is in. */
	file: string;
}

const WORDING_LINE = /^\s*[-*]\s*\*\*CV wording:\*\*\s*(.+)$/i;

export function wordingRules(profile: ProfileSnapshot): WordingRule[] {
	const rules: WordingRule[] = [];
	for (const doc of evidenceProfile(profile).files) {
		let heading = "";
		for (const line of doc.content.split("\n")) {
			const h = line.match(/^#{1,6}\s+(.+)$/);
			if (h?.[1]) {
				heading = h[1];
				continue;
			}
			const m = line.match(WORDING_LINE);
			const phrase = m?.[1]?.match(/"([^"]+)"/)?.[1];
			const subject = heading
				.split(/\s*[:(—–]\s*|\s+-\s+/)[0]
				?.replace(/\*\*/g, "")
				.trim();
			if (!m || !phrase || !subject) continue;
			rules.push({
				subject,
				phrase,
				noCommitCounts: /no commit counts?/i.test(m[1] ?? ""),
				file: doc.path,
			});
		}
	}
	return rules;
}

export interface RuleSet {
	banned: BannedTerm[];
	records: ExperienceRecord[];
	/** The profile's own wording rules ("sole developer", no commit counts), by subject. */
	wording: WordingRule[];
}

export function ruleSet(profile: ProfileSnapshot): RuleSet {
	return {
		banned: bannedTerms(profile),
		records: experienceRecords(profile),
		wording: wordingRules(profile),
	};
}

/** Text that breaks a wording rule: another word after the phrase's first, or a commit count. */
function wordingBreak(block: string, rule: WordingRule): string | null {
	const [first, ...rest] = rule.phrase.split(/\s+/);
	if (first && rest.length > 0) {
		const other = block.match(
			new RegExp(
				`\\b${escapeRegExp(first)}\\s+(?!${escapeRegExp(rest.join(" "))}\\b)[\\p{L}-]+`,
				"iu",
			),
		);
		if (other) return other[0];
	}
	if (rule.noCommitCounts)
		return block.match(/\b\d[\d,]*\+?\s+commits?\b/i)?.[0] ?? null;
	return null;
}

function excerptAround(text: string, index: number): string {
	const start = text.lastIndexOf("\n", index) + 1;
	const end = text.indexOf("\n", index);
	const line = text.slice(start, end === -1 ? undefined : end).trim();
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** The cover letter's word range (the owner's decision, 2026-11-03: 220, was 250). */
export const LETTER_MIN_WORDS = 220;
export const LETTER_MAX_WORDS = 400;

/** Every deterministic rule for one document. Notes are private, so only placeholders apply there. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Profile rules keep evidence and issue emission in order so each finding retains its source context.
export function checkDocumentRules(
	kind: DocumentKind,
	input: string,
	rules: RuleSet,
	context: DocumentContext,
): RuleIssue[] {
	const text = normalizeLineEndings(input);
	const issues: RuleIssue[] = [];
	const placeholder = text.match(PLACEHOLDER);
	if (placeholder?.index !== undefined)
		issues.push({
			rule: "placeholder",
			document: kind,
			message: `Leftover placeholder "${placeholder[0]}".`,
			excerpt: excerptAround(text, placeholder.index),
		});
	if (kind === "notes") return issues;

	for (const banned of rules.banned) {
		// The target company's own name may appear in a letter or answer ("…at ClickHouse");
		// a claim of using it is left to the claims check. A CV never names it.
		if (kind !== "cv" && banned.pattern.test(context.companyName)) continue;
		const match = text.match(banned.pattern);
		if (match?.index !== undefined)
			issues.push({
				rule: "banned_term",
				document: kind,
				message: `"${match[0]}" must not be claimed (${banned.reason}).`,
				excerpt: excerptAround(text, match.index),
			});
	}

	for (const rule of rules.wording) {
		const subject = new RegExp(`\\b${escapeRegExp(rule.subject)}\\b`, "i");
		for (const block of text.split(/\n\s*\n|\n(?=\s*[-*]\s)/)) {
			if (!subject.test(block)) continue;
			const wrong = wordingBreak(block, rule);
			if (wrong)
				issues.push({
					rule: "cv_wording",
					document: kind,
					message: `${rule.subject}: write "${rule.phrase}"${rule.noCommitCounts ? " with no commit counts" : ""}, not "${wrong}" (${rule.file}).`,
					excerpt: block.trim().slice(0, 200),
				});
		}
	}

	if (kind === "cv")
		issues.push(...checkExperienceRecords(text, rules.records));

	if (kind === "cover_letter") {
		const words = wordCount(text);
		if (words < LETTER_MIN_WORDS || words > LETTER_MAX_WORDS)
			issues.push({
				rule: "length",
				document: kind,
				message: `Cover letter has ${words} words; it must be ${LETTER_MIN_WORDS} to ${LETTER_MAX_WORDS}.`,
			});
	}
	if (kind === "cv" && wordCount(text) > 1100)
		issues.push({
			rule: "length",
			document: kind,
			message: `CV has ${wordCount(text)} words; that cannot fit two pages.`,
		});

	// A company name is a proper noun: any other spelling is wrong. A role title can also be a
	// plain description of the candidate ("senior full-stack engineer"), so it is only required
	// verbatim in the letter, below.
	const company = context.companyName;
	if (company) {
		for (const match of text.matchAll(
			new RegExp(escapeRegExp(company), "gi"),
		)) {
			if (match[0] !== company) {
				issues.push({
					rule: "name_spelling",
					document: kind,
					message: `Company name must be spelled exactly "${company}", not "${match[0]}".`,
					excerpt: excerptAround(text, match.index ?? 0),
				});
				break;
			}
		}
	}
	if (kind === "cover_letter") {
		for (const [label, name] of [
			["company name", context.companyName],
			["role title", context.jobTitle],
		] as const)
			if (name && !text.includes(name))
				issues.push({
					rule: "name_spelling",
					document: kind,
					message: `The letter must name the ${label} exactly as posted: "${name}".`,
				});
	}
	return issues;
}
