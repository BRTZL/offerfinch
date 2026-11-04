import type { NormalizedJob } from "../domain/types";
import { EEA_EXTRA, EU_MEMBERS } from "./countries";
import { countryNames, type WorkContext, workContext } from "./home";
import {
	countriesIn,
	countriesInLocation,
	GLOBAL_REMOTE_DESCRIPTION,
	GLOBAL_REMOTE_LOCATION,
	isHomeCountry,
	LEGAL_AREAS_WITHOUT_TURKEY,
	mentionsAny,
	REGIONS_MAYBE_TURKEY,
	REGIONS_WITHOUT_TURKEY,
	withoutTimeZones,
} from "./places";
import type { FilterSettings } from "./settings";

export type FilterRule =
	| "location"
	| "work_permit"
	| "citizenship"
	| "language"
	| "role";
type RuleOutcome = "pass" | "reject";

interface FilterReason {
	rule: FilterRule;
	outcome: RuleOutcome;
	message: string;
	/** The posting text the decision rests on, quoted. */
	evidence?: string;
}

/**
 * How the job's place fits the user, for ranking and the scorer: in a country they may work in,
 * remote from their country, remote worldwide, abroad with relocation or visa support, kept with
 * no place given (`unclear`: ranked lower), or rejected.
 */
export type LocationVerdict =
	| "home"
	| "remote_home"
	| "remote_global"
	| "relocation"
	| "unclear"
	| "rejected";

export interface FilterResult {
	/**
	 * Keep or reject, nothing in between. A rejected job is hidden; a kept job with no place given
	 * (`locationVerdict: "unclear"`) is scored, flagged and ranked lower.
	 */
	decision: "keep" | "reject";
	/** Absent on results stored before it existed. */
	locationVerdict?: LocationVerdict;
	/**
	 * Citizenships or clearances the posting prefers (not requires) that the user lacks: never a
	 * reject, a lower rank.
	 */
	preferred?: PreferredRequirement[];
	/**
	 * Set when a re-filter set the job aside: the revision of the settings it used. A pass with
	 * newer settings looks at it again and brings it back when they keep it.
	 */
	refilteredWith?: string;
	/** One-line reason for the decision. */
	summary: string;
	reasons: FilterReason[];
	flags: string[];
}

export type FilterInput = Pick<
	NormalizedJob,
	"title" | "locations" | "workplaceType" | "descriptionText"
>;

const LANGUAGES = [
	"Spanish",
	"German",
	"French",
	"Dutch",
	"Italian",
	"Portuguese",
	"Polish",
	"Swedish",
	"Danish",
	"Norwegian",
	"Finnish",
	"Czech",
	"Slovak",
	"Hungarian",
	"Romanian",
	"Greek",
	"Russian",
	"Ukrainian",
	"Hebrew",
	"Arabic",
	"Japanese",
	"Korean",
	"Mandarin",
	"Chinese",
	"Cantonese",
	"Hindi",
	"Vietnamese",
	"Thai",
	"Indonesian",
	"Catalan",
	"Estonian",
	"Lithuanian",
	"Bulgarian",
	"Serbian",
	"Croatian",
	"English",
	"Turkish",
];

const OPTIONAL_LANGUAGE =
	/\b(plus|nice[- ]to[- ]have|bonus|advantage|advantageous|preferred|desirable|desired|beneficial|is a benefit|helpful|appreciated|ideally|optional)\b/i;
const FLUENCY_BEFORE =
	/\b(fluent|fluency|native|mother tongue|proficien\w*|business[- ]level|professional[- ](?:level|working)|excellent (?:command|knowledge)|full professional|strong (?:written and (?:spoken|verbal)|verbal and written|command)|C1|C2)\b/i;
const REQUIRED_WORD = /\b(required|a must|mandatory|essential|needed)\b/i;
const FILLER = new Set([
	"and",
	"or",
	"language",
	"languages",
	"skill",
	"skills",
	"proficiency",
	"fluency",
	"knowledge",
	"written",
	"spoken",
	"verbal",
	"both",
	"is",
	"are",
	"a",
	"an",
	"at",
	"level",
	"b2",
	"c1",
	"c2",
	"also",
	"strictly",
	"absolutely",
]);

/** "Spanish is required", "German and English skills are mandatory"; not "Spanish market experience is required". */
function requiredAfter(after: string): boolean {
	const match = after.match(REQUIRED_WORD);
	if (!match || match.index === undefined || match.index > 60) return false;
	const words =
		after
			.slice(0, match.index)
			.toLowerCase()
			.match(/[\p{L}\d]+/gu) ?? [];
	const languages = new Set(LANGUAGES.map((l) => l.toLowerCase()));
	return words.every((w) => FILLER.has(w) || languages.has(w));
}

