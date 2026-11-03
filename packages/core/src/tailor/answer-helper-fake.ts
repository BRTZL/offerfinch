import type { GenerateObjectRequest } from "../scoring/llm";
import type { AnswerHelperInput } from "./answer-helper";

/**
 * A deterministic stand-in for the answer helper's model, for tests and e2e runs without one
 * (OFFERFINCH_FAKE_MODELS=1). It follows the real rules in miniature: "all of them" becomes the
 * tools the question lists, "and more" stays vague and is reported missing, and every part of
 * the question the draft does not touch is listed as missing. It never adds a fact.
 */

/** The examples a question lists: "(for example Lighthouse, Chrome DevTools, and X)". */
function examplesOf(question: string): string[] {
	const list = question.match(
		/\((?:for example|e\.g\.,?|such as)\s+([^)]*)\)/i,
	);
	if (!list?.[1]) return [];
	return list[1]
		.split(/,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** The question's parts: "Which tools have you used, and have you worked to a budget?" is two. */
function partsOf(question: string): string[] {
	return question
		.replace(/\s*\([^)]*\)/g, "")
		.replace(/\?\s*$/, "")
		.split(/,\s*and\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const joinList = (items: string[]) =>
	items.length < 2
		? (items[0] ?? "")
		: `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export function fakeAnswerHelperResponder(
	request: GenerateObjectRequest<unknown>,
): { answer: string; missing: string[] } {
	const { input } = request.context as { input: AnswerHelperInput };
	const draft = input.draft.trim();
	const parts = partsOf(input.question);
	if (!draft)
		return {
			answer: parts.map((p) => `[${p}?]`).join(" "),
			missing: parts.map((p) => `Not in your profile yet: ${p}?`),
		};
	const examples = examplesOf(input.question);
	const all = /\ball (?:of )?(?:them|those)\b/i.test(draft);
	const more = /\band (?:more|others)\b/i.test(draft);
	const sentences: string[] = [];
	if (all && examples.length)
		sentences.push(
			`I have used ${joinList(examples)}${more ? ", and other tools" : ""}.`,
		);
	else sentences.push(draft.replace(/^\w/, (c) => c.toUpperCase()));
	const missing: string[] = [];
	if (more) missing.push('Which tools "and more" covers, by name');
	// The first part is the one the draft answered; the rest are missing unless it names them.
	for (const part of parts.slice(1)) {
		const words = part
			.toLowerCase()
			.split(/\W+/)
			.filter((w) => w.length > 4);
		if (!words.some((w) => draft.toLowerCase().includes(w)))
			missing.push(`Not answered yet: ${part}?`);
	}
	return { answer: sentences.join(" "), missing };
}
