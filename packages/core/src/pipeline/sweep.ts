import { STUCK_APPLYING_MINUTES } from "../apply/submit";
import { billingOf } from "../scoring/llm";
import { capReached, subscriptionBudgetReached } from "../scoring/metered";
import type { InstanceStatus, PipelineDeps } from "./ports";

/** Statuses after which an instance does nothing more on its own. */
const STOPPED: InstanceStatus[] = ["errored", "terminated", "complete"];

export interface SweepResult {
	checked: number;
	restarted: string[];
	/** Still running or waiting; left alone. */
	active: string[];
	failed: { jobId: string; error: string }[];
	/** Applications stuck in applying, handed over to the user. */
	handedOver: string[];
	/** Jobs paused by the spending cap whose instance was started again now that it has room. */
	resumed: string[];
	/** Why paused work was left alone this time (the subscription call budget), if it was. */
	waiting?: string;
}

/** Longer than a preparation's draft and review steps take, so a running one is left alone. */
const CAP_PAUSED_MINUTES = 120;

/**
 * Finds applications whose workflow started but left the job in `found` (the instance errored,
 * was terminated, or completed early, e.g. before a profile was imported) and restarts their
 * instance. The restarted run re-reads Postgres, so a job that has moved on is not touched twice.
 * Applications stuck in `applying` are handed over to the user, never resubmitted.
 */
export async function sweepStuckApplications(
	deps: PipelineDeps,
	userId: string,
	options: { olderThanMinutes?: number; limit?: number; now?: Date } = {},
): Promise<SweepResult> {
	const now = options.now ?? deps.now?.() ?? new Date();
	const cutoff = new Date(
		now.getTime() - (options.olderThanMinutes ?? 60) * 60_000,
	);
	// The subscription's call budget for the last 24 hours: while it is used up, scoring and
	// preparation on it wait, and the sweep after it frees starts them again.
	const budget = deps.spend
		? await subscriptionBudgetReached(deps.spend, userId, [
				deps.llm,
				deps.tailorLlm ?? deps.llm,
			])
		: null;
	const scoringWaits =
		budget !== null && billingOf(deps.llm) === "subscription";
	const preparingWaits =
		budget !== null && billingOf(deps.tailorLlm ?? deps.llm) === "subscription";
	const jobIds = scoringWaits
		? []
		: await deps.repo.listStuckFoundJobIds(
				userId,
				cutoff,
				options.limit ?? 100,
			);
	const result: SweepResult = {
		checked: jobIds.length,
		restarted: [],
		active: [],
		failed: [],
		handedOver: [],
		resumed: [],
		...(budget ? { waiting: budget.message } : {}),
	};
	// A submission whose worker died leaves the application in applying with nothing to wake it.
	if (deps.apply)
		result.handedOver = await deps.apply.store.handOverStuck(
			userId,
			new Date(now.getTime() - STUCK_APPLYING_MINUTES * 60_000),
		);
	for (const jobId of jobIds) {
		try {
			const status = await deps.workflows.status(jobId);
			if (!STOPPED.includes(status)) {
				result.active.push(jobId);
				continue;
			}
			await deps.workflows.restart({ userId, jobId });
			result.restarted.push(jobId);
			deps.log?.("stuck application restarted", { jobId, status });
		} catch (error) {
			result.failed.push({
				jobId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	// Preparation the cap paused waits for an event; a new month or a higher cap sends none, so
	// the sweep starts those instances again (Postgres decides what they do) when there is room.
	// The same wakes preparation a subscription paused (usage limit, logged out): one retry per
	// application per sweep, after it has waited CAP_PAUSED_MINUTES.
	if (
		deps.spend &&
		!preparingWaits &&
		!(await capReached(deps.spend, userId))
	) {
		const paused = await deps.spend.listCapPausedJobIds(
			userId,
			new Date(now.getTime() - CAP_PAUSED_MINUTES * 60_000),
		);
		for (const jobId of paused.slice(0, options.limit ?? 100)) {
			try {
				if ((await deps.workflows.status(jobId)) === "running") continue;
				await deps.workflows.restart({ userId, jobId });
				result.resumed.push(jobId);
			} catch (error) {
				result.failed.push({
					jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return result;
}
