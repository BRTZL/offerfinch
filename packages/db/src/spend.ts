import type { LlmUsage } from "@offerfinch/core/scoring/llm";
import {
	DEFAULT_SUBSCRIPTION_DAILY_CALLS,
	MAX_SUBSCRIPTION_DAILY_CALLS,
	OUTCOME_UNKNOWN_BASIS,
	type SpendStore,
	type SubscriptionBudget,
} from "@offerfinch/core/scoring/metered";
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	or,
	sql,
} from "drizzle-orm";

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
export const STALE_RESERVATION_MINUTES = 60;
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
				// Every open reservation counts, a subscription call's too: until it settles it may
				// turn out to be paid extra usage.
				reserved: sql<number>`coalesce(sum(${llmUsage.estimateMicros}) filter (where ${llmUsage.status} = 'reserved'), 0)`,
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
				// A vendor with a held call (payment unknown, or paid without usage) or a pause the
				// user has not lifted takes no new call, in this process or after a restart.
				const vendor = subscriptionVendor(input.provider);
				if (vendor) {
					const unresolved = await this.unresolved(tx, input.userId, vendor);
					if (unresolved)
						return {
							ok: false as const,
							reason: "payment_unresolved" as const,
							detail: unresolved,
						};
				}
				// No confirmation click: before each Claude call the provider reads the plan's usage
				// report and sends nothing unless extra usage is off (fails closed when unknown);
				// a call that drew on it anyway pauses Claude (above) until reconciled.
				// The plan's protection: this call must fit the last 24 hours' budget.
				const budget = await this.budget(tx, input.userId);
				if (budget.used + (input.modelCalls ?? 0) > budget.budget)
					return { ok: false as const, reason: "call_budget", ...budget };
			}
			const status = await this.status(tx, input.userId);
			const committed = status.spentMicros + status.reservedMicros;
			if (status.enabled && committed + input.estimateMicros > status.capMicros)
				return {
					ok: false as const,
					reason: "cap" as const,
					spentMicros: committed,
					capMicros: status.capMicros,
				};
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
	 * Why a vendor's subscription calls must wait, or null: a held call of that vendor (payment
	 * unknown, paid without usage, or a reservation whose process died), else its pause.
	 */
	private async unresolved(
		t: Tx | Database,
		userId: string,
		vendor: SubscriptionVendor,
	): Promise<string | null> {
		const label = VENDOR_LABEL[vendor];
		const [held] = await t
			.select({ n: sql<number>`count(*)` })
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					eq(llmUsage.status, "reserved"),
					sql`${llmUsage.provider} like ${`${SUBSCRIPTION_PREFIX[vendor]}%`}`,
					or(
						isNotNull(llmUsage.error),
						lt(llmUsage.createdAt, this.staleBefore()),
					),
				),
			);
		const n = Number(held?.n ?? 0);
		if (n > 0)
			return `${n} ${label} subscription call${n === 1 ? "'s" : "s'"} payment is unknown or was paid, so ${label} calls are stopped. In Settings > Models, enter what each one really cost (from the ${label} usage page) or that it was not charged, then resume ${label}.`;
		const [pause] = await t
			.select()
			.from(subscriptionPauses)
			.where(
				and(
					eq(subscriptionPauses.userId, userId),
					eq(subscriptionPauses.vendor, vendor),
				),
			);
		if (pause)
			return `${label} calls are stopped since ${pause.pausedAt.toISOString().slice(0, 16).replace("T", " ")} UTC (${pause.reason}). Every held call is reconciled; resume ${label} in Settings > Models.`;
		return null;
	}

	/** Each vendor's state: held calls, a pause, and whether its calls may run. */
	async subscriptionState(userId: string) {
		const out: Record<
			SubscriptionVendor,
			{
				held: number;
				pausedAt: Date | null;
				reason: string | null;
				blocked: string | null;
			}
		> = {
			anthropic: { held: 0, pausedAt: null, reason: null, blocked: null },
			openai: { held: 0, pausedAt: null, reason: null, blocked: null },
		};
		const held = await this.listHeld(userId);
		const pauses = await this.db
			.select()
			.from(subscriptionPauses)
			.where(eq(subscriptionPauses.userId, userId));
		for (const vendor of ["anthropic", "openai"] as const) {
			out[vendor].held = held.filter((h) => h.vendor === vendor).length;
			const pause = pauses.find((p) => p.vendor === vendor);
			out[vendor].pausedAt = pause?.pausedAt ?? null;
			out[vendor].reason = pause?.reason ?? null;
			out[vendor].blocked = await this.unresolved(this.db, userId, vendor);
		}
		return out;
	}

	/**
	 * Lifts a vendor's pause once every held call of it is reconciled. Claude also takes the
	 * extra-usage confirmation again (resuming says it is off). Throws while calls are held.
	 */
	async resumeSubscription(
		userId: string,
		vendor: SubscriptionVendor,
	): Promise<void> {
		await this.db.transaction(async (tx) => {
			const [held] = await tx
				.select({ n: sql<number>`count(*)` })
				.from(llmUsage)
				.where(
					and(
						eq(llmUsage.userId, userId),
						eq(llmUsage.status, "reserved"),
						sql`${llmUsage.provider} like ${`${SUBSCRIPTION_PREFIX[vendor]}%`}`,
						or(
							isNotNull(llmUsage.error),
							lt(llmUsage.createdAt, this.staleBefore()),
						),
					),
				);
			if (Number(held?.n ?? 0) > 0)
				throw new Error(
					`Refusing: reconcile every held ${VENDOR_LABEL[vendor]} call first`,
				);
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
	 * A call of `vendor` was paid, or its payment is unknown: that vendor stops (a pause kept in
	 * the database) until the user reconciles and resumes it; a Claude call also withdraws the
	 * Claude confirmation. Another vendor's calls are not touched.
	 */
	async clearExtraUsageConfirmation(
		userId: string,
		vendor?: string,
	): Promise<void> {
		const v: SubscriptionVendor = vendor === "openai" ? "openai" : "anthropic";
		await this.db
			.insert(subscriptionPauses)
			.values({
				userId,
				vendor: v,
				pausedAt: this.now(),
				reason: "a call was paid, or its payment could not be established",
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
		input: {
			basis: string;
			error: string;
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
				priceBasis: input.basis,
				error: input.error.slice(0, 500),
			})
			.where(and(eq(llmUsage.id, id), eq(llmUsage.status, "reserved")));
	}

	/**
	 * A reservation open this long has lost its process (a killed scan or server): its outcome
	 * is unknown, so it is held like one that failed, until the user reconciles it.
	 */
	private staleBefore(): Date {
		return new Date(this.now().getTime() - STALE_RESERVATION_MINUTES * 60_000);
	}

	/**
	 * Reservations held because their call's outcome is unknown (a failure without usage, or a
	 * process that died mid-call), oldest first.
	 */
	async listHeld(userId: string) {
		const rows = await this.db
			.select({
				id: llmUsage.id,
				task: llmUsage.task,
				provider: llmUsage.provider,
				billing: llmUsage.billing,
				applicationId: llmUsage.applicationId,
				estimateMicros: llmUsage.estimateMicros,
				basis: llmUsage.priceBasis,
				error: llmUsage.error,
				createdAt: llmUsage.createdAt,
			})
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					eq(llmUsage.status, "reserved"),
					or(
						isNotNull(llmUsage.error),
						lt(llmUsage.createdAt, this.staleBefore()),
					),
				),
			)
			.orderBy(asc(llmUsage.createdAt), asc(sql`${llmUsage}.rowid`));
		const offSince = await this.claudeOffSince(userId);
		return rows.map((r) => ({
			...r,
			/** The subscription vendor, or the API's ("anthropic", "openai") for key calls. */
			vendor: (subscriptionVendor(r.provider) ??
				(r.provider.split(":")[0] as string)) as string,
			subscription: subscriptionVendor(r.provider) !== null,
			/**
			 * A Claude subscription call held only because its outcome is unknown, sent while the
			 * user's confirmation that extra usage is off stood (given before it, never withdrawn
			 * since). Its billing is still unknown: the user decides; nothing is settled here.
			 */
			confirmedOffBefore:
				offSince !== null &&
				subscriptionVendor(r.provider) === "anthropic" &&
				(r.basis?.startsWith(OUTCOME_UNKNOWN_BASIS) ?? false) &&
				r.createdAt.getTime() >= offSince.getTime(),
		}));
	}

	/**
	 * Since when the Claude confirmation that extra usage is off has stood without an extra-usage
	 * event (a paid Claude call, or a Claude pause); null when it is not standing.
	 */
	private async claudeOffSince(userId: string): Promise<Date | null> {
		const [settings] = await this.db
			.select({ at: spendingSettings.extraUsageOffConfirmedAt })
			.from(spendingSettings)
			.where(eq(spendingSettings.userId, userId));
		const since = settings?.at ?? null;
		if (!since) return null;
		const [pause] = await this.db
			.select({ vendor: subscriptionPauses.vendor })
			.from(subscriptionPauses)
			.where(
				and(
					eq(subscriptionPauses.userId, userId),
					eq(subscriptionPauses.vendor, "anthropic"),
				),
			);
		if (pause) return null;
		const [paid] = await this.db
			.select({ n: sql<number>`count(*)` })
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					eq(llmUsage.billing, "api"),
					sql`${llmUsage.provider} like ${`${SUBSCRIPTION_PREFIX.anthropic}%`}`,
					gte(llmUsage.createdAt, since),
				),
			);
		return Number(paid?.n ?? 0) > 0 ? null : since;
	}

	/**
	 * Settles a held reservation at what the provider's usage page shows for it (0 when it was not
	 * billed). Only the owner's held rows; returns whether one was settled. A positive amount was
	 * billed per token, so a subscription row becomes `api` and counts as spent.
	 */
	async reconcile(
		userId: string,
		id: string,
		costMicros: number,
	): Promise<boolean> {
		const rows = await this.db
			.update(llmUsage)
			.set({
				status: "settled",
				costMicros,
				...(costMicros > 0 ? { billing: "api" as const } : {}),
				priceBasis: `reconciled by the user from the provider's usage page (${new Date(this.now()).toISOString().slice(0, 10)})`,
				settledAt: this.now(),
			})
			.where(
				and(
					eq(llmUsage.id, id),
					eq(llmUsage.userId, userId),
					eq(llmUsage.status, "reserved"),
					or(
						isNotNull(llmUsage.error),
						lt(llmUsage.createdAt, this.staleBefore()),
					),
				),
			)
			.returning({ id: llmUsage.id });
		return rows.length > 0;
	}
}
