import { mentions } from "../employer-names";
import {
	type ExperienceRecord,
	nameKey,
	type RuleIssue,
	type RuleSet,
	type SegmentPlace,
} from "../profile-rules";
import { type KnownExpansion, withoutExpansions } from "./expansions";
import type { Segment } from "./segments";
import { factTokens, inOwnWords, NEGATED } from "./tokens";
import type { CheckedDocument } from "./types";

/* ------------------------------------------------------------- numbers */

export const NUMBER = /(?<![\p{L}\d.])\d+(?:[.,]\d+)?(?:%|\+)?/gu;

const LETTER_DATE =
	/^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/;

/** Every number in a document must appear in the profile (or, for a letter, the posting). */
export function unsupportedNumbers(
	kind: CheckedDocument,
	text: string,
	profileText: string,
	postingText: string,
): RuleIssue[] {
	const issues: RuleIssue[] = [];
	const known = (n: string) => {
		const core = n.replace(/[%+]$/, "");
		const pattern = new RegExp(
			`(?<![\\d.,])${core.replace(/[.]/g, "\\.")}(?![\\d])`,
		);
		return pattern.test(profileText) || pattern.test(postingText);
	};
	for (const line of text.split("\n")) {
		const clean = line.trim().replace(/\\$/, "");
		if (!clean || clean.includes("@") || LETTER_DATE.test(clean)) continue;
		for (const match of clean.matchAll(NUMBER)) {
			if (known(match[0])) continue;
			issues.push({
				rule: "unsupported_number",
				document: kind,
				message: `"${match[0]}" does not appear in the profile.`,
				excerpt: clean.slice(0, 200),
			});
		}
	}
	return issues;
}

/* --------------------------------------------------------------- check */

export function place(segment: Segment): SegmentPlace {
	return { context: segment.context, occurrence: segment.occurrence };
}

/** The company named as a whole word (or words) in a line. */
function names(line: string, company: string): boolean {
	const key = nameKey(company);
	return key.length > 0 && ` ${nameKey(line)} `.includes(` ${key} `);
}

/**
 * A CV line under a role (`### Title — Company` in Experience) states something done at that
 * employer. Its evidence must come from that employer's experience file, or from a profile line
 * that names the employer (an answer, a confirmation made under that role): a true line moved
 * under another employer is no longer true. Null when it does; otherwise the problem in words.
 */
export function otherEmployer(
	segment: Segment,
	evidence: { files: Set<string>; lines: string[] },
	rules: RuleSet,
): string | null {
	const employer = segment.employer;
	if (!employer) return null;
	const record = rules.records.find(
		(r) => nameKey(r.company) === nameKey(employer),
	);
	// No file to tie the line to: it cannot be about that employer on this evidence.
	if (!record)
		return `No experience file for ${employer}, the role this line sits under.`;
	if (evidence.files.has(record.file)) return null;
	if (evidence.lines.some((line) => names(line, record.company))) return null;
	return `Its evidence (${[...evidence.files].join(", ")}) is not about ${record.company}, the role this line sits under (${record.file}).`;
}

export interface Employer {
	record: ExperienceRecord;
	/** Its company and product names (`roleAliases`). */
	names: { loose: string[]; exact: string[] };
}

/**
 * A line that names several employers (or one, under another employer's role) states its facts
 * for each of them. Each must have cited quotes of its own that state every fact word of the
 * line: a sentence of a quote is about the employers it names, or, naming none, about the
 * employer whose file it comes from. In a file that is no employer's (an answer), a sentence
 * naming none goes on about the employers of the sentence before it in the same quote: "at alpha
 * and beta I mentored them. onboarded etc." "React across Alpha and Beta" is flagged on "Alpha
 * uses React. Beta uses Go." No scope reading beyond that: anything else goes to the human.
 * The facts are read per clause: a clause naming no employer ("…, and I use Claude Code daily")
 * is checked against the profile as a whole, not for each employer. A CV line under a role is
 * one clause: all of it is done at that role.
 * `everywhere` holds what the profile's answers state at every employer ("yes in all my
 * companies" to a question from tailoring, see `everyEmployerYes`): a part about each of them.
 */
export function eachEmployer(
	segment: Segment,
	pairs: { file: string; quote: string }[],
	employers: Employer[],
	known: KnownExpansion,
	everywhere: Set<string>[] = [],
): string | null {
	const named = employers.filter((e) => mentions(segment.text, e.names));
	const role = employers.find(
		(e) =>
			segment.employer !== undefined &&
			nameKey(e.record.company) === nameKey(segment.employer),
	);
	if (named.length > 0 && role && !named.includes(role)) named.push(role);
	if (named.length < 2) return null;
	const nameTokens = new Set(
		named
			.flatMap((e) => [...e.names.loose, ...e.names.exact])
			.flatMap((n) => [...factTokens(n)]),
	);
	const checked = withoutExpansions(segment.text, known);
	const scoped = role ? [checked] : employerClauses(checked);
	/** The fact words an employer must have: those of the clauses naming it (all, for a role). */
	const neededFor = (employer: Employer) => {
		const own = scoped.filter(
			(clause) => employer === role || mentions(clause, employer.names),
		);
		return [
			...new Set(own.flatMap((clause) => [...factTokens(clause)])),
		].filter((t) => t !== NEGATED && !nameTokens.has(t));
	};
	const files = new Set(employers.map((e) => e.record.file));
	const parts = pairs.flatMap((p) => {
		let before: Employer[] = [];
		return p.quote.split(/(?<=[.!?;])\s+/).map((text) => {
			let names = employers.filter((e) => mentions(text, e.names));
			if (names.length === 0 && !files.has(p.file)) names = before;
			before = names;
			return { file: p.file, text, names };
		});
	});
	for (const employer of named) {
		const about = parts.filter((part) =>
			part.names.length > 0
				? part.names.includes(employer)
				: part.file === employer.record.file,
		);
		const stated = new Set([
			...about.flatMap((a) => [...factTokens(a.text)]),
			...everywhere.flatMap((tokens) => [...tokens]),
		]);
		const lacking = neededFor(employer).filter((t) => !stated.has(t));
		if ((about.length === 0 && everywhere.length === 0) || lacking.length > 0)
			return `This line names ${named.map((e) => e.record.company).join(" and ")}; the cited quotes about ${employer.record.company} do not state ${lacking.length > 0 ? inOwnWords(checked, lacking).join(", ") : "anything"}.`;
	}
	return null;
}

/**
 * The clauses of a letter or answer line, for which employer a fact is about: split at ";", a
 * dash, ", and" / ", but" and the like, and "and I". Not at a bare comma: in "At Alpha and Beta,
 * I built X" the opening phrase places X.
 */
function employerClauses(text: string): string[] {
	return text
		.split(
			/\s*(?:;|\s[-–—]\s|[–—]|,\s*(?=(?:and|but|while|whereas|so|yet|plus)\b)|\s+(?=(?:and|but)\s+(?:I|we)\b))\s*/,
		)
		.filter((clause) => /[\p{L}\d]/u.test(clause));
}
