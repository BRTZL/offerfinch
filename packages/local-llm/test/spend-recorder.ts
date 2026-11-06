import type { SpendStore } from "@offerfinch/core/scoring/metered";

/**
 * A spending store that keeps every string it is given (reservations, refusals, settlements,
 * holds): what the real store would save in the ledger, for tests that check what is kept.
 */
export class SpendRecorder implements SpendStore {
	readonly rows: string[] = [];
	private n = 0;

	private keep(kind: string, input: unknown): void {
		this.rows.push(`${kind} ${JSON.stringify(input)}`);
	}

	async reserveSpend(input: Parameters<SpendStore["reserveSpend"]>[0]) {
		this.keep("reserve", input);
		return { ok: true as const, id: `r${++this.n}` };
	}

	async subscriptionBudget() {
		return { used: 0, budget: 500, resetsAt: null };
	}

	async recordRefusal(input: Parameters<SpendStore["recordRefusal"]>[0]) {
		this.keep("refusal", input);
	}

	async recordPaidStop(userId: string, vendor: string) {
		this.keep("paid-stop", { userId, vendor });
	}

	async listCapPausedJobIds() {
		return [];
	}

	async spendingStatus() {
		return { enabled: true, capMicros: 1e9, spentMicros: 0, reservedMicros: 0 };
	}

	async settleSpend(
		id: string,
		input: Parameters<SpendStore["settleSpend"]>[1],
	) {
		this.keep("settle", { id, ...input });
	}

	async holdSpend(id: string, input: Parameters<SpendStore["holdSpend"]>[1]) {
		this.keep("hold", { id, ...input });
	}
}
