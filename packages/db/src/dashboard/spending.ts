import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	sql,
} from "drizzle-orm";
import { applications, llmUsage, spendingSettings } from "../schema/pipeline";
import {
	DrizzleSpendStore,
	MAX_SPENDING_CAP_MICROS,
	monthStart,
} from "../spend";
import type { DashboardRepositoryContext } from "./context";
import type { PendingEvent } from "./shared";
export const spendingMethods = {
	/** Every LLM call made for one application, with the estimated total. */
	async applicationCost(userId: string, applicationId: string) {
		const calls = await this.database
			.select({
				task: llmUsage.task,
				model: llmUsage.model,
				provider: llmUsage.provider,
				status: llmUsage.status,
				inputTokens: llmUsage.inputTokens,
				outputTokens: llmUsage.outputTokens,
				cachedInputTokens: llmUsage.cachedInputTokens,
				costMicros: llmUsage.costMicros,
				estimateMicros: llmUsage.estimateMicros,
				priceBasis: llmUsage.priceBasis,
				billing: llmUsage.billing,
				error: llmUsage.error,
				createdAt: llmUsage.createdAt,
			})
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					eq(llmUsage.applicationId, applicationId),
				),
			)
			.orderBy(asc(llmUsage.createdAt), asc(sql`${llmUsage}.rowid`));
		return {
			/** Calls on a subscription: $0 here, shown as "Subscription", never a price. */
			subscriptionCalls: calls.filter((c) => c.billing === "subscription")
				.length,
			apiCalls: calls.filter((c) => c.billing === "api").length,
			/** Settled calls at their estimated cost; calls still running at their reservation. */
			totalMicros: calls.reduce(
				(n, c) =>
					n + (c.status === "settled" ? c.costMicros : c.estimateMicros),
				0,
			),
			estimated: true as const,
			calls,
		};
	},

	/** The spending cap and this month's spend. */
	async spending(userId: string) {
		const status = await new DrizzleSpendStore(this.database).spendingStatus(
			userId,
		);
		const [unattributed] = await this.database
			.select({
				micros: sql<number>`coalesce(sum(${llmUsage.costMicros}), 0)`,
			})
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					isNull(llmUsage.applicationId),
					gte(llmUsage.createdAt, monthStart()),
				),
			);
		const held = await new DrizzleSpendStore(this.database).heldApiCalls(
			userId,
		);
		const [subscription] = await this.database
			.select({ n: sql<number>`count(*)` })
			.from(llmUsage)
			.where(
				and(
					eq(llmUsage.userId, userId),
					eq(llmUsage.billing, "subscription"),
					gte(llmUsage.createdAt, monthStart()),
				),
			);
		return {
			...status,
			/** Calls this month on a subscription: not priced, outside the cap unless paid. */
			subscriptionCalls: Number(subscription?.n ?? 0),
			/** Spend not tied to an application this month (careers-page extraction). */
			unattributedMicros: Number(unattributed?.micros ?? 0),
			/** API-key calls this month with an unknown outcome, counted at their worst case. */
			held,
			reached:
				status.enabled &&
				status.spentMicros + status.reservedMicros >= status.capMicros,
		};
	},

	/**
	 * Saves the cap. Applications preparation paused at the cap (waiting in scored or preparing)
	 * get an event, so they continue if the new cap leaves room; each call checks it again.
	 */
	async setSpendingCap(
		userId: string,
		input: { enabled: boolean; monthlyCapMicros: number },
	): Promise<{ events: PendingEvent[] }> {
		if (
			!Number.isInteger(input.monthlyCapMicros) ||
			input.monthlyCapMicros < 0 ||
			input.monthlyCapMicros > MAX_SPENDING_CAP_MICROS
		)
			throw new Error("Refusing: the cap must be between $0 and $2,000");
		return this.database.transaction(async (tx) => {
			await tx
				.insert(spendingSettings)
				.values({ userId, ...input })
				.onConflictDoUpdate({
					target: spendingSettings.userId,
					set: { ...input, updatedAt: new Date() },
				});
			const waiting = await tx
				.select({ id: applications.id })
				.from(applications)
				.where(
					and(
						eq(applications.userId, userId),
						inArray(applications.state, ["scored", "preparing"]),
					),
				);
			// A redraft paused by the spending limit runs again too (core `pipeline/redraft.ts`); one
			// paused by a subscription waits for Try again.
			const redrafts = await tx
				.select({ id: applications.id, redraft: applications.redraft })
				.from(applications)
				.where(
					and(
						eq(applications.userId, userId),
						eq(applications.state, "ready_for_review"),
						isNotNull(applications.redraft),
					),
				);
			for (const app of redrafts) {
				if (
					app.redraft?.problem?.kind !== "paused" ||
					!app.redraft.problem.spendingCap
				)
					continue;
				const { problem: _paused, ...rest } = app.redraft;
				await tx
					.update(applications)
					.set({ redraft: rest })
					.where(eq(applications.id, app.id));
				waiting.push({ id: app.id });
			}
			const stamp = Date.now();
			const events: PendingEvent[] = [];
			for (const app of waiting)
				events.push(
					await this.addEvent(tx, userId, app.id, `cap-${app.id}-${stamp}`, {
						action: "spending_cap_changed",
					}),
				);
			return { events };
		});
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;
