import type { z } from "zod";

import { redactContact } from "../profile/types";
import type { ModelPrice } from "./pricing";

export interface GenerateObjectRequest<T> {
	system: string;
	/**
	 * The stable start of the prompt (the profile), identical across calls of a task for one user.
	 * Sent before `prompt`; Anthropic caches the system prompt and this prefix (5 minutes), and
	 * OpenAI caches a repeated prefix on its own.
	 */
	promptPrefix?: string;
	prompt: string;
	schema: z.ZodType<T>;
	/** Short label used in logs and errors. */
	task: string;
	/** The user's own email and phone: removed from everything sent, whatever surrounds them. */
	redact?: readonly string[];
	maxTokens?: number;
	/** Structured inputs behind the prompt. Real providers ignore it; the fake uses it to stay deterministic. */
	context?: unknown;
	/**
	 * Called once with the tokens the call used, as the provider reported them, whenever the
	 * provider answered (refusals and unparseable output included, since they are billed too).
	 */
	onUsage?: (usage: LlmUsage) => void;
	/**
	 * Subscription providers: called when the prompt is sent to the model (once per call at
	 * most), for the daily call budget; never called means nothing was sent.
	 */
	onModelCall?: () => void;
}

/** Tokens one call used, as the provider reported them. */
export interface LlmUsage {
	/** The model that answered (a fallback may differ from the one asked for). */
	model: string;
	/** Uncached input tokens. */
	inputTokens: number;
	outputTokens: number;
	/** Input tokens read from the provider's cache (billed at the cached rate). */
	cachedInputTokens: number;
	/** Input tokens written to the cache (Anthropic bills these above the input rate). */
	cacheWriteTokens: number;
	/** Of `cacheWriteTokens`, those written with a 1-hour lifetime (billed higher than 5-minute writes). */
	cacheWrite1hTokens?: number;
}

/** The prompt as one text: the cached prefix, then the rest. */
export function fullPrompt(request: {
	promptPrefix?: string;
	prompt: string;
}): string {
	return request.promptPrefix
		? `${request.promptPrefix}\n\n${request.prompt}`
		: request.prompt;
}

/**
 * The last redaction pass over everything a call sends: system prompt, cached prefix and prompt.
 * Every prompt builder redacts its own inputs; this catches any field one of them missed.
 * Deterministic, so a cached prefix stays the same bytes.
 */
export function redactRequest<T>(
	request: GenerateObjectRequest<T>,
): GenerateObjectRequest<T> {
	return {
		...request,
		system: redactContact(request.system, request.redact),
		prompt: redactContact(request.prompt, request.redact),
		...(request.promptPrefix !== undefined
			? { promptPrefix: redactContact(request.promptPrefix, request.redact) }
			: {}),
	};
}

/**
 * How a provider's calls are paid for. `api`: per token, on an API key (the default, counted
 * against the spending cap). `subscription`: the user's own flat-rate plan (Claude Pro or Max)
 * through the vendor's local CLI; settled at $0 with real tokens, outside the spending cap. A call
 * the vendor said drew on paid extra usage (or ChatGPT credits) settles as `api` and counts.
 */
export type LlmBilling = "api" | "subscription";

/** Provider-neutral structured generation. Implementations: Anthropic (real) and a deterministic fake. */
export interface LlmProvider {
	readonly name: string;
	/** Unset means `api`. */
	readonly billing?: LlmBilling;
	/** The vendor behind the model (plan pauses and usage are kept per vendor). Unset: the name's prefix. */
	readonly vendor?: string;
	/** Subscription providers: the one user whose plan this is; calls for anyone else are refused. */
	readonly ownerUserId?: string;
	/**
	 * Pay-per-use providers whose models are not in the price table (OpenCode's sources): the
	 * model's own price, read from the provider. The cap reserves at least this and settles at it.
	 */
	readonly price?: ModelPrice;
	/**
	 * Pay-per-use providers that call `onModelCall` when their request goes out: a call that
	 * failed before it did was not billed, and its reservation is released.
	 */
	readonly reportsModelCalls?: boolean;
	generateObject<T>(request: GenerateObjectRequest<T>): Promise<T>;
}

