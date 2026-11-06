import type { BlobStore } from "@offerfinch/core/export/export";
import type { LlmProvider } from "@offerfinch/core/scoring/llm";
import type { BrowserProvider } from "@offerfinch/core/scrape/browser";
import { describe, expect, it } from "vitest";

import { FAKE_MODEL_REF } from "../src/shared/providers";
import { buildPipeline, sharedDuckDuckGoStops } from "../src/worker/pipeline";
import { type AiSettings, DEFAULT_AI } from "../src/worker/settings";

/** Stand-ins for the models on the user's sign-ins: named like the real ones, never called. */
const local = ({ provider, model }: { provider: string; model: string }) =>
	({
		name: `${provider}-subscription:${model || "default"}`,
		billing: "subscription",
		vendor: provider === "codex" ? "openai" : "anthropic",
		generateObject: async () => {
			throw new Error("not in tests");
		},
	}) as LlmProvider;

function build(ai: AiSettings, platform = "darwin") {
	return buildPipeline({
		db: {} as never,
		ai,
		platform,
		workflows: { runtime: "local" } as never,
		browser: {} as BrowserProvider,
		blobs: {} as BlobStore,
		notifier: { notifyStrongMatch: async () => {} },
		fakeModels: false,
		local,
		ownerUserId: "local",
		userData: "/tmp/offerfinch-test",
		siteHost: {
			site: async () => {
				throw new Error("no site tabs in tests");
			},
			onCheck: () => {},
			onCheckDone: () => {},
		},
		log: () => {},
	});
}

describe("model roles", () => {
	it("runs each step on the model it names, the same model for all three included", () => {
		const { roles, deps } = build({
			scoring: { model: "claude:claude-opus-5-5" },
			tailoring: { model: "claude:claude-opus-5-5" },
			claims: { model: "claude:claude-opus-5-5" },
		});
		expect(roles.map((r) => [r.role, r.provider, r.billing, r.ready])).toEqual([
			["scoring", "claude-subscription:claude-opus-5-5", "subscription", true],
			[
				"tailoring",
				"claude-subscription:claude-opus-5-5",
				"subscription",
				true,
			],
			["claims", "claude-subscription:claude-opus-5-5", "subscription", true],
		]);
		expect(roles.every((r) => r.problem === null)).toBe(true);
		expect(deps.claimsLlm?.name).toBe("claude-subscription:claude-opus-5-5");
	});

	it("mixes providers in any order, Codex on the account's default model", () => {
		const { roles } = build({
			scoring: { model: "codex:" },
			tailoring: { model: "codex:gpt-6.1-sol" },
			claims: { model: "codex:" },
		});
		expect(roles.map((r) => [r.provider, r.model, r.ready])).toEqual([
			["codex-subscription:default", "codex:", true],
			["codex-subscription:gpt-6.1-sol", "codex:gpt-6.1-sol", true],
			["codex-subscription:default", "codex:", true],
		]);
	});

	it("pauses steps without a model instead of failing", () => {
		const none = build(DEFAULT_AI);
		expect(none.roles.map((r) => r.ready)).toEqual([false, false, false]);
		expect(none.roles[0]?.problem).toBe(
			"Choose a model for Finding matches in Settings > Models.",
		);
		expect(none.roles[0]?.provider).toBe("not-connected:scoring");
	});

	it("pauses a provider this version or platform can't run, and the test models outside test runs", () => {
		const later = build({
			scoring: { model: "opencode:opencode-go/glm-5.1" },
			tailoring: { model: "antigravity:gemini-3.8-flash" },
			claims: { model: FAKE_MODEL_REF },
		});
		expect(later.roles.map((r) => r.ready)).toEqual([true, false, false]);
		expect(later.roles[0]?.problem).toBeNull();
		expect(later.roles[1]?.problem).toMatch(/Antigravity\) models are not/);
		expect(later.roles[2]?.problem).toMatch(/only available in test runs/);
		const windows = build(
			{
				scoring: { model: "claude:claude-opus-5-5" },
				tailoring: { model: "codex:" },
				claims: { model: "opencode:opencode/deepseek-v4.1-flash-free" },
			},
			"win32",
		);
		expect(windows.roles.map((r) => r.ready)).toEqual([true, false, false]);
		expect(windows.roles[1]?.problem).toMatch(/Codex runs only on macOS/);
		expect(windows.roles[2]?.problem).toMatch(
			/OpenCode is not available on Windows/,
		);
	});
});

describe("one DuckDuckGo hold for job-board search and web search", () => {
	it("a check either meets holds both, and clearing it clears both", async () => {
		const stops = new Map<
			string,
			{ kind: "captcha"; reason: string; at: string }
		>();
		const store = {
			other: () => "still the store's own",
			stopped: async (_u: string, id: string) => stops.get(id) ?? null,
			stop: async (
				_u: string,
				id: string,
				r: { kind: "captcha"; reason: string; at: string },
			) => {
				stops.set(id, r);
			},
			clearStop: async (_u: string, id: string) => {
				stops.delete(id);
			},
		};
		const shared = sharedDuckDuckGoStops(store);
		const record = {
			kind: "captcha" as const,
			reason: "DuckDuckGo's bot check",
			at: "x",
		};
		await shared.stop("u1", "job-board-search", record);
		expect(await shared.stopped("u1", "web-search")).toEqual(record);
		expect([...stops.keys()].sort()).toEqual([
			"job-board-search",
			"web-search",
		]);
		expect(shared.other()).toBe("still the store's own");
		await shared.clearStop("u1", "web-search");
		expect(stops.size).toBe(0);
	});
});
