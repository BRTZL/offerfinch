import type { ProfileSnapshot } from "../../profile/types";
import {
	ASKED_QUESTION_PREFIX,
	type DocumentContext,
	normalizeForMatch,
} from "../profile-rules";
import { namedTerms } from "./expansions";
import { factTokens, NEGATED } from "./tokens";

/* ------------------------------------------------------------- answers */

/** A question asking for a value ("What is your English level?"), not a yes or no. */
const WH_QUESTION = /^(?:what|which|how|where|when)\b/i;

/** A question answered yes or no: "Have you worked with …?" */
const YES_NO_QUESTION =
	/^(?:have|has|had|do|does|did|are|were|is|was|can|could|would|will)\s+you\b/i;

/**
 * Every word an unqualified yes may use: the yes itself, and only how widely it holds ("yes, in
 * all my companies"). Anything else narrows or hedges it ("yes, with Docker", "yes perhaps",
 * "yes but only as an observer", "yes to the previous question") and the question's names stay
 * unsourced; an answer naming its own items is evidence for those words as it stands.
 */
const PLAIN_YES = new Set(
	`yes yeah yep yup definitely absolutely of course sure indeed always basically in at on across
	all my every each the companies company jobs job roles role teams team places employers
	employer projects everywhere`.split(/\s+/),
);

/** A yes to every item at once: "yes, all of them", "yes, both". */
const WHOLE_YES =
	/^(?:yes|yeah|yep)[\s,.!-]*(?:to\s+)?(?:both|all|each)(?:\s+of\s+them)?[\s.!]*$/i;

