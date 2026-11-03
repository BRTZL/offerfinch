/** Enforces a minimum gap between requests to the same host. */
export class HostRateLimiter {
	private readonly last = new Map<string, number>();

	constructor(
		private readonly minIntervalMs: number,
		private readonly now: () => number = Date.now,
		private readonly sleep: (ms: number) => Promise<void> = (ms) =>
			new Promise((resolve) => setTimeout(resolve, ms)),
	) {}

	/** Waits until the host may be hit again. `crawlDelaySeconds` from robots.txt raises the gap. */
	async wait(url: string, crawlDelaySeconds?: number): Promise<void> {
		const host = new URL(url).host;
		const gap = Math.max(this.minIntervalMs, (crawlDelaySeconds ?? 0) * 1000);
		const previous = this.last.get(host);
		if (previous !== undefined) {
			const remaining = previous + gap - this.now();
			if (remaining > 0) await this.sleep(remaining);
		}
		this.last.set(host, this.now());
	}
}
