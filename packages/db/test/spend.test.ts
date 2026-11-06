import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	DrizzleSpendStore,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let other: Database;

beforeAll(async () => {
	db = await testDb();
	// Two stores on the one connection the app uses: their transactions are in flight together,
	// and only the transaction lock (client.ts) keeps one from reading before the other's insert.
	other = db;
});

afterAll(async () => {
	db.$close();
});

describe("spending cap in SQLite", () => {
	it("lets only one of two parallel calls through when the cap fits one", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 1_000_000,
		});
		const reserve = (store: DrizzleSpendStore) =>
			store.reserveSpend({
				userId: "u1",
				applicationId: null,
				task: "tailor",
				provider: "anthropic:claude-opus-5-5",
				estimateMicros: 700_000,
			});
		const results = await Promise.all([
			reserve(new DrizzleSpendStore(db)),
			reserve(new DrizzleSpendStore(other)),
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const refused = results.find((r) => !r.ok);
		expect(refused).toMatchObject({ ok: false, capMicros: 1_000_000 });
	});

	it("settles a call at its reported cost and reports the month's spend", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 5_000_000,
		});
		const store = new DrizzleSpendStore(db);
		const reserved = await store.reserveSpend({
			userId: "u1",
			applicationId: null,
			task: "fit-score",
			provider: "anthropic:claude-opus-5-5",
			estimateMicros: 400_000,
		});
		if (!reserved.ok) throw new Error("refused");
		await store.settleSpend(reserved.id, {
			usage: {
				model: "claude-opus-5-5",
				inputTokens: 10_000,
				outputTokens: 2_000,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
			},
			costMicros: 80_000,
			basis: "estimated",
			error: null,
		});
		expect(await repo.spending("u1")).toMatchObject({
			enabled: true,
			capMicros: 5_000_000,
			spentMicros: 80_000,
			reservedMicros: 0,
			reached: false,
		});
	});

	it("stores the highest cap the dashboard allows and refuses more", async () => {
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 2_000_000_000,
		});
		expect((await repo.spending("u1")).capMicros).toBe(2_000_000_000);
		await expect(
			repo.setSpendingCap("u1", {
				enabled: true,
				monthlyCapMicros: 2_000_000_001,
			}),
		).rejects.toThrow(/between \$0 and \$2,000/);
	});

	it("holds an API call with an unknown outcome against this month's cap", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		const store = new DrizzleSpendStore(db);
		const reserved = await store.reserveSpend({
			userId: "u1",
			applicationId: null,
			task: "tailor",
			provider: "anthropic:claude-opus-5-5",
			estimateMicros: 300_000,
		});
		if (!reserved.ok) throw new Error("refused");
		await store.holdSpend(reserved.id, {
			basis: "outcome unknown",
			error: "stream ended",
		});
		expect(await repo.spending("u1")).toMatchObject({
			reservedMicros: 300_000,
			held: { count: 1, micros: 300_000 },
		});
		// Next month it no longer counts.
		const later = new DrizzleSpendStore(
			db,
			() => new Date(Date.now() + 32 * 86_400_000),
		);
		expect((await later.spendingStatus("u1")).reservedMicros).toBe(0);
	});
});

