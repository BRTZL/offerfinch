import {
	type GenerateObjectRequest,
	type LlmProvider,
	SubscriptionUnavailableError,
} from "@offerfinch/core/scoring/llm";
import {
	meteredFor,
	SUBSCRIPTION_BASIS,
} from "@offerfinch/core/scoring/metered";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { type Database, DrizzleSpendStore } from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
beforeAll(async () => {
	db = await testDb();
});
afterAll(() => db.$close());
beforeEach(async () => {
	await execute(db, sql`delete from llm_usage`);
	await execute(db, sql`delete from subscription_pauses`);
	await execute(db, sql`delete from spending_settings`);
});

/** A subscription call that is sent, then answers, fails unclearly, or turns out paid. */
function provider(
	vendor: "anthropic" | "openai",
	outcome: "ok" | "paid" | "unclear",
): LlmProvider & { calls: number } {
	return {
		name:
			vendor === "openai"
				? "codex-subscription:gpt-6.1-terra"
				: "claude-subscription:claude-sonnet-5-5",
		billing: "subscription",
		vendor,
		ownerUserId: "u1",
		calls: 0,
		async generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
			this.calls++;
			request.onModelCall?.();
			if (outcome === "ok") return { ok: true } as T;
			if (outcome === "unclear")
				throw new Error("the CLI ended without an answer");
			throw new SubscriptionUnavailableError(
				"extra_usage",
				this.name,
				"the vendor said this call was paid",
				undefined,
				true,
			);
		},
	};
}

const callInput = {
	task: "claims-check",
	system: "s",
	prompt: "p",
	schema: z.object({ ok: z.boolean() }),
	maxTokens: 100,
};

async function store() {
	const s = new DrizzleSpendStore(db);
	await s.setSubscriptionDailyCalls("u1", 100);
	return s;
}

describe("an OpenCode source that charged its paid balance", () => {
	const opencode = (
		source: string,
		outcome: "ok" | "paid",
	): LlmProvider & { calls: number } => ({
		...provider("anthropic", outcome),
		name: `opencode:${source}/glm-5.1`,
		vendor: `opencode:${source}`,
	});

	it("stops that source only: not Claude, not another source, and not Claude's confirmation", async () => {
		const s = await store();
		await s.confirmExtraUsageOff("u1", true);
		const confirmed = await s.extraUsageOffConfirmedAt("u1");
		await expect(
			meteredFor(opencode("opencode-go", "paid"), s, "u1", null).generateObject(
				callInput,
			),
		).rejects.toMatchObject({ kind: "extra_usage", paid: true });
		const stops = await s.paidStops("u1");
		expect(stops["opencode:opencode-go"]).toBeInstanceOf(Date);
		expect(stops.anthropic).toBeNull();
		expect(await s.extraUsageOffConfirmedAt("u1")).toEqual(confirmed);
		const again = opencode("opencode-go", "ok");
		await expect(
			meteredFor(again, s, "u1", null).generateObject(callInput),
		).rejects.toThrow(/OpenCode \(opencode-go\) used its paid balance/);
		expect(again.calls).toBe(0);
		await expect(
			meteredFor(
				opencode("zai-coding-plan", "ok"),
				s,
				"u1",
				null,
			).generateObject(callInput),
		).resolves.toEqual({ ok: true });
		await expect(
			meteredFor(provider("anthropic", "ok"), s, "u1", null).generateObject(
				callInput,
			),
		).resolves.toEqual({ ok: true });
		await s.resumeSubscription("u1", "opencode:opencode-go");
		await expect(
			meteredFor(opencode("opencode-go", "ok"), s, "u1", null).generateObject(
				callInput,
			),
		).resolves.toEqual({ ok: true });
	});
});

