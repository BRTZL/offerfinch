import { usd } from "./money";

/** The estimate the worker returns (`application.prepareEstimate`), one entry per step. */
export interface EstimateStep {
	plan: "anthropic" | "openai" | null;
	samples: number;
	micros: { median: number; low: number; high: number };
	calls: { median: number; low: number; high: number };
}

/** The plan each subscription vendor bills, in the words Settings › Models uses. */
const PLAN: Record<"anthropic" | "openai", string> = {
	anthropic: "Claude",
	openai: "ChatGPT",
};

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/**
 * Prepare's likely cost in words, for one job or `jobs` of them: the median with the recorded
 * range in dollars for API models, plan usage in calls for a subscription (never "$0", which
 * would read as free), "No estimate yet" without history.
 */
export function estimateText(
	estimate: { steps: EstimateStep[] } | null | undefined,
	jobs = 1,
	connected = true,
): { headline: string; basis: string } {
	if (!estimate)
		return {
			headline: "No estimate yet",
			basis: connected
				? "Nothing has been prepared with your current models, so there is no cost on record to go by."
				: "A model for drafting or checking is not connected yet (Settings › Models).",
		};
	const parts: string[] = [];
	const priced = estimate.steps.filter((s) => s.plan === null);
	if (priced.length > 0) {
		const sum = (k: "median" | "low" | "high") =>
			priced.reduce((n, s) => n + s.micros[k], 0) * jobs;
		const [median, low, high] = [sum("median"), sum("low"), sum("high")];
		parts.push(
			low === high
				? `about ${usd(median)}`
				: `about ${usd(median)} (${usd(low)}–${usd(high)})`,
		);
	}
	for (const vendor of ["anthropic", "openai"] as const) {
		const steps = estimate.steps.filter((s) => s.plan === vendor);
		if (steps.length === 0) continue;
		const calls = Math.max(
			1,
			Math.round(steps.reduce((n, s) => n + s.calls.median, 0) * jobs),
		);
		parts.push(
			`uses your ${PLAN[vendor]} plan · about ${plural(calls, "call")}`,
		);
	}
	const samples = Math.min(...estimate.steps.map((s) => s.samples));
	const text = parts.join(" + ");
	return {
		headline:
			jobs > 1
				? `For ${jobs} jobs: ${text}`
				: `${text.charAt(0).toUpperCase()}${text.slice(1)}`,
		basis: `Estimated from ${plural(samples, "past preparation")} with your current models. A redraft or a long posting costs more.`,
	};
}
