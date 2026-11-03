import type { GenerateObjectRequest } from "../scoring/llm";
import { parseFormAnswers } from "../tailor/tailor";
import type {
	ApplicationChatInput,
	ApplicationChatOutput,
	ProfileChatInput,
	ProfileChatOutput,
} from "./chat";

/**
 * Deterministic stand-ins for the chat model, for tests and e2e runs without a model
 * (OFFERFINCH_FAKE_MODELS=1). They read the user's last message and answer by keyword, using
 * only the user's words and the documents' own lines, so their proposals stay supportable.
 */

function lastUserText(history: { role: string; content: string }[]): string {
	return [...history].reverse().find((m) => m.role === "user")?.content ?? "";
}

/** "I actually led …", "I built …": a statement about the user's own work. */
const STATEMENT =
	/^\s*(?:i\s+(?:actually\s+|also\s+)?(?:led|built|ran|managed|wrote|shipped|designed|mentored|owned|created|started|moved)\b)/i;

export function fakeApplicationChatResponder(
	request: GenerateObjectRequest<unknown>,
): ApplicationChatOutput {
	const { input } = request.context as { input: ApplicationChatInput };
	const text = lastUserText(input.history);
	const lower = text.toLowerCase();
	const doc = (kind: string) => input.documents.find((d) => d.kind === kind);
	const editable =
		input.state === "ready_for_review" || input.state === "approved";
	const out: ApplicationChatOutput = { reply: "", edits: [], facts: [] };

	if (STATEMENT.test(text)) {
		out.facts.push({
			question: "What did you tell OfferFinch about your work?",
			answer: text.trim(),
		});
		out.reply =
			"Noted. Save it to your profile and drafts may cite it; the claims check accepts it from then on.";
		return out;
	}
	if (!editable && /letter|cv|answer/.test(lower)) {
		out.reply = `Documents can be changed in review or after approval. This application is ${input.state.replace(/_/g, " ")}.`;
		return out;
	}
	const letter = doc("cover_letter");
	if (letter && /letter|warmer|friendlier/.test(lower)) {
		const lines = letter.content.split("\n");
		const close = lines.findIndex((l) =>
			/^I would welcome a conversation/.test(l),
		);
		const opening = lines.findIndex((l) => /^I am applying for/.test(l));
		if (close >= 0) lines[close] = "I'd welcome a conversation about the role.";
		else if (opening >= 0)
			lines[opening] = (lines[opening] as string).replace(
				/^I am applying/,
				"I'm applying",
			);
		const content = lines.join("\n");
		if (content !== letter.content) {
			out.edits.push({
				document: "cover_letter",
				question: "",
				content,
				summary: "A warmer, shorter closing line.",
			});
			out.reply =
				"Here's a warmer close for the letter. Nothing changes until you accept it.";
			return out;
		}
	}
	const answers = doc("form_answers");
	if (answers && /answer|shorten|shorter/.test(lower)) {
		const parsed = parseFormAnswers(answers.content);
		const first = parsed[0];
		const sentence = first?.answer.match(/^[^.!?]+[.!?]/)?.[0];
		if (first && sentence && sentence !== first.answer) {
			out.edits.push({
				document: "form_answers",
				question: first.question,
				content: sentence,
				summary: "Cut the first answer to its opening sentence.",
			});
			out.reply = "Shortened the first answer to its opening sentence.";
			return out;
		}
	}
	out.reply =
		"Tell me what to change: the letter, the CV or an answer. I can only use what your profile says or what you tell me.";
	return out;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function fakeProfileChatResponder(
	request: GenerateObjectRequest<unknown>,
): ProfileChatOutput {
	const { input } = request.context as { input: ProfileChatInput };
	const text = lastUserText(input.history).trim();
	// "I built Ledgerline at Bluefin Labs in 2024 with Go and Postgres, it cut latency 40%"
	const built = text.match(
		/^i\s+(?:built|made|created|wrote)\s+([^,]+?)(?:\s+at\s+([^,]+?))?(?:\s+in\s+(\d{4}))?(?:\s+with\s+([^,]+?))?(?:,\s*(.+))?$/i,
	);
	if (built?.[1]) {
		const [, name, where, year, stack, result] = built;
		const description = [
			where ? `Built at ${where.trim()}` : "Built",
			year ? `in ${year}` : "",
			stack ? `with ${stack.trim()}` : "",
		]
			.filter(Boolean)
			.join(" ");
		const bullets = result
			? [capitalize(result.replace(/^it\s+/i, "").replace(/\.$/, ""))]
			: [];
		return {
			reply: stack
				? `Here's ${name.trim()} as a project. Accept it to add it to your profile.`
				: `Here's ${name.trim()} as a project. What did you build it with?`,
			records: [
				{
					action: "create",
					recordId: "",
					kind: "project",
					fields: [
						{ key: "name", value: capitalize(name.trim()) },
						{ key: "description", value: `${description}.` },
						{ key: "bullets", value: bullets.join("\n") },
					],
					summary: `New project: ${capitalize(name.trim())}.`,
				},
			],
		};
	}
	const project = input.records.find((r) => r.kind === "project");
	if (project && /improve|reword|tighten/i.test(text)) {
		const description = String(
			(project.data as Record<string, unknown>).description ?? "",
		).trim();
		const tightened = description.replace(/^(?:This is |It is )/i, "");
		if (tightened && tightened !== description)
			return {
				reply: "Tightened the description.",
				records: [
					{
						action: "update",
						recordId: project.id,
						kind: "project",
						fields: [{ key: "description", value: capitalize(tightened) }],
						summary: "Shorter description.",
					},
				],
			};
	}
	return {
		reply:
			"Tell me about a role, project or skill: what you did, where, when and with what. I'll draft it and ask about anything missing.",
		records: [],
	};
}
