import { describe, expect, it, vi } from "vitest";

vi.mock("../src/worker/routers/procedure", () => ({
	protectedProcedure: { handler: (fn: unknown) => fn },
}));
vi.mock("../src/worker/routers/shared", () => ({ worker: () => null }));

const { breakdown, modelOf } = await import(
	"../src/worker/routers/spending-breakdown"
);

const row = (
	provider: string,
	model: string | null,
	calls: number,
	billing = "subscription",
	micros = 0,
) => ({ provider, model, task: "fit-score", billing, calls, micros });

describe("Spending by model", () => {
	it("names a model once, however the call reached it", () => {
		expect(modelOf("claude-subscription:claude-sonnet-5-5", null)).toEqual({
			key: "claude-sonnet-5-5",
			label: "Claude Sonnet 5.5",
			via: "Claude plan",
		});
		expect(modelOf("anthropic:claude-opus-5-5", "claude-opus-5-5")).toEqual({
			key: "claude-opus-5-5",
			label: "Claude Opus 5.5",
			via: "Anthropic API key",
		});
		expect(modelOf("codex-subscription:default", "gpt-6.1-sol").label).toBe(
			"GPT-6.1 Sol",
		);
		expect(modelOf("codex-subscription:default", null)).toEqual({
			key: "codex-subscription:default",
			label: "Codex (account default)",
			via: "ChatGPT plan",
		});
		expect(
			modelOf("opencode:openrouter/qwen-4-coder", "openrouter/qwen-4-coder"),
		).toEqual({
			key: "openrouter/qwen-4-coder",
			label: "Qwen 4 Coder",
			via: "OpenCode (OpenRouter)",
		});
		expect(modelOf("antigravity:gemini-3.8-flash", null)).toEqual({
			key: "gemini-3.8-flash",
			label: "Gemini 3.8 Flash",
			via: "Gemini",
		});
	});

	it("puts a model's plan calls in one row, whether or not its model was recorded", () => {
		const { byModel } = breakdown([
			row("claude-subscription:claude-sonnet-5-5", "claude-sonnet-5-5", 613),
			row("claude-subscription:claude-sonnet-5-5", null, 44),
			row("claude-subscription:claude-opus-5-5", null, 216),
			row("claude-subscription:claude-opus-5-5", "claude-opus-5-5", 172),
			row("codex-subscription:default", "gpt-6.1-sol", 55),
		]);
		expect(
			byModel.map((m) => [m.label, m.calls, m.subscription, m.via]),
		).toEqual([
			["Claude Sonnet 5.5", 657, 657, ["Claude plan"]],
			["Claude Opus 5.5", 388, 388, ["Claude plan"]],
			["GPT-6.1 Sol", 55, 55, ["ChatGPT plan"]],
		]);
	});

	it("keeps the cost of API calls and says both ways a model was paid", () => {
		const { byModel } = breakdown([
			row("claude-subscription:claude-opus-5-5", "claude-opus-5-5", 10),
			row("anthropic:claude-opus-5-5", "claude-opus-5-5", 2, "api", 30_000),
		]);
		expect(byModel).toEqual([
			{
				name: "claude-opus-5-5",
				label: "Claude Opus 5.5",
				calls: 12,
				micros: 30_000,
				subscription: 10,
				via: ["Claude plan", "Anthropic API key"],
			},
		]);
	});
});
