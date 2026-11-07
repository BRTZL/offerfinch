import { z } from "zod";
import {
	billingOf,
	DEFAULT_MAX_OUTPUT_TOKENS,
	type GenerateObjectRequest,
	type LlmBilling,
	LlmNotBilledError,
	LlmPausedError,
	type LlmProvider,
	type LlmUsage,
	redactRequest,
	SubscriptionUnavailableError,
} from "./llm";

import { estimateCost, inputTokenBound, worstCaseMicros } from "./pricing";

/**
 * Spending cap and cost tracking around every LLM call made for a user. Before a call, a
 * worst-case estimate is reserved in one locked transaction that refuses it when the month's
 * spend plus open reservations plus this one would pass the cap; parallel workflows therefore
 * cannot all pass the check at once. After the call, the reservation is replaced by the cost of
 * the tokens the provider reported.
 */
export interface SpendStore {
	/**
	 * One locked reservation per call. `api`: refused when its worst case would pass the cap.
	 * `subscription`: never counted against the cap (it settles at $0 unless the vendor says it
	 * was paid); refused while that vendor is stopped after a paid call, or when its model calls
	 * would pass the user's budget for the last 24 hours.
	 */
	reserveSpend(input: {
		userId: string;
		applicationId: string | null;
		task: string;
		provider: string;
		estimateMicros: number;
		/** Unset: `api`. */
		billing?: LlmBilling;
		/** Subscription: model calls held against the daily budget until it settles. */
		modelCalls?: number;
	}): Promise<
		| { ok: true; id: string }
		| { ok: false; reason: "cap"; spentMicros: number; capMicros: number }
		| ({ ok: false; reason: "call_budget" } & SubscriptionBudget)
	>;
	/** The user's subscription call budget and its use over the last 24 hours. */
	subscriptionBudget(userId: string): Promise<SubscriptionBudget>;
	/**
	 * A subscription call refused before it started (another account, the call budget): a settled $0 row carrying the message, so the application says why.
	 */
	recordRefusal(input: {
		userId: string;
		applicationId: string | null;
		task: string;
		provider: string;
		error: string;
	}): Promise<void>;
	/**
	 * Jobs whose application has sat in scored or preparing since before `before`: what the cap
	 * may have paused. The sweep wakes them once the cap leaves room (a new month, a higher cap).
	 */
	listCapPausedJobIds(userId: string, before: Date): Promise<string[]>;
	/** This month's spend (settled) and open reservations against the cap. */
	spendingStatus(userId: string): Promise<{
		enabled: boolean;
		capMicros: number;
		spentMicros: number;
		reservedMicros: number;
	}>;
	settleSpend(
		id: string,
		input: {
			usage: LlmUsage | null;
			costMicros: number;
			basis: string;
			error: string | null;
			/** Re-labels the row: a subscription call that turned out paid becomes `api`. */
			billing?: LlmBilling;
			/** Subscription: the model calls it really made. */
			modelCalls?: number;
		},
	): Promise<void>;
	/**
	 * An API-key call whose outcome is unknown (it failed with no usage reported, and was not
	 * refused before processing): its reservation stays open at the worst-case estimate, counted
	 * against this month's cap. Subscription calls are never held.
	 */
	holdSpend(id: string, input: { basis: string; error: string }): Promise<void>;
}

/** Model calls on the subscription in any rolling 24 hours, and their use. */
export interface SubscriptionBudget {
	budget: number;
	/** Settled calls plus open reservations (1 each: a call sends one prompt). */
	used: number;
	/** When the oldest call in the window leaves it, if any is counted. */
	resetsAt: Date | null;
}

/**
 * Model calls (prompts sent) the subscription may make in any rolling 24 hours, until the user
 * changes it in Settings > Models. Plan limits are token-weighted and unpublished, so a call
 * count is a proxy. 500 lets the fit score see every job a scan finds now that no rule sets jobs
 * aside first (scoring is 1 call, a draft 1, up to two drafts, retries extra); jobs past it wait
 * in found and the sweep scores them once the window has room (docs/decisions.md, 2026-11-05).
 */
