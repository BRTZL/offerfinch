import type { LlmUsage } from "./llm";

/**
 * Estimated LLM prices, USD per million tokens. Estimates only: the provider's invoice is the
 * real cost (discounts, long-context tiers and cache write rates are not all modelled). Update the
 * table and its source when a price changes.
 */
export interface ModelPrice {
	input: number;
	cachedInput: number;
	output: number;
	/** Above this many input tokens the provider charges another rate, which is not in the table. */
	maxInputTokens?: number;
	source: string;
}

const ANTHROPIC =
	"Anthropic model table (claude-api skill, cached 2026-10-06; live: https://platform.claude.com/docs/en/about-claude/pricing)";
const OPENAI =
	"https://developers.openai.com/api/docs/pricing, standard tier, short context (fetched 2026-10-31)";

const MODEL_PRICES: Record<string, ModelPrice> = {
	"claude-fable-5-1": {
		input: 10,
		cachedInput: 0.25,
		output: 50,
		source: ANTHROPIC,
	},
	"claude-opus-5-5": {
		input: 4,
		cachedInput: 0.2,
		output: 20,
		source: ANTHROPIC,
	},
	// Cached-read rates below are not in the source table: charged at the input rate.
	"claude-opus-5": { input: 5, cachedInput: 5, output: 25, source: ANTHROPIC },
	"claude-sonnet-5-5": {
		input: 2,
		cachedInput: 0.2,
		output: 10,
		source: ANTHROPIC,
	},
	"claude-haiku-5-5": {
		input: 0.1,
		cachedInput: 0.1,
		output: 0.5,
		maxInputTokens: 100_000,
		source: ANTHROPIC,
	},
	"gpt-6-astra": {
		input: 10,
		cachedInput: 1,
		output: 50,
		maxInputTokens: 272_000,
		source: OPENAI,
	},
	"gpt-6.1-sol": {
		input: 2,
		cachedInput: 0.1,
		output: 10,
		maxInputTokens: 272_000,
		source: OPENAI,
	},
	"gpt-6.1-terra": {
		input: 1,
		cachedInput: 0.05,
		output: 5,
		maxInputTokens: 272_000,
		source: OPENAI,
	},
	"gpt-6-sol": {
		input: 2,
		cachedInput: 0.2,
		output: 10,
		maxInputTokens: 272_000,
		source: OPENAI,
	},
	"gpt-6-luna": {
		input: 0.1,
		cachedInput: 0.01,
		output: 0.5,
		maxInputTokens: 272_000,
		source: OPENAI,
	},
	fake: {
		input: 0,
		cachedInput: 0,
		output: 0,
		source: "deterministic fake, no cost",
	},
};

/** Used for a model the table does not know, or a call past its priced range: never $0. */
const FALLBACK: ModelPrice = MODEL_PRICES["claude-fable-5-1"] as ModelPrice;

/**
 * Anthropic bills a cache write at 1.25 times the input rate for the 5-minute lifetime (the one
 * this pipeline sets) and 2 times for 1 hour. The worst-case reservation assumes every input token
 * is a 1-hour write.
 */
const CACHE_WRITE_FACTOR = 2;
const CACHE_WRITE_5M_FACTOR = 1.25;

export function priceOf(model: string): ModelPrice | null {
	if (MODEL_PRICES[model]) return MODEL_PRICES[model] ?? null;
	// Dated or suffixed ids ("gpt-6.1-terra-2026-09-01") use their base model's price.
	const base = Object.keys(MODEL_PRICES)
		.filter((id) => model.startsWith(`${id}-`))
		.sort((a, b) => b.length - a.length)[0];
	return base ? (MODEL_PRICES[base] ?? null) : null;
}

export interface CostEstimate {
	/** Estimated cost in micro-dollars (1e-6 USD). */
	micros: number;
	/** Where the price came from, and why the fallback was used when it was. */
	basis: string;
}

export function estimateCost(usage: LlmUsage): CostEstimate {
	const known = priceOf(usage.model);
	const totalInput =
		usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
	const outOfRange =
		known?.maxInputTokens !== undefined && totalInput > known.maxInputTokens;
	const price = known && !outOfRange ? known : FALLBACK;
	const cacheWrite1h = Math.min(
		usage.cacheWrite1hTokens ?? 0,
		usage.cacheWriteTokens,
	);
	const cacheWrite5m = usage.cacheWriteTokens - cacheWrite1h;
	const dollars =
		(usage.inputTokens * price.input +
			usage.cachedInputTokens * price.cachedInput +
			cacheWrite5m * price.input * CACHE_WRITE_5M_FACTOR +
			cacheWrite1h * price.input * CACHE_WRITE_FACTOR +
			usage.outputTokens * price.output) /
		1_000_000;
	return {
		micros: Math.ceil(dollars * 1_000_000),
		basis: !known
			? `estimated; no price for ${usage.model}, charged at the highest known rate`
			: outOfRange
				? `estimated; ${totalInput} input tokens is past the priced range, charged at the highest known rate`
				: `estimated; ${known.source}`,
	};
}

/**
 * Input tokens a request framing adds beyond its text: roles, the output-format wrapper and the
 * structured-output instructions a provider injects. Generous on purpose.
 */
const REQUEST_OVERHEAD_TOKENS = 4_000;

/**
 * An upper bound on the input tokens of a request: one per UTF-8 byte of everything sent (system,
 * prompt and the output schema), since a byte-level BPE token covers at least one byte, plus the
 * framing overhead. Characters-per-token averages undercount emoji, CJK and code.
 */
export function inputTokenBound(parts: string[]): number {
	const encoder = new TextEncoder();
	return (
		parts.reduce((n, part) => n + encoder.encode(part).length, 0) +
		REQUEST_OVERHEAD_TOKENS
	);
}

/** The highest rate in the table for each kind of token: what any answering model can cost. */
function highestRates(): { input: number; output: number } {
	const prices = Object.values(MODEL_PRICES);
	return {
		// Any input token may be a cache write, the most expensive kind.
		input:
			Math.max(...prices.map((p) => Math.max(p.input, p.cachedInput))) *
			CACHE_WRITE_FACTOR,
		output: Math.max(...prices.map((p) => p.output)),
	};
}

/**
 * The most a call not made yet can be charged at settlement: every input token at the highest
 * input rate (a cache write), and every output token it may use at the highest output rate. The
 * answering model may differ from the one asked for (Anthropic's server-side fallback, a dated
 * id), and a call past a model's priced range is charged at the fallback rate, so the configured
 * model's own price is not an upper bound. A local fake (priced at zero, never calls a provider)
 * reserves nothing.
 */
export function worstCaseMicros(
	model: string,
	inputTokens: number,
	maxTokens: number,
): number {
	const known = priceOf(model);
	if (known && known.input === 0 && known.output === 0) return 0;
	const rates = highestRates();
	return Math.ceil(inputTokens * rates.input + maxTokens * rates.output);
}
