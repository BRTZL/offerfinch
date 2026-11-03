import { type DocumentContext, normalizeForMatch } from "../profile-rules";

export function maskNames(text: string, context: DocumentContext): string {
	let masked = text;
	for (const name of [context.jobTitle, context.companyName])
		if (name.trim()) masked = masked.split(name).join(" ");
	return masked;
}

/** "In my own words" attributes the wording; it is no scope ("own") and no fact. */
export function withoutAsides(text: string): string {
	return text.replace(/\b(?:in|from) my (?:own )?words\b,?/gi, " ");
}

/* ------------------------------------------------------------ coverage */

function tokens(text: string): Set<string> {
	return new Set(
		normalizeForMatch(text)
			.split(/[^\p{L}\d%+#.]+/u)
			.map((t) => t.replace(/^\.+|\.+$/g, ""))
			.filter((t) => t.length >= 3),
	);
}

export function overlap(claim: string, line: string): number {
	const a = tokens(claim);
	if (a.size === 0) return 0;
	const b = tokens(line);
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared / a.size;
}

/** Share of the segment's fact words (short ones like "Go" and "C#" included) the claim repeats. */
function factShare(segment: string, claim: string): number {
	const facts = [...factTokens(segment)].filter((t) => t !== NEGATED);
	if (facts.length === 0) return 0;
	const said = factTokens(claim);
	return facts.filter((t) => said.has(t)).length / facts.length;
}

/**
 * A claim belongs to a segment when most of its words come from it, or it restates most of the
 * segment's words or fact words. Fact words keep short tokens, so a line "Go" can be claimed.
 */
export function related(claim: string, segment: string): boolean {
	return (
		Math.max(
			overlap(claim, segment),
			overlap(segment, claim),
			factShare(segment, claim),
		) >= 0.5
	);
}

/**
 * Words that carry no fact about the candidate: function words, and the rhetoric a letter wraps
 * facts in ("your posting asks for"). Everything else in a segment is a fact its claims must
 * repeat. Negations and yes/no are never here: "No" is the answer.
 */
const FILLER = new Set(
	`a an the and or nor but of to in on at by for with from as into onto over via per than then so
	such is are was were be been being am i me my mine we our ours us you your yours it its this
	that these those there here they them their he she his her who whom whose which what where when
	why how do does did done has have had having can could would should will shall may might must also
	any some very just about through using use used again further
	once while during before after above below up down out off too other another per across
	i'd i'm i'll i've we'd we're we've we'll you'd you're you've you'll
	yes yeah true candidate candidates applicant posting role roles position company asks
	ask asked list listed mentions mention mentioned together combination combine combines describes
	describe described mix kind part thing things`.split(/\s+/),
);

/**
 * Words that set the scope of a fact: who did it ("on my own", "sole", "alone", "led"), how much
 * of it ("all", "every", "most", "only"). Stemmed as `factTokens` stems them. A checker restating
 * them in its claim is not enough: they must be in the verified quotes it cites, so "Built APIs on
 * my own" is not supported by a profile line saying "Built APIs". After a negation ("not only")
 * they narrow nothing and are ordinary words.
 */
const SCOPE = new Set(
	`own only sole alone myself solo single independent all every each entire whole both most
	majority lead led head primary principal first`.split(/\s+/),
);

/**
 * "on my own" (alone), told apart from the verb "own" (to be responsible for): one token, so a
 * quote saying "Owned the billing service" does not state "on my own".
 */
const ALONE = "on my own";

/**
 * Scope words a stronger one in the quotes states: a "sole developer" owns what they build, and
 * built it on their own. Never the other way: "Owned the billing service" is not "sole".
 */
export const STATED_BY: Readonly<Record<string, readonly string[]>> = {
	own: ["sole", "solo", "alone", ALONE],
	[ALONE]: ["sole", "solo", "alone"],
};

/**
 * How much or how often: "I work mainly in Go" claims a share the profile must state. Matched
 * before stemming and kept whole, so "mainly" is never "main" (a branch).
 */
const PROPORTION = new Set(
	`mainly primarily predominantly chiefly largely exclusively extensively heavily daily
	weekly regularly usually frequently often always constantly`.split(/\s+/),
);

const POSSESSIVE = /^(?:my|his|her|their|our|your)$/;

/** Irregular forms of one word, so an answer's "teached" and a letter's "taught" match. */
const IRREGULAR: Readonly<Record<string, string>> = {
	taught: "teach",
	built: "build",
	wrote: "write",
	written: "write",
	ran: "run",
};

const NEGATION = /^(?:no|not|never|none|cannot|without|neither)$|n't$/;

/** Stands for every negation, so "No" and "does not" match. */
export const NEGATED = "¬";

function stem(word: string): string {
	if (/[\d+#.]/.test(word)) return word;
	const irregular = IRREGULAR[word];
	if (irregular) return irregular;
	let w = word;
	if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
	else if (w.length > 4 && /ie[sd]$/.test(w)) w = `${w.slice(0, -3)}y`;
	else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
	else if (w.length > 3 && /(?:ch|sh|x|ss|z)es$/.test(w)) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss"))
		w = w.slice(0, -1);
	if (w.length > 5 && w.endsWith("ly")) w = w.slice(0, -2);
	// "running" -> "runn" -> "run", "shipped" -> "shipp" -> "ship".
	if (w !== word && /([b-df-hj-km-rtv-y])\1$/.test(w)) w = w.slice(0, -1);
	return w;
}

/** The fact-bearing words of a text, stemmed; short ones ("Go", "C#", "No") included. */
export function factTokens(text: string): Set<string> {
	return words(text).tokens;
}

/** The scope words of a text (see SCOPE), stemmed, except right after a negation. */
export function scopeTokens(text: string): Set<string> {
	return words(text).scope;
}

function words(text: string): { tokens: Set<string>; scope: Set<string> } {
	const tokens = new Set<string>();
	const scope = new Set<string>();
	let negated = false;
	const all = normalizeForMatch(withoutAsides(text))
		.split(/[^\p{L}\p{M}\d+#.']+/u)
		.map((raw) => raw.replace(/^[.']+|[.']+$/g, "").replace(/'s$/, ""))
		.filter(Boolean);
	for (const [index, word] of all.entries()) {
		// "most recently" dates a role and "would most like" is a preference; neither claims a share.
		if (
			word === "most" &&
			/^(?:recent|recently|like|love|enjoy|want|prefer)$/.test(
				all[index + 1] ?? "",
			)
		)
			continue;
		if (
			word === "own" &&
			all[index - 2] === "on" &&
			POSSESSIVE.test(all[index - 1] ?? "")
		) {
			tokens.add(ALONE);
			if (!negated) scope.add(ALONE);
			negated = false;
			continue;
		}
		if (NEGATION.test(word)) {
			tokens.add(NEGATED);
			negated = true;
			continue;
		}
		if (FILLER.has(word)) continue;
		if (PROPORTION.has(word)) {
			tokens.add(word);
			if (!negated) scope.add(word);
			negated = false;
			continue;
		}
		const stemmed = stem(word);
		tokens.add(stemmed);
		if (SCOPE.has(stemmed) && !negated) scope.add(stemmed);
		negated = false;
	}
	return { tokens, scope };
}

/**
 * Fact tokens shown in the text's own words: "trunk, bas, continuou" from "… Trunk Based
 * Development and Continuous Delivery" reads "Trunk Based Development, Continuous Delivery".
 * Neighbouring words that are all wanted make one phrase; a word between them ("and") splits it.
 * A token the text does not hold is shown as it is.
 */
export function inOwnWords(text: string, wanted: Iterable<string>): string[] {
	const want = new Set(wanted);
	const phrases: string[] = [];
	const found = new Set<string>();
	let run: string[] = [];
	const close = () => {
		if (run.length > 0) phrases.push(run.join(" "));
		run = [];
	};
	for (const raw of withoutAsides(text).split(/[^\p{L}\p{M}\d+#.'’]+/u)) {
		const word = raw.replace(/^[.'’]+|[.'’]+$/g, "");
		const hits = word ? [...factTokens(word)].filter((t) => want.has(t)) : [];
		if (hits.length === 0) {
			if (word) close();
			continue;
		}
		for (const t of hits) found.add(t);
		run.push(word);
	}
	close();
	const out = [...new Set(phrases)];
	for (const t of want) if (!found.has(t)) out.push(t);
	return out;
}
