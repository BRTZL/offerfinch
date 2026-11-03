import type { ProfileSnapshot } from "../profile/types";
import { factTokens } from "./claims";
import { evidenceProfile, normalizeForMatch } from "./profile-rules";
import type { QuestionRequirement } from "./tailor";

/**
 * Which of a draft's missing facts become questions. The user is asked at most once per
 * application by default (a round), only about what would materially change it (a must-have
 * requirement, or a question the posting's form asks), a few at a time, and never again about a
 * topic already asked or one the profile settles. Everything else stays out of the documents and
 * is named as a gap in the notes.
 */

export interface MissingFact {
	question: string;
	why: string;
	requirement?: QuestionRequirement;
}

/** A question already asked for this application, whatever became of it. */
export interface AskedQuestion {
	question: string;
	answer: string | null;
	status: "open" | "answered" | "dismissed";
}

export interface QuestionBudget {
	/** Question rounds this application has had (moves into needs_answers). */
	rounds: number;
	/** Rounds allowed per application. */
	maxRounds: number;
	/** Questions per round. */
	maxQuestions: number;
}

export function questionsAllowed(budget: QuestionBudget): number {
	return budget.rounds < budget.maxRounds ? budget.maxQuestions : 0;
}

export interface QuestionSelection {
	ask: { question: string; why: string }[];
	dropped: { question: string; reason: string }[];
}

const NEGATED = "¬";
/** A profile sentence that settles a topic by saying what is not there or not known. */
const SETTLING =
	/\b(?:no|not|never|none|without|isn'?t recorded|not recorded|unknown|n\/a)\b/i;

function topicWords(text: string): Set<string> {
	return new Set(
		[...factTokens(text)].filter((t) => t !== NEGATED && t.length > 1),
	);
}

/**
 * Two texts are about the same topic when they share at least three topic words and those cover
 * half of the shorter one. Generous on purpose: a question wrongly dropped becomes a gap, which
 * costs nothing; a question asked twice costs the user's patience and a tailoring round.
 */
function sameTopic(a: string, b: string): boolean {
	const x = topicWords(a);
	const y = topicWords(b);
	let shared = 0;
	for (const t of x) if (y.has(t)) shared++;
	return shared >= 3 && shared / Math.min(x.size, y.size) >= 0.5;
}

/** Profile sentences that record a negative or a detail that is not known. */
function settlingSentences(profile: ProfileSnapshot): string[] {
	return evidenceProfile(profile).files.flatMap((file) =>
		file.content
			.split("\n")
			.flatMap((line) => normalizeForMatch(line).split(/(?<=[.!?])\s+/))
			.filter((sentence) => SETTLING.test(sentence)),
	);
}

export function selectQuestions(
	missing: MissingFact[],
	input: {
		profile: ProfileSnapshot;
		asked: AskedQuestion[];
		budget: QuestionBudget;
	},
): QuestionSelection {
	const allowed = questionsAllowed(input.budget);
	const settled = settlingSentences(input.profile);
	const ask: QuestionSelection["ask"] = [];
	const dropped: QuestionSelection["dropped"] = [];
	for (const fact of missing) {
		const question = fact.question.trim();
		if (!question) continue;
		let reason: string | null = null;
		if (fact.requirement === "nice_to_have")
			reason = "a nice-to-have; left out and named as a gap";
		else if (input.asked.some((a) => sameTopic(question, a.question)))
			reason = "already asked for this application";
		else if (settled.some((s) => sameTopic(question, s)))
			reason = "the profile already settles it";
		else if (ask.some((a) => sameTopic(question, a.question)))
			reason = "the same topic as another question";
		else if (allowed === 0)
			reason = "no question round left; left out and named as a gap";
		else if (ask.length >= allowed)
			reason = `more than ${allowed} questions in one round`;
		if (reason) dropped.push({ question, reason });
		else ask.push({ question, why: fact.why });
	}
	return { ask, dropped };
}

/** The dropped questions, appended to the private notes so the user sees what was not asked. */
export function notesWithDropped(
	notes: string,
	dropped: QuestionSelection["dropped"],
): string {
	if (dropped.length === 0) return notes;
	return `${notes.trimEnd()}\n\n## Not asked\n\n${dropped
		.map((d) => `- ${d.question} (${d.reason})`)
		.join("\n")}\n`;
}
