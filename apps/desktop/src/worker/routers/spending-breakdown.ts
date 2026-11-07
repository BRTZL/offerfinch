import { protectedProcedure } from "./procedure";
import { worker } from "./shared";

/** How a call was paid for, from its provider (`<provider>:<model>`). */
const VIA: Record<string, string> = {
	"claude-subscription": "Claude plan",
	"codex-subscription": "ChatGPT plan",
	opencode: "OpenCode",
	antigravity: "Gemini",
	anthropic: "Anthropic API key",
	openai: "OpenAI API key",
};

/** OpenCode's billing sources (the part before "/" in its model ids) by name. */
const OPENCODE_SOURCE: Record<string, string> = {
	"opencode-go": "Go plan",
	"zai-coding-plan": "Z.ai Coding Plan",
	opencode: "OpenCode Zen",
	openrouter: "OpenRouter",
	anthropic: "Anthropic",
	openai: "OpenAI",
};

/** "claude-opus-5-5" → "Claude Opus 5.5", "gpt-6.1-sol" → "GPT-6.1 Sol". */
function modelLabel(id: string): string {
	const parts = id.split("-");
	const words: string[] = [];
	const version: string[] = [];
	for (const part of parts) {
		if (/^\d+(\.\d+)?$/.test(part)) version.push(part);
		else {
			if (version.length) words.push(version.splice(0).join("."));
			words.push(
				part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1),
			);
		}
	}
	if (version.length) words.push(version.join("."));
	// "GPT 6.1 Sol" reads as OpenAI writes it: "GPT-6.1 Sol".
	return words.join(" ").replace(/^GPT (\d)/, "GPT-$1");
}

/**
 * One model, whichever way the call reached it: the same model through the Claude plan or an
 * API key is one row (the row says how it was paid). A call recorded before its model was known
 * (an empty `model`) takes the model from its provider name; Codex's "default" stays its own row,
 * since which model the account defaulted to was not recorded.
 */
export function modelOf(provider: string, model: string | null) {
	const colon = provider.indexOf(":");
	const kind = colon === -1 ? provider : provider.slice(0, colon);
	const fromProvider = colon === -1 ? "" : provider.slice(colon + 1);
	const id = model || fromProvider || provider;
	// OpenCode ids carry their billing source: "openrouter/qwen-4-coder".
	const slash = id.lastIndexOf("/");
	const source = slash === -1 ? "" : id.slice(0, id.indexOf("/"));
	const label =
		id === "default"
			? kind === "codex-subscription"
				? "Codex (account default)"
				: "Default model"
			: modelLabel(id.slice(slash + 1));
	const via = VIA[kind] ?? kind;
	return {
		key: id === "default" ? `${kind}:default` : id,
		label,
		via: source ? `${via} (${OPENCODE_SOURCE[source] ?? source})` : via,
	};
}

type Row = {
	provider: string;
	model: string | null;
	task: string;
	billing: string;
	calls: number;
	micros: number | null;
};

type Total = {
	name: string;
	label: string;
	calls: number;
	micros: number;
	subscription: number;
	/** How these calls were paid ("Claude plan", "OpenAI API key"), most calls first. */
	via: string[];
};

/** Sums the month's calls by model (one row per model, however it was reached) and by step. */
export function breakdown(rows: Row[]) {
	const sum = (
		keyOf: (r: Row) => { key: string; label: string; via: string },
	) => {
		const by = new Map<string, Total & { viaCalls: Map<string, number> }>();
		for (const r of rows) {
			const { key, label, via } = keyOf(r);
			const e = by.get(key) ?? {
				name: key,
				label,
				calls: 0,
				micros: 0,
				subscription: 0,
				via: [],
				viaCalls: new Map<string, number>(),
			};
			e.calls += r.calls;
			if (r.billing === "subscription") e.subscription += r.calls;
			else e.micros += r.micros ?? 0;
			e.viaCalls.set(via, (e.viaCalls.get(via) ?? 0) + r.calls);
			by.set(key, e);
		}
		return [...by.values()]
			.map(({ viaCalls, ...v }) => ({
				...v,
				via: [...viaCalls.entries()]
					.sort((a, b) => b[1] - a[1])
					.map(([name]) => name)
					.filter(Boolean),
			}))
			.sort((a, b) => b.micros - a.micros || b.calls - a.calls);
	};
	return {
		byModel: sum((r) => modelOf(r.provider, r.model)),
		byStep: sum((r) => ({ key: r.task, label: r.task, via: "" })),
	};
}

export const spendingBreakdownRouter = {
	/**
	 * This calendar month's (UTC) model calls by model and by step: priced API calls with
	 * their cost (settled, or the estimate while running), subscription calls counted.
	 */
	get: protectedProcedure.handler(({ context }) => {
		const start = new Date();
		start.setUTCDate(1);
		start.setUTCHours(0, 0, 0, 0);
		const rows = worker()
			.db.$client.prepare(
				`select provider, model, task, billing,
					  count(*) as calls,
					  sum(case when status = 'settled' then cost_micros else estimate_micros end) as micros
					from llm_usage where user_id = ? and created_at >= ?
					group by provider, model, task, billing`,
			)
			.all(context.session.user.id, start.getTime()) as Row[];
		return breakdown(rows);
	}),
};