describe("subscription calls in Postgres", () => {
	const reserveSub = (store: DrizzleSpendStore, estimateMicros = 300_000) =>
		store.reserveSpend({
			userId: "u1",
			applicationId: null,
			task: "tailor",
			provider: "claude-subscription:claude-sonnet-5-5",
			estimateMicros,
			billing: "subscription",
		});

	it("needs no confirmation click, and refuses them once a paid call paused Claude", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 20_000_000,
		});
		const store = new DrizzleSpendStore(db);
		// Not confirmed: the provider's own check before each call guards extra usage.
		await store.confirmExtraUsageOff("u1", false);
		expect((await reserveSub(store)).ok).toBe(true);
		await store.recordPaidStop("u1", "anthropic");
		expect(await store.extraUsageOffConfirmedAt("u1")).toBeNull();
		// Confirming again is not enough: Claude stays stopped until it is resumed.
		await store.confirmExtraUsageOff("u1", true);
		expect(await reserveSub(store)).toMatchObject({
			ok: false,
			reason: "vendor_stopped",
		});
		await store.resumeSubscription("u1", "anthropic");
		expect((await reserveSub(store)).ok).toBe(true);
	});

	it("never counts a subscription reservation against the cap, open or settled at $0", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 500_000,
		});
		const store = new DrizzleSpendStore(db);
		await store.confirmExtraUsageOff("u1", true);
		const first = await reserveSub(store);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((await store.spendingStatus("u1")).reservedMicros).toBe(0);
		// Past the cap's room: a subscription call is not capped.
		expect((await reserveSub(store, 900_000)).ok).toBe(true);
		await execute(
			db,
			sql`delete from llm_usage where estimate_micros = 900000`,
		);
		await store.settleSpend(first.id, {
			usage: {
				model: "claude-sonnet-5-5",
				inputTokens: 9_000,
				outputTokens: 1_500,
				cachedInputTokens: 0,
				cacheWriteTokens: 0,
			},
			costMicros: 0,
			basis: "subscription",
			error: null,
		});
		const status = await store.spendingStatus("u1");
		expect(status).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
		const rows = await execute<{
			billing: string;
			cost_micros: number;
			input_tokens: number;
		}>(
			db,
			sql`select billing, cost_micros, input_tokens from llm_usage where provider like 'claude-subscription:%'`,
		);
		expect([...rows]).toEqual([
			{ billing: "subscription", cost_micros: 0, input_tokens: 9_000 },
		]);
		const spending = await repo.spending("u1");
		expect(spending.subscriptionCalls).toBe(1);
	});

	it("counts a paid extra-usage call as API spend once it settles", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 20_000_000,
		});
		const store = new DrizzleSpendStore(db);
		await store.confirmExtraUsageOff("u1", true);
		const paid = await reserveSub(store);
		if (!paid.ok) throw new Error("not reserved");
		await store.settleSpend(paid.id, {
			usage: null,
			costMicros: 42_000,
			basis: "paid extra usage",
			error: "Subscription paused (extra_usage, x): paid",
			billing: "api",
		});
		const status = await store.spendingStatus("u1");
		expect(status).toMatchObject({ spentMicros: 42_000, reservedMicros: 0 });
	});

	it("serializes API reservations under the same lock across connections", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 300_000,
		});
		const reserveApi = (store: DrizzleSpendStore) =>
			store.reserveSpend({
				userId: "u1",
				applicationId: null,
				task: "tailor",
				provider: "anthropic:claude-sonnet-5-5",
				estimateMicros: 300_000,
			});
		const results = await Promise.all([
			reserveApi(new DrizzleSpendStore(db)),
			reserveApi(new DrizzleSpendStore(other)),
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
	});
});

describe("the subscription call budget in Postgres", () => {
	const reserve = (store: DrizzleSpendStore) =>
		store.reserveSpend({
			userId: "u1",
			applicationId: null,
			task: "fit-score",
			provider: "claude-subscription:claude-opus-5-5",
			estimateMicros: 0,
			billing: "subscription",
			modelCalls: 2,
		});

	it("holds 2 calls per open reservation, settles to the calls made, and frees them after 24 hours", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 20_000_000,
		});
		const store = new DrizzleSpendStore(db);
		await store.confirmExtraUsageOff("u1", true);
		await store.setSubscriptionDailyCalls("u1", 3);
		const first = await reserve(store);
		if (!first.ok) throw new Error("not reserved");
		expect(await store.subscriptionBudget("u1")).toMatchObject({
			budget: 3,
			used: 2,
		});
		expect(await reserve(store)).toMatchObject({
			ok: false,
			reason: "call_budget",
			used: 2,
			budget: 3,
		});
		await store.settleSpend(first.id, {
			usage: null,
			costMicros: 0,
			basis: "subscription",
			error: null,
			modelCalls: 1,
		});
		const budget = await store.subscriptionBudget("u1");
		expect(budget.used).toBe(1);
		expect(budget.resetsAt?.getTime()).toBeGreaterThan(Date.now());
		expect((await reserve(store)).ok).toBe(true);
		// A day later the calls have left the window.
		const tomorrow = new DrizzleSpendStore(
			db,
			() => new Date(Date.now() + 25 * 3_600_000),
		);
		expect((await tomorrow.subscriptionBudget("u1")).used).toBe(0);
		await store.setSubscriptionDailyCalls("u1", null);
		expect((await store.subscriptionBudget("u1")).budget).toBe(500);
		await expect(store.setSubscriptionDailyCalls("u1", 1.5)).rejects.toThrow(
			/whole number/,
		);
	});

	it("lets exactly as many parallel calls through as the budget holds", async () => {
		await execute(db, sql`delete from llm_usage`);
		const store = new DrizzleSpendStore(db);
		await store.confirmExtraUsageOff("u1", true);
		await store.setSubscriptionDailyCalls("u1", 4);
		// Five reservations in flight at once; each reads the budget, then inserts. Without the
		// transaction lock all five would read before any insert.
		const results = await Promise.all(
			Array.from({ length: 5 }, () => reserve(new DrizzleSpendStore(db))),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(2);
		expect(
			results.filter((r) => !r.ok && r.reason === "call_budget"),
		).toHaveLength(3);
	});
});

