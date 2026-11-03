import type { ProfileSnapshot } from "../../profile/types";
import { mentions, roleAliases } from "../employer-names";
import {
	citableText,
	type DocumentContext,
	evidenceProfile,
	nameKey,
	normalizeForMatch,
	ruleSet,
} from "../profile-rules";
import { parseContact } from "../tailor";
import { namedTerms } from "./expansions";
import type { Employer } from "./numbers-employers";
import { type Segment, sentences } from "./segments";
import { factTokens, maskNames, scopeTokens, withoutAsides } from "./tokens";

/**
 * When the claims model may skip a letter or form-answer sentence (PLAN rule 2). The CV is all
 * claims. A letter or an answer also talks about the company, the product, the role and why the
 * candidate is interested: those sentences state nothing about the candidate and need no
 * evidence. A skip is accepted unless the sentence says something about the candidate:
 * - a first-person clause ("I", "my", "we") that is more than interest: a fact word, a number, a
 *   name, an accomplishment, a scope word or a self-description. "… is the reason I'm applying"
 *   is interest; "I have built Go services for 5 years" is a fact wherever it sits;
 * - the candidate in the third person ("the candidate", "the author", "this engineer", "he"), or
 *   the hire the company would gain ("Talabat gains an engineer with …", "suits someone who …");
 * - a name only the candidate's side has: one of their employers, or a word of their profile the
 *   posting does not use ("as Fabula did");
 * - an implied candidate subject: "Having led …", "Five years of Go …".
 * Numbers in a sentence with no such part do not block it ("an audience of 100M+ people"); every
 * number is still checked against the profile and the posting on its own.
 */

/** What the candidate's side of a check knows: their employers and the words of their profile. */
export interface CandidateSide {
	employers: Employer[];
	/** Every fact token of the profile's citable text. */
	words: Set<string>;
	/** The candidate's own name: whole, and each part ("Ada Example", "Ada", "Example"). */
	person: string[];
}

const NO_SIDE: CandidateSide = { employers: [], words: new Set(), person: [] };

export function candidateSide(profile: ProfileSnapshot): CandidateSide {
	const evidence = evidenceProfile(profile);
	return {
		employers: ruleSet(evidence).records.map((record) => ({
			record,
			names: roleAliases(evidence, record),
		})),
		// The citable text: an earlier posting's wording in a question line is not the candidate's.
		words: factTokens(
			evidence.files.map((f) => citableText(evidence, f.path)).join("\n"),
		),
		person: personNames(parseContact(evidence).name),
	};
}

/** The full name and each part of it two letters or longer. */
function personNames(name: string): string[] {
	const full = name.replace(/\s+/g, " ").trim();
	if (!full) return [];
	const parts = full.split(" ").filter((p) => p.replace(/\W/g, "").length >= 2);
	return [...new Set([full, ...parts])];
}

/**
 * Name parts that are also common words ("Will", "Hope"): matched only as written, capitalized,
 * so "I hope to join" is not about a candidate named Hope.
 */
const COMMON_WORD_NAMES = new Set(
	`will may mark grace hope joy rose bill sky summer june april august art ray dean frank faith
	long young king brown white green black park lee rich page case hunter mason chase story love
	bliss sunny star dawn eve iris ivy lily jade pearl ruby amber hazel holly autumn river`.split(
		/\s+/,
	),
);

/** The candidate named by their own name, in any case: "Ada is fluent in Japanese." */
function namesCandidate(text: string, side: CandidateSide): boolean {
	return side.person.some((name) => {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const word = `(?<![\\p{L}\\d])${escaped}(?![\\p{L}\\d])`;
		if (!COMMON_WORD_NAMES.has(name.toLowerCase()))
			return new RegExp(word, "iu").test(text);
		// "Hope" as written anywhere; "hope" in any case only as a subject or an owner: "hope is
		// fluent in Japanese", "hope's work", never "I hope to join".
		return (
			new RegExp(word, "u").test(text) ||
			new RegExp(
				`(?<!\\b(?:i|we|you|they|to|and|or)\\s+)${word}(?:['’]s\\b|\\s+${NAME_VERB})`,
				"iu",
			).test(text)
		);
	});
}

