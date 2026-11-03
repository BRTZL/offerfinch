import {
	type GenerateObjectRequest,
	type LlmProvider,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import { meteredFor } from "@offerfinch/core/scoring/metered";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { type Database, DrizzleSpendStore } from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
beforeAll(async () => {
	db = await testDb();
});
afterAll(() => db.$close());

/** A Codex subscription call that is sent and then cannot say whether credits paid for it. */
function codex(
	outcome: "unknown" | "paid" | "ok",
): LlmProvider & { calls: number } {
	return {
		name: "codex-subscription:gpt-6.1-terra",
		billing: "subscription",
		vendor: "openai",
		ownerUserId: "u1",
		calls: 0,
		async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
			this.calls++;
			request.onModelCall?.();
			if (outcome === "ok") return { ok: true } as T;
			throw new SubscriptionUnavailableError(
				"extra_usage",
				this.name,
				"credit balance not read again",
				undefined,
				outcome === "unknown" ? "unknown" : true,
			);
		},
	};
}

const claude: LlmProvider = {
	name: "claude-subscription:claude-sonnet-5-5",
	billing: "subscription",
	vendor: "anthropic",
	ownerUserId: "u1",
	async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		request.onModelCall?.();
		return { ok: true } as T;
	},
};

const request = {
	task: "claims-check",
	system: "s",
	prompt: "p",
	schema: z.object({ ok: z.boolean() }),
	maxTokens: 100,
};

describe("a held Codex call stops Codex across restarts until it is reconciled and resumed", () => {
	it("refuses Codex from a new process (a new store) after an unknown payment, not Claude", async () => {
		await execute(db, sql`delete from llm_usage`);
		const first = new DrizzleSpendStore(db);
		await first.setSubscriptionDailyCalls("u1", 100);
		await first.confirmExtraUsageOff("u1", true);
		const unknown = codex("unknown");
		await expect(
			meteredFor(unknown, first, "u1", null).generateObject(request),
		).rejects.toMatchObject({ paid: "unknown" });

		// The worker restarts: a new store, no breaker; the hold is in the database.
		const restarted = new DrizzleSpendStore(db);
		const later = codex("ok");
		const refused = await meteredFor(later, restarted, "u1", null)
			.generateObject(request)
			.catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(SubscriptionUnavailableError);
		expect((refused as Error).message).toMatch(
			/payment is unknown or was paid/,
		);
		expect(later.calls).toBe(0);
		// Claude is another vendor: its calls go on.
		await expect(
			meteredFor(claude, restarted, "u1", null).generateObject(request),
		).resolves.toEqual({ ok: true });

		const [held] = await restarted.listHeld("u1");
		expect(held).toMatchObject({ vendor: "openai", subscription: true });
		expect(held?.estimateMicros).toBeGreaterThan(0);
		await expect(restarted.resumeSubscription("u1", "openai")).rejects.toThrow(
			/reconcile/,
		);

		// "Not charged": the hold settles at $0, yet Codex stays stopped until resumed.
		expect(await restarted.reconcile("u1", held?.id ?? "", 0)).toBe(true);
		const stillPaused = await meteredFor(codex("ok"), restarted, "u1", null)
			.generateObject(request)
			.catch((e: unknown) => e);
		expect((stillPaused as Error).message).toMatch(/resume Codex/);
		await restarted.resumeSubscription("u1", "openai");
		await expect(
			meteredFor(codex("ok"), restarted, "u1", null).generateObject(request),
		).resolves.toEqual({ ok: true });
	});

	it("counts a held call reconciled at a positive amount as API spend", async () => {
		await execute(db, sql`delete from llm_usage`);
		const store = new DrizzleSpendStore(db);
		await expect(
			meteredFor(codex("unknown"), store, "u1", null).generateObject(request),
		).rejects.toBeInstanceOf(SubscriptionUnavailableError);
		const [held] = await store.listHeld("u1");
		const before = (await store.spendingStatus("u1")).spentMicros;
		expect(await store.reconcile("u1", held?.id ?? "", 420_000)).toBe(true);
		const [row] = await execute<{ billing: string; cost_micros: number }>(
			db,
			sql`select billing, cost_micros from llm_usage where id = ${held?.id ?? ""}`,
		);
		expect(row).toEqual({ billing: "api", cost_micros: 420_000 });
		expect((await store.spendingStatus("u1")).spentMicros).toBe(
			before + 420_000,
		);
		await store.resumeSubscription("u1", "openai");
	});

	it("stops Codex after a paid call too, and reports each vendor's state", async () => {
		await execute(db, sql`delete from llm_usage`);
		const store = new DrizzleSpendStore(db);
		await expect(
			meteredFor(codex("paid"), store, "u1", null).generateObject(request),
		).rejects.toMatchObject({ paid: true });
		const state = await store.subscriptionState("u1");
		expect(state.openai.blocked).toMatch(/Codex/);
		expect(state.anthropic.blocked).toBeNull();
		for (const h of await store.listHeld("u1"))
			await store.reconcile("u1", h.id, 0);
		await store.resumeSubscription("u1", "openai");
		expect((await store.subscriptionState("u1")).openai.blocked).toBeNull();
	});
});

