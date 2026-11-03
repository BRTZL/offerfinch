import type { BlobStore } from "@offerfinch/core/export/export";
import type { LlmProvider } from "@offerfinch/core/scoring/llm";
import type { BrowserProvider } from "@offerfinch/core/scrape/browser";
import { describe, expect, it } from "vitest";

import {
	buildPipeline,
	sharedDuckDuckGoStops,
	VENDOR_RULE,
} from "../src/worker/pipeline";
import { type AiSettings, DEFAULT_AI } from "../src/worker/settings";

/** Subscription providers stand-ins: named like the real ones, never called. */
const local = ({ provider, model }: { provider: string; model: string }) =>
	({
		name: `${provider}:${model || "default"}`,
		billing: "subscription",
		vendor: provider.startsWith("codex") ? "openai" : "anthropic",
		generateObject: async () => {
			throw new Error("not in tests");
		},
	}) as LlmProvider;

function build(ai: AiSettings, secrets = {}) {
	return buildPipeline({
		db: {} as never,
		ai,
		secrets,
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
	it("runs scoring and tailoring on Claude and the claims check on Codex", () => {
		const { roles, deps } = build({
			scoring: { mode: "claude-subscription" },
			tailoring: { mode: "claude-subscription" },
			claims: { mode: "codex-subscription" },
		});
		expect(roles.map((r) => [r.role, r.provider, r.billing, r.ready])).toEqual([
			["scoring", "claude-subscription:claude-opus-5-5", "subscription", true],
			[
				"tailoring",
				"claude-subscription:claude-sonnet-5-5",
				"subscription",
				true,
			],
			["claims", "codex-subscription:default", "subscription", true],
		]);
		expect(deps.claimsLlm?.name).toBe("codex-subscription:default");
	});

	it("refuses Claude for the claims check and Codex for drafting, with the rule", () => {
		const { roles } = build({
			scoring: { mode: "codex-subscription" },
			tailoring: { mode: "api" },
			claims: { mode: "claude-subscription" },
		});
		expect(roles[0]?.problem).toContain("Codex runs the claims check only");
		expect(roles[2]?.problem).toContain(VENDOR_RULE);
		expect(roles.every((r) => !r.ready)).toBe(true);
	});

	it("pauses roles without keys instead of failing, and mixes keys with a subscription", () => {
		const none = build(DEFAULT_AI);
		expect(none.roles.map((r) => r.ready)).toEqual([false, false, false]);
		const mixed = build(
			{
				scoring: { mode: "api" },
				tailoring: { mode: "api" },
				claims: { mode: "codex-subscription", model: "gpt-6.1-terra" },
			},
			{ anthropic: "sk-ant-test" },
		);
		expect(mixed.roles.map((r) => [r.provider, r.billing])).toEqual([
			["anthropic:claude-opus-5-5", "api"],
			["anthropic:claude-sonnet-5-5", "api"],
			["codex-subscription:gpt-6.1-terra", "subscription"],
		]);
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
