import {
	applyPlanSnapshot,
	emptyPlanUsage,
} from "@offerfinch/core/scoring/plan-usage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type Database,
	DrizzlePlanUsageStore,
	DrizzleSpendStore,
} from "../src/index";
import { testDb } from "./setup";

let db: Database;

beforeAll(async () => {
	db = await testDb();
});

afterAll(() => {
	db.$close();
});

describe("DrizzlePlanUsageStore", () => {
	it("keeps one state per vendor and reads it back whole", async () => {
		const store = new DrizzlePlanUsageStore(db);
		expect(await store.load("u1", "anthropic")).toBeNull();
		const at = new Date("2026-11-04T10:00:00Z");
		const state = applyPlanSnapshot(
			emptyPlanUsage("anthropic"),
			{
				at,
				complete: true,
				windows: [
					{
						id: "five_hour",
						label: "Session",
						kind: "session",
						usedPercent: 42,
						resetsAt: new Date("2026-11-04T14:00:00Z"),
						durationMins: 300,
					},
				],
				account: {
					plan: "max",
					extraUsage: {
						enabled: false,
						used: null,
						limit: null,
						currency: null,
					},
					credits: null,
				},
			},
			true,
		);
		await store.save("u1", state);
		expect(await store.load("u1", "anthropic")).toEqual(state);
		expect(await store.load("u1", "openai")).toBeNull();
		const later = applyPlanSnapshot(
			state,
			{
				at: new Date("2026-11-04T10:05:00Z"),
				complete: false,
				windows: [
					{
						id: "five_hour",
						label: "Session",
						kind: "session",
						usedPercent: 45,
						resetsAt: null,
						durationMins: null,
					},
				],
			},
			false,
		);
		await store.save("u1", later);
		expect(await store.load("u1", "anthropic")).toEqual(later);
	});
});

describe("subscriptionCallsSince", () => {
	it("counts a vendor's prompts and tokens since a window started", async () => {
		const spend = new DrizzleSpendStore(db);
		const reserve = async (provider: string) => {
			const r = await spend.reserveSpend({
				userId: "u1",
				applicationId: null,
				task: "fit-score",
				provider,
				estimateMicros: 1_000,
				billing: "subscription",
				modelCalls: 1,
			});
			if (!r.ok) throw new Error(`reserve refused: ${r.reason}`);
			return r.id;
		};
		await spend.confirmExtraUsageOff("u1", true);
		const claude = await reserve("claude-subscription:claude-sonnet-5-5");
		await spend.settleSpend(claude, {
			usage: {
				model: "claude-sonnet-5-5",
				inputTokens: 100,
				outputTokens: 20,
				cachedInputTokens: 50,
				cacheWriteTokens: 10,
			},
			costMicros: 0,
			basis: "plan",
			error: null,
			billing: "subscription",
			modelCalls: 1,
		});
		await reserve("claude-subscription:claude-sonnet-5-5");
		await reserve("codex-subscription:default");
		const since = new Date(Date.now() - 60_000);
		expect(
			await spend.subscriptionCallsSince("u1", "anthropic", since),
		).toEqual({ calls: 2, inputTokens: 160, outputTokens: 20 });
		expect(await spend.subscriptionCallsSince("u1", "openai", since)).toEqual({
			calls: 1,
			inputTokens: 0,
			outputTokens: 0,
		});
		expect(
			await spend.subscriptionCallsSince(
				"u1",
				"anthropic",
				new Date(Date.now() + 60_000),
			),
		).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
	});
});