export const DEFAULT_SUBSCRIPTION_DAILY_CALLS = 500;
export const MAX_SUBSCRIPTION_DAILY_CALLS = 1_000;
/**
 * A subscription call sends one prompt and reserves it. There is no repair inside a call: an
 * answer that fails the schema is a failed call, and a retry is another call, reserved again.
 */
export const RESERVED_MODEL_CALLS = 1;

export function budgetPause(
	provider: string,
	budget: SubscriptionBudget,
): SubscriptionUnavailableError {
	return new SubscriptionUnavailableError(
		"call_budget",
		provider,
		`${budget.used} of ${budget.budget} model calls in the last 24 hours are used (your plan protection, Settings > Models). New scoring and preparation wait${budget.resetsAt ? ` until ${budget.resetsAt.toISOString()}` : ""}; the next sweep after that resumes them, or raise the budget in Settings > Models.`,
		budget.resetsAt ?? undefined,
	);
}

/** True (as a pause) when the subscription has no room for another call. */
export async function subscriptionBudgetReached(
	store: SpendStore | undefined,
	userId: string,
	providers: (LlmProvider | undefined)[],
): Promise<SubscriptionUnavailableError | null> {
	const subscription = providers.find(
		(p) => p !== undefined && billingOf(p) === "subscription",
	);
	if (!store || !subscription) return null;
	const budget = await store.subscriptionBudget(userId);
	return budget.used + RESERVED_MODEL_CALLS > budget.budget
		? budgetPause(subscription.name, budget)
		: null;
}

export class SpendingCapReachedError extends LlmPausedError {
	constructor(
		readonly spentMicros: number,
		readonly capMicros: number,
	) {
		super(
			`Spending cap reached: $${(spentMicros / 1e6).toFixed(2)} of $${(capMicros / 1e6).toFixed(2)} this month. New preparation is paused; raise or turn off the cap in Settings.`,
		);
		this.name = "SpendingCapReachedError";
	}
}

/** What a subscription call records: no per-token price, whatever the model. */
export const SUBSCRIPTION_BASIS =
	"subscription: included in the user's plan, not billed per token; tokens as the CLI reported them";

/** The model a provider is named after ("anthropic:claude-opus-5-5" -> "claude-opus-5-5"). */
function modelOf(provider: LlmProvider): string {
	return provider.name.split(":").slice(1).join(":") || provider.name;
}

/** Size allowance for a schema that cannot be serialized here: larger than any schema in use. */
const UNKNOWN_SCHEMA_ALLOWANCE = "x".repeat(64_000);

/** The output schema as the provider receives it (JSON Schema), for the input bound. */
function schemaText(schema: unknown): string {
	try {
		return JSON.stringify(z.toJSONSchema(schema as z.ZodType));
	} catch {
		return UNKNOWN_SCHEMA_ALLOWANCE;
	}
}

export class MeteredLlm implements LlmProvider {
	readonly name: string;

	readonly billing: LlmBilling;
	readonly vendor: string | undefined;
	readonly reportsModelCalls: boolean | undefined;

	constructor(
		private readonly inner: LlmProvider,
		private readonly store: SpendStore,
		private readonly scope: { userId: string; applicationId: string | null },
	) {
		this.name = inner.name;
		this.billing = billingOf(inner);
		this.vendor = inner.vendor;
		this.reportsModelCalls = inner.reportsModelCalls;
	}

	/** The inner provider's own price, read when asked (it may be listed later). */
	get price(): LlmProvider["price"] {
		return this.inner.price;
	}