/** Splits a posting into sentences and list items so rules work on one claim at a time. */
function sentences(text: string): string[] {
	return text
		.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function quote(text: string, max = 200): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/* ---------------------------------------------------------------- language */

/**
 * Splits a sentence into clauses so an optional marker covers only its own clause:
 * "Fluent Spanish is required; German is a nice to have." is two clauses. Commas split only
 * before a new "<Language> is/are" clause, so "Spanish, German or French is a plus" stays whole.
 */
function clauses(sentence: string): string[] {
	const languages = LANGUAGES.join("|");
	return sentence
		.split(
			new RegExp(
				`;|\\s[–—-]\\s|\\b(?:but|while|whereas|although)\\b|,\\s*(?=(?:and\\s+)?(?:(?:some|basic|good|working)\\s+)?(?:knowledge of\\s+|fluency in\\s+)?(?:${languages})\\s+(?:(?:language\\s+)?skills\\s+|language\\s+)?(?:is|are|would be|will be)\\b)`,
				"i",
			),
		)
		.map((c) => c.trim())
		.filter(Boolean);
}

export function languageRequirements(
	text: string,
): { language: string; evidence: string }[] {
	const found: { language: string; evidence: string }[] = [];
	for (const sentence of sentences(text).flatMap((s) =>
		clauses(s).map((clause) => ({ sentence: s, clause })),
	)) {
		if (OPTIONAL_LANGUAGE.test(sentence.clause)) continue;
		for (const language of LANGUAGES) {
			const match = sentence.clause.match(new RegExp(`\\b${language}\\b`));
			if (!match || match.index === undefined) continue;
			const clause = sentence.clause;
			const before = clause.slice(Math.max(0, match.index - 60), match.index);
			const after = clause.slice(match.index + language.length);
			const fluencyBefore = FLUENCY_BEFORE.test(before);
			const fluencyAfter =
				/^\s*(?:\(|:|-|–)?\s*(native|fluent|C1|C2|business|professional)\b/i.test(
					after,
				);
			const required = requiredAfter(after);
			if (fluencyBefore || fluencyAfter || required) {
				if (!found.some((f) => f.language === language))
					found.push({ language, evidence: quote(sentence.sentence) });
			}
		}
	}
	return found;
}

const STOPWORDS: Record<string, string[]> = {
	German: [
		"und",
		"der",
		"die",
		"das",
		"wir",
		"mit",
		"für",
		"sie",
		"ist",
		"nicht",
		"eine",
	],
	Spanish: [
		"que",
		"los",
		"las",
		"del",
		"para",
		"con",
		"una",
		"por",
		"somos",
		"nuestro",
		"buscamos",
	],
	French: [
		"les",
		"des",
		"une",
		"pour",
		"avec",
		"nous",
		"est",
		"vous",
		"dans",
		"sur",
		"votre",
	],
	Italian: [
		"che",
		"per",
		"con",
		"una",
		"della",
		"sono",
		"nostro",
		"siamo",
		"cerchiamo",
		"delle",
	],
	Dutch: [
		"het",
		"een",
		"van",
		"voor",
		"met",
		"wij",
		"zijn",
		"jouw",
		"naar",
		"ons",
	],
	Portuguese: [
		"que",
		"para",
		"com",
		"uma",
		"dos",
		"das",
		"você",
		"nosso",
		"somos",
		"não",
	],
	English: [
		"the",
		"and",
		"you",
		"with",
		"for",
		"our",
		"are",
		"will",
		"your",
		"this",
		"we",
	],
	Turkish: [
		"ve",
		"bir",
		"için",
		"ile",
		"olarak",
		"bu",
		"olan",
		"deneyim",
		"çalışma",
		"biz",
	],
};

/** Detects the language a posting is written in, by stopword counts. */
function postingLanguage(text: string): string {
	const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
	if (words.length < 40) return "English";
	const counts = Object.fromEntries(
		Object.keys(STOPWORDS).map((lang) => [lang, 0]),
	) as Record<string, number>;
	const sets = Object.entries(STOPWORDS).map(
		([lang, list]) => [lang, new Set(list)] as const,
	);
	for (const word of words) {
		for (const [lang, set] of sets)
			if (set.has(word)) counts[lang] = (counts[lang] ?? 0) + 1;
	}
	const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	const [top, second] = ranked;
	if (!top || top[1] < 8) return "English";
	// Require a clear lead so mixed-language postings fall back to English.
	return second && top[1] < second[1] * 1.5 ? "English" : top[0];
}

function languageRule(
	job: FilterInput,
	settings: FilterSettings,
): FilterReason {
	const allowed = settings.languages.map((l) => l.toLowerCase());
	const written = postingLanguage(job.descriptionText);
	if (!allowed.includes(written.toLowerCase())) {
		return {
			rule: "language",
			outcome: "reject",
			message: `Posting is written in ${written}; roles needing ${written} are outside ${settings.languages.join(" and ")}.`,
			evidence: quote(job.descriptionText.slice(0, 160)),
		};
	}
	const required = languageRequirements(
		`${job.title}\n${job.descriptionText}`,
	).filter((r) => !allowed.includes(r.language.toLowerCase()));
	if (required.length > 0) {
		return {
			rule: "language",
			outcome: "reject",
			message: `Requires ${required.map((r) => r.language).join(" and ")}; works in ${settings.languages.join(" and ")} only.`,
			evidence: required[0]?.evidence,
		};
	}
	return {
		rule: "language",
		outcome: "pass",
		message: "No language requirement outside the user's languages.",
	};
}

/* ------------------------------------------------------------- work permit */

const RESIDENCY =
	/\b(?:must|need to|needs to|required to|should|have to|has to)\s+(?:currently\s+)?(?:be\s+)?(?:reside|residing|resident|based|located|live|living)\s+(?:with)?in\s+(?:the\s+|one of the following[^:]*:\s*)?([^.;\n]{2,80})/i;
const AUTHORIZATION =
	/\b(?:valid work permit|work permit|right to work|work authori[sz]ation|authori[sz]ed to work|eligible to work|eligibility to work|legally (?:able|authori[sz]ed|eligible|permitted) to work|permission to work)\b([^.;\n]{0,100})/i;
const NO_SPONSORSHIP =
	/\b(?:(?:not|unable to|cannot|can't|can ?not|do not|don't|does not|doesn't|won't|will not|not able to|not in a position to)\s+(?:currently\s+)?(?:be able to\s+)?(?:offer|provide|sponsor|support)[^.\n]{0,40}\b(?:visas?|sponsorship|work permits?)|(?:not|unable to|cannot|can't|can ?not|do not|don't|does not|doesn't|won't|will not|not able to|not in a position to)\s+(?:currently\s+)?(?:be able to\s+)?sponsor\b|(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:not\s+(?:available|offered|provided|possible)|unavailable)|not eligible for (?:visa\s+)?sponsorship|(?:not|never|without)\s+(?:now or in the future\s+)?(?:requir|need)\w*\s+(?:\w+\s+){0,3}sponsorship|without (?:the need for |requiring |needing )?(?:(?:visa|employer|company)\s+)?sponsorship|no (?:visa )?sponsorship)\b/i;

/** "You do not need work authorization in Germany", "Residence in the US is not required". */
const NEGATED_REQUIREMENT =
	/\b(?:(?:do|does|will|would)\s+not|don't|doesn't|won't|no)\s+(?:need|require|have to)\b|\b(?:is|are)?\s*not\s+(?:required|necessary|needed|a requirement)\b|\bisn't\s+(?:required|necessary|needed)\b|\bno need\b|\bregardless of\b/i;
/** Wording that makes work authorization a requirement rather than a mention. */
const AFFIRMATIVE_REQUIREMENT =
	/\b(?:must|required|requires|requirement|mandatory|essential|need|needs|have to|has to|should|only (?:consider|accept|hire|open to))\b/i;

/* ------------------------------------------------- relocation and visa offer */

const RELOCATION_OFFER =
	/\b(?:relocation (?:package|support|assistance|bonus|allowance|stipend|budget|help|benefits?|costs?|expenses)|(?:help|support|assist)(?:s|ing)?\s+(?:you\s+)?(?:with\s+)?(?:your\s+)?relocat\w*|relocation (?:is |will be |can be )?(?:offered|provided|available|supported|covered|possible|paid)|(?:offer|provide|include)s?\s+(?:full\s+|generous\s+)?relocation|visa (?:support|assistance|sponsorship)|sponsorship (?:is |will be )?(?:available|offered|provided|possible)|(?:we|will|can|do|does|happy to|able to) sponsor\b|sponsor\w*\s+(?:\w+\s+){0,4}(?:visas?|work permits?|H-?1B|blue cards?)|(?:handle|take care of|cover)\s+(?:the\s+|your\s+)?(?:visa|work permit|relocation)|relocation\s+(?:to|into)\s+[^.;\n]{1,40}?\s+(?:is\s+|will\s+be\s+|can\s+be\s+)?(?:provided|offered|available|supported|covered|paid)|relocat\w*\s+(?:assistance|support|package|help|bonus)\s+(?:to|into)\b|we(?:'ll|\s+will|\s+can|\s+help)?\s+(?:help\s+(?:\w+\s+)?)?relocate\s+(?:you\b|(?:\w+\s+){0,4}?(?:to|into)\b)|help(?:s|ing)?\s+you\s+relocate)/i;
const NO_RELOCATION =
	/\b(?:no relocation|relocation\s+(?:to|into)\s+[^.;\n]{1,40}?\s+(?:is\s+|will\s+)?not\b|relocation (?:is |will )?not (?:be )?(?:offered|provided|available|supported|possible|covered)|(?:not|unable to|cannot|can't|do not|don't|does not|doesn't|won't|will not)\s+(?:be able to\s+)?(?:offer|provide|support|cover|assist with|help with|include)[^.\n]{0,30}\brelocation|without relocation)\b/i;

export interface RelocationOffer {
	/** The posting offers relocation or visa support, and refuses neither. */
	offered: boolean;
	/** The posting says it gives no sponsorship or relocation. */
	refused: boolean;
	evidence?: string;
}

/**
 * Whether the posting offers relocation or visa support ("relocation package", "we sponsor
 * visas", "visa sponsorship available"). A refusal anywhere ("unable to sponsor", "no
 * relocation") wins: someone who needs a visa cannot take a job that will not sponsor one.
 */
export function relocationOffer(text: string): RelocationOffer {
	let offer: string | undefined;
	let refusal: string | undefined;
	for (const sentence of sentences(text)) {
		if (NO_SPONSORSHIP.test(sentence) || NO_RELOCATION.test(sentence))
			refusal ??= sentence;
		else if (RELOCATION_OFFER.test(sentence)) offer ??= sentence;
	}
	if (refusal)
		return { offered: false, refused: true, evidence: quote(refusal) };
	if (offer) return { offered: true, refused: false, evidence: quote(offer) };
	return { offered: false, refused: false };
}

/** The move-to list allows one of these countries (an empty list allows any). */
function willMoveTo(ctx: WorkContext, countries: readonly string[]): boolean {
	return (
		ctx.relocationCountries.length === 0 ||
		countries.some((c) => isHomeCountry(c, ctx.relocationCountries))
	);
}

/* ------------------------------------------------------------------ places */

/** Countries clearly inside a region; a home country here makes the region decisive. */
const MIDDLE_EAST = [
	"Turkey",
	"Israel",
	"United Arab Emirates",
	"Saudi Arabia",
	"Egypt",
	"Jordan",
	"Lebanon",
	"Qatar",
	"Kuwait",
	"Bahrain",
	"Oman",
	"Iraq",
	"Cyprus",
];

const REGION_MEMBERS: Record<string, readonly string[]> = {
	namer: ["United States", "Canada"],
	"north america": ["United States", "Canada", "Mexico"],
	"us & canada": ["United States", "Canada"],
	"us and canada": ["United States", "Canada"],
	dach: ["Germany", "Austria", "Switzerland"],
	nordics: ["Sweden", "Norway", "Denmark", "Finland", "Iceland"],
	benelux: ["Belgium", "Netherlands", "Luxembourg"],
	iberia: ["Spain", "Portugal"],
	anz: ["Australia", "New Zealand"],
	eu: EU_MEMBERS,
	"european union": EU_MEMBERS,
	eea: [...EU_MEMBERS, ...EEA_EXTRA],
	"european economic area": [...EU_MEMBERS, ...EEA_EXTRA],
	schengen: [...EU_MEMBERS, ...EEA_EXTRA, "Switzerland"],
	europe: [...EU_MEMBERS, ...EEA_EXTRA, "Switzerland", "United Kingdom"],
	emea: [...EU_MEMBERS, ...EEA_EXTRA, "Switzerland", "United Kingdom"],
	// Regions that hold Turkey: a remote role limited to them hires from Turkey. Unclear regions
	// reject, so these must be listed, not guessed. Time zones are never regions (`withoutTimeZones`).
	"middle east": MIDDLE_EAST,
	mena: [...MIDDLE_EAST, "Morocco", "Algeria", "Tunisia", "Libya"],
};

function regionIncludes(region: string, countries: readonly string[]): boolean {
	const members = REGION_MEMBERS[region.toLowerCase()];
	return Boolean(members?.some((m) => isHomeCountry(m, countries)));
}

function placesIn(
	text: string,
	read: (text: string) => string[] = countriesIn,
): {
	countries: string[];
	regionsWithout?: string;
	regionMaybe?: string;
	legalArea?: string;
} {
	return {
		countries: read(text),
		regionsWithout: mentionsAny(text, REGIONS_WITHOUT_TURKEY),
		regionMaybe: mentionsAny(
			text,
			REGIONS_MAYBE_TURKEY.filter(
				(r) => !LEGAL_AREAS_WITHOUT_TURKEY.includes(r),
			),
		),
		legalArea: mentionsAny(text, LEGAL_AREAS_WITHOUT_TURKEY),
	};
}

/** "europe" -> "Europe", "emea" -> "EMEA", "north america" -> "North America". */
function displayPlace(place: string): string {
	if (place !== place.toLowerCase()) return place;
	if (place.length <= 4 && !place.includes(" ")) return place.toUpperCase();
	return place.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/**
 * Work-permit rule. Two kinds of requirement are told apart:
 * - residence ("must be based in X"): where the candidate lives. A place clearly elsewhere is a
 *   reject, unless relocation is on, the user would move there and the posting offers relocation
 *   or visa support. A geographic region that may not include the user's country (Europe, EMEA,
 *   CET for Turkey) is a reject too: only jobs that clearly hire from it are kept.
 * - work authorization ("authorized to work in X"): a legal right. A country or legal area the
 *   user lacks (US, EU, EEA) is a reject; so is a geographic region that may not include it.
 *   A mention that does not say it is required is no requirement.
 * The first decisive sentence wins; the others only matter when nothing is decisive.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep ordered location, citizenship, and work-right exceptions together so fallback verdicts retain precedence.
function permitRule(job: FilterInput, ctx: WorkContext): FilterReason {
	const home = ctx.rightToWork;
	let ambiguous: FilterReason | undefined;
	for (const sentence of sentences(job.descriptionText)) {
		const residency = sentence.match(RESIDENCY);
		const authorization = sentence.match(AUTHORIZATION);
		const target = residency?.[1] ?? authorization?.[1];
		if (!target) continue;
		// A requirement the posting waives is no requirement.
		if (NEGATED_REQUIREMENT.test(sentence)) continue;
		// "authorising employment in the region" refers back to the residency place in the same sentence.
		const places = placesIn(withoutTimeZones(target));
		const named = [
			...places.countries,
			places.regionsWithout,
			places.legalArea,
			places.regionMaybe,
		]
			.filter((value): value is string => Boolean(value))
			.map(displayPlace);
		if (named.length === 0) continue;
		const regions = [
			places.regionsWithout,
			places.legalArea,
			places.regionMaybe,
		].filter((r): r is string => Boolean(r));
		if (
			places.countries.some((c) => isHomeCountry(c, home)) ||
			regions.some((r) => regionIncludes(r, home))
		) {
			return {
				rule: "work_permit",
				outcome: "pass",
				message: `Work rights asked for ${named.join(", ")}, which includes ${ctx.label}.`,
				evidence: quote(sentence),
			};
		}
		const kind = residency ? "residence" : "work authorization";
		// RESIDENCY already needs "must/need to/should"; an authorization mention needs its own.
		if (!residency && !AFFIRMATIVE_REQUIREMENT.test(sentence)) {
			ambiguous ??= {
				rule: "work_permit",
				outcome: "pass",
				message: `Mentions work authorization in ${named.join(", ")} without saying it is required.`,
				evidence: quote(sentence),
			};
			continue;
		}
		const clearlyElsewhere =
			places.countries.length > 0 ||
			Boolean(places.regionsWithout) ||
			Boolean(places.legalArea);
		if (!clearlyElsewhere) {
			ambiguous ??= {
				rule: "work_permit",
				outcome: "reject",
				message: `Asks for ${kind} in ${named.join(", ")}, which may not include ${ctx.label}.`,
				evidence: quote(sentence),
			};
			continue;
		}
		if (residency && ctx.relocation && willMoveTo(ctx, places.countries)) {
			const offer = relocationOffer(job.descriptionText);
			if (offer.offered)
				return {
					rule: "work_permit",
					outcome: "pass",
					message: `Asks for residence in ${named.join(", ")}; the posting offers relocation or visa support.`,
					evidence: offer.evidence ?? quote(sentence),
				};
		}
		return {
			rule: "work_permit",
			outcome: "reject",
			message: `Requires ${kind} in ${named.join(", ")}; you can work in ${ctx.label} only, and a move there needs relocation or visa support the posting does not offer.`,
			evidence: quote(sentence),
		};
	}
	if (ambiguous) return ambiguous;
	const noSponsor = sentences(job.descriptionText).find((s) =>
		NO_SPONSORSHIP.test(s),
	);
	if (noSponsor) {
		return {
			rule: "work_permit",
			outcome: "pass",
			message: "Says no visa sponsorship; decided by job location.",
			evidence: quote(noSponsor),
		};
	}
	return {
		rule: "work_permit",
		outcome: "pass",
		message: "No work-permit or residency requirement found.",
	};
}

/* ------------------------------------------------- citizenship and clearance */

/** Demonyms and short forms a citizenship requirement names, to the filter's country names. */
const NATIONALITY: Record<string, string> = {
	us: "United States",
	usa: "United States",
	"united states": "United States",
	american: "United States",
	uk: "United Kingdom",
	british: "United Kingdom",
	"united kingdom": "United Kingdom",
	eu: "EU",
	european: "EU",
	"european union": "EU",
	eea: "EEA",
	canadian: "Canada",
	australian: "Australia",
	"new zealand": "New Zealand",
	german: "Germany",
	french: "France",
	dutch: "Netherlands",
	irish: "Ireland",
	israeli: "Israel",
	indian: "India",
	japanese: "Japan",
	korean: "South Korea",
	singaporean: "Singapore",
	swiss: "Switzerland",
	turkish: "Turkey",
	emirati: "United Arab Emirates",
	saudi: "Saudi Arabia",
	polish: "Poland",
	spanish: "Spain",
	italian: "Italy",
	swedish: "Sweden",
};

/** "U.S." -> "United States", "EU" -> "EU", "Canadian" -> "Canada"; null when it names none. */
function nationality(raw: string): string | null {
	const key = raw.replace(/\./g, "").replace(/\s+/g, " ").trim().toLowerCase();
	if (NATIONALITY[key]) return NATIONALITY[key] ?? null;
	const found = countriesIn(raw);
	return found[0] ?? null;
}

const NATION = String.raw`(U\.?\s?S\.?(?:A\.?)?|U\.?K\.?|E\.?U\.?|EEA|United States|United Kingdom|European Union|New Zealand|[A-Z][a-z]+)`;

/** Citizenship requirements, each with the group that names the nationality. */
const CITIZENSHIP_PATTERNS: RegExp[] = [
	// "Must be a US Citizen", "must hold British citizenship", "must have a valid EU passport"
	new RegExp(
		String.raw`\b(?:must|need to|needs to|required to|should|has to|have to|only)\s+(?:be|hold|have|possess|consider|accept|hire)\s+(?:a\s+|an\s+)?(?:current\s+|valid\s+|active\s+)?${NATION}\s+(?:citizens?(?:hip)?|nationals?|nationality|passport)`,
		"i",
	),
	// "US citizenship is required", "U.S. Citizenship required", "EU citizenship mandatory"
	new RegExp(
		String.raw`\b${NATION}\s+citizenship\s*:?\s+(?:is\s+)?(?:required|mandatory|needed|a must|necessary)`,
		"i",
	),
	// "U.S. citizenship preferred": recorded as a preference (never a reject).
	new RegExp(
		String.raw`\b${NATION}\s+citizenship\s*:?\s+(?:is\s+)?(?:preferred|a plus|desired|desirable|an advantage)`,
		"i",
	),
	// "requires U.S. citizenship"
	new RegExp(
		String.raw`\b(?:requires?|requiring)\s+(?:active\s+)?${NATION}\s+citizenship`,
		"i",
	),
	// "EU citizens only", "open to US citizens only"
	new RegExp(String.raw`\b${NATION}\s+citizens?\s+only\b`, "i"),
	// "only US citizens", "only open to EU citizens"
	new RegExp(
		String.raw`\bonly\s+(?:open\s+to\s+|available\s+to\s+)?${NATION}\s+citizens\b`,
		"i",
	),
	// "citizens of the United States"
	/\b(?:must|only|required)[^.;\n]{0,30}\bcitizens?\s+of\s+(?:the\s+)?(United States|United Kingdom|European Union|[A-Z][a-z]+)/i,
];

/** US export control: only US persons (citizens, green card holders, asylees) may work on it. */
const US_PERSON =
	/\b(?:U\.?\s?S\.?\s+persons?|ITAR|export[- ]controlled|EAR\s+(?:controlled|regulations))\b/i;
const GREEN_CARD =
	/\b(?:green card holders?|(?:lawful\s+)?permanent residents?\s+of\s+the\s+(?:U\.?S\.?|United States))\b/i;

/** Clearances, with the country whose citizens can hold them. */
const CLEARANCES: { pattern: RegExp; country: string | null; label: string }[] =
	[
		{
			pattern:
				/\b(?:TS\/SCI|Top Secret|(?:active\s+)?Secret\s+(?:security\s+)?clearance|DoD\s+(?:government\s+)?(?:security\s+)?clearance|DOD\s+clearance|Public Trust(?:\s+(?:clearance|position|background))?|full[- ]scope poly(?:graph)?)\b/,
			country: "United States",
			label: "a US security clearance",
		},
		{
			pattern:
				/\b(?:SC|DV|eDV|NPPV\d?)(?:\s*(?:\/|or|and)\s*(?:SC|DV|eDV))?\s+(?:level\s+)?(?:security\s+)?clear(?:ance|ed)\b|\b(?:SC|DV)[- ]cleared\b/,
			country: "United Kingdom",
			label: "a UK SC/DV clearance",
		},
		{
			pattern:
				/\b(?:NV1|NV2|Negative Vetting|Baseline)\s+(?:security\s+)?clearance\b|\bAGSVA\b/i,
			country: "Australia",
			label: "an Australian security clearance",
		},
		{
			pattern:
				/\b(?:security|government|federal|national security)\s+clearance\b|\bclearance\s+(?:is\s+)?(?:required|preferred|a plus|desired|desirable|an advantage)\b|\bclearance\s*:\s*(?=\w)|\b(?:active|current|obtain|maintain)\s+(?:a\s+)?clearance\b/i,
			country: null,
			label: "a security clearance",
		},
	];

/** The requirement is waived or made optional in the same clause. */
const WAIVED =
	/\b(?:not\s+(?:required|necessary|needed|a requirement|mandatory)|no\s+(?:security\s+)?clearance\s+(?:is\s+)?(?:required|needed|necessary)|(?:does|do|will)\s+not\s+(?:need|require)|doesn't\s+require|don't\s+need|regardless\s+of\s+(?:citizenship|nationality)|irrespective\s+of\s+(?:citizenship|nationality))\b/i;
const OPTIONAL =
	/\b(?:preferred|a plus|is a bonus|nice[- ]to[- ]have|desirable|desired|advantage(?:ous)?|ideally|beneficial|helpful)\b/i;

/** The clause around a match: from the last sentence end before it to the next one after. */
/** Where the clause around a match starts and ends in the text (see `clauseAround`). */
function clauseBounds(
	text: string,
	index: number,
	length: number,
): [number, number] {
	// A clause ends at ; ! ? a line break, or a period after a lowercase letter, a digit or a
	// bracket. "U.S." (a period after a capital) is not an end, so "Must be a U.S. citizen" stays
	// one clause. Searched in the whole text, so the character before a period is always seen.
	const END = /[;!?\n]|(?<=[a-z0-9)\]])\.(?=\s|$)/g;
	const from = Math.max(0, index - 160);
	let start = from;
	for (const m of text.slice(0, index).matchAll(END))
		if ((m.index ?? 0) >= from) start = (m.index ?? 0) + m[0].length;
	const after = new RegExp(END.source, "g");
	after.lastIndex = index + length;
	const next = after.exec(text);
	const end =
		next && next.index < index + length + 160
			? next.index
			: Math.min(text.length, index + length + 160);
	return [start, end];
}

function clauseAround(text: string, index: number, length: number): string {
	const [start, end] = clauseBounds(text, index, length);
	return text.slice(start, end).trim();
}

/**
 * The part of the clause a modifier can belong to: up to the commas and contrast words around
 * the match. "U.S. citizenship is required, clearance preferred": "preferred" is the
 * clearance's, not the citizenship's.
 */
function segmentAround(text: string, index: number, length: number): string {
	const [start, end] = clauseBounds(text, index, length);
	const BOUNDARY = /,|\b(?:and|but|while|whereas|however)\b/gi;
	let from = start;
	for (const m of text.slice(start, index).matchAll(BOUNDARY))
		from = start + (m.index ?? 0) + m[0].length;
	const tail = text.slice(index + length, end);
	const stop = tail.search(new RegExp(BOUNDARY.source, "i"));
	return text.slice(from, stop >= 0 ? index + length + stop : end).trim();
}

interface CitizenshipNeed {
	/** A country, or "EU"/"EEA". */
	country: string;
	what: string;
	evidence: string;
	/** Green card holders also qualify ("US citizen or green card holder"). */
	residentsQualify: boolean;
}

/** A requirement the posting only prefers ("clearance preferred", "U.S. citizenship a plus"). */
interface PreferredRequirement {
	country: string;
	what: string;
	evidence: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep ordered location, citizenship, and work-right exceptions together so fallback verdicts retain precedence.
function citizenshipNeeds(job: FilterInput): {
	needs: CitizenshipNeed[];
	preferred: PreferredRequirement[];
} {
	const text = job.descriptionText;
	const needs: CitizenshipNeed[] = [];
	const preferred: PreferredRequirement[] = [];
	const consider = (
		index: number,
		length: number,
		country: string | null,
		what: string,
	) => {
		if (!country) return;
		// Waivers and preferences count only in the requirement's own segment: "Must be a US
		// citizen. React experience preferred." and "U.S. citizenship is required, clearance
		// preferred" still require the citizenship.
		const clause = clauseAround(text, index, length);
		const segment = segmentAround(text, index, length);
		if (WAIVED.test(segment)) return;
		if (OPTIONAL.test(segment)) {
			if (!preferred.some((p) => p.country === country && p.what === what))
				preferred.push({ country, what, evidence: quote(clause) });
			return;
		}
		if (needs.some((n) => n.country === country && n.what === what)) return;
		needs.push({
			country,
			what,
			evidence: quote(clause),
			residentsQualify: GREEN_CARD.test(clause),
		});
	};
	for (const pattern of CITIZENSHIP_PATTERNS) {
		for (const match of text.matchAll(new RegExp(pattern, "gi"))) {
			const country = nationality(match[1] ?? "");
			consider(
				match.index ?? 0,
				match[0].length,
				country,
				`${country ?? ""} citizenship`,
			);
		}
	}
	for (const match of text.matchAll(new RegExp(US_PERSON, "gi"))) {
		const clause = clauseAround(text, match.index ?? 0, match[0].length);
		// "ITAR" in a list of regulations the team knows is not a hiring requirement.
		if (
			!/\b(?:must|required|requires|requirement|subject to|eligib|access|only|preferred|a plus)\b/i.test(
				clause,
			)
		)
			continue;
		consider(
			match.index ?? 0,
			match[0].length,
			"United States",
			"US person status (export control)",
		);
	}
	for (const match of text.matchAll(new RegExp(GREEN_CARD, "gi"))) {
		const clause = clauseAround(text, match.index ?? 0, match[0].length);
		if (!/\b(?:must|required|only|open to|eligible)\b/i.test(clause)) continue;
		consider(
			match.index ?? 0,
			match[0].length,
			"United States",
			"US citizenship or a green card",
		);
	}
	const jobCountry =
		job.locations.flatMap((l) => countriesInLocation(l))[0] ?? null;
	for (const clearance of CLEARANCES) {
		if (needs.some((n) => n.what.includes("clearance"))) break;
		const flags = clearance.pattern.flags.includes("i") ? "gi" : "g";
		for (const match of text.matchAll(
			new RegExp(clearance.pattern.source, flags),
		)) {
			const country = clearance.country ?? jobCountry ?? "United States";
			consider(
				match.index ?? 0,
				match[0].length,
				country,
				clearance.country
					? clearance.label
					: `a ${country === "United States" ? "US" : country} security clearance`,
			);
		}
	}
	return {
		needs,
		preferred,
	};
}

function holds(country: string, ctx: WorkContext): boolean {
	if (country === "EU")
		return ctx.citizenship.some((c) => EU_MEMBERS.includes(c));
	if (country === "EEA")
		return ctx.citizenship.some(
			(c) => EU_MEMBERS.includes(c) || EEA_EXTRA.includes(c),
		);
	return isHomeCountry(country, ctx.citizenship);
}

/**
 * Citizenship and clearance rule: "Must be a US Citizen", "U.S. persons only (ITAR)", "DoD
 * security clearance", "EU citizens only", "SC/DV clearance". A security clearance can only be
 * held by the country's citizens, so it counts as that citizenship. A waived requirement
 * ("clearance not required") is none; an optional one ("clearance a plus") does not reject.
 */
function citizenshipRule(
	job: FilterInput,
	ctx: WorkContext,
): FilterReason & { preferred: PreferredRequirement[] } {
	const result = citizenshipRuleBody(job, ctx);
	// Preferred, not required: never a reject, but a lower rank when the user lacks it.
	const preferred = citizenshipNeeds(job).preferred.filter(
		(p) => !holds(p.country, ctx),
	);
	return { ...result, preferred };
}

function citizenshipRuleBody(job: FilterInput, ctx: WorkContext): FilterReason {
	const { needs } = citizenshipNeeds(job);
	const unmet = needs.filter(
		(n) =>
			!holds(n.country, ctx) &&
			!(n.residentsQualify && isHomeCountry(n.country, ctx.rightToWork)),
	);
	const first = unmet[0];
	if (!first) {
		const met = needs[0];
		return met
			? {
					rule: "citizenship",
					outcome: "pass",
					message: `Requires ${met.what}, which you hold.`,
					evidence: met.evidence,
				}
			: {
					rule: "citizenship",
					outcome: "pass",
					message: "No citizenship or clearance requirement found.",
				};
	}
	const what = unmet.map((n) => n.what).join(" and ");
	if (ctx.citizenship.length === 0)
		return {
			rule: "citizenship",
			outcome: "pass",
			message: `Requires ${what}; set your citizenship in Settings › Job search to decide.`,
			evidence: first.evidence,
		};
	return {
		rule: "citizenship",
		outcome: "reject",
		message: `Requires ${what}; your citizenship is ${countryNames(ctx.citizenship)}.`,
		evidence: first.evidence,
	};
}

/* ---------------------------------------------------------------- location */

/** Wording that says the job is remote, when the workplace field does not. */
const REMOTE_IN_TEXT =
	/\b(?:fully remote|100% remote|remote[- ]first|remote[- ]friendly|work remotely|working remotely|remote (?:position|role|job|opportunity)|this (?:position|role|job) is remote|work from home)\b/i;
/** "remote within the US", "US-based remote", "remote (US only)": remote, but in one place. */
const REMOTE_LIMITED =
	/\b(?:remote\s+(?:with)?in\s+(?:the\s+)?([^.;,\n)]{2,40})|remote\s*\(([^)]{2,40})\)|([A-Z][\w.]*(?:\s[A-Z][\w.]*)?)[- ]based\s+remote|open to (?:candidates|applicants|people)\s+(?:located|based|residing|living)\s+(?:only\s+)?in\s+(?:the\s+)?([^.;,\n]{2,40}))/i;
/** "We are not hiring candidates in Turkey", "open to anyone except Turkey": a place excluded. */
const NOT_HIRING_IN =
	/\b(?:(?:not|no longer|never|cannot|can't|unable to)\s+(?:currently\s+)?(?:hir\w*|accept\w*|consider\w*|recruit\w*|open to|available (?:to|in)|employ\w*)|excluding|except(?:\s+for)?|other than|outside(?:\s+of)?)\b([^.;\n]{0,60})/i;
/** "EMEA (excluding Turkey)", "Europe, except the UK": places a location field leaves out. */
const LOCATION_EXCLUSION =
	/\b(?:excluding|excl\.|except(?:\s+for)?|not(?:\s+in)?|outside(?:\s+of)?|other than)\s+([^)|;]{2,60})/gi;
/** Remote and hybrid in a location field or title, Turkish included ("Uzaktan çalışma"). */
const REMOTE_WORD = /\b(?:remote|uzaktan|tam uzaktan|tamamen uzaktan)\b/i;
const HYBRID_WORD = /\b(?:hybrid|hibrit)\b/i;

/**
 * A sentence's clauses, split at contrast words: "We are not hiring in Germany, but remote
 * candidates in Turkey are welcome" is two, each with its own polarity.
 */
function contrastClauses(sentence: string): string[] {
	return sentence
		.split(/\s*,?\s*\b(?:but|however|while|whereas|although|though|yet)\b\s*/i)
		.map((c) => c.trim())
		.filter(Boolean);
}

/** Any negation in a clause: its country mention is no evidence of hiring there. */
const NEGATION =
	/\b(?:not|no|never|cannot|can't|unable|excluding|except|other than|outside)\b/i;
/** Wording near a country that ties hiring to it. */
const HIRING_WORDS =
	/\b(remote|hire|hiring|based|candidates|located|residing|work from)\b/i;

interface LocationOutcome extends FilterReason {
	verdict: LocationVerdict;
}

const pass = (
	verdict: LocationVerdict,
	message: string,
	evidence?: string,
): LocationOutcome => ({
	rule: "location",
	outcome: "pass",
	verdict,
	message,
	evidence,
});
const reject = (message: string, evidence?: string): LocationOutcome => ({
	rule: "location",
	outcome: "reject",
	verdict: "rejected",
	message,
	evidence,
});
/** Kept with no place to judge ("Remote", nothing given): scored, flagged and ranked lower. */
const noPlace = (message: string, evidence?: string): LocationOutcome => ({
	rule: "location",
	outcome: "pass",
	verdict: "unclear",
	message,
	evidence,
});

/** Words a location entry may hold that name no place: "Remote", "Remote (100%)", "WFH". */
const PLACELESS_WORDS =
	/\b(?:remote(?:ly)?|fully|full[- ]time|work from home|wfh|home[- ]based|distributed|first|only|n\/a)\b|100\s*%/gi;

/** "Remote", "100% remote": an entry that names no place at all, unlike an unknown town. */
function namesNoPlace(location: string): boolean {
	return (
		withoutTimeZones(location)
			.replace(PLACELESS_WORDS, "")
			.replace(/[\s\-–—|,/()&+:.]/g, "").length === 0
	);
}

/** A place the app cannot place, or a mix: a reject, as only clear hires from home are kept. */
const cannotTell = (joined: string, label: string): LocationOutcome =>
	reject(
		`Cannot tell whether ${joined} hires from ${label}; only jobs that clearly do are kept.`,
		joined,
	);

/**
 * A posting that is not remote by its fields but names no place to judge: nothing given, only
 * "Worldwide" (worldwide is remote), or words that name no place. Null when it names one.
 */
function placelessOutcome(
	locations: string[],
	perLocation: { global: boolean }[],
	ctx: WorkContext,
): LocationOutcome | null {
	const joined = locations.join(" | ");
	if (locations.length === 0) return noPlace("No location given.");
	if (perLocation.every((p) => p.global))
		return ctx.keepGlobalRemote
			? pass("remote_global", "Global remote.", joined)
			: reject(
					"Remote worldwide; worldwide remote jobs are off in your settings.",
					joined,
				);
	if (locations.every(namesNoPlace))
		return noPlace("The posting does not say where the job is.", joined);
	return null;
}

function workplaceLabel(workplace: NormalizedJob["workplaceType"]): string {
	return workplace === "hybrid"
		? "Hybrid"
		: workplace === "onsite"
			? "On-site"
			: workplace === "remote"
				? "Remote"
				: "Located";
}

/** "United States, Canada" or "EU": what the location entries name, for messages. */
function placeNames(
	entries: {
		loc: string;
		countries: string[];
		regionsWithout?: string;
		legalArea?: string;
	}[],
): string {
	const names = entries.flatMap((p) =>
		p.countries.length > 0
			? p.countries
			: [displayPlace(p.regionsWithout ?? p.legalArea ?? p.loc)],
	);
	return [...new Set(names)].join(", ");
}

/** A place that is clearly not where the user may work (a country or region without them). */
function isForeignPlace(place: string, home: readonly string[]): boolean {
	const p = placesIn(place);
	if (p.countries.some((c) => isHomeCountry(c, home))) return false;
	const regions = [p.regionsWithout, p.regionMaybe, p.legalArea].filter(
		(r): r is string => Boolean(r),
	);
	if (regions.some((r) => regionIncludes(r, home))) return false;
	// A region that may not include home ("Remote in Europe only" for Turkey) is foreign too.
	return p.countries.length > 0 || regions.length > 0;
}

/** Global wording that leaves no doubt, beyond a loose "work from anywhere". */
const STRONG_GLOBAL =
	/\b(?:anywhere in the world|worldwide|world wide|any country|any time ?zone|globally)\b/i;

/**
 * "Work from anywhere" in the posting: global, unless it goes on "within the U.S." or "in Canada
 * or the United States", which limits it to that place. A place that includes the user's country
 * is neither (the home-country check reads it); a region that may include it stays undecided.
 */
function globalRemoteInText(
	text: string,
	home: readonly string[],
): {
	global?: { evidence: string; strong: boolean };
	limitedTo?: { place: string; evidence: string };
} {
	let global: { evidence: string; strong: boolean } | undefined;
	let limitedTo: { place: string; evidence: string } | undefined;
	const pattern = new RegExp(GLOBAL_REMOTE_DESCRIPTION.source, "gi");
	for (const match of text.matchAll(pattern)) {
		const end = (match.index ?? 0) + match[0].length;
		const after = text.slice(end, end + 80);
		const within = after.match(
			/^[\s*_]*(?:with)?in\s+(?:the\s+)?([^.;\n*]{2,60})/i,
		);
		const raw = within?.[1]?.trim();
		// "Anywhere in US time zones": hours, not a place, so still anywhere.
		const place =
			raw &&
			withoutTimeZones(raw)
				.replace(/\bthe\b/gi, "")
				.trim()
				? raw
				: undefined;
		if (!place || /^(?:the\s+)?world\b/i.test(place)) {
			global ??= {
				evidence: quote(`${match[0]}${place ? " in the world" : ""}`),
				strong: Boolean(place) || STRONG_GLOBAL.test(match[0]),
			};
			continue;
		}
		const p = placesIn(withoutTimeZones(place));
		const includesHome =
			p.countries.some((c) => isHomeCountry(c, home)) ||
			[p.regionsWithout, p.legalArea, p.regionMaybe].some(
				(r) => r && regionIncludes(r, home),
			);
		if (includesHome) continue;
		// A region that may not include home ("anywhere in Europe" for Turkey) limits it too.
		limitedTo ??= {
			place,
			evidence: quote(`${match[0]}${after.slice(0, within?.[0].length ?? 0)}`),
		};
	}
	return { global, limitedTo };
}

/**
 * Location rule (the user's decision, 2026-11-03). A job is kept only when:
 * (a) it is in a country the user lives in, may work in, or chose for office work;
 * (b) it is remote and hires from the user's country: named, worldwide, or a region that clearly
 *     includes it; or
 * (c) it is abroad, relocation is on (and the country is on the user's move-to list, when set),
 *     and the posting offers relocation or visa support.
 * Anything else is a reject with the reason, including a place the app cannot place and a region
 * that may not include the user's country ("EMEA" for Turkey): only jobs that clearly hire from
 * it are kept. A posting that names no place at all ("Remote", nothing given) is kept, flagged
 * and ranked lower (`noPlace`).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep ordered location, citizenship, and work-right exceptions together so fallback verdicts retain precedence.
function locationRule(job: FilterInput, ctx: WorkContext): LocationOutcome {
	const home = ctx.rightToWork;
	const label = ctx.label;
	const locations = job.locations.filter((l) => l.trim());
	const joined = locations.join(" | ");
	const words = `${joined} ${job.title}`;
	const workplace =
		job.workplaceType !== "unknown"
			? job.workplaceType
			: REMOTE_WORD.test(words)
				? "remote"
				: HYBRID_WORD.test(words)
					? "hybrid"
					: "unknown";
	// What a location field leaves out ("EMEA (excluding Turkey)") is not a place it names.
	const exclusions = locations.flatMap((loc) =>
		[...loc.matchAll(LOCATION_EXCLUSION)].map((m) => m[1] ?? ""),
	);
	const perLocation = locations.map((loc) => {
		const kept = withoutTimeZones(loc.replace(LOCATION_EXCLUSION, " "));
		return {
			loc,
			...placesIn(kept, countriesInLocation),
			global: GLOBAL_REMOTE_LOCATION.test(kept),
		};
	});

	const description = job.descriptionText;
	// The posting leaves out where the user is (a location field, or a clause of the text with
	// its own polarity): that wins over any positive mention.
	// Leaving out a city ("Turkey (excluding Ankara)") still names the country around it.
	const homeKept = perLocation.some((p) =>
		p.countries.some((c) => isHomeCountry(c, home)),
	);
	const excludedInLocation =
		!homeKept &&
		exclusions.find((tail) =>
			countriesIn(tail).some((c) => isHomeCountry(c, home)),
		);
	if (excludedInLocation)
		return reject(`The location leaves out ${label}: ${joined}.`, joined);
	const excluded = sentences(description)
		.flatMap(contrastClauses)
		.find((clause) => {
			const after = clause.match(NOT_HIRING_IN)?.[1];
			return after
				? countriesIn(after).some((c) => isHomeCountry(c, home))
				: false;
		});
	if (excluded)
		return reject(
			`The posting says it does not hire in ${label}.`,
			quote(excluded),
		);

	// (a) In a country the user may work in.
	const homeLocation = perLocation.find((p) =>
		p.countries.some((c) =>
			isHomeCountry(c, workplace === "remote" ? home : ctx.onsite),
		),
	);
	if (homeLocation) {
		if (workplace !== "remote")
			return pass(
				"home",
				`${workplaceLabel(workplace)} in ${homeLocation.loc}.`,
				joined,
			);
		return ctx.keepRemoteFromHome
			? pass("remote_home", `Remote in ${homeLocation.loc}.`, joined)
			: reject(
					`Remote in ${homeLocation.loc}; remote jobs are off in your settings.`,
					joined,
				);
	}

	// Affirmative evidence only: "We are not hiring in Turkey" names Turkey but rules it out.
	const homeInText = sentences(description)
		.flatMap(contrastClauses)
		.find(
			(clause) =>
				HIRING_WORDS.test(clause) &&
				!NEGATION.test(clause) &&
				countriesIn(clause).some((c) => isHomeCountry(c, home)),
		);
	const inText = globalRemoteInText(description, home);
	const limitedSentence = sentences(description)
		.map((s) => ({ s, place: s.match(REMOTE_LIMITED)?.slice(1).find(Boolean) }))
		.find(
			({ place }) => place && isForeignPlace(withoutTimeZones(place), home),
		);
	const limited = limitedSentence?.place
		? {
				place: limitedSentence.place.trim().replace(/\s+only$/i, ""),
				evidence: quote(limitedSentence.s),
			}
		: inText.limitedTo;
	// Location entries that name a place; a bare "Remote" names none.
	const placed = perLocation.filter(
		(p) =>
			!p.global &&
			(p.countries.length > 0 ||
				p.regionsWithout ||
				p.regionMaybe ||
				p.legalArea),
	);
	// A legal area (EU, EEA, Schengen) is decisive, unlike geographic Europe or EMEA: it holds
	// the user's countries or it does not.
	const legalOutside = (p: (typeof perLocation)[number]) =>
		Boolean(p.legalArea && !regionIncludes(p.legalArea, home));
	const foreignOnly =
		placed.length > 0 &&
		placed.every(
			(p) =>
				(!p.regionMaybe || legalOutside(p)) &&
				(p.countries.length > 0 ||
					Boolean(p.regionsWithout) ||
					legalOutside(p)),
		);
	// The location fields outrank a loose "work from anywhere" in the text; "anywhere in the
	// world" still counts.
	const globalEvidence = GLOBAL_REMOTE_LOCATION.test(joined)
		? joined
		: inText.global && (!foreignOnly || inText.global.strong)
			? inText.global.evidence
			: undefined;

	const regionVerdict = (): "in" | "maybe" | "out" | null => {
		const regions = perLocation.flatMap((p) =>
			[p.regionsWithout, p.regionMaybe, p.legalArea].filter((r): r is string =>
				Boolean(r),
			),
		);
		if (regions.length === 0) return null;
		if (regions.some((r) => regionIncludes(r, home))) return "in";
		if (perLocation.some((p) => p.regionMaybe && !p.legalArea)) return "maybe";
		return "out";
	};

	// (b) Remote: from the user's country, worldwide, or a region that clearly includes it.
	if (workplace === "remote") {
		if (globalEvidence && ctx.keepGlobalRemote && !limited)
			return pass("remote_global", "Global remote.", globalEvidence);
		// An explicit restriction ("Remote in the US only") comes before any mention of home.
		if (limited)
			return reject(
				`Remote only within ${displayPlace(limited.place)}; you live and can work in ${label}.`,
				limited.evidence,
			);
		if (homeInText && ctx.keepRemoteFromHome)
			return pass(
				"remote_home",
				`Remote, and the posting names ${label}.`,
				quote(homeInText),
			);
		const region = regionVerdict();
		if (region === "in" && ctx.keepRemoteFromHome)
			return pass(
				"remote_home",
				`Remote in ${joined}, which includes ${label}.`,
				joined,
			);
		if (
			region === "maybe" ||
			perLocation.some(
				(p) => p.regionMaybe && !p.legalArea && !p.countries.length,
			)
		)
			return reject(
				`${joined} may not include ${label}; only jobs that clearly hire from ${label} are kept.`,
				joined,
			);
		if (foreignOnly)
			return reject(
				`Remote only within ${placeNames(placed)}; you live and can work in ${label}.`,
				joined,
			);
		if (globalEvidence)
			return reject(
				"Remote worldwide; worldwide remote jobs are off in your settings.",
				globalEvidence,
			);
		if (locations.every(namesNoPlace))
			return noPlace(
				"Remote, but the posting does not say from where.",
				joined || undefined,
			);
		return cannotTell(joined, label);
	}

	const placeless = placelessOutcome(locations, perLocation, ctx);
	if (placeless) return placeless;

	// Every location is a known place outside the user's countries.
	const allForeign = perLocation.every(
		(p) =>
			!p.regionMaybe &&
			!p.global &&
			(p.countries.length > 0 || p.regionsWithout) &&
			!p.countries.some((c) => isHomeCountry(c, ctx.onsite)),
	);
	if (!allForeign) return cannotTell(joined, label);

	const countries = perLocation.flatMap((p) => p.countries);
	const where = `${workplaceLabel(workplace)} in ${joined}`;
	// The workplace field says nothing, but the posting reads as remote: from where is unknown.
	if (job.workplaceType === "unknown" && REMOTE_IN_TEXT.test(description)) {
		if (globalEvidence && ctx.keepGlobalRemote && !limited)
			return pass("remote_global", "Global remote.", globalEvidence);
		if (homeInText && ctx.keepRemoteFromHome)
			return pass(
				"remote_home",
				`Remote, and the posting names ${label}.`,
				quote(homeInText),
			);
		if (limited)
			return reject(
				`${where}; remote only within ${displayPlace(limited.place)}, and you live and can work in ${label}.`,
				limited.evidence,
			);
		return reject(
			`${where}; the posting mentions remote work but not from where, and you can work in ${label}.`,
			joined,
		);
	}

	// (c) Abroad: only with relocation on and relocation or visa support offered.
	const offer = relocationOffer(description);
	if (!ctx.relocation)
		return reject(
			`${where}; you can work in ${label} only, and relocation is off in your settings.`,
			joined,
		);
	if (!willMoveTo(ctx, countries))
		return reject(
			`${where}; ${countryNames(countries) || "that place"} is not among the countries you would move to.`,
			joined,
		);
	if (offer.offered)
		return pass(
			"relocation",
			`${where}; the posting offers relocation or visa support.`,
			offer.evidence,
		);
	return reject(
		offer.refused
			? `${where}; the posting offers no sponsorship or relocation.`
			: `${where}; the posting does not mention relocation or visa support.`,
		offer.evidence ?? joined,
	);
}

/* -------------------------------------------------------------------- role */

/**
 * A title keyword as a whole word. Escaped, so "C++", "C#" and ".NET" are keywords, not syntax;
 * the edges are "not a word character" rather than `\b`, which never matches after "+" or "#".
 */
export function keywordPattern(keyword: string): RegExp {
	const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<!\\w)${escaped}(?!\\w)`);
}

function roleRule(job: FilterInput, settings: FilterSettings): FilterReason {
	const title = job.title.toLowerCase();
	const excluded = settings.excludeTitleKeywords.find((k) =>
		keywordPattern(k).test(title),
	);
	if (excluded)
		return {
			rule: "role",
			outcome: "reject",
			message: `Title contains "${excluded}".`,
			evidence: job.title,
		};
	if (settings.roleKeywords.length === 0)
		return { rule: "role", outcome: "pass", message: "Role rule disabled." };
	const hit = settings.roleKeywords.find((k) =>
		title.includes(k.toLowerCase()),
	);
	if (hit)
		return {
			rule: "role",
			outcome: "pass",
			message: `Title matches "${hit}".`,
		};
	return {
		rule: "role",
		outcome: "reject",
		message: "Title is not a target role.",
		evidence: job.title,
	};
}

/* -------------------------------------------------------------------- main */

/**
 * Deterministic hard-requirement filter. Runs before any AI spend.
 * Order matters only for the summary: language, citizenship and work-permit rejections are the
 * most specific.
 */
export function evaluateHardRequirements(
	job: FilterInput,
	settings: FilterSettings,
): FilterResult {
	const ctx = workContext(settings);
	const permit = permitRule(job, ctx);
	const location = locationRule(job, ctx);
	const { verdict, ...locationReason } = location;
	let locationVerdict = verdict;
	// No country known yet (no profile location, nothing set): a place cannot rule a job out.
	if (ctx.onsite.length === 0) {
		for (const reason of [permit, locationReason]) {
			if (reason.outcome !== "reject") continue;
			reason.outcome = "pass";
			reason.message = `${reason.message.split(";")[0]}; set where you live in Settings › Job search to decide.`;
		}
		if (locationVerdict === "rejected") locationVerdict = "unclear";
	}
	const { preferred, ...citizenship } = citizenshipRule(job, ctx);
	const reasons: FilterReason[] = [
		languageRule(job, settings),
		citizenship,
		permit,
		locationReason,
		roleRule(job, settings),
	];

	// A residency or permit requirement that names the user's country settles a missing place.
	if (
		locationVerdict === "unclear" &&
		locationReason.outcome === "pass" &&
		permit.outcome === "pass" &&
		permit.evidence &&
		/includes/.test(permit.message)
	) {
		locationReason.outcome = "pass";
		locationReason.message = permit.message;
		locationVerdict = "remote_home";
	}

	const rejected = reasons.filter((r) => r.outcome === "reject");
	if (rejected.length > 0) {
		return {
			decision: "reject",
			locationVerdict,
			...(preferred.length > 0 ? { preferred } : {}),
			summary: rejected.map((r) => r.message).join(" "),
			reasons,
			flags: [],
		};
	}
	return {
		decision: "keep",
		locationVerdict,
		...(preferred.length > 0 ? { preferred } : {}),
		summary:
			ctx.onsite.length === 0
				? "Passes the rules; set where you live in Settings › Job search to decide on place."
				: locationVerdict === "unclear"
					? `Passes the rules; ${locationReason.message.charAt(0).toLowerCase()}${locationReason.message.slice(1)}`
					: "Passes location, citizenship, work-permit, language and role rules.",
		reasons,
		flags: locationVerdict === "unclear" ? ["location unclear"] : [],
	};
}
