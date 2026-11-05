/** What setup's first search says above its list, from the scan's progress and the found jobs. */

export interface SearchProgress {
	status: string;
	error?: string | null;
	total: number | null;
	done: number;
	unit: "sources" | "companies";
	/** The source being read now, by name. */
	source: string | null;
}

export interface SearchCounts {
	read: number;
	setAside: number;
	matches: number;
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

export const NO_MATCHES =
	"No matches this time. OfferFinch keeps looking every hour, and new ones show up in the Inbox.";

export function firstSearchLine(
	p: SearchProgress | undefined,
	counts: SearchCounts,
	phase: { checking: boolean; settled: boolean; fitRules: number },
): string {
	if (!p) return "Starting…";
	if (p.status === "errored") return `The search stopped: ${p.error}`;
	if (p.status !== "complete") {
		if (!p.total) return "Searching for jobs…";
		const n = Math.min(p.done + 1, p.total);
		const reading = p.source ? `Reading ${p.source}` : "Searching for jobs";
		return `${reading} · ${n} of ${p.total} ${p.unit === "companies" ? "companies" : "sources"}`;
	}
	const read = `${plural(counts.read, "job")} read`;
	// The scan ended before the first read of what it found.
	if (counts.read === 0 && !phase.settled)
		return "Search done. Checking what it found…";
	if (phase.settled) {
		if (counts.read === 0) return `Done: no new jobs this time. ${NO_MATCHES}`;
		const head = `Done: ${read}, ${counts.setAside} set aside`;
		if (counts.matches === 0) return `${head}. ${NO_MATCHES}`;
		return `${head}, ${plural(counts.matches, "match", "matches")}. ${counts.matches === 1 ? "It is" : "They are"} waiting in your Inbox.`;
	}
	// Nothing passed yet: still the rules pass (a row may be between the two reads).
	if (phase.checking || phase.fitRules === 0)
		return `${read}. Checking them against your rules…`;
	return phase.fitRules === 1
		? "1 fits your rules. Scoring it…"
		: `${phase.fitRules} fit your rules. Scoring them…`;
}
