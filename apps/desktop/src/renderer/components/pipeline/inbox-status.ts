import { ENDED_COMPANY_HIDDEN } from "@offerfinch/core/domain/dismissal";

/**
 * Where an Inbox row stands, as its status chip and the status filter's bucket. Kept in step
 * with the views' predicates (`inboxViewWhere` in packages/db/src/dashboard/shared.ts), so a row
 * listed under "To review" always says To review. No imports from the app: unit-tested in node.
 */

type InboxBucket = "matches" | "drafting" | "review" | "approved" | "closed";

type ChipTone =
	| "match"
	| "drafting"
	| "review"
	| "approved"
	| "warning"
	| "closed";

interface StatusRow {
	state: string;
	endedReason: string | null;
	prepareRequestedAt: Date | string | null;
	closedAt: Date | string | null;
	openQuestions?: number;
	/** Truthy while an employer's form that was sent waits for "Got the email". */
	sentCheckEmail?: number | boolean;
}

const SUBMITTED = ["applying", "applied", "needs_human"];

const CLOSED_LABEL: Record<string, string> = {
	applied: "Applied",
	rejected: "Rejected",
	expired: "Expired",
	failed: "Failed",
};

type Status = { bucket: InboxBucket | null; label: string; tone: ChipTone };

/** A step that still needs the user or the drafts: Match, Drafting, To review, Approved. */
function openStatus(row: StatusRow): Status | null {
	const { state } = row;
	const fresh = state === "scored" && !row.endedReason;
	if (fresh && !row.prepareRequestedAt)
		return { bucket: "matches", label: "Match", tone: "match" };
	if (state === "preparing" || state === "needs_answers" || fresh)
		return state === "needs_answers" || (row.openQuestions ?? 0) > 0
			? { bucket: "drafting", label: "Needs answers", tone: "warning" }
			: { bucket: "drafting", label: "Drafting", tone: "drafting" };
	if (state === "ready_for_review")
		return { bucket: "review", label: "To review", tone: "review" };
	if (state === "approved")
		return { bucket: "approved", label: "Approved", tone: "approved" };
	return null;
}

/** Done, set aside, below the minimum, or the posting closed. */
function closedStatus(row: StatusRow): Status {
	const { state } = row;
	if (row.closedAt && !SUBMITTED.includes(state))
		return { bucket: "closed", label: "Posting closed", tone: "closed" };
	if (state === "dismissed")
		return {
			bucket: "closed",
			label:
				row.endedReason === ENDED_COMPANY_HIDDEN
					? "Company hidden"
					: "Not interested",
			tone: "closed",
		};
	if (state === "scored")
		return { bucket: "closed", label: "Below your minimum", tone: "closed" };
	return {
		bucket: "closed",
		label: CLOSED_LABEL[state] ?? state,
		tone: state === "applied" ? "approved" : "closed",
	};
}

/**
 * The bucket (null: in no status view, as a job added by link still being read) and the chip's
 * words and tone.
 */
export function inboxStatus(row: StatusRow): Status {
	const { state } = row;
	if (state === "found" || state === "rejected_by_filter")
		return {
			bucket: null,
			label: state === "found" ? "Added" : "Set aside",
			tone: "closed",
		};
	// Submitted or being submitted: a posting closed since then changes nothing.
	if (state === "needs_human")
		return row.sentCheckEmail
			? { bucket: "review", label: "Sent — check your email", tone: "approved" }
			: { bucket: "review", label: "Needs you", tone: "warning" };
	if (state === "applying")
		return { bucket: "approved", label: "Submitting", tone: "approved" };
	return (!row.closedAt && openStatus(row)) || closedStatus(row);
}

/**
 * The row to open when nothing is: the first of the list, once the list shows what was asked
 * for (not the previous filter's rows, kept on screen while the new ones load), and never one
 * that is leaving (fading out after Not interested or Interested). Null when the selection
 * should stay as it is, or nothing is left to open.
 */
export function rowToOpen<T>(input: {
	items: T[];
	/** Something is open already: a row, a company, or several rows. */
	selected: boolean;
	/** The list holds the current filter's rows (loaded, not a placeholder). */
	settled: boolean;
	/** The line is on its way out of the list. */
	leaving?: (item: T) => boolean;
}): T | null {
	if (input.selected || !input.settled) return null;
	return input.items.find((item) => !input.leaving?.(item)) ?? null;
}

/**
 * The line to open after `ids` leave the list: the next one that stays, else the one before.
 * Lines already leaving (`leaving`) do not stay either; null when nothing does.
 */
export function lineAfter<T>(
	items: T[],
	ids: string[],
	idsOf: (item: T) => string[],
	leaving: ReadonlySet<string> = new Set(),
): T | null {
	const goes = new Set([...ids, ...leaving]);
	const stays = (item: T) => idsOf(item).some((id) => !goes.has(id));
	const at = items.findIndex((item) =>
		idsOf(item).some((id) => ids.includes(id)),
	);
	if (at < 0) return null;
	const after = items.slice(at + 1).find(stays);
	if (after) return after;
	return [...items.slice(0, at)].reverse().find(stays) ?? null;
}
