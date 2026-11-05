import { describe, expect, it } from "vitest";
import {
	type AiChoice,
	autoFill,
	providerOfRef,
	readyNow,
} from "../src/shared/auto-connect";
import {
	FAKE_MODEL_REF,
	formatModelRef,
	type ModelInfo,
	type ProviderId,
} from "../src/shared/providers";

const model = (
	provider: ProviderId,
	id: string,
	billing: ModelInfo["billing"] = "subscription",
): ModelInfo => ({
	ref: formatModelRef(provider, id),
	name: id,
	provider,
	billing,
	efforts: [],
});
const CLAUDE = [model("claude", "claude-opus-5-5")];
const CODEX = [model("codex", ""), model("codex", "gpt-6.1-sol")];

const fresh: AiChoice = {
	scoring: { model: null },
	tailoring: { model: null },
	claims: { model: null },
};

const CLAUDE_ALL: AiChoice = {
	scoring: { model: "claude:claude-opus-5-5" },
	tailoring: { model: "claude:claude-sonnet-5-5" },
	claims: { model: "claude:claude-opus-5-5" },
};
const CODEX_ALL: AiChoice = {
	scoring: { model: "codex:" },
	tailoring: { model: "codex:" },
	claims: { model: "codex:" },
};

describe("Connect AI fills the steps without a model", () => {
	it("Claude signed in: Claude does all three, Codex or not", () => {
		for (const codex of [true, false]) {
			const r = autoFill({
				settings: fresh,
				available: { claude: CLAUDE, ...(codex ? { codex: CODEX } : {}) },
			});
			expect(r.filled).toEqual(["scoring", "tailoring", "claims"]);
			expect(r.settings).toEqual(CLAUDE_ALL);
		}
	});

	it("Codex only: Codex does all three, on the account's default model", () => {
		const r = autoFill({
			settings: fresh,
			available: { codex: CODEX },
		});
		expect(r.filled).toEqual(["scoring", "tailoring", "claims"]);
		expect(r.settings).toEqual(CODEX_ALL);
	});

	it("no Claude or Codex: the first plan model, never a pay-per-use one", () => {
		const paid = model("opencode", "openrouter/minimax-m2.7", "api");
		const plan = model("opencode", "opencode-go/glm-5.1");
		const gemini = model("antigravity", "gemini-3.8-flash");
		expect(
			autoFill({
				settings: fresh,
				available: { opencode: [paid, plan], antigravity: [gemini] },
			}).settings.scoring,
		).toEqual({ model: plan.ref });
		const r = autoFill({
			settings: fresh,
			available: { opencode: [paid], antigravity: [gemini] },
		});
		expect(r.settings.claims).toEqual({ model: gemini.ref });
		expect(
			autoFill({ settings: fresh, available: { opencode: [paid] } }).filled,
		).toEqual([]);
	});

	it("fills only the steps asked for", () => {
		const r = autoFill({
			settings: fresh,
			available: { codex: CODEX },
			only: ["claims"],
		});
		expect(r.filled).toEqual(["claims"]);
		expect(r.settings.scoring).toEqual({ model: null });
	});

	it("neither: nothing changes", () => {
		const r = autoFill({ settings: fresh, available: {} });
		expect(r.filled).toEqual([]);
		expect(r.settings).toEqual(fresh);
	});

	it("never changes a choice already made, and fills only the steps left", () => {
		const made: AiChoice = {
			scoring: { model: FAKE_MODEL_REF },
			tailoring: { model: "codex:gpt-6.1-terra", effort: "high" },
			claims: { model: null },
		};
		const r = autoFill({
			settings: made,
			available: { claude: CLAUDE, codex: CODEX },
		});
		expect(r.filled).toEqual(["claims"]);
		expect(r.settings).toEqual({
			...made,
			claims: { model: "claude:claude-opus-5-5" },
		});
	});
});

describe("a step is ready only while its provider is signed in", () => {
	const roles = [
		{ role: "scoring" as const, model: "claude:claude-opus-5-5", ready: true },
		{
			role: "tailoring" as const,
			model: "claude:claude-sonnet-5-5",
			ready: true,
		},
		{ role: "claims" as const, model: "codex:", ready: true },
	];

	it("both signed in: all ready", () => {
		expect(
			readyNow(roles, { claude: true, codex: true }).map((r) => r.ready),
		).toEqual([true, true, true]);
	});

	it("Claude signed out: its steps keep the choice but are not ready", () => {
		const now = readyNow(roles, { claude: false, codex: true });
		expect(now.map((r) => r.model)).toEqual(roles.map((r) => r.model));
		expect(now.map((r) => r.ready)).toEqual([false, false, true]);
	});

	it("Codex gone: the checker is not ready", () => {
		expect(
			readyNow(roles, { claude: true, codex: false }).map((r) => r.ready),
		).toEqual([true, true, false]);
	});

	it("test models need no sign-in; no model is never ready", () => {
		const other = [
			{ role: "scoring" as const, model: FAKE_MODEL_REF, ready: true },
			{ role: "tailoring" as const, model: null, ready: false },
			{
				role: "claims" as const,
				model: "opencode:opencode-go/glm-5.1",
				ready: true,
			},
		];
		expect(readyNow(other, {}).map((r) => r.ready)).toEqual([
			true,
			false,
			false,
		]);
	});

	it("names the provider of a reference; none for the test models or no choice", () => {
		expect(providerOfRef("claude:claude-opus-5-5")).toBe("claude");
		expect(providerOfRef("codex:")).toBe("codex");
		expect(providerOfRef(FAKE_MODEL_REF)).toBeNull();
		expect(providerOfRef(null)).toBeNull();
		expect(providerOfRef("nonsense")).toBeNull();
	});
});
