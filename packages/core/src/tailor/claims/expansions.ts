import type { ProfileSnapshot } from "../../profile/types";
import { type DocumentContext, evidenceProfile } from "../profile-rules";
import type { Segment } from "./segments";
import {
	factTokens,
	maskNames,
	NEGATED,
	STATED_BY,
	scopeTokens,
} from "./tokens";

/**
 * Names in a segment (capitalized words other than the first, a short capitalized first word,
 * all-caps words, tokens like Next.js, C# or R2), with the company and role named in the posting
 * masked. They must appear in the profile files the segment's claims cite, so a checker cannot
 * vouch for "Rust" with a quote from a file that never mentions it.
 */
export function namedTerms(
	text: string,
	context: DocumentContext,
	known: KnownExpansion = trustedExpansion,
): Set<string> {
	const masked = withoutExpansions(maskNames(text, context), known);
	const out = new Set<string>();
	const words = masked.match(/[\p{L}\d][\p{L}\p{M}\d+#.'-]*/gu) ?? [];
	words.forEach((word, index) => {
		const clean = word.replace(/[.'-]+$/, "");
		// "I'd" and "I've" mid-sentence are capitalized pronouns, not names.
		if (/^I(?:'(?:d|m|ll|ve))?$/.test(clean)) return;
		const named =
			(index > 0 && /^\p{Lu}/u.test(clean)) ||
			// A short capitalized first word ("Go" alone on a line) is a name too.
			(index === 0 && clean.length < 3 && /^\p{Lu}/u.test(clean)) ||
			/^\p{Lu}{2,}/u.test(clean) ||
			/\p{L}[+#.]|\p{L}\d|\d\p{L}/u.test(clean);
		if (!named || /^\d+$/.test(clean)) return;
		for (const token of factTokens(clean))
			if (token !== NEGATED) out.add(token);
	});
	return out;
}

const CONNECTORS = new Set(["of", "and", "for", "the", "&", "to", "in", "on"]);

/**
 * Standard expansions accepted without the profile stating them. Any other spelled-out form
 * must be in the profile: matching initials alone allowed "MCP (Medical Certification Program)".
 */
export const TRUSTED_EXPANSIONS: Readonly<Record<string, readonly string[]>> =
	Object.freeze({
		API: ["application programming interface"],
		ATS: ["applicant tracking system"],
		AWS: ["amazon web services"],
		CD: ["continuous delivery", "continuous deployment"],
		CI: ["continuous integration"],
		CMS: ["content management system"],
		CRM: ["customer relationship management"],
		ERP: ["enterprise resource planning"],
		GCP: ["google cloud platform"],
		JWT: ["json web token"],
		LLM: ["large language model"],
		MCP: ["model context protocol"],
		ORM: ["object relational mapping", "object relational mapper"],
		PWA: ["progressive web app", "progressive web application"],
		QA: ["quality assurance"],
		RAG: ["retrieval augmented generation"],
		SDK: ["software development kit"],
		SEO: ["search engine optimization", "search engine optimisation"],
		SLA: ["service level agreement"],
		SPA: ["single page application", "single page app"],
		SQL: ["structured query language"],
		SSG: ["static site generation"],
		SSR: ["server side rendering"],
		UI: ["user interface"],
		UX: ["user experience"],
	});

/** Which spelled-out forms may be dropped: an acronym and the words given for it. */
export type KnownExpansion = (acronym: string, words: string[]) => boolean;

function phrase(words: string[]): string {
	return words
		.join(" ")
		.toLowerCase()
		.replace(/[^\p{L}\d]+/gu, " ")
		.trim();
}

export const trustedExpansion: KnownExpansion = (acronym, words) =>
	(TRUSTED_EXPANSIONS[acronym.toUpperCase()] ?? []).includes(phrase(words));

/**
 * The meanings the profile gives an acronym next to it: "CD (compact disc)" and "compact disc
 * (CD)", where the words spell the acronym. By acronym, upper case.
 */
function statedExpansions(content: string): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	const add = (acronym: string, words: string[]) => {
		if (!spells(acronym, words)) return;
		const key = acronym.toUpperCase();
		out.set(key, (out.get(key) ?? new Set()).add(phrase(words)));
	};
	for (const m of content.matchAll(
		/\b(\p{Lu}[\p{Lu}\d]+)s?\s*\(([^()]{3,80})\)/gu,
	))
		add(m[1] ?? "", (m[2] ?? "").trim().split(/[\s-]+/));
	for (const m of content.matchAll(
		/((?:[\p{L}\d]+[\s-]+){1,8}?)\(\s*(\p{Lu}[\p{Lu}\d]+)s?\s*\)/gu,
	)) {
		const acronym = m[2] ?? "";
		const words = (m[1] ?? "").trim().split(/[\s-]+/);
		// The last words before the parenthesis, as many significant ones as the acronym has letters.
		let first = words.length;
		let significant = 0;
		while (first > 0 && significant < acronym.length) {
			first--;
			if (!CONNECTORS.has((words[first] ?? "").toLowerCase())) significant++;
		}
		add(acronym, words.slice(first));
	}
	return out;
}

/**
 * Which expansions may be dropped for this profile. When the profile spells an acronym out next
 * to it, only its own meanings count: "CD (compact disc)" in the profile means "CD (Continuous
 * Deployment)" is a claim of its own, trusted list or not. Otherwise the trusted list, and any
 * phrase the profile's evidence files contain.
 */
export function profileExpansions(profile: ProfileSnapshot): KnownExpansion {
	const contents = evidenceProfile(profile).files.map((f) => f.content);
	const text = ` ${phrase(contents)} `;
	const stated = statedExpansions(contents.join("\n"));
	return (acronym, words) => {
		const own = stated.get(acronym.toUpperCase());
		if (own) return own.has(phrase(words));
		return (
			trustedExpansion(acronym, words) || text.includes(` ${phrase(words)} `)
		);
	};
}

/** True when the significant words' initials spell the acronym: "Model Context Protocol", MCP. */
function spells(acronym: string, words: string[]): boolean {
	const initials = words
		.filter((w) => !CONNECTORS.has(w.toLowerCase()))
		.map((w) => w[0]?.toUpperCase() ?? "")
		.join("");
	return initials === acronym.toUpperCase();
}

/**
 * Drops an acronym's spelled-out form next to it: "MCP (Model Context Protocol)" and "Model
 * Context Protocol (MCP)" both become "MCP", so the acronym alone is what the profile must state.
 * Only a form `known` accepts is dropped (the trusted list, or the profile's own wording); any
 * other parenthesis stays, and its words are claims the profile must support.
 */
export function withoutExpansions(
	text: string,
	known: KnownExpansion = trustedExpansion,
): string {
	const means = (acronym: string, words: string[]) =>
		spells(acronym, words) && known(acronym, words);
	let out = text.replace(
		/\b(\p{Lu}[\p{Lu}\d]+)s?\s*\(([^()]{3,80})\)/gu,
		(whole, acronym: string, inner: string) =>
			means(acronym, inner.trim().split(/[\s-]+/))
				? whole.slice(0, whole.indexOf("(")).trimEnd()
				: whole,
	);
	// Last first, so earlier offsets stay valid.
	for (const match of [
		...out.matchAll(/\s*\(\s*(\p{Lu}[\p{Lu}\d]+)s?\s*\)/gu),
	].reverse()) {
		const acronym = match[1] ?? "";
		const words = [...out.slice(0, match.index).matchAll(/\S+/g)];
		let first = words.length;
		let significant = 0;
		while (first > 0 && significant < acronym.length) {
			first--;
			if (!CONNECTORS.has((words[first]?.[0] ?? "").toLowerCase()))
				significant++;
		}
		const taken = words
			.slice(first)
			.map((w) => w[0].replace(/[^\p{L}\d]/gu, ""));
		const from = words[first]?.index;
		if (from === undefined || !means(acronym, taken)) continue;
		out = `${out.slice(0, from)}${acronym}${out.slice(match.index + match[0].length)}`;
	}
	return out;
}

/**
 * What a segment's claims leave out: fact words, a negation, a "yes" turned into "no", or a
 * scope word ("own", "only", "all") the verified quotes do not state.
 */
export function uncovered(
	segment: Segment,
	said: Set<string>,
	claimTexts: string[],
	quoted: Set<string>,
	known: KnownExpansion,
): string[] {
	const text = withoutExpansions(segment.text, known);
	const missing = [...factTokens(text)].filter((t) => !said.has(t));
	for (const scope of scopeTokens(text))
		if (
			!quoted.has(scope) &&
			!(STATED_BY[scope] ?? []).some((t) => quoted.has(t)) &&
			!missing.includes(scope)
		)
			missing.push(`${scope} (not in the cited quotes)`);
	// A form answer's polarity: claims that negate what the answer affirms do not cover it.
	if (
		segment.document === "form_answers" &&
		!factTokens(segment.text).has(NEGATED) &&
		claimTexts.some((c) => factTokens(c).has(NEGATED))
	)
		missing.push(NEGATED);
	return missing;
}
