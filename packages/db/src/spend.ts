import type { LlmUsage } from "@offerfinch/core/scoring/llm";
import {
	DEFAULT_SUBSCRIPTION_DAILY_CALLS,
	MAX_SUBSCRIPTION_DAILY_CALLS,
	type SpendStore,
	type SubscriptionBudget,
} from "@offerfinch/core/scoring/metered";
import { and, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "./client";
import {
	applications,
	llmUsage,
	spendingSettings,
	subscriptionPauses,
} from "./schema/pipeline";

/** The cap a user has before changing it: $20 per calendar month (UTC), on. */
export const DEFAULT_SPENDING_CAP_MICROS = 20_000_000;
/** Longer than any model call runs: an open reservation this old lost its process. */
const STALE_RESERVATION_MINUTES = 60;
/** The column is a 32-bit integer of micro-dollars; $2,000 keeps well inside it. */
export const MAX_SPENDING_CAP_MICROS = 2_000_000_000;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type SubscriptionVendor = "anthropic" | "openai";

/** The subscription providers' name prefixes, per vendor. */
export const SUBSCRIPTION_PREFIX: Record<SubscriptionVendor, string> = {
	anthropic: "claude-subscription:",
	openai: "codex-subscription:",
};

export const VENDOR_LABEL: Record<SubscriptionVendor, string> = {
	anthropic: "Claude",
	openai: "Codex",
};

/** The vendor of a subscription provider (`claude-subscription:…`, `codex-subscription:…`). */
export function subscriptionVendor(
	provider: string,
): SubscriptionVendor | null {
	for (const [vendor, prefix] of Object.entries(SUBSCRIPTION_PREFIX))
		if (provider.startsWith(prefix)) return vendor as SubscriptionVendor;
	return null;
}

/** The first instant of the current calendar month, UTC. */
export function monthStart(now = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Postgres side of cost tracking and the spending cap. */
export class DrizzleSpendStore implements SpendStore {
	constructor(
		private readonly db: Database,
		private readonly now: () => Date = () => new Date(),
	) {}

	private async status(t: Tx | Database, userId: string) {
		const [settings] = await t
			.select()
			.from(spendingSettings)
			.where(eq(spendingSettings.userId, userId));
		const [sums] = await t
			.select({
				// Settled subscription rows are $0 by construction; filtered too, so one can never
				// count. A paid extra-usage call is re-labelled `api` when it settles.
				spent: sql<number>`coalesce(sum(${llmUsage.costMicros}) filter (where ${llmUsage.status} = 'settled' and ${llmUsage.billing} = 'api'), 0)`,
				// Open API-key reservations only: a subscription call never counts against the cap
				// (it counts once it settles as paid).
				reserved: sql<number>`coalesce(sum(${llmUsage.estimateMicros}) filter (where ${llmUsage.status} = 'reserved' and ${llmUsage.billing} = 'api'), 0)`,
			})
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					gte(llmUsage.createdAt, monthStart(this.now())),
				),
			);
		return {
			// No monthly limit unless the user sets one (the user's decision, 2026-11-02).
			enabled: settings?.enabled ?? false,
			capMicros: settings?.monthlyCapMicros ?? DEFAULT_SPENDING_CAP_MICROS,
			spentMicros: Number(sums?.spent ?? 0),
			// A reservation whose worker died stays counted at its estimate: errs towards stopping.
			reservedMicros: Number(sums?.reserved ?? 0),
		};
	}

	async listCapPausedJobIds(userId: string, before: Date): Promise<string[]> {
		const rows = await this.db
			.select({ jobId: applications.jobId })
			.from(applications)
			.where(
				and(
					eq(applications.userId, userId),
					inArray(applications.state, ["scored", "preparing"]),
					lt(applications.stateChangedAt, before),
				),
			)
			.limit(200);
		return rows.map((r) => r.jobId);
	}

	spendingStatus(userId: string) {
		return this.status(this.db, userId);
	}

	/**
	 * Model calls over the last 24 hours: settled rows at what they made, open reservations at
	 * what they hold. A reservation whose process died keeps counting: errs towards stopping.
	 */
	private async budget(
		t: Tx | Database,
		userId: string,
	): Promise<SubscriptionBudget> {
		const [settings] = await t
			.select({ calls: spendingSettings.subscriptionDailyCalls })
			.from(spendingSettings)
			.where(eq(spendingSettings.userId, userId));
		const since = new Date(this.now().getTime() - 24 * 3_600_000);
		const [row] = await t
			.select({
				used: sql<number>`coalesce(sum(${llmUsage.modelCalls}), 0)`,
				oldest: sql<Date | null>`min(${llmUsage.createdAt}) filter (where ${llmUsage.modelCalls} > 0)`,
			})
			.from(llmUsage)
			.where(and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, since)));
		const oldest = row?.oldest ? new Date(row.oldest) : null;
		return {
			budget: settings?.calls ?? DEFAULT_SUBSCRIPTION_DAILY_CALLS,
			used: Number(row?.used ?? 0),
			resetsAt: oldest ? new Date(oldest.getTime() + 24 * 3_600_000) : null,
		};
	}

	subscriptionBudget(userId: string): Promise<SubscriptionBudget> {
		return this.budget(this.db, userId);
	}

	/**
	 * A vendor's subscription calls since `since` (a plan window's start): prompts sent, and the
	 * tokens they reported. Open reservations count as one call each.
	 */
	async subscriptionCallsSince(
		userId: string,
		vendor: SubscriptionVendor,
		since: Date,
	): Promise<{ calls: number; inputTokens: number; outputTokens: number }> {
		const [row] = await this.db
			.select({
				calls: sql<number>`coalesce(sum(${llmUsage.modelCalls}), 0)`,
				inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.cachedInputTokens} + ${llmUsage.cacheWriteTokens}), 0)`,
				outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)`,
			})
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					gte(llmUsage.createdAt, since),
					sql`${llmUsage.provider} like ${`${SUBSCRIPTION_PREFIX[vendor]}%`}`,
				),
			);
		return {
			calls: Number(row?.calls ?? 0),
			inputTokens: Number(row?.inputTokens ?? 0),
			outputTokens: Number(row?.outputTokens ?? 0),
		};
	}

	/** Sets the user's subscription call budget per rolling 24 hours (null: the default). */
	async setSubscriptionDailyCalls(
		userId: string,
		calls: number | null,
	): Promise<void> {
		if (
			calls !== null &&
			(!Number.isInteger(calls) ||
				calls < 0 ||
				calls > MAX_SUBSCRIPTION_DAILY_CALLS)
		)
			throw new Error(
				`Refusing: the call budget must be a whole number from 0 to ${MAX_SUBSCRIPTION_DAILY_CALLS}`,
			);
		await this.db
			.insert(spendingSettings)
			.values({ userId, enabled: false, subscriptionDailyCalls: calls })
			.onConflictDoUpdate({
				target: spendingSettings.userId,
				set: { subscriptionDailyCalls: calls, updatedAt: this.now() },
			});
	}

	async reserveSpend(
		input: Parameters<SpendStore["reserveSpend"]>[0],
	): ReturnType<SpendStore["reserveSpend"]> {
		const billing = input.billing ?? "api";
		return this.db.transaction(async (tx) => {
			// One reservation at a time, so parallel workflows cannot all pass the check: SQLite
			// transactions run one at a time (client.ts), which replaces Postgres' advisory lock.
			if (billing === "subscription") {
				// A vendor stopped after a paid call takes no new call until the user resumes it,
				// in this process or after a restart. Only that vendor: the other keeps running.
				const vendor = subscriptionVendor(input.provider);
				const stopped = vendor
					? await this.stopped(tx, input.userId, vendor)
					: null;
				if (stopped)
					return {
						ok: false as const,
						reason: "vendor_stopped" as const,
						detail: stopped,
					};
				// No confirmation click: before each Claude call the provider reads the plan's usage
				// report and sends nothing unless extra usage is off (fails closed when unknown).
				// The plan's protection: this call must fit the last 24 hours' budget.
				const budget = await this.budget(tx, input.userId);
				if (budget.used + (input.modelCalls ?? 0) > budget.budget)
					return { ok: false as const, reason: "call_budget", ...budget };
			} else {
				const status = await this.status(tx, input.userId);
				const committed = status.spentMicros + status.reservedMicros;
				if (
					status.enabled &&
					committed + input.estimateMicros > status.capMicros
				)
					return {
						ok: false as const,
						reason: "cap" as const,
						spentMicros: committed,
						capMicros: status.capMicros,
					};
			}
			const [row] = await tx
				.insert(llmUsage)
				.values({
					userId: input.userId,
					applicationId: input.applicationId,
					task: input.task,
					provider: input.provider,
					status: "reserved",
					estimateMicros: input.estimateMicros,
					billing,
					modelCalls: input.modelCalls ?? 0,
				})
				.returning({ id: llmUsage.id });
			return { ok: true as const, id: row?.id ?? "" };
		});
	}

	async recordRefusal(
		input: Parameters<SpendStore["recordRefusal"]>[0],
	): Promise<void> {
		await this.db.insert(llmUsage).values({
			userId: input.userId,
			applicationId: input.applicationId,
			task: input.task,
			provider: input.provider,
			status: "settled",
			estimateMicros: 0,
			billing: "subscription",
			priceBasis: "refused before the CLI started; nothing sent",
			error: input.error.slice(0, 500),
			settledAt: this.now(),
		});
	}

	/** The user's confirmation that extra usage is off on their Claude account, or null. */
	async extraUsageOffConfirmedAt(userId: string): Promise<Date | null> {
		const [row] = await this.db
			.select({ at: spendingSettings.extraUsageOffConfirmedAt })
			.from(spendingSettings)
			.where(eq(spendingSettings.userId, userId));
		return row?.at ?? null;
	}

	/** Records (or, `false`, withdraws) the user's confirmation that extra usage is off. */
	async confirmExtraUsageOff(
		userId: string,
		confirmed: boolean,
	): Promise<void> {
		const at = confirmed ? this.now() : null;
		await this.db
			.insert(spendingSettings)
			.values({ userId, enabled: false, extraUsageOffConfirmedAt: at })
			.onConflictDoUpdate({
				target: spendingSettings.userId,
				set: { extraUsageOffConfirmedAt: at, updatedAt: this.now() },
			});
	}

	/**
	 * Why a vendor's subscription calls must wait, or null: a paid call stopped it and the user
	 * has not resumed it.
	 */
	private async stopped(
		t: Tx | Database,
		userId: string,
		vendor: SubscriptionVendor,
	): Promise<string | null> {
		const [pause] = await t
			.select({ pausedAt: subscriptionPauses.pausedAt })
			.from(subscriptionPauses)
			.where(
				and(
					eq(subscriptionPauses.userId, userId),
					eq(subscriptionPauses.vendor, vendor),
				),
			);
		return pause ? paidStopText(vendor, pause.pausedAt) : null;
	}

	/** Each vendor's paid stop: when a paid call stopped it, or null while it runs. */
	async paidStops(
		userId: string,
	): Promise<Record<SubscriptionVendor, Date | null>> {
		const pauses = await this.db
			.select()
			.from(subscriptionPauses)
			.where(eq(subscriptionPauses.userId, userId));
		const at = (vendor: SubscriptionVendor) =>
			pauses.find((p) => p.vendor === vendor)?.pausedAt ?? null;
		return { anthropic: at("anthropic"), openai: at("openai") };
	}

	/**
	 * Lifts a vendor's paid stop. Resuming Claude also says extra usage is off again (the probe
	 * still checks it before every call).
	 */
	async resumeSubscription(
		userId: string,
		vendor: SubscriptionVendor,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			await tx
				.delete(subscriptionPauses)
				.where(
					and(
						eq(subscriptionPauses.userId, userId),
						eq(subscriptionPauses.vendor, vendor),
					),
				);
			if (vendor === "anthropic")
				await tx
					.insert(spendingSettings)
					.values({
						userId,
						enabled: false,
						extraUsageOffConfirmedAt: this.now(),
					})
					.onConflictDoUpdate({
						target: spendingSettings.userId,
						set: {
							extraUsageOffConfirmedAt: this.now(),
							updatedAt: this.now(),
						},
					});
		});
	}

	/**
	 * A call of `vendor` was paid: that vendor stops (kept in the database) until the user resumes
	 * it; a paid Claude call also withdraws the Claude confirmation. The other vendor, and its
	 * confirmation, are never touched.
	 */
	async recordPaidStop(userId: string, vendor: string): Promise<void> {
		const v: SubscriptionVendor = vendor === "openai" ? "openai" : "anthropic";
		await this.db
			.insert(subscriptionPauses)
			.values({
				userId,
				vendor: v,
				pausedAt: this.now(),
				reason: PAID_STOP_REASON[v],
			})
			.onConflictDoNothing();
		if (v !== "anthropic") return;
		await this.db
			.update(spendingSettings)
			.set({ extraUsageOffConfirmedAt: null, updatedAt: this.now() })
			.where(eq(spendingSettings.userId, userId));
	}

	async settleSpend(
		id: string,
		input: {
			usage: LlmUsage | null;
			costMicros: number;
			basis: string;
			error: string | null;
			billing?: "api" | "subscription";
			modelCalls?: number;
		},
	): Promise<void> {
		await this.db
			.update(llmUsage)
			.set({
				...(input.billing ? { billing: input.billing } : {}),
				...(input.modelCalls !== undefined
					? { modelCalls: input.modelCalls }
					: {}),
				status: "settled",
				model: input.usage?.model ?? null,
				inputTokens: input.usage?.inputTokens ?? 0,
				outputTokens: input.usage?.outputTokens ?? 0,
				cachedInputTokens: input.usage?.cachedInputTokens ?? 0,
				cacheWriteTokens: input.usage?.cacheWriteTokens ?? 0,
				costMicros: input.costMicros,
				priceBasis: input.basis,
				error: input.error?.slice(0, 500) ?? null,
				settledAt: this.now(),
			})
			.where(eq(llmUsage.id, id));
	}

	async holdSpend(
		id: string,
		input: { basis: string; error: string },
	): Promise<void> {
		await this.db
			.update(llmUsage)
			.set({ priceBasis: input.basis, error: input.error.slice(0, 500) })
			.where(and(eq(llmUsage.id, id), eq(llmUsage.status, "reserved")));
	}

	/**
	 * API-key calls this month still open at their worst case: held (failed without a usage
	 * report) or lost with their process. They count against the cap.
	 */
	async heldApiCalls(
		userId: string,
	): Promise<{ count: number; micros: number }> {
		const stale = new Date(
			this.now().getTime() - STALE_RESERVATION_MINUTES * 60_000,
		);
		const [row] = await this.db
			.select({
				count: sql<number>`count(*)`,
				micros: sql<number>`coalesce(sum(${llmUsage.estimateMicros}), 0)`,
			})
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					eq(llmUsage.status, "reserved"),
					eq(llmUsage.billing, "api"),
					gte(llmUsage.createdAt, monthStart(this.now())),
					or(isNotNull(llmUsage.error), lt(llmUsage.createdAt, stale)),
				),
			);
		return {
			count: Number(row?.count ?? 0),
			micros: Number(row?.micros ?? 0),
		};
	}
}

const PAID_STOP_REASON: Record<SubscriptionVendor, string> = {
	anthropic: "a call used paid extra usage",
	openai: "a call used paid ChatGPT credits",
};

/** What a paid stop says, wherever it shows: "Claude used paid extra usage on <date>. …" */
export function paidStopText(vendor: SubscriptionVendor, at: Date): string {
	const what =
		vendor === "anthropic" ? "paid extra usage" : "paid ChatGPT credits";
	return `${VENDOR_LABEL[vendor]} used ${what} on ${at.toISOString().slice(0, 10)}. Calls are stopped. Resume ${VENDOR_LABEL[vendor]} in Settings > Models.`;
}
