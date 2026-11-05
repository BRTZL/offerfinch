import type { DismissReason } from "../domain/dismissal";

/**
 * Ranking: the order of Matches. The fit score decides how good a job is: it already weighs
 * place, work rights, language, seniority, role, pay and domain (docs/decisions.md, 2026-11-05).
 * The rank is the score less what the user passed on before (a company, several similar jobs);
 * the biggest penalty is shown as the reason ("Ranked lower: you passed on a job at this company").
 */

/** Every kind a stored rank may hold; new ranks use only the dismissal ones. */
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
}

export interface RankInput {
	score: number;
	job: { title: string; companyId?: string };
	dismissals?: readonly DismissalSignal[];
}

/* --------------------------------------------------------------- seniority */

/** A title's level, for "you passed on several senior roles". */
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
	const penalties = dismissalPenalties(
		input,
		seniorityLevel(input.job.title),
	).sort((a, b) => b.points - a.points);
	const total = penalties.reduce((sum, p) => sum + p.points, 0);
	return {
		rank: Math.max(0, Math.min(100, Math.round(input.score - total))),
		penalties,
	};
}

/** "Ranked lower: you passed on a job at this company", from the biggest penalty; null when none. */
export function rankReason(
	penalties: readonly RankPenalty[] | null | undefined,
) {
	const first = penalties?.[0];
	return first ? `Ranked lower: ${first.reason}` : null;
}

/** Ranks a scored match: its fit score less what the user passed on before. */
export function rankScored(input: {
	score: number;
	job: RankInput["job"];
	dismissals?: readonly DismissalSignal[];
}): RankResult {
	return rankMatch(input);
}
