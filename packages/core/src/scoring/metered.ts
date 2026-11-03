import { z } from "zod";
import {
	billingOf,
	type GenerateObjectRequest,
	type LlmBilling,
	LlmNotBilledError,
	LlmPausedError,
	type LlmProvider,
	type LlmUsage,
	redactRequest,
	SubscriptionUnavailableError,
	vendorOf,
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
	 * One locked reservation per call. `subscription`: also refused unless the user has
	 * confirmed that extra usage is off on their Claude account, or when its model calls would
	 * pass the user's budget for the last 24 hours; its worst case counts against the cap until
	 * it settles, because a call can still turn out to be paid extra usage.
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
		| { ok: false; reason: "extra_usage_unconfirmed" }
		/**
		 * The vendor has a call whose payment is unknown, or that was paid, and the user has not
		 * reconciled it and resumed: its calls stop until they do. `detail` says how.
		 */
		| { ok: false; reason: "payment_unresolved"; detail: string }
		| ({ ok: false; reason: "call_budget" } & SubscriptionBudget)
	>;
	/** The user's subscription call budget and its use over the last 24 hours. */
	subscriptionBudget(userId: string): Promise<SubscriptionBudget>;
	/**
	 * A subscription call refused before it started (another account, extra usage not
	 * confirmed off): a settled $0 row carrying the message, so the application says why.
	 */
	recordRefusal(input: {
		userId: string;
		applicationId: string | null;
		task: string;
		provider: string;
		error: string;
	}): Promise<void>;
	/**
	 * Withdraws the user's confirmation that extra usage is off (a call drew on it). `vendor` is
	 * the paid call's ("anthropic", "openai"): a store that keeps one confirmation per vendor
	 * withdraws only that one; one that keeps a single confirmation may ignore it.
	 */
	clearExtraUsageConfirmation(userId: string, vendor?: string): Promise<void>;
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
	 * Keeps a reservation open, at its worst-case estimate, for a call whose outcome is unknown (no
	 * usage reported, and not established as unbilled): it still counts against the cap until the
	 * user reconciles it against the provider's usage page.
	 */
	holdSpend(
		id: string,
		input: {
			basis: string;
			error: string;
			billing?: LlmBilling;
			modelCalls?: number;
		},
	): Promise<void>;
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
 * count is a proxy: 40 covers a scan of about 25 new jobs scored, or a dozen scored and three or
 * four tailored (scoring is 1 call, a draft 1, up to two drafts, retries extra), and leaves the rest of the
 * plan's day for the user's own work.
 */
export const DEFAULT_SUBSCRIPTION_DAILY_CALLS = 40;
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

/** A subscription call that the vendor said drew on paid extra usage. */
export const EXTRA_USAGE_BASIS =
	"paid extra usage on the Claude subscription: billed per token, estimated at the API price";

/** A sent subscription call whose payment could not be established either way. */
export const PAYMENT_UNKNOWN_BASIS =
	"subscription call sent, payment unknown (the check that would say whether it drew on paid extra usage failed); held at the worst case until reconciled with the vendor's usage page";

/** A sent subscription call that failed without an answer or usage: held until reconciled. */
export const OUTCOME_UNKNOWN_BASIS =
	"subscription call sent, outcome unknown (no answer, no usage reported); held at the worst case until reconciled with claude.ai > Settings > Usage";

/**
 * A subscription call the provider reported answered on the plan (`onAnswered`: output for the
 * sent prompt, e.g. one that failed the schema, a session that ended by itself, no sign of paid
 * extra usage), with no tokens reported: billed like any answered call.
 */
export const ANSWERED_NO_USAGE_BASIS =
	"subscription: answered (output for the prompt, the session ended by itself, no sign of paid extra usage), included in the user's plan; the CLI reported no tokens";

/** A subscription call that returned its answer from a session that also failed. */
export const BILLING_UNCLEAR_BASIS =
	"subscription call answered, but its session also failed (an error or crash result, an assistant error, a lost stream); held at the worst case until reconciled with claude.ai > Settings > Usage";

function tokensOf(usage: LlmUsage): string {
	return `${usage.model}: ${usage.inputTokens} input, ${usage.cachedInputTokens} cached, ${usage.outputTokens} output tokens reported`;
}

export const EXTRA_USAGE_UNCONFIRMED =
	"extra usage is not confirmed off for this Claude account. Anthropic offers no per-request switch that keeps a call off paid extra usage, so subscription calls run only after you turn it off at claude.ai > Settings > Usage and confirm that in Settings › Models. The sweep that ends each scan then restarts it once it has waited an hour (preparation: two).";

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

/**
 * Not billed: the vendor refused the request before any model work (HTTP 401 or 429 and the
 * like, as `NOT_BILLED_STATUSES` for the API providers). A subscription provider reports those
 * as a logout or a usage-limit pause; one that drew on paid extra usage is never this.
 */
function refusedBeforeProcessing(error: unknown): boolean {
	if (error instanceof LlmNotBilledError) return true;
	return (
		error instanceof SubscriptionUnavailableError &&
		!error.paid &&
		(error.kind === "usage_limit" || error.kind === "logged_out")
	);
}

export class MeteredLlm implements LlmProvider {
	readonly name: string;

	readonly billing: LlmBilling;
	readonly vendor: string | undefined;

	constructor(
		private readonly inner: LlmProvider,
		private readonly store: SpendStore,
		private readonly scope: { userId: string; applicationId: string | null },
	) {
		this.name = inner.name;
		this.billing = billingOf(inner);
		this.vendor = inner.vendor;
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
		try {
			const output = await this.inner.generateObject({
				...request,
				onUsage: (u) => {
					usage = u;
					request.onUsage?.(u);
				},
			});
			await this.settle({ id: reserved.id, estimateMicros }, usage, null);
			return output;
		} catch (error) {
			await this.settle({ id: reserved.id, estimateMicros }, usage, error);
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
			request.maxTokens ?? 16000,
		);
	}

	/**
	 * A subscription call. Refused before the CLI starts for another account, or while the user
	 * has not confirmed extra usage off. Its worst case at the API price is reserved against the
	 * cap, because no vendor switch keeps a request off paid extra usage: a call the vendor says
	 * drew on it settles at its estimated API price (held at the worst case without usage),
	 * labelled `api`, and clears the confirmation. A sent call whose payment the provider could
	 * not establish (`paid: "unknown"`) is held at the reservation whatever tokens it reported, and
	 * clears the confirmation too. A call settles at $0 with the tokens reported only when it
	 * provably cost nothing extra: nothing was sent, its answer came back (with usage, or with
	 * `onAnswered`: the provider's positive evidence that it was answered on the plan, even when
	 * the answer failed the schema), or the vendor refused it before processing; any other sent
	 * call that failed is held at the reservation until reconciled. A pause is recorded with its message, so the application says
	 * why.
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
			const error =
				reserved.reason === "call_budget"
					? budgetPause(this.inner.name, reserved)
					: new SubscriptionUnavailableError(
							"extra_usage",
							this.inner.name,
							reserved.reason === "payment_unresolved"
								? reserved.detail
								: EXTRA_USAGE_UNCONFIRMED,
						);
			await this.store.recordRefusal({ ...refusal, error: error.message });
			throw error;
		}
		let usage: LlmUsage | null = null;
		let error: unknown = null;
		let modelCalls = 0;
		let answered = false;
		let unclear: string | null = null;
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
				onAnswered: () => {
					answered = true;
					request.onAnswered?.();
				},
				onBillingUnclear: (detail) => {
					unclear ??= detail;
					request.onBillingUnclear?.(detail);
				},
			});
		} catch (caught) {
			error = caught;
			throw caught;
		} finally {
			await this.settleSubscription(
				reserved.id,
				usage,
				error,
				modelCalls,
				answered,
				unclear,
			);
		}
	}

	// biome-ignore lint/complexity/useMaxParams: These arguments form the subscription-settlement contract shared by reservation and reconciliation.
	private async settleSubscription(
		id: string,
		usage: LlmUsage | null,
		error: unknown,
		modelCalls: number,
		answered: boolean,
		unclear: string | null,
	): Promise<void> {
		const message =
			error === null
				? null
				: error instanceof Error
					? error.message
					: String(error);
		// Nothing sent (a breaker still open from an earlier paid call re-throws that call's
		// error): nothing new was billed, and the confirmation stays as the user left it.
		if (
			error instanceof SubscriptionUnavailableError &&
			error.paid === "unknown" &&
			modelCalls > 0
		) {
			// Sent, and whether it was paid cannot be established: it may have been, so it keeps
			// its reservation whatever tokens it reported, and the vendor's confirmation is
			// withdrawn, as for a paid call, so later calls stop until the user reconciles it and
			// confirms again (where the store gates that vendor's calls on it).
			await this.store.clearExtraUsageConfirmation(
				this.scope.userId,
				vendorOf(this.inner),
			);
			await this.store.holdSpend(id, {
				basis: `${PAYMENT_UNKNOWN_BASIS}${usage ? ` (${tokensOf(usage)})` : ""}`,
				error: message ?? "payment unknown",
				modelCalls,
			});
			return;
		}
		if (
			error instanceof SubscriptionUnavailableError &&
			error.paid === true &&
			modelCalls > 0
		) {
			// The first sign of paid extra usage stops every later call until the user confirms
			// again (the provider's breaker stops this process's callers meanwhile).
			await this.store.clearExtraUsageConfirmation(
				this.scope.userId,
				vendorOf(this.inner),
			);
			if (usage) {
				const cost = estimateCost(usage);
				await this.store.settleSpend(id, {
					usage,
					costMicros: cost.micros,
					basis: `${EXTRA_USAGE_BASIS} (${cost.basis})`,
					error: message,
					billing: "api",
					modelCalls,
				});
			} else
				await this.store.holdSpend(id, {
					basis: `${EXTRA_USAGE_BASIS}; no usage reported, held at the worst case until reconciled with claude.ai > Settings > Usage`,
					error: message ?? "paid extra usage",
					billing: "api",
					modelCalls,
				});
			return;
		}
		if (unclear !== null && modelCalls > 0) {
			// Its session also failed: what it cost is not clear, whether the answer passed the
			// schema or not and whatever tokens it reported. Held like a call whose outcome is
			// unknown (the store stops this vendor's calls on it until reconciled).
			await this.store.holdSpend(id, {
				basis: `${BILLING_UNCLEAR_BASIS}${usage ? ` (${tokensOf(usage)})` : ""}`,
				error: unclear,
				modelCalls,
			});
			return;
		}
		if (
			error !== null &&
			usage === null &&
			modelCalls > 0 &&
			!refusedBeforeProcessing(error)
		) {
			// The answer arrived and its whole session showed no sign of paid extra usage (a paid
			// report is handled above and wins): billed like any answered call, on the plan.
			if (answered) {
				await this.store.settleSpend(id, {
					usage: null,
					costMicros: 0,
					basis: ANSWERED_NO_USAGE_BASIS,
					error: message,
					modelCalls,
				});
				return;
			}
			// The prompt was sent and no answer came back (a lost stream, an abort, a 5xx): Claude
			// may have billed it, and the report that would say paid extra usage never arrived.
			await this.store.holdSpend(id, {
				basis: OUTCOME_UNKNOWN_BASIS,
				error: message ?? "outcome unknown",
				modelCalls,
			});
			return;
		}
		await this.store.settleSpend(id, {
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
	 * billed, so the reservation is held until reconciled, and a retry reserves again on top of it.
	 */
	private async settle(
		reservation: { id: string; estimateMicros: number },
		usage: LlmUsage | null,
		error: unknown,
	): Promise<void> {
		const message =
			error === null
				? null
				: error instanceof Error
					? error.message
					: String(error);
		if (usage) {
			const cost = estimateCost(usage);
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
		await this.store.holdSpend(reservation.id, {
			basis:
				"outcome unknown (no usage reported); held at the worst case until reconciled with the provider's usage page",
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

/** True when the user's cap is on and this month's spend and reservations have reached it. */
export async function capReached(
	store: SpendStore | undefined,
	userId: string,
): Promise<SpendingCapReachedError | null> {
	if (!store) return null;
	const status = await store.spendingStatus(userId);
	const used = status.spentMicros + status.reservedMicros;
	return status.enabled && used >= status.capMicros
		? new SpendingCapReachedError(used, status.capMicros)
		: null;
}