export function billingOf(provider: LlmProvider): LlmBilling {
	return provider.billing ?? "api";
}

/** "anthropic", "openai", "fake": the company whose model answers. */
export function vendorOf(provider: LlmProvider): string {
	return provider.vendor ?? provider.name.split(":")[0] ?? provider.name;
}

/**
 * A call that cannot run now and should wait instead of failing: the workflow step returns
 * (no retries, no `failed` application) and the application stays where it is until the sweep
 * after a later scan, or the user, starts it again.
 */
export class LlmPausedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LlmPausedError";
	}
}

export type SubscriptionPauseKind =
	/** The plan's usage limit (five-hour or weekly window) is reached. */
	| "usage_limit"
	/** The CLI is not logged in, or the login expired. */
	| "logged_out"
	/** The CLI would bill something other than the subscription (an API key, another backend). */
	| "not_subscription"
	/**
	 * Paid extra usage: on for the Claude account, not confirmed off by the user, unknown, or
	 * seen on a call. A call that drew on it is `paid` and recorded at its API price.
	 */
	| "extra_usage"
	/** The SDK could not be held to a pure model call (tools, settings, MCP): refused. */
	| "boundary"
	/** A user other than the one whose subscription this is. */
	| "not_owner"
	/** The user's own budget of subscription model calls per rolling 24 hours is used up. */
	| "call_budget";

/** Stable start of every subscription pause message: the dashboard finds them by it. */
export const SUBSCRIPTION_PAUSE_PREFIX = "Subscription paused";

/**
 * The subscription provider cannot answer now. Never retried and never sent to an API key
 * instead: the message says what happened and how preparation resumes.
 */
export class SubscriptionUnavailableError extends LlmPausedError {
	// biome-ignore lint/complexity/useMaxParams: Positional, so every existing pause keeps its call unchanged; the last two are optional flags.
	constructor(
		readonly kind: SubscriptionPauseKind,
		readonly provider: string,
		detail: string,
		/** When the usage limit resets, if the vendor said. */
		readonly resetsAt?: Date,
		/**
		 * `true`: the request was already sent and the vendor said it drew on paid extra usage (or
		 * ChatGPT credits): it was billed per token, so it is recorded at its API price, counted by
		 * the cap, and that vendor's calls stop until the user resumes them.
		 */
		readonly paid: boolean = false,
		/**
		 * `true`: nothing was billed (nothing sent, or the vendor refused the request before
		 * processing it), so a pay-per-use reservation is released.
		 */
		readonly notBilled: boolean = false,
	) {
		super(`${SUBSCRIPTION_PAUSE_PREFIX} (${kind}, ${provider}): ${detail}`);
		this.name = "SubscriptionUnavailableError";
	}
}

export class LlmRefusalError extends Error {
	constructor(
		readonly task: string,
		readonly detail: string,
	) {
		super(`LLM declined ${task}: ${detail}`);
		this.name = "LlmRefusalError";
	}
}

/**
 * The provider refused the request before processing it (HTTP 400, 401, 403, 404, 413, 422 or
 * 429), so nothing was billed. Only this lets the spending cap release a reservation for a call
 * that reported no usage; any other failure (a 5xx, a dropped stream, a timeout) may have been
 * billed and keeps its reservation, counted against this month's cap.
 */
export class LlmNotBilledError extends Error {
	constructor(
		readonly task: string,
		readonly status: number,
		detail: string,
	) {
		super(
			`LLM ${task} refused before processing: HTTP ${status} ${detail}`.trim(),
		);
		this.name = "LlmNotBilledError";
	}
}

/** HTTP statuses a provider returns before any model work, so the request is not billed. */
export const NOT_BILLED_STATUSES: ReadonlySet<number> = new Set([
	400, 401, 403, 404, 413, 422, 429,
]);
