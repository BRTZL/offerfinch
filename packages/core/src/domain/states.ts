/**
 * Application state machine from docs/PLAN.md:
 *
 * found -> rejected_by_filter | scored -> preparing -> needs_answers -> ready_for_review
 *   -> approved | rejected | expired -> applying -> applied | needs_human | failed
 *
 * Rules enforced here:
 * - Preparation hands off to the user only through `needs_answers`; `needs_human` is a submission
 *   handoff, reachable only from `applying`. So `applying` is reachable only from `approved`, or as
 *   a retry from `needs_human` after an approved submission stopped.
 * - New answers to a form's questions change the form answers, so they go back through review
 *   and approval (`applying`/`needs_human -> ready_for_review`) before anything is submitted.
 * - The state alone never authorizes a submission: repositories also refuse to enter `applying`
 *   unless an unrevoked approval matches the current document hashes (see `domain/approval.ts`).
 * - An edit after approval moves `approved` back to `ready_for_review` and revokes the approval.
 * - `expired` is where a timed-out wait ends. It is terminal and never leads to `approved`.
 * - `dismissed` is "Not interested": the user's call on a match (`scored`), or the system's for a
 *   company the user hid (`found` or `scored` only, never later). Undo and unhiding a company
 *   return it to the state it left, so it is not terminal; it never leads past `scored`.
 */
export const APPLICATION_STATES = [
	"found",
	"rejected_by_filter",
	"scored",
	"preparing",
	"needs_answers",
	"ready_for_review",
	"approved",
	"rejected",
	"expired",
	"applying",
	"applied",
	"needs_human",
	"failed",
	"dismissed",
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

const TRANSITIONS: Record<ApplicationState, readonly ApplicationState[]> = {
	// found -> dismissed: a new job from a company the user hid.
	found: ["rejected_by_filter", "scored", "dismissed"],
	// rejected_by_filter -> found: the user chose it anyway (added it themselves, or Show in
	// Matches on a job never scored); -> scored: Show in Matches on a match the job search's
	// re-filter set aside. Either way the filter never sets it aside again.
	rejected_by_filter: ["found", "scored"],
	// scored -> dismissed: Not interested, or a company the user hid.
	// scored -> rejected_by_filter: the job search changed and the match no longer passes it
	// (re-filter, no model call); only a match nobody acted on.
	scored: ["preparing", "expired", "dismissed", "rejected_by_filter"],
	preparing: ["needs_answers", "ready_for_review", "failed"],
	// -> rejected_by_filter: the job search changed and the re-filter now rejects the job.
	needs_answers: ["preparing", "expired", "rejected_by_filter"],
	ready_for_review: ["approved", "rejected", "expired", "rejected_by_filter"],
	// approved -> applied: the user submitted it by hand.
	approved: ["applying", "ready_for_review", "applied"],
	rejected: [],
	expired: [],
	// applying -> ready_for_review: saved answers to the form's questions were added; review again.
	applying: ["applied", "needs_human", "failed", "ready_for_review"],
	applied: [],
	// needs_human -> ready_for_review: answers to the form's questions were added (only when no
	// attempt reached the click); -> applied: the board confirmed, or the user submitted by hand.
	needs_human: ["applying", "expired", "failed", "ready_for_review", "applied"],
	failed: [],
	// Undo, or unhiding the company: back to where it was, nowhere further.
	dismissed: ["found", "scored"],
};

/** States the system may dismiss on its own (a hidden company); nothing past a listed match. */
export const AUTO_DISMISSABLE_STATES = [
	"found",
	"scored",
] as const satisfies readonly ApplicationState[];

/** States a workflow may be paused in while it waits for the user. A timeout moves these to `expired`. */
export const WAITING_STATES = [
	"scored",
	"needs_answers",
	"ready_for_review",
	"needs_human",
] as const satisfies readonly ApplicationState[];

export const TERMINAL_STATES = APPLICATION_STATES.filter(
	(state) => TRANSITIONS[state].length === 0,
);

export function allowedTransitions(
	from: ApplicationState,
): readonly ApplicationState[] {
	return TRANSITIONS[from];
}

export function canTransition(
	from: ApplicationState,
	to: ApplicationState,
): boolean {
	return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
	constructor(
		readonly from: ApplicationState,
		readonly to: ApplicationState,
	) {
		super(`Invalid application transition: ${from} -> ${to}`);
		this.name = "InvalidTransitionError";
	}
}

export function assertTransition(
	from: ApplicationState,
	to: ApplicationState,
): void {
	if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isWaitingState(state: ApplicationState): boolean {
	return (WAITING_STATES as readonly ApplicationState[]).includes(state);
}
