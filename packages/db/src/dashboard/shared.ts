import type { ApplicationState } from "@offerfinch/core/domain/states";
import { SUBSCRIPTION_PAUSE_PREFIX } from "@offerfinch/core/scoring/llm";
import { sql } from "drizzle-orm";
import { applications, jobs } from "../schema/pipeline";

/** What the dashboard sends to the workflow after committing; `null` when nothing changed. */
export interface PendingEvent {
	userId: string;
	eventId: string;
	instanceId: string;
}

/**
 * The Inbox's views, in the order the work flows: decide on matches, drafts are written, review
 * and approve, then applied or closed. Each is a predicate on the application, so a list and its
 * count always agree.
 */
export const INBOX_VIEWS = [
	"matches",
	"drafting",
	"review",
	"approved",
	"closed",
	"all",
] as const;

export type InboxView = (typeof INBOX_VIEWS)[number];

/**
 * The posting is not known to be closed (core `pipeline/closed.ts`). Needs `jobs` joined, as
 * every Inbox query has it.
 */
const postingOpen = sql`${jobs.closedAt} is null`;

/** A listed match nobody acted on: the user decides on it (Prepare or Not interested). */
const openMatch = sql`(${applications.state} = 'scored' and ${applications.endedReason} is null and ${applications.prepareRequestedAt} is null and ${postingOpen})`;

/** Submitted or being submitted: a posting closed since then is expected, and changes nothing. */
const submitted = sql`${applications.state} in ('applying', 'applied', 'needs_human')`;

export function inboxViewWhere(view: InboxView) {
	switch (view) {
		case "matches":
			return openMatch;
		case "drafting":
			// Prepare pressed (scored until the run starts drafting), drafting, or waiting for answers.
			return sql`((${applications.state} in ('preparing', 'needs_answers') or (${applications.state} = 'scored' and ${applications.endedReason} is null and ${applications.prepareRequestedAt} is not null)) and ${postingOpen})`;
		case "review":
			return sql`(${applications.state} = 'needs_human' or (${applications.state} = 'ready_for_review' and ${postingOpen}))`;
		case "approved":
			return sql`(${applications.state} = 'applying' or (${applications.state} = 'approved' and ${postingOpen}))`;
		case "closed":
			// Scored below the minimum counts as closed: it was never a match to decide on. So does
			// a posting found closed before it was submitted. A job the job filter rejected is
			// hidden everywhere, here too.
			return sql`(${applications.state} in ('applied', 'rejected', 'expired', 'failed', 'dismissed') or (${applications.state} = 'scored' and ${applications.endedReason} is not null) or (${jobs.closedAt} is not null and ${applications.state} not in ('found', 'rejected_by_filter') and not ${submitted}))`;
		case "all":
			return sql`${applications.state} not in ('found', 'rejected_by_filter')`;
	}
}

export interface ApplicationFilters {
	/** One of the Inbox's views; replaces `states` when set. */
	view?: InboxView;
	states?: ApplicationState[];
	search?: string;
	minScore?: number;
	companyId?: string;
	limit?: number;
	/** Rows to skip (paging; the desktop inbox loads pages as it scrolls). */
	offset?: number;
	/** `recent` (default): last change first; `fit`: highest rank (else score) first. */
	sort?: "recent" | "fit";
	/** Also jobs the user added by link that are still being read, checked or scored. */
	includeAdded?: boolean;
}

export class EditConflictError extends Error {
	constructor(readonly currentVersion: number) {
		super(
			`The document changed since you opened it (now version ${currentVersion}); reload and edit again`,
		);
		this.name = "EditConflictError";
	}
}

/** The submission day the user gave (noon UTC, so it reads as that day everywhere), or now. */
export function appliedDate(day: string | undefined, now: Date): Date {
	if (!day) return now;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
		throw new Error("Refusing: the submission date must be YYYY-MM-DD");
	const date = new Date(`${day}T12:00:00Z`);
	if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day)
		throw new Error("Refusing: not a valid date");
	// "Today" in the user's time zone can be tomorrow in UTC (up to UTC+14).
	const latest = new Date(now.getTime() + 14 * 3_600_000);
	if (day > latest.toISOString().slice(0, 10))
		throw new Error("Refusing: the submission date is in the future");
	return date;
}

/**
 * Why an application waits on a subscription, if it does: its latest model call was refused
 * for a usage limit, a logout, a non-subscription login, extra usage or another account, and
 * it has not moved on since. The message carries how it resumes.
 */
export function subscriptionPauseOf(
	state: string,
	calls: readonly { billing: string; error: string | null }[],
): string | null {
	if (!["found", "scored", "preparing", "ready_for_review"].includes(state))
		return null;
	const last = calls.at(-1);
	// A paid extra-usage call is re-labelled `api` but still carries its pause.
	return last?.error?.startsWith(SUBSCRIPTION_PAUSE_PREFIX) ? last.error : null;
}
