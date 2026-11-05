/**
 * The beats of setup's first-search list (docs/decisions.md, 2026-11-05), kept apart from the
 * list's markup so they can be tested on their own: when a row reads found, when a set-aside row
 * leaves, and that it stays gone.
 */

/** One job the first search found, as `desktop.scanJobs` returns it. */
export interface FoundRow {
	jobId: string;
	company: string;
	title: string;
	state: "found" | "fits" | "rejected_by_filter" | "scored";
	reason: string | null;
	score: number | null;
	match: boolean;
	/** Past the rules; its scoring paused (the model cannot run now). */
	paused: boolean;
}

export type ShownRow = FoundRow & {
	/** What the row shows now: a new row reads as found for a beat before its real state. */
	shown: FoundRow["state"];
	/** A set-aside row that has shown its reason and left the list. */
	gone: boolean;
};

/** A new row reads "Found" this long, so the rules pass is seen even when it beat the poll. */
const FOUND_MS = 700;
/** A set-aside row shows its reason at least this long, then leaves with the others… */
const ASIDE_MIN_MS = 1_200;
/** …or on its own after this, if the rules pass is still going. */
const ASIDE_MAX_MS = 3_000;

/** What `shownRowsAt` remembers per job between renders. */
export interface RowBeats {
	/** When each job was first seen. */
	seen: Map<string, number>;
	/** When each job was first seen set aside. */
	asideAt: Map<string, number>;
	/** Set-aside jobs that have left the list: they stay gone until they leave that state. */
	gone: Set<string>;
}

export const newRowBeats = (): RowBeats => ({
	seen: new Map(),
	asideAt: new Map(),
	gone: new Set(),
});

/**
 * The rows with the beats of the prototype, at `now`: each arrives as found, a set-aside row
 * holds its reason and the set-aside rows leave together once no row is still being checked (or
 * each on its own after a few seconds). A row that left stays gone, even when a later arrival
 * starts a check again, until its job leaves the set-aside state. `waiting`: a beat is still
 * running, so look again shortly.
 */
export function shownRowsAt(
	rows: FoundRow[],
	beats: RowBeats,
	now: number = Date.now(),
): { shown: ShownRow[]; waiting: boolean } {
	for (const r of rows)
		if (!beats.seen.has(r.jobId)) beats.seen.set(r.jobId, now);
	const first = rows.map((r) => {
		const fresh = now - (beats.seen.get(r.jobId) ?? now) < FOUND_MS;
		return { ...r, shown: fresh ? ("found" as const) : r.state };
	});
	const checking = first.some((r) => r.shown === "found");
	let waiting = checking;
	const shown = first.map((r) => {
		if (r.shown !== "rejected_by_filter") {
			if (r.state !== "rejected_by_filter") {
				beats.asideAt.delete(r.jobId);
				beats.gone.delete(r.jobId);
			}
			return { ...r, gone: false };
		}
		if (!beats.asideAt.has(r.jobId)) beats.asideAt.set(r.jobId, now);
		const held = now - (beats.asideAt.get(r.jobId) ?? now);
		if (held >= ASIDE_MAX_MS || (held >= ASIDE_MIN_MS && !checking))
			beats.gone.add(r.jobId);
		const gone = beats.gone.has(r.jobId);
		if (!gone) waiting = true;
		return { ...r, gone };
	});
	return { shown, waiting };
}
