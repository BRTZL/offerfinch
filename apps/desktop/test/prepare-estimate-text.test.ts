import { describe, expect, it } from "vitest";
import {
	type EstimateStep,
	estimateText,
} from "../src/renderer/lib/prepare-estimate";

const priced = (median: number, low: number, high: number): EstimateStep => ({
	plan: null,
	samples: 4,
	micros: { median, low, high },
	calls: { median: 0, low: 0, high: 0 },
});
const plan = (vendor: "anthropic" | "openai", calls: number): EstimateStep => ({
	plan: vendor,
	samples: 3,
	micros: { median: 0, low: 0, high: 0 },
	calls: { median: calls, low: calls, high: calls },
});

describe("Prepare's estimate in words", () => {
	it("says there is none without history", () => {
		expect(estimateText(null).headline).toBe("No estimate yet");
		expect(estimateText(null).basis).toContain("Nothing has been prepared");
		// A model not connected: say so, not that nothing was prepared.
		expect(estimateText(null, 1, false).basis).toContain("not connected");
	});

	it("gives the median with the recorded range, summed over steps", () => {
		const text = estimateText({
			steps: [
				priced(200_000, 100_000, 600_000),
				priced(30_000, 20_000, 40_000),
			],
		});
		expect(text.headline).toBe("About $0.23 ($0.12–$0.64)");
		expect(text.basis).toContain("4 past preparations");
	});

	it("sums a selection", () => {
		expect(
			estimateText(
				{
					steps: [
						priced(200_000, 100_000, 600_000),
						priced(30_000, 20_000, 40_000),
					],
				},
				3,
			).headline,
		).toBe("For 3 jobs: about $0.69 ($0.36–$1.92)");
	});

	it("shows plan usage in calls, never dollars, for a subscription", () => {
		expect(
			estimateText({ steps: [plan("anthropic", 2), plan("openai", 1)] })
				.headline,
		).toBe(
			"Uses your Claude plan · about 2 calls + uses your ChatGPT plan · about 1 call",
		);
		expect(
			estimateText(
				{ steps: [plan("anthropic", 2), priced(30_000, 20_000, 40_000)] },
				2,
			).headline,
		).toBe(
			"For 2 jobs: about $0.06 ($0.04–$0.08) + uses your Claude plan · about 4 calls",
		);
		// Half calls (an even number of past preparations) are summed before rounding.
		const half = { steps: [plan("anthropic", 1.5), plan("anthropic", 1.5)] };
		expect(estimateText(half).headline).toBe(
			"Uses your Claude plan · about 3 calls",
		);
		expect(estimateText(half, 10).headline).toBe(
			"For 10 jobs: uses your Claude plan · about 30 calls",
		);
	});
});
