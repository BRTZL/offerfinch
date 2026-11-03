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

	it("holds a call with an unknown outcome against the cap until its owner reconciles it", async () => {
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
		// Another user cannot settle it.
		expect(await store.reconcile("u2", reserved.id, 0)).toBe(false);
		expect(await store.reconcile("u1", reserved.id, 120_000)).toBe(true);
		expect(await repo.spending("u1")).toMatchObject({
			spentMicros: 120_000,
			reservedMicros: 0,
			held: { count: 0, micros: 0 },
		});
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
		await store.clearExtraUsageConfirmation("u1");
		expect(await store.extraUsageOffConfirmedAt("u1")).toBeNull();
		// Confirming again is not enough: Claude stays paused until it is resumed.
		await store.confirmExtraUsageOff("u1", true);
		expect(await reserveSub(store)).toMatchObject({
			ok: false,
			reason: "payment_unresolved",
		});
		await store.resumeSubscription("u1", "anthropic");
		expect((await reserveSub(store)).ok).toBe(true);
	});

	it("counts an open subscription reservation at its worst case, and a settled one at $0", async () => {
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
		expect((await store.spendingStatus("u1")).reservedMicros).toBe(300_000);
		// No room for a second worst case while the first is open.
		expect(await reserveSub(store)).toMatchObject({ ok: false, reason: "cap" });
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
		const held = await reserveSub(store);
		if (!paid.ok || !held.ok) throw new Error("not reserved");
		await store.settleSpend(paid.id, {
			usage: null,
			costMicros: 42_000,
			basis: "paid extra usage",
			error: "Subscription paused (extra_usage, x): paid",
			billing: "api",
		});
		await store.holdSpend(held.id, {
			basis: "paid extra usage, no usage",
			error: "Subscription paused (extra_usage, x): paid",
			billing: "api",
		});
		const status = await store.spendingStatus("u1");
		expect(status).toMatchObject({
			spentMicros: 42_000,
			reservedMicros: 300_000,
		});
		expect((await store.listHeld("u1")).map((h) => h.id)).toEqual([held.id]);
	});

	it("serializes subscription reservations with API ones under the same lock", async () => {
		await execute(db, sql`delete from llm_usage`);
		const repo = new DashboardRepository(db);
		await repo.setSpendingCap("u1", {
			enabled: true,
			monthlyCapMicros: 300_000,
		});
		await new DrizzleSpendStore(db).confirmExtraUsageOff("u1", true);
		const results = await Promise.all([
			reserveSub(new DrizzleSpendStore(db)),
			reserveSub(new DrizzleSpendStore(other)),
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
		expect((await store.subscriptionBudget("u1")).budget).toBe(40);
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
	it("is listed as held after an hour and can be reconciled, still counting until then", async () => {
		await execute(db, sql`delete from llm_usage`);
		const store = new DrizzleSpendStore(db);
		await store.confirmExtraUsageOff("u1", true);
		const open = await store.reserveSpend({
			userId: "u1",
			applicationId: null,
			task: "tailor",
			provider: "claude-subscription:claude-sonnet-5-5",
			estimateMicros: 2_880_000,
			billing: "subscription",
			modelCalls: 2,
		});
		if (!open.ok) throw new Error("not reserved");
		expect(await store.listHeld("u1")).toEqual([]);
		const later = new DrizzleSpendStore(
			db,
			() => new Date(Date.now() + 61 * 60_000),
		);
		expect((await later.listHeld("u1")).map((h) => h.id)).toEqual([open.id]);
		expect((await later.spendingStatus("u1")).reservedMicros).toBe(2_880_000);
		expect(await later.reconcile("u1", open.id, 0)).toBe(true);
		expect((await later.spendingStatus("u1")).reservedMicros).toBe(0);
	});

	it("counts a stale subscription reservation reconciled at a positive amount as spent", async () => {
		await execute(db, sql`delete from llm_usage`);
		const store = new DrizzleSpendStore(db);
		await store.confirmExtraUsageOff("u1", true);
		const open = await store.reserveSpend({
			userId: "u1",
			applicationId: null,
			task: "tailor",
			provider: "claude-subscription:claude-sonnet-5-5",
			estimateMicros: 2_880_000,
			billing: "subscription",
			modelCalls: 1,
		});
		if (!open.ok) throw new Error("not reserved");
		const later = new DrizzleSpendStore(
			db,
			() => new Date(Date.now() + 61 * 60_000),
		);
		// Not the owner's: refused, and the row stays held.
		expect(await later.reconcile("u2", open.id, 1_500_000)).toBe(false);
		expect(await later.reconcile("u1", open.id, 1_500_000)).toBe(true);
		expect(await later.spendingStatus("u1")).toMatchObject({
			spentMicros: 1_500_000,
			reservedMicros: 0,
		});
		// Settled rows are no longer held, so a second reconcile cannot change it.
		expect(await later.reconcile("u1", open.id, 0)).toBe(false);
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
		await store.clearExtraUsageConfirmation("u1", "anthropic");
		expect(
			await reserve("claude-subscription:claude-sonnet-5-5"),
		).toMatchObject({
			ok: false,
			reason: "payment_unresolved",
		});
		expect((await reserve("codex-subscription:default")).ok).toBe(true);
		await store.resumeSubscription("u1", "anthropic");
		await store.resumeSubscription("u1", "openai");
	});
});