	async generateObject<T>(raw: GenerateObjectRequest<T>): Promise<T> {
		const request = redactRequest(raw);
		const estimateMicros = this.worstCase(request);
		if (this.billing === "subscription")
			return this.generateOnSubscription(request, estimateMicros);
		const reserved = await this.store.reserveSpend({
			...this.scope,
			task: request.task,
			provider: this.inner.name,
			estimateMicros,
		});
		if (!reserved.ok)
			throw reserved.reason === "cap"
				? new SpendingCapReachedError(reserved.spentMicros, reserved.capMicros)
				: new Error(`unexpected refusal of an API call: ${reserved.reason}`);
		let usage: LlmUsage | null = null;
		let modelCalls = 0;
		// A provider that reports its sends: none means nothing went out, so nothing was billed.
		const sent = () => !this.inner.reportsModelCalls || modelCalls > 0;
		try {
			const output = await this.inner.generateObject({
				...request,
				onUsage: (u) => {
					usage = u;
					request.onUsage?.(u);
				},
				onModelCall: () => {
					modelCalls++;
					request.onModelCall?.();
				},
			});
			await this.settle({ id: reserved.id, estimateMicros }, usage, null);
			return output;
		} catch (error) {
			await this.settle(
				{ id: reserved.id, estimateMicros },
				usage,
				error,
				sent(),
			);
			throw error;
		}
	}

	/** The call's worst case at the model's API price (the highest known rate when unpriced). */
	private worstCase<T>(request: GenerateObjectRequest<T>): number {
		return worstCaseMicros(
			modelOf(this.inner),
			inputTokenBound([
				request.system,
				request.promptPrefix ?? "",
				request.prompt,
				schemaText(request.schema),
			]),
			request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			this.inner.price,
		);
	}

	/**
	 * A subscription call, the way T3 Code runs one: the provider checks the login and the plan's
	 * headroom before it sends anything (Claude: extra usage confirmed off by a probe), and this
	 * reserves one call of the daily budget, outside the spending cap. It settles at $0 with the
	 * tokens reported, however it ended, unless the vendor said it drew on paid extra usage: then
	 * it is labelled `api` at its estimated API price (the reserved worst case without usage) and
	 * that vendor stops until the user resumes it. Refused before the CLI starts for another
	 * account, a stopped vendor or a used-up budget, recorded with its message, so the
	 * application says why.
	 */
	private async generateOnSubscription<T>(
		request: GenerateObjectRequest<T>,
		estimateMicros: number,
	): Promise<T> {
		const owner = this.inner.ownerUserId;
		const refusal = {
			...this.scope,
			task: request.task,
			provider: this.inner.name,
		};
		// One person's plan: an account other than the configured owner never runs on it.
		if (owner !== undefined && owner !== this.scope.userId) {
			const error = new SubscriptionUnavailableError(
				"not_owner",
				this.inner.name,
				"subscription models answer only for the account they are configured for (LLM_SUBSCRIPTION_USER). Use API-key providers for other accounts.",
			);
			await this.store.recordRefusal({ ...refusal, error: error.message });
			throw error;
		}
		const reserved = await this.store.reserveSpend({
			...refusal,
			estimateMicros,
			billing: "subscription",
			modelCalls: RESERVED_MODEL_CALLS,
		});
		if (!reserved.ok) {
			if (reserved.reason === "cap")
				throw new SpendingCapReachedError(
					reserved.spentMicros,
					reserved.capMicros,
				);
			const error = budgetPause(this.inner.name, reserved);
			await this.store.recordRefusal({ ...refusal, error: error.message });
			throw error;
		}
		let usage: LlmUsage | null = null;
		let error: unknown = null;
		let modelCalls = 0;
		try {
			return await this.inner.generateObject({
				...request,
				onUsage: (u) => {
					usage = u;
					request.onUsage?.(u);
				},
				onModelCall: () => {
					modelCalls++;
					request.onModelCall?.();
				},
			});
		} catch (caught) {
			error = caught;
			throw caught;
		} finally {
			await this.settleSubscription(
				{ id: reserved.id, estimateMicros },
				usage,
				error,
				modelCalls,
			);
		}
	}

