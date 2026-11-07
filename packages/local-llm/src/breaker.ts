import type { SubscriptionUnavailableError } from "@offerfinch/core/scoring/llm";

/** How long a pause without a reset time keeps every caller from starting the CLI again. */
const HOLD_MINUTES: Record<string, number> = {
	usage_limit: 30,
	logged_out: 10,
	not_subscription: 10,
	extra_usage: 60,
	boundary: 60,
	not_owner: 0,
	call_budget: 0,
};

/**
 * Process-wide stop after a usage limit, a logout or a refused session: the next callers (the
 * other applications of the same scan) fail fast with the same pause instead of each starting a
 * CLI that would fail the same way. Held until the vendor's reset time, else a few minutes.
 */
export class Breaker {
	private open: { error: SubscriptionUnavailableError; until: number } | null =
		null;

	trip(error: SubscriptionUnavailableError, now: Date): void {
		const minutes = HOLD_MINUTES[error.kind] ?? 10;
		const until = error.resetsAt
			? error.resetsAt.getTime()
			: now.getTime() + minutes * 60_000;
		if (until > now.getTime()) this.open = { error, until };
	}

	/** Closes the breaker if its open pause is of `kind`; any other pause stays as it is. */
	clear(kind: SubscriptionUnavailableError["kind"]): void {
		if (this.open?.error.kind === kind) this.open = null;
	}

	current(now: Date): SubscriptionUnavailableError | null {
		if (this.open && now.getTime() < this.open.until) return this.open.error;
		this.open = null;
		return null;
	}
}