describe("a Claude call held because its outcome is unknown", () => {
	/** A Claude subscription call that is sent and fails without usage, answered or not. */
	function lost(answered: boolean): LlmProvider {
		return {
			...claude,
			async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
				req.onModelCall?.();
				if (answered) req.onAnswered?.();
				throw new Error("no valid structured output for fit-score");
			},
		};
	}
	async function fresh() {
		await execute(db, sql`delete from llm_usage`);
		await execute(db, sql`delete from subscription_pauses`);
		const store = new DrizzleSpendStore(db);
		await store.setSubscriptionDailyCalls("u1", 100);
		await store.confirmExtraUsageOff("u1", true);
		return store;
	}

	it("settles at $0 and keeps Claude running when its answer arrived (output that failed the schema)", async () => {
		const store = await fresh();
		await expect(
			meteredFor(lost(true), store, "u1", null).generateObject(request),
		).rejects.toThrow(/no valid structured output/);
		expect(await store.listHeld("u1")).toEqual([]);
		const [row] = await execute<{ status: string; cost_micros: number }>(
			db,
			sql`select status, cost_micros from llm_usage`,
		);
		expect(row).toEqual({ status: "settled", cost_micros: 0 });
		expect((await store.subscriptionState("u1")).anthropic.blocked).toBeNull();
	});

	it("stops Claude on a call whose session failed around a valid answer, which is still returned", async () => {
		const store = await fresh();
		const unclear: LlmProvider = {
			...claude,
			async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
				req.onModelCall?.();
				req.onUsage?.({
					model: "claude-sonnet-5-5",
					inputTokens: 10,
					outputTokens: 5,
					cachedInputTokens: 0,
					cacheWriteTokens: 0,
				});
				req.onBillingUnclear?.("a crash result after the answer");
				return { ok: true } as T;
			},
		};
		await expect(
			meteredFor(unclear, store, "u1", null).generateObject(request),
		).resolves.toEqual({ ok: true });
		expect(await store.listHeld("u1")).toHaveLength(1);
		// The next Claude call is refused before it is sent, like any held Claude call.
		const next = await meteredFor(claude, store, "u1", null)
			.generateObject(request)
			.catch((e: unknown) => e);
		expect(next).toBeInstanceOf(SubscriptionUnavailableError);
		expect((next as Error).message).toMatch(/payment is unknown or was paid/);
		for (const h of await store.listHeld("u1"))
			await store.reconcile("u1", h.id, 0);
		await store.resumeSubscription("u1", "anthropic");
	});

	it("marks a hold sent while the confirmation stood (before it and since), and not otherwise", async () => {
		const store = await fresh();
		await expect(
			meteredFor(lost(false), store, "u1", null).generateObject(request),
		).rejects.toThrow();
		const [held] = await store.listHeld("u1");
		expect(held).toMatchObject({
			vendor: "anthropic",
			confirmedOffBefore: true,
		});
		expect((await store.subscriptionState("u1")).anthropic.blocked).toMatch(
			/Claude/,
		);

		// Confirmed only after the call was sent: no hint.
		await execute(
			db,
			sql`update spending_settings set extra_usage_off_confirmed_at = ${Date.now() + 60_000} where user_id = 'u1'`,
		);
		expect((await store.listHeld("u1"))[0]?.confirmedOffBefore).toBe(false);
		await store.confirmExtraUsageOff("u1", true);
		await execute(
			db,
			sql`update spending_settings set extra_usage_off_confirmed_at = ${(held?.createdAt.getTime() ?? 0) - 1_000} where user_id = 'u1'`,
		);
		expect((await store.listHeld("u1"))[0]?.confirmedOffBefore).toBe(true);

		// A Claude call paid from extra usage since: no hint.
		await execute(
			db,
			sql`insert into llm_usage (id, user_id, task, provider, billing, status, estimate_micros, cost_micros, created_at) values ('00000000-0000-4000-8000-000000000001', 'u1', 'x', 'claude-subscription:claude-sonnet-5-5', 'api', 'settled', 0, 100, ${Date.now()})`,
		);
		expect((await store.listHeld("u1"))[0]?.confirmedOffBefore).toBe(false);
		await execute(db, sql`delete from llm_usage where billing = 'api'`);

		// The confirmation withdrawn (a paid or unknown call pauses Claude): no hint.
		await store.clearExtraUsageConfirmation("u1", "anthropic");
		expect((await store.listHeld("u1"))[0]?.confirmedOffBefore).toBe(false);

		// The user's buttons still settle it.
		expect(await store.reconcile("u1", held?.id ?? "", 0)).toBe(true);
		await store.resumeSubscription("u1", "anthropic");
	});
});