	private async settleSubscription(
		reservation: { id: string; estimateMicros: number },
		usage: LlmUsage | null,
		error: unknown,
		modelCalls: number,
	): Promise<void> {
		const message =
			error === null
				? null
				: error instanceof Error
					? error.message
					: String(error);
		// Anything else is on the plan: answered, failed, timed out or refused. Extra usage is
		// confirmed off and probed before every Claude call, and Codex starts only with headroom,
		// so an unclear ending is almost surely on the plan; the provider logs it.
		await this.store.settleSpend(reservation.id, {
			usage,
			costMicros: 0,
			basis: SUBSCRIPTION_BASIS,
			error: message,
			modelCalls,
		});
	}

	/**
	 * Reported usage settles at its cost. Without usage: an answer was billed, at an unknown
	 * amount, so it settles at the reservation; a refusal before processing (LlmNotBilledError) was
	 * not billed and is released; anything else (a 5xx, a lost stream, a timeout) may have been
	 * billed, so the reservation is held for the month, and a retry reserves again on top of it.
	 */
	private async settle(
		reservation: { id: string; estimateMicros: number },
		usage: LlmUsage | null,
		error: unknown,
		sent = true,
	): Promise<void> {
		const message =
			error === null
				? null
				: error instanceof Error
					? error.message
					: String(error);
		if (usage) {
			const cost = estimateCost(usage, this.inner.price);
			await this.store.settleSpend(reservation.id, {
				usage,
				costMicros: cost.micros,
				basis: cost.basis,
				error: message,
			});
			return;
		}
		if (message === null) {
			await this.store.settleSpend(reservation.id, {
				usage: null,
				costMicros: reservation.estimateMicros,
				basis:
					"estimated; the provider answered without reporting usage, charged at the reserved worst case",
				error: null,
			});
			return;
		}
		if (error instanceof LlmNotBilledError) {
			await this.store.settleSpend(reservation.id, {
				usage: null,
				costMicros: 0,
				basis: `not billed: the provider refused the request before processing (HTTP ${error.status})`,
				error: message,
			});
			return;
		}
		if (
			!sent ||
			(error instanceof SubscriptionUnavailableError && error.notBilled)
		) {
			await this.store.settleSpend(reservation.id, {
				usage: null,
				costMicros: 0,
				basis: sent
					? "not billed: the provider refused the request before processing"
					: "not billed: the call stopped before its request was sent",
				error: message,
			});
			return;
		}
		await this.store.holdSpend(reservation.id, {
			basis:
				"outcome unknown (no usage reported); held at the worst case for this month's cap",
			error: message,
		});
	}
}

/** The provider to use for a user's call: metered when the deps have a spend store. */
export function meteredFor(
	llm: LlmProvider,
	store: SpendStore | undefined,
	userId: string,
	applicationId: string | null,
): LlmProvider {
	return store ? new MeteredLlm(llm, store, { userId, applicationId }) : llm;
}

/**
 * True when the user's cap is on and this month's spend and reservations have reached it, for
 * work on `providers`. Work whose every provider is a subscription is never stopped by the cap:
 * subscription calls do not count against it (only one that turned out paid does, afterwards).
 */
export async function capReached(
	store: SpendStore | undefined,
	userId: string,
	providers: (LlmProvider | undefined)[],
): Promise<SpendingCapReachedError | null> {
	if (!store) return null;
	const known = providers.filter((p): p is LlmProvider => p !== undefined);
	if (known.length > 0 && known.every((p) => billingOf(p) === "subscription"))
		return null;
	const status = await store.spendingStatus(userId);
	const used = status.spentMicros + status.reservedMicros;
	return status.enabled && used >= status.capMicros
		? new SpendingCapReachedError(used, status.capMicros)
		: null;
}