describe("a reservation whose process died", () => {
	it("counts a stale API reservation as held this month; a stale subscription one never counts", async () => {
		await execute(db, sql`delete from llm_usage`);
		const store = new DrizzleSpendStore(db);
		for (const [provider, billing] of [
			["claude-subscription:claude-sonnet-5-5", "subscription"],
			["anthropic:claude-sonnet-5-5", "api"],
		] as const) {
			const open = await store.reserveSpend({
				userId: "u1",
				applicationId: null,
				task: "tailor",
				provider,
				estimateMicros: 2_880_000,
				billing,
				modelCalls: billing === "subscription" ? 1 : 0,
			});
			if (!open.ok) throw new Error("not reserved");
		}
		expect(await store.heldApiCalls("u1")).toEqual({ count: 0, micros: 0 });
		const later = new DrizzleSpendStore(
			db,
			() => new Date(Date.now() + 61 * 60_000),
		);
		expect(await later.heldApiCalls("u1")).toEqual({
			count: 1,
			micros: 2_880_000,
		});
		expect((await later.spendingStatus("u1")).reservedMicros).toBe(2_880_000);
	});
});

describe("a paid call pauses its own vendor only", () => {
	it("needs no confirmation for either vendor, and a paid Claude call pauses Claude, not Codex", async () => {
		await execute(db, sql`delete from llm_usage`);
		const store = new DrizzleSpendStore(db);
		await store.confirmExtraUsageOff("u1", false);
		await store.setSubscriptionDailyCalls("u1", 100);
		const reserve = (provider: string) =>
			store.reserveSpend({
				userId: "u1",
				applicationId: null,
				task: "claims-check",
				provider,
				estimateMicros: 100_000,
				billing: "subscription",
				modelCalls: 1,
			});
		expect((await reserve("claude-subscription:claude-sonnet-5-5")).ok).toBe(
			true,
		);
		expect((await reserve("codex-subscription:default")).ok).toBe(true);
		await store.recordPaidStop("u1", "anthropic");
		expect(
			await reserve("claude-subscription:claude-sonnet-5-5"),
		).toMatchObject({
			ok: false,
			reason: "vendor_stopped",
		});
		expect((await reserve("codex-subscription:default")).ok).toBe(true);
		await store.resumeSubscription("u1", "anthropic");
		await store.resumeSubscription("u1", "openai");
	});

	it("stops only Gemini on a paid Gemini call, never Claude or its confirmation", async () => {
		await execute(db, sql`delete from llm_usage`);
		const store = new DrizzleSpendStore(db);
		await store.setSubscriptionDailyCalls("u1", 100);
		await store.confirmExtraUsageOff("u1", true);
		const reserve = (provider: string) =>
			store.reserveSpend({
				userId: "u1",
				applicationId: null,
				task: "claims-check",
				provider,
				estimateMicros: 100_000,
				billing: "subscription",
				modelCalls: 1,
			});
		await store.recordPaidStop("u1", "google");
		expect(await reserve("antigravity:gemini-3.8-flash")).toMatchObject({
			ok: false,
			reason: "vendor_stopped",
		});
		expect(await store.extraUsageOffConfirmedAt("u1")).not.toBeNull();
		expect((await reserve("claude-subscription:claude-sonnet-5-5")).ok).toBe(
			true,
		);
		await store.resumeSubscription("u1", "google");
		expect((await reserve("antigravity:gemini-3.8-flash")).ok).toBe(true);
	});
});
