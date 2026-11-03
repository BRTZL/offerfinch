import {
	type ApplicationState,
	isWaitingState,
	TERMINAL_STATES,
} from "../domain/states";
import type { PipelineRepository } from "../pipeline/ports";
import { WAIT_TIMEOUTS } from "./types";

export type NextAction =
	| { kind: "done"; state: ApplicationState }
	| { kind: "prepare" }
	| { kind: "apply" }
	| { kind: "submit" }
	| { kind: "wait"; state: ApplicationState; timeout: string };

/** Decides what the workflow does next from the state in Postgres. */
export function nextAction(state: ApplicationState): NextAction {
	if (
		(TERMINAL_STATES as ApplicationState[]).includes(state) ||
		state === "found"
	)
		return { kind: "done", state };
	if (state === "preparing" || state === "scored") return { kind: "prepare" };
	if (state === "approved") return { kind: "apply" };
	if (state === "applying") return { kind: "submit" };
	if (isWaitingState(state))
		return { kind: "wait", state, timeout: WAIT_TIMEOUTS[state] ?? "14 days" };
	return { kind: "done", state };
}

/** The part of the repository the wait loop needs. */
export type ApplicationStore = Pick<
	PipelineRepository,
	"getState" | "transition" | "consumeEvent" | "checkApproval"
>;

/**
 * Called when a wait times out. Only moves to `expired`, and only if the application is still in
 * the state it was waiting in. A timeout never approves, submits or advances anything.
 */
export async function expireAfterTimeout(
	store: ApplicationStore,
	userId: string,
	applicationId: string,
	waitedIn: ApplicationState,
): Promise<{ expired: boolean; state: ApplicationState | null }> {
	if (!isWaitingState(waitedIn))
		return {
			expired: false,
			state: await store.getState(userId, applicationId),
		};
	const expired = await store.transition(userId, applicationId, {
		from: [waitedIn],
		to: "expired",
		reason: `No user action within ${WAIT_TIMEOUTS[waitedIn] ?? "the wait period"} while ${waitedIn}`,
		actor: "workflow",
	});
	return { expired, state: await store.getState(userId, applicationId) };
}
