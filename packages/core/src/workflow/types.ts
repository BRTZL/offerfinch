import type { ApplicationState } from "../domain/states";

/**
 * One event type for every user action. The payload carries ids only: the workflow
 * re-reads Postgres (the source of truth) on each wake-up, so a duplicate event is harmless.
 * Cloudflare event types allow letters, digits, `-` and `_` only.
 */
export const APPLICATION_UPDATED_EVENT = "application_updated";

export interface ApplicationUpdatedPayload {
	/** Row id in `workflow_events`, written before the event is sent. */
	eventId: string;
}

export interface ScanWorkflowParams {
	userId: string;
	/** Limit the scan to these companies; all active companies when omitted. */
	companyIds?: string[];
	trigger: "cron" | "cli" | "manual";
}

export interface ApplicationWorkflowParams {
	userId: string;
	jobId: string;
}

/**
 * ApplicationWorkflow instance ids derive from the job id (max 100 characters), so a retried
 * scan can never start a second instance for the same job.
 */
export function applicationInstanceId(jobId: string): string {
	return `job-${jobId}`;
}

/** Cloudflare `createBatch` accepts at most 100 instances per call. */
export const WORKFLOW_BATCH_SIZE = 100;

/** How long a paused workflow waits before the application expires. Cloudflare allows up to 365 days. */
export const WAIT_TIMEOUTS: Partial<
	Record<ApplicationState, `${number} days`>
> = {
	scored: "30 days",
	needs_answers: "14 days",
	ready_for_review: "14 days",
	approved: "30 days",
	needs_human: "7 days",
};
