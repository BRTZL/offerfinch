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
	/** Jobs whose scoring failed (their run errored); the next search tries them again. */
	failed: number;
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

const NO_MATCHES =
	"No matches this time. OfferFinch keeps looking every hour, and new ones show up in the Inbox.";

/** How often the step reads the run while it is live, and while scoring waits on a paused model. */
export const POLL_MS = 1_000;
export const PAUSED_POLL_MS = 5_000;

/**
 * Whether the first search is settled, and how often to read it meanwhile. A scan ends before
 * its jobs are scored, so the scan alone never settles it: settled is the scan complete, no
 * scoring it started still pending, no job waiting on a paused model, and a read of the jobs
 * taken after scoring was seen done (the polls tick apart, and the last scores land just before
 * `pending` reaches 0). An errored scan is settled at once. While scoring is paused (its runs
 * ended, the jobs still unscored) it is never settled: it reads slower until scoring resumes.
 * A job whose scoring failed (its run errored) is not pending and not paused: it settles, and
 * the done line counts it apart (`doneLine`).
 */
export function firstSearchSettle(s: {
	status: string | undefined;
	/** `desktop.scoring`'s pending count, once read. */
	pending: number | undefined;
	/** Jobs of this run waiting on a paused model, from the latest jobs read. */
	paused: number | undefined;
	jobsAt: number;
	scoringAt: number;
}): { settled: boolean; paused: boolean; pollMs: number | false } {
	if (s.status === "errored")
		return { settled: true, paused: false, pollMs: false };
	if (s.status !== "complete" || s.pending === undefined || s.pending > 0)
		return { settled: false, paused: false, pollMs: POLL_MS };
	if (s.paused === undefined)
		return { settled: false, paused: false, pollMs: POLL_MS };
	if (s.paused > 0)
		return { settled: false, paused: true, pollMs: PAUSED_POLL_MS };
	const settled = s.jobsAt > s.scoringAt;
	return { settled, paused: false, pollMs: settled ? false : POLL_MS };
}

/**
 * The settled line. Failed scoring is never "no matches": it says how many failed and that the
 * next search tries them again.
 */
function doneLine(counts: SearchCounts): string {
	if (counts.read === 0) return `Done: no new jobs this time. ${NO_MATCHES}`;
	const head = `Done: ${plural(counts.read, "job")} read, ${counts.setAside} set aside`;
	const matches = plural(counts.matches, "match", "matches");
	if (counts.failed > 0)
		return `${head}, ${matches}. Scoring failed for ${counts.failed}; OfferFinch retries at the next search.`;
	if (counts.matches === 0) return `${head}. ${NO_MATCHES}`;
	return `${head}, ${matches}. ${counts.matches === 1 ? "It is" : "They are"} waiting in your Inbox.`;
}

/** Scoring waits on a paused model: the same words every poll, so the live region stays quiet. */
function pausedLine(paused: { count: number; reason: string | null }): string {
	const n = paused.count;
	const head = `Scoring is paused: ${plural(n, "job")} ${n === 1 ? "waits" : "wait"} for a fit score.`;
	return paused.reason ? `${head} ${paused.reason}` : head;
}

export function firstSearchLine(
	p: SearchProgress | undefined,
	counts: SearchCounts,
	phase: {
		checking: boolean;
		settled: boolean;
		fitRules: number;
		/** Scoring waits on a paused model: how many jobs, and why (the pause's own message). */
		paused?: { count: number; reason: string | null } | null;
	},
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
	if (phase.settled) return doneLine(counts);
	if (phase.paused && phase.paused.count > 0) return pausedLine(phase.paused);
	// Nothing passed yet: still the rules pass (a row may be between the two reads).
	if (phase.checking || phase.fitRules === 0)
		return `${read}. Checking them against your rules…`;
	return phase.fitRules === 1
		? "1 fits your rules. Scoring it…"
		: `${phase.fitRules} fit your rules. Scoring them…`;
}