describe("a paid call stops its vendor across restarts until resumed", () => {
	it("refuses Codex from a new process after a paid call, not Claude, and keeps Claude's confirmation", async () => {
		const first = await store();
		await first.confirmExtraUsageOff("u1", true);
		const confirmed = await first.extraUsageOffConfirmedAt("u1");
		await expect(
			meteredFor(provider("openai", "paid"), first, "u1", null).generateObject(
				callInput,
			),
		).rejects.toMatchObject({ paid: true });

		// The worker restarts: a new store, no breaker; the stop is in the database.
		const restarted = new DrizzleSpendStore(db);
		const later = provider("openai", "ok");
		const refused = await meteredFor(later, restarted, "u1", null)
			.generateObject(callInput)
			.catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(SubscriptionUnavailableError);
		expect((refused as Error).message).toMatch(
			/Codex used paid ChatGPT credits on \d{4}-\d{2}-\d{2}\. Calls are stopped\./,
		);
		expect(later.calls).toBe(0);
		// Claude is another vendor: its calls go on, and its confirmation stands.
		await expect(
			meteredFor(
				provider("anthropic", "ok"),
				restarted,
				"u1",
				null,
			).generateObject(callInput),
		).resolves.toEqual({ ok: true });
		expect(await restarted.extraUsageOffConfirmedAt("u1")).toEqual(confirmed);
		expect((await restarted.paidStops("u1")).anthropic).toBeNull();

		// The paid row names Codex, never Claude.
		const [paid] = await execute<{ price_basis: string; billing: string }>(
			db,
			sql`select price_basis, billing from llm_usage where provider like 'codex-subscription:%' and billing = 'api'`,
		);
		expect(paid?.price_basis).toMatch(/ChatGPT credits on the Codex plan/);
		expect(paid?.price_basis).not.toMatch(/Claude/);

		// Resumed: the next Codex call runs.
		await restarted.resumeSubscription("u1", "openai");
		expect((await restarted.paidStops("u1")).openai).toBeNull();
		await expect(
			meteredFor(later, restarted, "u1", null).generateObject(callInput),
		).resolves.toEqual({ ok: true });
		expect(later.calls).toBe(1);
	});

	it("a paid Claude call stops Claude and withdraws its confirmation; resuming confirms again", async () => {
		const s = await store();
		await s.confirmExtraUsageOff("u1", true);
		await meteredFor(provider("anthropic", "paid"), s, "u1", null)
			.generateObject(callInput)
			.catch(() => {});
		expect(await s.extraUsageOffConfirmedAt("u1")).toBeNull();
		expect((await s.paidStops("u1")).anthropic).toBeInstanceOf(Date);
		const refused = await meteredFor(provider("anthropic", "ok"), s, "u1", null)
			.generateObject(callInput)
			.catch((e: unknown) => e);
		expect((refused as Error).message).toMatch(
			/Claude used paid extra usage on \d{4}-\d{2}-\d{2}\. Calls are stopped\./,
		);
		await s.resumeSubscription("u1", "anthropic");
		expect(await s.extraUsageOffConfirmedAt("u1")).toBeInstanceOf(Date);
		await expect(
			meteredFor(provider("anthropic", "ok"), s, "u1", null).generateObject(
				callInput,
			),
		).resolves.toEqual({ ok: true });
	});

	it("a Codex-only setup runs without the Claude confirmation", async () => {
		const s = await store();
		expect(await s.extraUsageOffConfirmedAt("u1")).toBeNull();
		await expect(
			meteredFor(provider("openai", "ok"), s, "u1", null).generateObject(
				callInput,
			),
		).resolves.toEqual({ ok: true });
	});
});

describe("an unclear ending is on the plan", () => {
	it("settles at $0 as a subscription row, holds nothing and stops nothing", async () => {
		const s = await store();
		await s.confirmExtraUsageOff("u1", true);
		for (const vendor of ["anthropic", "openai"] as const)
			await meteredFor(provider(vendor, "unclear"), s, "u1", null)
				.generateObject(callInput)
				.catch(() => {});
		const rows = await execute<{
			status: string;
			billing: string;
			cost_micros: number;
			price_basis: string;
			model_calls: number;
		}>(
			db,
			sql`select status, billing, cost_micros, price_basis, model_calls from llm_usage`,
		);
		expect(rows).toHaveLength(2);
		for (const row of rows)
			expect(row).toMatchObject({
				status: "settled",
				billing: "subscription",
				cost_micros: 0,
				price_basis: SUBSCRIPTION_BASIS,
				model_calls: 1,
			});
		expect(await s.paidStops("u1")).toEqual({
			anthropic: null,
			openai: null,
			google: null,
		});
		expect(await s.extraUsageOffConfirmedAt("u1")).toBeInstanceOf(Date);
	});

	it("never counts a subscription call against the cap, while running or after", async () => {
		const s = await store();
		await execute(
			db,
			sql`insert into spending_settings (user_id, enabled, monthly_cap_micros, updated_at) values ('u1', 1, 0, 0) on conflict(user_id) do update set enabled = 1, monthly_cap_micros = 0`,
		);
		const reserved = await s.reserveSpend({
			userId: "u1",
			applicationId: null,
			task: "fit-score",
			provider: "claude-subscription:claude-sonnet-5-5",
			estimateMicros: 5_000_000,
			billing: "subscription",
			modelCalls: 1,
		});
		expect(reserved.ok).toBe(true);
		expect((await s.spendingStatus("u1")).reservedMicros).toBe(0);
		// An API-key call is still capped.
		const api = await s.reserveSpend({
			userId: "u1",
			applicationId: null,
			task: "fit-score",
			provider: "anthropic:claude-opus-5-5",
			estimateMicros: 1,
		});
		expect(api).toMatchObject({ ok: false, reason: "cap" });
	});
});
