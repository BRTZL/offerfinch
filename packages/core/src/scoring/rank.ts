import type { DismissReason } from "../domain/dismissal";
import type { FilterResult, LocationVerdict } from "../filter/rules";
import type { ProfileSnapshot } from "../profile/types";

/**
 * Ranking: the order of Matches. The fit score says how well the skills match; the rank also
 * weighs how realistic the job is: an unclear location, a seniority far from the profile's, a
 * heavy domain the profile never touches, and what the user passed on before. The score is kept
 * as it is; the rank is the score minus penalties, and the biggest penalty is shown as the
 * reason ("Ranked lower: location unclear").
 */

type RankPenaltyKind =
	| "location"
	| "work_rights"
	| "preferred"
	| "seniority"
	| "domain"
	| "dismissed_company"
	| "dismissed_similar";

export interface RankPenalty {
	kind: RankPenaltyKind;
	points: number;
	/** Short, shown after "Ranked lower: ". */
	reason: string;
}

export interface RankResult {
	rank: number;
	penalties: RankPenalty[];
}

export type SeniorityLevel =
	| "intern"
	| "junior"
	| "mid"
	| "senior"
	| "staff"
	| "executive";

/** One match the user marked Not interested, as ranking reads it. */
export interface DismissalSignal {
	companyId: string;
	reasons: DismissReason[];
	title: string;
	locationVerdict?: LocationVerdict | null;
}

export interface RankInput {
	score: number;
	job: { title: string; descriptionText: string; companyId?: string };
	filter: FilterResult | null;
	/** Years of experience the profile shows; null when it shows none. */
	profileYears: number | null;
	/** All profile text, for domain words. */
	profileText: string;
	dismissals?: readonly DismissalSignal[];
}

/* --------------------------------------------------------------- seniority */

export function seniorityLevel(title: string): SeniorityLevel {
	if (/\b(?:intern|internship|trainee|working student)\b/i.test(title))
		return "intern";
	if (/\b(?:director|head of|vp|vice president|chief|cto)\b/i.test(title))
		return "executive";
	if (/\b(?:staff|principal|distinguished|fellow)\b/i.test(title))
		return "staff";
	if (/\b(?:junior|jr\.?|entry[- ]level|graduate|new grad)\b/i.test(title))
		return "junior";
	if (/\b(?:senior|sr\.?|lead|tech lead)\b/i.test(title)) return "senior";
	return "mid";
}