function plainYes(answer: string): boolean {
	const words = normalizeForMatch(answer)
		.split(/[^\p{L}']+/u)
		.filter(Boolean);
	return (
		/^(?:yes|yeah|yep|yup|definitely|absolutely|of course|sure)$/.test(
			words[0] === "of" ? `of ${words[1] ?? ""}` : (words[0] ?? ""),
		) &&
		!/\d/.test(answer) &&
		words.every((w) => PLAIN_YES.has(w))
	);
}

/**
 * The only questions a yes sources names from: they ask whether the candidate has worked with
 * one thing, or two joined by "and" ("Have you worked with Trunk Based Development and
 * Continuous Delivery?"). Each item is a run of capitalized words. Anything else ("Docker instead
 * of Kubernetes", "X or Y", "X, Y and Z", a negation, a condition) sources nothing. Examples in
 * parentheses are already left out. The items, or null.
 */
const EXPERIENCE_QUESTION =
	/^(?:have|do|did|are|were)\s+you\s+(?:ever\s+)?(?:worked|work|used|use|built|build|shipped|ship|practi[sc]ed|practi[sc]e|run|ran|operated|operate|maintained|maintain|been working|(?:had|have)\s+(?:hands-on\s+)?experience|experienced?|familiar)(?:\s+(?:with|in|on|using))?\s+(.+?)(?:\s+(?:before|professionally|in production|day to day))?\s*\??$/iu;

const ITEM = String.raw`[\p{Lu}\d][\p{L}\p{M}\d+#.'-]*(?:\s+[\p{Lu}\d][\p{L}\p{M}\d+#.'-]*)*`;

const ITEMS = new RegExp(`^${ITEM}(?:\\s+(?:and|&)\\s+${ITEM})?$`, "u");

/**
 * Words that turn the items into a comparison, a choice or a condition, in any case: "Docker Over
 * Kubernetes", "Docker Rather Than Kubernetes". Any of them in the items sources nothing.
 */
const NOT_A_LIST =
	/\b(?:over|than|versus|vs|against|beyond|besides|instead|rather|except|without|other|compared|or|nor|either|neither|not|never|no|if|unless|when|only|but)\b/i;

function experienceItems(asked: string): string | null {
	const items = asked.match(EXPERIENCE_QUESTION)?.[1]?.trim();
	if (!items || !ITEMS.test(items) || NOT_A_LIST.test(items)) return null;
	return items;
}

/**
 * The question as asked, for matching its shape: examples in parentheses left out, and a
 * follow-up asking where ("… Continuous Delivery? If so, at which company or project?"), which
 * the answer's breadth words answer.
 */
function askedQuestion(line: string): string {
	return line
		.slice(ASKED_QUESTION_PREFIX.length)
		.replace(/\([^()]*\)/g, " ")
		.replace(
			/\?\s*if (?:so|yes),?\s+(?:at |in |on )?(?:which|what|where)\b[^?]*\?\s*$/i,
			"?",
		)
		.replace(/\s+\?/g, "?")
		.trim();
}

/**
 * How widely a plain yes holds, when it says it holds at every employer: "in all my companies",
 * "everywhere", "at every job", "always". "In all my teams" or "on every project" is narrower.
 */
const EVERY_EMPLOYER =
	/\b(?:everywhere|always)\b|\b(?:all|every|each)\b(?:\s+(?:of\s+)?(?:my|the))?\s+(?:companies|company|jobs|job|roles|role|employers|employer|places|place)\b|\b(?:my|the)\s+all\s+(?:companies|jobs|roles|employers|places)\b/i;

/**
 * The words a plain yes states at every employer: "yes in my all companies basically" to "Have
 * you worked with Trunk Based Development and Continuous Delivery?" states the question (its
 * verb and items) for each of them. Only for an answer line right below a question from tailoring
 * of the shapes `answerTopic` accepts, an unqualified yes, and a breadth phrase; null otherwise.
 */
export function everyEmployerYes(
	profile: ProfileSnapshot,
	file: string,
	line: string,
): Set<string> | null {
	if (!/^\s*-\s+Answer:/.test(line)) return null;
	const lines = profile.files.find((f) => f.path === file)?.content.split("\n");
	const at = lines?.indexOf(line) ?? -1;
	const question = at > 0 ? lines?.[at - 1] : undefined;
	if (!question?.startsWith(ASKED_QUESTION_PREFIX)) return null;
	const asked = askedQuestion(question);
	const answer = line.replace(/^\s*-\s+Answer:/, "");
	if (
		!YES_NO_QUESTION.test(asked) ||
		experienceItems(asked) === null ||
		!plainYes(answer) ||
		!EVERY_EMPLOYER.test(answer)
	)
		return null;
	return new Set([...factTokens(asked)].filter((t) => t !== NEGATED));
}

/**
 * The name a question from tailoring asks about, for the answer line right below it in
 * answers.md: "professional working proficiency" answers "What is your English level?", and the
 * question line itself is never evidence. Only for a question asking for a value with exactly one
 * name (examples in parentheses left out), that name being the user's own ("your English"), an
 * answer with no negation, and a segment that states every word of the answer: "My English is
 * fluent." gets nothing from that answer, and "Which company did you use Rust at?" presupposes
 * Rust, so its answer "alpha" does not state it. A board's question gives nothing.
 */
export function answerTopic(
	profile: ProfileSnapshot,
	file: string,
	line: string,
	segment: string,
	context: DocumentContext,
): Set<string> {
	if (!/^\s*-\s+Answer:/.test(line)) return new Set();
	const lines = profile.files.find((f) => f.path === file)?.content.split("\n");
	const at = lines?.indexOf(line) ?? -1;
	const question = at > 0 ? lines?.[at - 1] : undefined;
	if (!question?.startsWith(ASKED_QUESTION_PREFIX)) return new Set();
	const asked = askedQuestion(question);
	const answerText = line.replace(/^\s*-\s+Answer:/, "");
	const answer = factTokens(answerText);
	// "Have you worked with Trunk Based Development?" answered "yes …": the user affirms the
	// question's names. Not for "X or Y" ("yes" affirms neither for sure), a negative or hedged
	// answer, or a question with a negation of its own.
	if (YES_NO_QUESTION.test(asked)) {
		const items = experienceItems(asked);
		if (
			items === null ||
			!(plainYes(answerText) || WHOLE_YES.test(answerText.trim()))
		)
			return new Set();
		// The question's names, as read in the question, that are its items.
		const named = factTokens(items);
		return new Set([...namedTerms(asked, context)].filter((t) => named.has(t)));
	}
	const said = factTokens(segment);
	if (
		!WH_QUESTION.test(asked) ||
		answer.has(NEGATED) ||
		answer.size === 0 ||
		[...answer].some((t) => !said.has(t))
	)
		return new Set();
	const topic = namedTerms(asked, context);
	// The word right after "your": the user's own attribute, not a name the question presupposes.
	const own = factTokens(
		asked.match(/\byour\s+([\p{L}\d][\p{L}\d+#.-]*)/iu)?.[1] ?? "",
	);
	return topic.size === 1 && [...topic].every((t) => own.has(t))
		? topic
		: new Set();
}