/** A verb after a name that makes it the subject: "Hope is fluent", "Will speaks German". */
const NAME_VERB =
	"(?:is|was|has|had|speaks|spoke|lives|lived|holds|held|knows|knew|works|worked|led|leads|built|builds|ships|shipped|can|could|does|did|isn['’]t|wasn['’]t|hasn['’]t)\\b";

/** A line of nothing but the candidate's name, as a letter is signed: "Ada". */
function onlyName(text: string, side: CandidateSide): boolean {
	const words = text
		.replace(/[^\p{L}\p{M}'\s-]/gu, " ")
		.trim()
		.toLowerCase();
	const parts = new Set(side.person.map((p) => p.toLowerCase()));
	return words.length > 0 && words.split(/\s+/).every((w) => parts.has(w));
}

/**
 * Words that state a fact about the candidate. A first-person sentence with one of them cannot be
 * skipped whatever the model says: it needs a claim with evidence.
 */
const FACT_MARKERS =
	/\b(years?|months?|weeks?|days?|experienced?|worked|working (?:at|for|with|on)|led|lead|leading|managed|built|build|shipped|designed|developed|created|founded|owned|mentored|hold|holds|held|certified|certificate|certification|clearance|degree|diploma|graduated|studied|fluent|fluency|native|speak|speaks|languages?|citizen|citizenship|visa|sponsorship|authori[sz]ed|authori[sz]ation|permit|relocat\w*|salary|notice|available|availability|start|based in|live in|living in|located|senior|expert|proficient)\b|\bI(?:'m| am) an?\b|\bI(?:'ve| have)\b|\bmy (?:team|work|role|experience|background|career|skills?)\b/i;

/** The company and role names are the posting's words, so they are masked before the test. */
export function skippable(
	segment: Segment,
	context: DocumentContext,
	postingText = "",
	side: CandidateSide = NO_SIDE,
): boolean {
	if (segment.document === "cv") return false;
	const raw = segment.text.trim();
	if (COURTESY.has(normalizeForMatch(raw))) return true;
	// A short answer is checked with its question ("Do you have 5 years of React? Yes"), and the
	// question's "you" is the candidate.
	if (
		segment.document === "form_answers" &&
		segment.context !== "" &&
		raw.startsWith(segment.context)
	)
		return false;
	if (segment.document === "cover_letter" && callToAction(raw, context))
		return true;
	if (schedulingQuestion(raw, context)) return true;
	if (onlyName(raw, side)) return true;
	// "how that experience fits" points back at a sentence checked on its own; it adds no fact.
	const text = withoutAsides(maskNames(raw, context)).replace(
		BACK_REFERENCE,
		" ",
	);
	if (aboutCandidate(raw, text, context, postingText, side)) return false;
	// "That cut latency by 40%." right after "I led the migration." is about the candidate too.
	const previous = previousSentence(segment);
	const continues =
		previous !== undefined &&
		BACK_SUBJECT.test(raw) &&
		mentionsCandidate(previous, context, side);
	if (!FIRST_PERSON.test(text) && !continues) return true;
	return interestOnly(raw, text, context, continues);
}

/**
 * A sentence with the candidate in it may be skipped only as interest. Each first-person clause
 * says only that the candidate wants, hopes, applies or looks forward: no fact word, scope,
 * self-description, accomplishment, number or name, and every predicate the candidate is the
 * subject of is interest ("I want this role and live nearby" states where they live). A clause
 * about the company or the role may keep its own words, numbers and the posting's names:
 * "Defining a stack for 100M+ people is the reason I'm applying." A clause opening on a gerund is
 * the candidate's doing when it carries a fact: "Shipping three apps alone is why I'm applying."
 */
function interestOnly(
	raw: string,
	text: string,
	context: DocumentContext,
	continues: boolean,
): boolean {
	const names = namedTerms(raw, context);
	return clauses(text).every((clause, index) => {
		const opening = continues && index === 0;
		const bare = clause.trim().replace(/[.!?]+$/, "");
		if (!opening && !FIRST_PERSON.test(bare))
			return !(GERUND_START.test(bare) && carriesFact(bare));
		if (
			carriesFact(bare) ||
			/\d/.test(bare) ||
			[...factTokens(bare)].some((t) => names.has(t))
		)
			return false;
		if (opening && FRAME_ONLY.test(bare)) return true;
		return motivationPredicates(bare);
	});
}

/** A fact word, scope, self-description, accomplishment or applicant in a clause. */
function carriesFact(clause: string): boolean {
	const plain = clause.replace(PRODUCT_PHRASE, " ").replace(COLLEAGUES, " ");
	return (
		SELF_DESCRIPTION.test(clause) ||
		FACT_MARKERS.test(clause) ||
		APPLICANT.test(plain) ||
		ACCOMPLISHMENT.test(plain) ||
		// "I took the whole migration on my own" states a fact through its scope words alone.
		scopeTokens(clause).size > 0
	);
}

/**
 * Every predicate of a first-person clause is interest. The clause is split at commas and at
 * "and", "or", "but": the first part and every part that starts a new predicate must express
 * interest. A part continuing what the candidate is interested in ("the team", "its mission") is
 * no predicate, nor is a verb under an earlier "to" ("would love to join and learn the domain").
 * A part opening on "am", "have", "can" and the like is a new predicate: "and am punctual".
 */
function motivationPredicates(clause: string): boolean {
	const split = clause.split(/(\s*,\s*|\s+(?:and|or|but)\s+)/i);
	let infinitive = false;
	let ok = true;
	for (let index = 0; index < split.length; index += 2) {
		const part = (split[index] ?? "").trim();
		if (!/[\p{L}\d]/u.test(part)) continue;
		const joiner = (split[index - 1] ?? "").trim().toLowerCase();
		const interest = INTEREST.test(part);
		// Only "and" or "or" carries an earlier "to" on, and only to what one aspires to: "would
		// love to join and learn the domain". "to join the team and live nearby" states a home.
		const underTo =
			infinitive &&
			(joiner === "and" || joiner === "or") &&
			ASPIRATION.test(part) &&
			!AUXILIARY.test(part) &&
			!FIRST_PERSON.test(part);
		const continued = index > 0 && (NOUN_PHRASE.test(part) || underTo);
		if (/\bto\s+\p{L}/u.test(part)) infinitive = true;
		if (!(interest || continued)) ok = false;
	}
	return ok;
}

/** What a candidate aspires to do, under an earlier "to": learn, grow, help, explore … */
const ASPIRATION =
	/^(?:learn|grow|help|meet|explore|see|shape|discover|understand|tackle|solve|focus|take|make|work on|join|be part|try|get|deepen|improve|share|talk|discuss|hear|create|ship|design|define|contribute)\b/i;

/** A part that continues an object, not a predicate: "the team", "its mission", "how it works". */
const NOUN_PHRASE =
	/^(?:the|a|an|its|their|your|this|that|these|those|every|each|all|both|some|any|more|how|what|why|where|when|which|who|whose|['’]s)\b|^['’]s\b/i;

/** A part opening on an auxiliary or copula is a new predicate of the candidate. */
const AUXILIARY =
	/^(?:am|is|are|was|were|be|been|being|have|has|had|having|can|could|will|would|shall|should|may|might|must|do|does|did|['’]m|['’]ve|['’]d|['’]ll)\b/i;

const GERUND_START = /^\p{L}+ing\b/iu;

/**
 * The clauses of a sentence: split at ";", ":", a dash, a comma before a conjunction ("…, and I
 * have led …"), a subordinating conjunction ("I'm applying because …"), and before a subject
 * pronoun that starts a clause of its own ("… is the reason I'm applying"). Not at a bare comma
 * before the pronoun: "For 8 years, I …" is one clause, its opening phrase the candidate's.
 */
function clauses(text: string): string[] {
	return text
		.split(
			/\s*(?:[;:()]|\s[-–—]\s|[–—]|,\s*(?=(?:and|but|so|which|while|whereas|although|though|because|since|as|where|yet|who)\b))\s*|\s+(?=(?:because|since|while|whereas|although|though)\b)/i,
		)
		.flatMap((part) =>
			part.split(
				/(?<=[^\s,])\s+(?=(?:I|I['’]m|I['’]ve|I['’]d|I['’]ll)\b)|(?<=[^\s,])\s+(?=(?:we|we['’]re|we['’]ve|we['’]d)\b)/,
			),
		)
		.flatMap((part) => {
			// "What draws me to the role is the chance to …": the interest, then what it is about.
			const frame = part.match(
				/^((?:what|why)\b.*?\b(?:me|I)\b.*?)\s+(?:is|are|was)\s+(.+)$/i,
			);
			return frame?.[1] && frame[2] ? [frame[1], frame[2]] : [part];
		})
		.filter((part) => /[\p{L}\d]/u.test(part));
}

/** "That is why" opening a sentence that continues one about the candidate: no fact by itself. */
const FRAME_ONLY =
	/^(?:that|this|it)(?:['’]s|\s+is|\s+was)\s+(?:why|the reason(?:\s+why)?)$/i;

/**
 * The candidate in a sentence without "I": named in the third person, the hire the company would
 * gain or that the role suits, a name only their side has, or an implied subject.
 */
function aboutCandidate(
	raw: string,
	text: string,
	context: DocumentContext,
	postingText: string,
	side: CandidateSide,
): boolean {
	if (CANDIDATE_REFERENCE.test(text) || hire(text) || namesCandidate(raw, side))
		return true;
	// Read with the company's name in place: "Tessera runs its ERP" has a subject.
	if (impliedSubjects(withoutAsides(raw))) return true;
	if (DURATION.test(text)) return true;
	// Names and nothing else is a list of the candidate's skills: "React and TypeScript, mostly."
	// A capitalized first word counts here: "React" opens the list.
	const named = namedTerms(raw, context);
	const capitalized = factTokens(
		(text.match(/[\p{Lu}\d][\p{L}\p{M}\d+#.'-]*/gu) ?? []).join(" "),
	);
	if (
		named.size > 0 &&
		[...factTokens(text)].every(
			(t) =>
				named.has(t) ||
				capitalized.has(t) ||
				LIST_WORDS.test(t) ||
				scopeTokens(t).size > 0,
		)
	)
		return true;
	const company = nameKey(context.companyName);
	if (
		side.employers.some(
			(e) => nameKey(e.record.company) !== company && mentions(raw, e.names),
		)
	)
		return true;
	const posting = factTokens(postingText);
	return [...named].some(
		(t) => !/\d/.test(t) && side.words.has(t) && !posting.has(t),
	);
}

/** The sentence before is about the candidate: first person, or the candidate named otherwise. */
function mentionsCandidate(
	text: string,
	context: DocumentContext,
	side: CandidateSide,
): boolean {
	const masked = maskNames(text, context);
	return (
		FIRST_PERSON.test(masked) ||
		CANDIDATE_REFERENCE.test(masked) ||
		hire(masked) ||
		namesCandidate(text, side)
	);
}

/**
 * Every part of a sentence between punctuation (",", ";", ":", a dash, parentheses): where an
 * implied subject can start. "The role is exciting; led the migration at Acme." has one.
 */
function pieces(text: string): string[] {
	return text
		.split(/[;:,()]|\s[-–—]\s|[–—]/)
		.map((p) => p.trim())
		.filter((p) => /[\p{L}\d]/u.test(p));
}

/**
 * Any part of the sentence with the candidate as its unstated subject, between punctuation or
 * after "and", "or", "but", "then" when the predicate before it cannot be the actor: "The role
 * is exciting and previously led the migration at Acme." A part before the clause it opens may be
 * a participle describing the company: "Founded in 2010, …".
 */
function impliedSubjects(text: string): boolean {
	const parts = pieces(text);
	return parts.some((piece, index) => {
		if (impliedSubject(piece, index < parts.length - 1)) return true;
		const roleSubject = ROLE_SUBJECT.test(piece);
		return piece
			.split(/\s+(?:and|or|but|then)\s+/i)
			.slice(1)
			.some(
				(next) =>
					(roleSubject || TIME_ADVERB.test(next)) &&
					impliedSubject(next, false),
			);
	});
}

/** A subject that cannot act: "The role is exciting and led …" leaves the actor unstated. */
const ROLE_SUBJECT =
	/^(?:the|this|your)\s+(?:[\p{L}-]+\s+){0,4}?(?:role|position|job|posting|opportunity|vacancy|opening)\b/iu;

/** A time adverb opening a coordinated predicate: "and previously led …". */
const TIME_ADVERB =
	/^(?:previously|recently|formerly|most recently|before that|since then|earlier|already|currently)\b/i;

/**
 * A part with the candidate as its unstated subject: an action verb first, after any opening
 * adverb ("Previously led the migration", "also built …", "Leading the migration at Acme"), or a
 * statement of availability ("Available immediately."). A participle before a preposition
 * describes a product or a company, not the candidate: "Founded in 2010", "Built for creators",
 * "Led by its founder". A gerund with a verb of its own is a subject: "Defining a stack … is the
 * reason".
 */
function impliedSubject(piece: string, opener: boolean): boolean {
	const rest = piece.replace(OPENING_ADVERBS, "").trim();
	if (AVAILABILITY.test(rest)) return true;
	const [first = "", second = ""] = rest.toLowerCase().split(/\s+/);
	const word = first.replace(/[^\p{L}'-]/gu, "");
	const next = second.replace(/[^\p{L}\d'-]/gu, "");
	if (word === "having" || LIST_START.test(word)) return true;
	// Before a relative clause: "Led a team that was …" is still the candidate's.
	const main =
		rest.split(/\b(?:that|which|who|whom|whose|where|when)\b/i)[0] ?? rest;
	const form = ACTION_FORMS.get(word);
	if (form === "past" || (!form && /^\p{L}{3,}ed$/u.test(word))) {
		// "Excited about the role" is interest; "Distributed systems are …" has its own verb.
		if (INTEREST_ADJECTIVE.test(word) || FINITE.test(main)) return false;
		// "Founded in 2010, …", "Led by its founder, …": a participle opening the company's clause.
		const passive =
			next === "by" ||
			(PREPOSITION.test(next) && PASSIVE_PARTICIPLE.test(word));
		return !(opener && passive);
	}
	if (!form) return false;
	if (form === "gerund") return !FINITE.test(main);
	// A base or "-s" form: "Lead the migration", "Leads the platform team".
	return OBJECT_START.test(next);
}

/** Adverbs and conjunctions a part may open with before its verb. */
const OPENING_ADVERBS =
	/^(?:(?:and|but|or|so|then|also|previously|recently|currently|formerly|most recently|before that|since then|now|later|earlier|already|personally|successfully|together|both|first|then)\b[\s,]*)+/i;

/** A part opening on how much of the candidate's time: "Mostly backend work in Go." */
const LIST_START =
	/^(?:mostly|mainly|primarily|largely|predominantly|chiefly|exclusively)$/;

/** Availability, notice and start date: always the candidate's. */
const AVAILABILITY =
	/^(?:available|availability|immediately available)\b|\bavailab(?:le|ility) (?:immediately|right away|from|to (?:start|join|interview)|on|now|asap|for (?:an )?interviews?)\b|\bnotice period\b|\bstart date\b|\bcan (?:start|join)\b|\b(?:start|join)(?:ing)? (?:immediately|right away|asap|straight away)\b/i;

/** Participles that describe a company or product when they open its clause: "Founded in …". */
const PASSIVE_PARTICIPLE =
	/^(?:founded|built|designed|created|developed|led|backed|owned|run|launched|made|used|trusted|loved|powered|funded|acquired|established|known|ranked|valued|located|based|headquartered|rebuilt|shipped|praised|watched|followed|seen|viewed|engineered|crafted|aimed|geared|focused|centred|centered|rooted|grounded|driven|started|born|named|listed|recognised|recognized|supported|used|adopted|operated|managed|hosted|deployed)$/;

/** "-ed" words that state interest, not a deed: "Excited about the role." */
const INTEREST_ADJECTIVE =
	/^(?:excited|interested|drawn|thrilled|delighted|pleased|inspired|impressed|honou?red|attracted|intrigued|fascinated)$/;

/** Words after a past participle that make it passive: "Founded in 2010", "Led by its founder". */
const PREPOSITION =
	/^(?:in|on|at|by|for|from|to|into|onto|with|as|around|across|over|under|through|since|during|of|out|up|and|or)$/;

/** Words that open the object of an active verb: "led the migration", "built 3 apps". */
const OBJECT_START =
	/^(?:the|a|an|my|our|their|its|this|that|these|those|every|each|all|both|several|many|multiple|two|three|four|five|six|seven|eight|nine|ten|\d[\d.,%+]*|\p{Lu}.*|[\p{L}-]+s|teams?|engineers?|people|projects?|products?|services?|apps?|systems?|features?)$/u;

/** A finite verb: what makes a gerund opening a subject rather than an action. */
const FINITE =
	/\b(?:is|are|was|were|has|have|had|will|would|can|could|should|makes?|made|means?|remains?|seems?|sounds?|looks?|feels?|matters?|gives?|takes?|requires?|keeps?|draws?|excites?|appeals?)\b/i;

/** Action verbs, by form: what a candidate's implied subject does. */
const ACTION_VERBS =
	`lead build ship design develop create found own manage mentor work deliver launch
migrate implement scale reduce cut increase improve grow automate architect write maintain achieve
complete drive spearhead refactor rewrite rebuild optimize optimise teach train hire run sell win
earn graduate study speak live use hold collaborate contribute support test review coach onboard
introduce establish help handle oversee coordinate deploy integrate own partner present publish
research ship serve set`.split(/\s+/);

const IRREGULAR_PAST: Readonly<Record<string, string>> = {
	lead: "led",
	build: "built",
	write: "wrote",
	drive: "drove",
	teach: "taught",
	run: "ran",
	sell: "sold",
	win: "won",
	speak: "spoke",
	hold: "held",
	grow: "grew",
	rewrite: "rewrote",
	rebuild: "rebuilt",
	oversee: "oversaw",
	cut: "cut",
	set: "set",
};

/** Each form of every action verb, to its kind: base or "-s", past, gerund. */
const ACTION_FORMS = new Map<string, "base" | "past" | "gerund">(
	ACTION_VERBS.flatMap((verb) => {
		const stem = verb.replace(/e$/, "");
		const doubled = /^(?:ship|cut|run|win|set|plan|scan)$/.test(verb)
			? verb + verb.slice(-1)
			: stem;
		const third = /(?:s|sh|ch|x|z)$/.test(verb)
			? `${verb}es`
			: /[^aeiou]y$/.test(verb)
				? `${verb.slice(0, -1)}ies`
				: `${verb}s`;
		const past =
			IRREGULAR_PAST[verb] ??
			(/[^aeiou]y$/.test(verb)
				? `${verb.slice(0, -1)}ied`
				: verb.endsWith("e")
					? `${verb}d`
					: `${doubled}ed`);
		const gerund = verb.endsWith("ie")
			? `${verb.slice(0, -2)}ying`
			: verb.endsWith("e") && !verb.endsWith("ee")
				? `${stem}ing`
				: `${doubled}ing`;
		return [
			[verb, "base"],
			[third, "base"],
			[past, "past"],
			[gerund, "gerund"],
		] as [string, "base" | "past" | "gerund"][];
	}),
);

/**
 * The hire as the company's gain or the role's match: "Talabat gains an engineer with …", "would
 * benefit from deep knowledge of …", "the team gets a migration delivered", "suits someone who …",
 * "fits a background in Rust", "someone who did it daily". A role's requirement ("The role asks
 * engineers to bring Kafka experience") describes the role, not the candidate.
 */
function hire(text: string): boolean {
	const plain = text.replace(PRODUCT_PHRASE, " ").replace(COLLEAGUES, " ");
	return (
		GAINING.test(plain) ||
		(RECEIVING.test(plain) &&
			(APPLICANT.test(plain) || ACCOMPLISHMENT.test(plain))) ||
		(SUITING.test(plain) && (APPLICANT.test(plain) || PERSON.test(plain))) ||
		PERSON_WITH_PAST.test(plain)
	);
}

/** The company gaining from someone: what only a hire brings. */
const GAINING =
	/\b(?:gains?|gained|gaining|stands? to gain|would gain|benefit(?:s|ed|ted|ing|ting)?\s+from|would benefit)\b/i;

const RECEIVING =
	/\b(?:gets?|getting|got|adds?|added|adding|welcomes?|welcomed|joins?|joined|joining)\b/i;

const SUITING =
	/\b(?:suits?|suited|fits?|fitted|matches|matched|is made for|was made for)\b/i;

const PERSON =
	/\b(?:someone|somebody|anyone|person|individual|engineer|developer|professional|specialist|expert)s?\b/i;

/** A person with a past: "someone who owned every migration", "an engineer who has shipped". */
const PERSON_WITH_PAST =
	/\b(?:someone|somebody|anyone|person|individual|engineer|developer|professional|specialist|expert)s?\s+(?:who|that)\s+(?:(?:has|have|had)\s+)?(?:\w+ed|did|made|built|led|ran|wrote|took|grew|held|knew|was|taught|won|sold|drove|spent)\b/i;

/** Words a list of skills may add to its names: how much, and where. */
const LIST_WORDS =
	/^(?:mostly|mainly|primarily|largely|predominantly|chiefly|exclusively|extensively|heavily|daily|weekly|regularly|usually|frequently|often|always|plus|etc|production|professionally)$/;

/** Time spent at something, the commonest unstated claim: "Five years of Go make …". */
const DURATION =
	/\b(?:\d+(?:[.,]\d+)?\+?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|several|many|a few)\s+(?:years?|months?)\b(?!\s+(?:ago|old)\b)/i;

/**
 * Every word a letter's closing line may use to ask the reader for a talk: no name, number, fact
 * word or scope can pass. "I would be glad to talk through how I could contribute to your team"
 * asks for a conversation; "I'd love to talk about my 8 years leading teams" states a fact.
 */
const CALL_TO_ACTION = new Set(
	`please let me know you your a an the convenient good suitable time times to talk talking
	discuss discussing speak speaking chat chatting call conversation conversations meet meeting
	hear hearing from about through over how what i i'd i'm i'll we us would could can might may
	be glad happy keen love like welcome role position team opportunity this that it further more
	in detail details whenever soon next steps if and or with at earliest convenience contribute
	help fit thank thanks look looking forward for consideration application`.split(
		/\s+/,
	),
);

/** What makes a line a call to action: it asks to talk, meet or hear back. */
const CALL_TO_ACTION_ANCHOR =
	/\b(?:let me know|talk|talking|discuss|discussing|speak|speaking|chat|chatting|call|conversations?|meet|meeting|hear(?:ing)? from you)\b/i;

function callToAction(text: string, context: DocumentContext): boolean {
	const masked = maskNames(text, context);
	return (
		CALL_TO_ACTION_ANCHOR.test(masked) &&
		!/\d/.test(masked) &&
		!CANDIDATE_REFERENCE.test(masked) &&
		namedTerms(text, context).size === 0 &&
		!FACT_MARKERS.test(masked) &&
		!ACCOMPLISHMENT.test(masked) &&
		scopeTokens(masked).size === 0 &&
		normalizeForMatch(masked)
			.split(/[^\p{L}']+/u)
			.filter(Boolean)
			.every((w) => CALL_TO_ACTION.has(w))
	);
}

/**
 * Courtesy lines a letter may end on, compared whole (normalized): "Thank you for considering my
 * Rust expertise." is not on the list and needs evidence.
 */
const COURTESY = new Set(
	[
		"Thank you for your time.",
		"Thank you for your consideration.",
		"Thank you for considering my application.",
		"Thank you for reading.",
		"Thanks for your time.",
		"Thanks for reading.",
	].map(normalizeForMatch),
);

/** "That experience" points back at a sentence that is checked on its own. */
const BACK_REFERENCE =
	/\b(?:that|this|the same) (?:experience|background|work)\b/gi;

/** A sentence continuing the one before it: "That makes data modeling central to the work". */
const BACK_SUBJECT = /^(?:that|this|it|these|those)\b/i;

/**
 * The sentence before a letter or answer sentence in its paragraph (from its context), or
 * undefined when it opens the paragraph.
 */
function previousSentence(segment: Segment): string | undefined {
	if (segment.document === "cv") return undefined;
	const paragraph =
		segment.document === "form_answers"
			? segment.context.slice(segment.context.indexOf(" › ") + 3)
			: segment.context;
	const all = sentences(paragraph);
	let seen = 0;
	for (const [index, sentence] of all.entries())
		if (sentence === segment.text && seen++ === segment.occurrence)
			return all[index - 1];
	return undefined;
}

/**
 * What a skippable first-person clause must express: applying, wanting, hoping, looking forward,
 * or being drawn to or excited by the company or the role.
 */
const INTEREST =
	/\b(?:applying|apply (?:for|to)|(?:decided|chose|choose|want|wanted|hope|hoping) to apply|wants?|wanted|would (?:(?:most|really|also) )?(?:like|love|welcome|enjoy|be (?:glad|happy|excited|thrilled|keen))|i['’]d (?:(?:most|really|also) )?(?:like|love|welcome|enjoy)|look(?:ing)? forward|excited|exciting|excites me|eager|keen|interested|drawn to|draws me|appeals? to me|attracts? me|compelling|hope|hoping)\b/i;

/**
 * What makes a sentence describe the candidate even when it also expresses interest: their own
 * things ("my expertise"), what they bring or offer, what they know, or a trait or competence.
 */
const SELF_DESCRIPTION =
	/\b(?:my|mine|our|ours|bring|brings|bringing|offer|offers|contribute|contributes|know|knows|knew|excel\w*|thrive\w*|good at|great at|strong|adept|capable|talented|reliable|confident|comfortable|known for|speciali[sz]\w*|master\w*|oriented|minded|driven|passionate|dedicated|motivated|fast learner|quick learner|calm|organi[sz]ed|team player)\b|\bI(?:['’]m| am)\b(?!\s+(?:applying|excited|eager|keen|interested|hoping|looking forward|drawn)\b)/i;

/** Any first person, plural included: "we cut latency" can be the candidate's team. */
const FIRST_PERSON =
	/\b(?:i|i['’]m|i['’]ve|i['’]d|i['’]ll|me|my|mine|myself|we|we['’]re|we['’]ve|we['’]d|our|ours|us)\b/i;

/** A question put to the reader: "Are you available for a call?" */
const READER_QUESTION =
	/^(?:are|would|could|can|will|may|shall|do|does)\b[^?]*\?$/i;

/**
 * Every word a skippable question may use: asking for a call or a conversation, and nothing
 * else. "Would you discuss the procurement migration delivered by the applicant?" asks nothing a
 * scheduler would; it states an accomplishment.
 */
const SCHEDULING = new Set(
	`are would could can will may shall do does you your we us i be open available free happy glad
	willing to for a an the short brief quick call chat conversation meeting interview talk discuss
	schedule arrange set up have some time next this coming week days soon sometime about role
	position team it in at more like love want hear meet speak connect`.split(
		/\s+/,
	),
);

function schedulingQuestion(text: string, context: DocumentContext): boolean {
	const masked = maskNames(text, context);
	return (
		READER_QUESTION.test(text) &&
		!/\d/.test(masked) &&
		normalizeForMatch(masked)
			.split(/[^\p{L}'-]+/u)
			.filter(Boolean)
			.every((w) => SCHEDULING.has(w))
	);
}

/**
 * The candidate in the third person: "The author would love to join". A sentence naming them is
 * about them and needs a claim with evidence.
 */
const CANDIDATE_REFERENCE =
	/\b(?:author|authors|writer|undersigned|candidate|candidates|applicant|applicants|jobseekers?|job seekers?|interviewees?|the hire|new hire|this hire|this engineer|this developer|the engineer joining|the developer joining|whoever joins|yours truly|writing this|he|she|him|her|his|hers|himself|herself)\b/i;

/**
 * Words that put the applicant into a sentence: a person who would join ("an engineer",
 * "someone"), what they bring ("experience", "knowledge").
 */
const APPLICANT =
	/\b(?:engineers?|developers?|candidates?|applicants?|someone|somebody|anyone|person|individuals?|hires?|hired|hiring|recruits?|professionals?|specialists?|experts?|talent|colleagues?|teammates?|members?|contributors?|newcomers?|experiences?|experienced|expertise|knowledge|know-how|skills?|skilled|proficien\w*|competen\w*|background|track record|qualifications?|qualified|abilit\w*|capabilit\w*)\b/i;

/** The hire's colleagues, not the hire: "mentoring other developers" is a duty of the role. */
const COLLEAGUES =
	/\bother (?:engineers|developers|colleagues|teammates|team members|people)\b/gi;

const ACCOMPLISHMENT =
	/\b(?:delivered|delivering|shipped|launched|migrated|implemented|led|managed|owned|scaled|reduced|cut|increased|improved|grew|automated|architected|wrote|written|maintained|achieved|completed|drove|driven|spearheaded|mentored|founded|refactored|rewrote|rebuilt|optimi[sz]ed)\b|\bby (?:the|an?|this|that|me|him|her|them)\b/i;

/** "built on one shared set of data" describes a product, not who built it. */
const PRODUCT_PHRASE =
	/\b(?:built|designed|developed|created|made)\s+(?:on|for|around|to|with|into|in|as|from)\b/gi;
