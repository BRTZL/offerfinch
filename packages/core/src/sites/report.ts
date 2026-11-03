import type {
	DroppedExample,
	ProviderDropReason,
	ProviderRunReport,
} from "../pipeline/scan-report";

/** At most this many examples kept per reason (the scan history caps them again). */
const EXAMPLES = 5;

/** What a source's run set aside, by reason, with a few examples each, for the scan history. */
export class DropLog {
	private readonly byReason = new Map<
		ProviderDropReason,
		{ count: number; examples: DroppedExample[] }
	>();

	add(reason: ProviderDropReason, example?: DroppedExample): void {
		const entry = this.byReason.get(reason) ?? { count: 0, examples: [] };
		entry.count++;
		if (example && entry.examples.length < EXAMPLES)
			entry.examples.push(example);
		this.byReason.set(reason, entry);
	}

	report(): ProviderRunReport["dropped"] {
		return [...this.byReason.entries()].map(([reason, e]) => ({
			reason,
			count: e.count,
			...(e.examples.length ? { examples: e.examples } : {}),
		}));
	}
}
