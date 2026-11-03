import type { FormAnswer } from "@offerfinch/core/tailor/tailor";
import type { EvalPosting } from "./fixtures";

/**
 * Automatic checks on one posting's documents. Pure: the scorecard is re-made from saved output
 * (and the verdicts written after reading the flags) without any model call.
 */

/** Phrases a hiring manager reads as filler or as machine-written. */
const CLICHES: { label: string; pattern: RegExp }[] = [
	{ label: "excited to", pattern: /\b(?:I am|I'm) (?:so |really )?excited\b/i },
	{ label: "writing to apply", pattern: /\bI am writing to\b/i },
	{ label: "passionate", pattern: /\bpassion(?:ate)?\b/i },
	{
		label: "great fit",
		pattern: /\b(?:great|perfect|strong|ideal|natural) fit\b/i,
	},
	{ label: "I believe", pattern: /\bI (?:truly |strongly )?believe\b/i },
	{ label: "thrive", pattern: /\bthriv(?:e|ing)\b/i },
	{ label: "leverage", pattern: /\bleverag(?:e|ing)\b/i },
	{ label: "stands out", pattern: /\bstands? out\b/i },
	{ label: "resonates", pattern: /\breson(?:ate|ates|ated)\b/i },
	{
		label: "aligns",
		pattern: /\balign(?:s|ed)? (?:with|perfectly|closely|well)\b/i,
	},
	{ label: "fast-paced", pattern: /\bfast-paced\b/i },
	{ label: "dynamic", pattern: /\bdynamic team\b/i },
	{ label: "eager", pattern: /\beager to\b/i },
	{ label: "unique opportunity", pattern: /\bunique opportunity\b/i },
	{ label: "I'm confident", pattern: /\bI(?: am|'m) confident\b/i },
	{ label: "track record", pattern: /\b(?:proven )?track record\b/i },
	{ label: "hit the ground running", pattern: /\bhit the ground running\b/i },
	{ label: "look forward", pattern: /\blook(?:ing)? forward to\b/i },
	{ label: "deeply", pattern: /\bdeeply\b/i },
	{ label: "exactly the kind", pattern: /\bexactly the (?:kind|sort|type)\b/i },
	{ label: "speaks to me", pattern: /\bspeaks to me\b/i },
	{ label: "drawn to", pattern: /\bdrawn to\b/i },
	{ label: "compelling", pattern: /\bcompelling\b/i },
	{ label: "genuinely", pattern: /\bgenuine(?:ly)?\b/i },
	{ label: "not just X but Y", pattern: /\bnot just\b[^.]{1,60}\bbut\b/i },
	{ label: "honest gap", pattern: /\bhonest(?:ly)? (?:gap|note)\b/i },
	{
		label: "colon set-up",
		pattern: /\b(?:is|was|are) (?:simple|clear|straightforward):/i,
	},
	{
		label: "what excites me",
		pattern: /\bwhat (?:excites|attracts) me\b/i,
	},
	{
		label: "would welcome",
		pattern: /\bI(?:'d| would) welcome the (?:chance|opportunity)\b/i,
	},
];

const PLACEHOLDER =
	/\{\{[^}]*\}\}|\[(?:[A-Z][A-Za-z ]+|Company|Name|Date|X+)\]|<[a-z][^>]*>|\bTODO\b|\bXXX\b|\bTBD\b|\blorem\b/i;

function words(text: string): number {
	return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function sentences(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+(?=[A-Z"'“‘(])/)
		.map((s) => s.trim())
		.filter((s) => words(s) > 2);
}

/** The letter's body: paragraphs between the greeting and the sign-off. */
function letterBody(letter: string): string[] {
	const paragraphs = letter
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);
	const start = paragraphs.findIndex((p) => /^Dear\b/i.test(p));
	const end = paragraphs.findIndex((p) =>
		/^(?:Best regards|Kind regards|Regards|Sincerely)\b/i.test(p),
	);
	return paragraphs.slice(start + 1, end === -1 ? undefined : end);
}

function clicheHits(text: string): string[] {
	return CLICHES.flatMap(({ label, pattern }) => {
		const m = text.match(pattern);
		return m ? [`${label}: "${m[0]}"`] : [];
	});
}

/** How many sentences open with "I", and the opener most repeated (first two words). */
function openers(text: string) {
	const all = sentences(text);
	const startsI = all.filter((s) => /^I\b/.test(s)).length;
	const counts = new Map<string, number>();
	for (const s of all) {
		const key = s.split(/\s+/).slice(0, 2).join(" ").toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const [top, topCount] = [...counts.entries()].sort(
		(a, b) => b[1] - a[1],
	)[0] ?? ["", 0];
	return { sentences: all.length, startsI, top, topCount };
}

export interface DocScore {
	letterWords: number;
	letterParagraphs: number;
	longestParagraphWords: number;
	letterSentences: number;
	letterStartsI: number;
	letterTopOpener: string;
	letterEmDashes: number;
	letterCliches: string[];
	namesCompany: boolean;
	namesRole: boolean;
	answers: {
		question: string;
		words: number;
		emDashes: number;
		cliches: string[];
		startsWithI: boolean;
		/** For the posting's own form questions: does the first sentence answer it? */
		answersIt: boolean | null;
		expected: string | null;
	}[];
	missingFormQuestions: string[];
	answersSameOpener: number;
	placeholders: string[];
	cvWords: number;
}

export function scoreDocuments(
	posting: EvalPosting,
	docs: { cv: string; coverLetter: string; formAnswers: FormAnswer[] },
): DocScore {
	const body = letterBody(docs.coverLetter);
	const bodyText = body.join("\n\n");
	const o = openers(bodyText);
	const answers = docs.formAnswers.map((a) => {
		const asked = posting.questions.find((q) => q.match.test(a.question));
		const first = sentences(a.answer)[0] ?? a.answer;
		return {
			question: a.question,
			words: words(a.answer),
			emDashes: (a.answer.match(/—/g) ?? []).length,
			cliches: clicheHits(a.answer),
			startsWithI: /^I\b/.test(a.answer.trim()),
			answersIt: asked ? asked.expect.test(first) : null,
			expected: asked?.label ?? null,
		};
	});
	const firstWords = docs.formAnswers.map((a) =>
		a.answer.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase(),
	);
	const counts = new Map<string, number>();
	for (const w of firstWords) counts.set(w, (counts.get(w) ?? 0) + 1);
	return {
		letterWords: words(docs.coverLetter),
		letterParagraphs: body.length,
		longestParagraphWords: Math.max(0, ...body.map(words)),
		letterSentences: o.sentences,
		letterStartsI: o.startsI,
		letterTopOpener: `${o.top} ×${o.topCount}`,
		letterEmDashes: (bodyText.match(/—/g) ?? []).length,
		letterCliches: clicheHits(bodyText),
		namesCompany: docs.coverLetter.includes(posting.job.companyName),
		namesRole: docs.coverLetter.includes(posting.job.title),
		answers,
		missingFormQuestions: posting.questions
			.filter((q) => !docs.formAnswers.some((a) => q.match.test(a.question)))
			.map((q) => q.label),
		answersSameOpener: Math.max(0, ...counts.values()),
		placeholders: [
			docs.cv,
			docs.coverLetter,
			...docs.formAnswers.map((a) => a.answer),
		].flatMap((t) => t.match(new RegExp(PLACEHOLDER, "gi")) ?? []),
		cvWords: words(docs.cv),
	};
}