const YEARS =
	/\b(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?(?:\+\s*)?years?(?:['’]s?)?\s+(?:of\s+)?(?:(?:professional|relevant|industry|hands[- ]on|commercial|working|proven|practical|production)\s+)*(?:experience|exp\b|work experience)/gi;

/** Someone other than the candidate: the team, a lead, the founders, the company. */
const THIRD_PARTY =
	/\b(?:led by|mentored by|managed by|tech lead|team lead|lead engineer|founders?|company|we|our|team|managers?|leaders?|CTO|CEO|engineers)\b/i;

/** Where the last match of a pattern starts, or -1. */
function lastIndex(text: string, pattern: RegExp): number {
	let last = -1;
	for (const m of text.matchAll(new RegExp(pattern.source, "gi")))
		last = m.index ?? last;
	return last;
}

/** The most years of experience the posting asks for ("5+ years of experience"), or null. */
export function requiredYears(text: string): number | null {
	let most: number | null = null;
	for (const match of text.matchAll(YEARS)) {
		const years = Number(match[1]);
		if (!Number.isFinite(years) || years > 20) continue;
		// "mentored by a tech lead with 15+ years of experience" is about someone else.
		const before = text
			.slice(Math.max(0, (match.index ?? 0) - 70), match.index)
			.split(/[.!?\n]/)
			.at(-1);
		if (before && lastIndex(before, THIRD_PARTY) > lastIndex(before, /\byou/i))
			continue;
		most = Math.max(most ?? 0, years);
	}
	return most;
}

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

function parseDate(text: string, now: Date): number | null {
	const t = text.trim().toLowerCase();
	if (!t) return null;
	if (/present|current|now|today|ongoing/.test(t)) return now.getTime();
	const year = t.match(/\b(19|20)\d{2}\b/)?.[0];
	if (!year) return null;
	const month = t.match(
		/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/,
	)?.[1];
	const numeric = t.match(/\b(\d{1,2})[/.-](?:19|20)\d{2}\b/)?.[1];
	const m = month
		? (MONTHS[month] ?? 0)
		: numeric
			? Math.min(11, Number(numeric) - 1)
			: 0;
	return Date.UTC(Number(year), m, 1);
}

/**
 * Years of work the profile shows: the roles' date ranges ("- **Dates:** Mar 2019 – Present"),
 * overlaps counted once. Null when no role has dates.
 */
export function profileYears(
	profile: ProfileSnapshot | null,
	now = new Date(),
): number | null {
	const spans: [number, number][] = [];
	for (const file of profile?.files ?? []) {
		if (!file.path.startsWith("experience/")) continue;
		const dates = file.content.match(/^-\s+\*\*Dates:\*\*\s+(.+)$/im)?.[1];
		if (!dates) continue;
		const [from, to] = dates.split(/\s+[–—-]\s+|\s+to\s+/i);
		const start = parseDate(from ?? "", now);
		const end = parseDate(to ?? "present", now);
		if (start === null || end === null || end < start) continue;
		spans.push([start, end]);
	}
	if (spans.length === 0) return null;
	spans.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let [curStart, curEnd] = spans[0] as [number, number];
	for (const [s, e] of spans.slice(1)) {
		if (s <= curEnd) curEnd = Math.max(curEnd, e);
		else {
			total += curEnd - curStart;
			curStart = s;
			curEnd = e;
		}
	}
	total += curEnd - curStart;
	return Math.round((total / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
}

function seniorityPenalty(
	job: RankInput["job"],
	years: number | null,
): RankPenalty | null {
	if (years === null) return null;
	const level = seniorityLevel(job.title);
	const asked = requiredYears(job.descriptionText);
	const have = Math.floor(years);
	if (asked !== null && asked > years + 1) {
		return {
			kind: "seniority",
			points: Math.min(25, Math.round(5 * (asked - years))),
			reason: `asks for ${asked}+ years; your profile shows about ${have}`,
		};
	}
	if ((level === "staff" || level === "executive") && years < 8)
		return {
			kind: "seniority",
			points: 15,
			reason: `${level === "staff" ? "staff or principal" : "leadership"} role; your profile shows about ${have} years`,
		};
	if ((level === "junior" || level === "intern") && years >= 5)
		return {
			kind: "seniority",
			points: 10,
			reason: `${level} role; your profile shows about ${have} years`,
		};
	if (asked !== null && asked <= 1 && years >= 6)
		return {
			kind: "seniority",
			points: 8,
			reason: `asks for ${asked} year${asked === 1 ? "" : "s"}; your profile shows about ${have}`,
		};
	return null;
}

/* ------------------------------------------------------------------ domain */

interface Domain {
	key: string;
	label: string;
	/** Words in the posting; `min` distinct ones (a title hit counts twice) make it heavy. */
	job: RegExp;
	min: number;
	/** Any of these in the profile means the user has done it. */
	profile: RegExp;
}

const DOMAINS: Domain[] = [
	{
		key: "defense",
		label: "defense and security clearance",
		job: /\b(?:security clearance|clearance|DoD|defen[cs]e|military|ITAR|classified|national security|weapons?|missiles?|aerospace and defen[cs]e)\b/gi,
		min: 2,
		profile: /\b(?:defen[cs]e|military|clearance|DoD|aerospace)\b/i,
	},
	{
		key: "embedded",
		label: "embedded systems and RTOS",
		job: /\b(?:RTOS|embedded C|embedded systems?|embedded software|firmware|microcontrollers?|bare[- ]metal|FreeRTOS|Zephyr|VxWorks|device drivers?|AUTOSAR|MCU)\b/gi,
		min: 2,
		profile: /\b(?:embedded|firmware|RTOS|microcontroller|bare[- ]metal)\b/i,
	},
	{
		key: "hardware",
		label: "FPGA and chip design",
		job: /\b(?:FPGA|VHDL|Verilog|SystemVerilog|ASIC|RTL design)\b/gi,
		min: 1,
		profile: /\b(?:FPGA|VHDL|Verilog|ASIC|RTL)\b/i,
	},
	{
		key: "mainframe",
		label: "mainframe and COBOL",
		job: /\b(?:COBOL|mainframe|z\/OS|JCL|CICS)\b/gi,
		min: 2,
		profile: /\b(?:COBOL|mainframe)\b/i,
	},
	{
		key: "sap",
		label: "SAP and ABAP",
		job: /\b(?:ABAP|SAP (?:HANA|S\/4\s?HANA|ERP|BW|Fiori))\b/gi,
		min: 1,
		profile: /\b(?:ABAP|SAP)\b/i,
	},
];

/** Domains the posting leans on heavily. */
function jobDomains(job: RankInput["job"]): Domain[] {
	return DOMAINS.filter((domain) => {
		const words = new Set(
			[...job.descriptionText.matchAll(domain.job)].map((m) =>
				m[0].toLowerCase(),
			),
		);
		const inTitle = new RegExp(domain.job.source, "i").test(job.title);
		return words.size + (inTitle ? 2 : 0) >= domain.min;
	});
}

function domainPenalties(
	job: RankInput["job"],
	profileText: string,
): RankPenalty[] {
	return jobDomains(job)
		.filter((domain) => !domain.profile.test(profileText))
		.map((domain) => ({
			kind: "domain" as const,
			points: 15,
			reason: `needs ${domain.label}, which your profile does not show`,
		}));
}

/* ---------------------------------------------------------------- location */

function locationPenalties(filter: FilterResult | null): RankPenalty[] {
	if (!filter) return [];
	const penalties: RankPenalty[] = [];
	const unclear = (rule: string) =>
		filter.reasons.some((r) => r.rule === rule && r.outcome === "unclear");
	const verdict =
		filter.locationVerdict ?? (unclear("location") ? "unclear" : undefined);
	if (verdict === "unclear")
		penalties.push({
			kind: "location",
			points: 15,
			reason: "location unclear",
		});
	else if (verdict === "relocation")
		penalties.push({
			kind: "location",
			points: 8,
			reason: "needs relocation",
		});
	if (unclear("work_permit"))
		penalties.push({
			kind: "work_rights",
			points: 10,
			reason: "right to work unclear",
		});
	if (unclear("citizenship"))
		penalties.push({
			kind: "work_rights",
			points: 10,
			reason: "citizenship requirement unclear",
		});
	// Preferred, not required ("clearance preferred"): a weaker chance without it, never a
	// reject. 8 for the first, 4 more for any other, 12 at most.
	const preferred = filter.preferred ?? [];
	const first = preferred[0];
	if (first)
		penalties.push({
			kind: "preferred",
			points: Math.min(12, 8 + 4 * (preferred.length - 1)),
			reason: `prefers ${first.what}, which you do not hold`,
		});
	return penalties;
}

/* -------------------------------------------------------------- dismissals */

/** Stack words in a title, for "you passed on several Java roles". */
const STACK_WORDS =
	/\b(java|kotlin|scala|php|ruby|rails|python|django|golang|go|rust|c\+\+|c#|\.net|dotnet|unity|unreal|android|ios|swift|flutter|react native|angular|vue|react|node|salesforce|sap|data|ml|machine learning|devops|sre|qa|test|security|embedded|firmware|blockchain|web3)\b/gi;

function stackWords(title: string): Set<string> {
	return new Set(
		[...title.matchAll(STACK_WORDS)].map((m) => m[0].toLowerCase()),
	);
}

function dismissalPenalties(
	input: RankInput,
	level: SeniorityLevel,
	verdict: LocationVerdict | undefined,
): RankPenalty[] {
	const signals = input.dismissals ?? [];
	if (signals.length === 0) return [];
	const penalties: RankPenalty[] = [];
	const companyId = input.job.companyId;
	if (companyId && signals.some((s) => s.companyId === companyId))
		penalties.push({
			kind: "dismissed_company",
			points: 25,
			reason: "you passed on a job at this company",
		});
	const similar = (
		reason: DismissReason,
		same: (s: DismissalSignal) => boolean,
	) => signals.filter((s) => s.reasons.includes(reason) && same(s)).length;
	const add = (count: number, what: string) => {
		if (count >= 2)
			penalties.push({
				kind: "dismissed_similar",
				points: Math.min(15, 4 * count),
				reason: `you passed on ${count} similar ${what}`,
			});
	};
	add(
		similar("seniority", (s) => seniorityLevel(s.title) === level),
		`${level === "mid" ? "mid-level" : level} roles for seniority`,
	);
	if (verdict && verdict !== "home")
		add(
			similar("location", (s) => s.locationVerdict === verdict),
			"jobs for their location",
		);
	const stack = stackWords(input.job.title);
	if (stack.size > 0)
		add(
			similar("stack", (s) =>
				[...stackWords(s.title)].some((w) => stack.has(w)),
			),
			"jobs for their stack",
		);
	return penalties;
}

/* -------------------------------------------------------------------- rank */

export function rankMatch(input: RankInput): RankResult {
	const level = seniorityLevel(input.job.title);
	const penalties = [
		...locationPenalties(input.filter),
		seniorityPenalty(input.job, input.profileYears),
		...domainPenalties(input.job, input.profileText),
		...dismissalPenalties(input, level, input.filter?.locationVerdict),
	]
		.filter((p): p is RankPenalty => p !== null)
		.sort((a, b) => b.points - a.points);
	const total = penalties.reduce((sum, p) => sum + p.points, 0);
	return {
		rank: Math.max(0, Math.min(100, Math.round(input.score - total))),
		penalties,
	};
}

/** "Ranked lower: location unclear", from the biggest penalty; null when none. */
export function rankReason(
	penalties: readonly RankPenalty[] | null | undefined,
) {
	const first = penalties?.[0];
	return first ? `Ranked lower: ${first.reason}` : null;
}

/** The profile's text for domain words: every file, joined. */
function profileTextOf(profile: ProfileSnapshot | null): string {
	return (profile?.files ?? []).map((f) => f.content).join("\n");
}

/** Ranks a scored match from its stored parts: the score, filter result and the profile. */
export function rankScored(input: {
	score: number;
	job: RankInput["job"];
	filter: FilterResult | null;
	profile: ProfileSnapshot | null;
	dismissals?: readonly DismissalSignal[];
	now?: Date;
}): RankResult {
	return rankMatch({
		score: input.score,
		job: input.job,
		filter: input.filter,
		profileYears: profileYears(input.profile, input.now),
		profileText: profileTextOf(input.profile),
		dismissals: input.dismissals,
	});
}
