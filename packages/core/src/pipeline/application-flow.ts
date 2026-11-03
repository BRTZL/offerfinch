import { beginSubmissionStep, submitStep } from "../apply/submit";
import { isWaitingState } from "../domain/states";
import { workContext } from "../filter/home";
import { evaluateHardRequirements, type FilterResult } from "../filter/rules";
import { scoreFit } from "../scoring/fit";
import { LlmPausedError } from "../scoring/llm";
import { meteredFor } from "../scoring/metered";
import { rankScored } from "../scoring/rank";
import {
	type ApplicationStore,
	expireAfterTimeout,
	nextAction,
} from "../workflow/flow";
import {
	APPLICATION_UPDATED_EVENT,
	type ApplicationUpdatedPayload,
	type ApplicationWorkflowParams,
} from "../workflow/types";
import {
	ApplicationNotFoundError,
	FlowPaused,
	type FlowStep,
	type PipelineDeps,
} from "./ports";
import {
	blockedStep,
	checkErrorStep,
	draftStep,
	failPreparationStep,
	markReadyStep,
	reviewStep,
	startPreparingStep,
} from "./prepare";
import { redraftInReview } from "./redraft";

export type ApplicationOutcome =
	| { outcome: "read_failed"; reason: string }
	| { outcome: "rejected_by_filter"; reason: string }
	| { outcome: "low_score"; score: number; reason: string }
	| { outcome: "no_profile"; reason: string }
	| { outcome: "paused"; state: string; waitingFor: string }
	| { outcome: "finished"; state: string };

/** Step 1: hard requirements, no AI. Idempotent: a retry after the write reads the stored result. */
export async function filterStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<{
	applicationId: string;
	ended: boolean;
	result: FilterResult;
} | null> {
	const app = await deps.repo.getApplicationByJob(userId, jobId);
	if (!app) return null;
	if (app.state !== "found") {
		const stored = app.filter ?? {
			decision: "keep",
			summary: "already filtered",
			reasons: [],
			flags: [],
		};
		return {
			applicationId: app.applicationId,
			ended: app.state === "rejected_by_filter",
			result: stored,
		};
	}
	const settings = await deps.repo.getFilterSettings(userId);
	const result = evaluateHardRequirements(app.job, settings);
	const chosen = await deps.repo.chosenAnyway?.(userId, app.applicationId);
	if (result.decision === "reject" && !chosen) {
		await deps.repo.recordFilterRejection(userId, app.applicationId, result);
		return { applicationId: app.applicationId, ended: true, result };
	}
	await deps.repo.saveFilterResult(userId, app.applicationId, result);
	return { applicationId: app.applicationId, ended: false, result };
}

/** Step 2: fit score against profile evidence. Idempotent: a scored application is not re-scored. */
export async function scoreStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<
	| { score: number; ended: boolean; reason: string | null }
	| { noProfile: true }
	| { capped: string }
> {
	const app = await deps.repo.getApplicationByJob(userId, jobId);
	if (!app) throw new ApplicationNotFoundError(userId, jobId);
	if (app.state !== "found")
		return {
			score: app.score ?? 0,
			ended: app.endedReason !== null,
			reason: app.endedReason,
		};
	const profile = await deps.repo.getProfile(userId);
	if (!profile) return { noProfile: true };
	const settings = await deps.repo.getFilterSettings(userId);
	const ctx = workContext(settings);
	let fit: Awaited<ReturnType<typeof scoreFit>>;
	try {
		fit = await scoreFit(
			meteredFor(deps.llm, deps.spend, userId, app.applicationId),
			{
				job: { ...app.job, companyName: app.companyName },
				profile,
				work: {
					livesIn: ctx.livesIn,
					citizenship: ctx.citizenship,
					rightToWork: ctx.rightToWork,
					locationVerdict: app.filter?.locationVerdict,
					locationNote: app.filter?.reasons.find((r) => r.rule === "location")
						?.message,
				},
			},
		);
	} catch (error) {
		// The application stays found; the sweep after a later scan starts it again.
		if (error instanceof LlmPausedError) return { capped: error.message };
		throw error;
	}
	const chosen = await deps.repo.chosenAnyway?.(userId, app.applicationId);
	const reason =
		fit.score < settings.minScore && !chosen
			? `Fit score ${fit.score} is below the minimum of ${settings.minScore}.`
			: null;
	// Deterministic, no model call: the order of Matches.
	const rank = rankScored({
		score: fit.score,
		job: {
			title: app.job.title,
			descriptionText: app.job.descriptionText,
			companyId: app.companyId,
		},
		filter: app.filter,
		profile,
		dismissals: (await deps.repo.dismissalSignals?.(userId)) ?? [],
	});
	await deps.repo.recordScore(userId, app.applicationId, fit, reason, rank);
	return { score: fit.score, ended: reason !== null, reason };
}

/** Step 3: invoke the notifier once per strong match, guarded by an atomic claim in SQLite. */
async function alertStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<boolean> {
	const app = await deps.repo.getApplicationByJob(userId, jobId);
	if (!app || app.score === null) return false;
	const settings = await deps.repo.getFilterSettings(userId);
	if (app.score < settings.alertMinScore) return false;
	if (!(await deps.repo.claimAlert(userId, app.applicationId))) return false;
	try {
		await deps.notifier.notifyStrongMatch({
			title: app.job.title,
			companyName: app.companyName,
			score: app.score,
			url: app.job.url,
			flags: app.filter?.flags ?? [],
		});
	} catch (error) {
		// Release the claim so the step retry sends it; otherwise a failed POST loses the alert.
		await deps.repo.releaseAlert(userId, app.applicationId);
		throw error;
	}
	return true;
}

const MAX_WAKEUPS = 50;

/** One draft and its review, then ready, a redraft or the flagged review. Step names unchanged. */
async function prepareOnce(
	step: FlowStep,
	deps: PipelineDeps,
	userId: string,
	jobId: string,
	wake: number,
): Promise<"capped" | "next"> {
	const drafted = await step.do(
		`prepare ${wake}`,
		() => draftStep(deps, userId, jobId),
		{ retries: 2, timeoutSeconds: 900 },
	);
	if (drafted.outcome === "capped") return "capped";
	if (drafted.outcome !== "drafted") return "next";
	const reviewed = await step.do(
		`review ${wake}`,
		() => reviewStep(deps, userId, jobId),
		{ retries: 2, timeoutSeconds: 900 },
	);
	if (reviewed.outcome === "capped") return "capped";
	if (reviewed.outcome !== "no_documents" && reviewed.passed)
		await step.do(`ready ${wake}`, () => markReadyStep(deps, userId, jobId));
	else await step.do(`retry ${wake}`, () => blockedStep(deps, userId, jobId));
	return "next";
}

/**
 * ApplicationWorkflow body. Filter and score run first and end the instance (reason saved) on a
 * rejection or low score. Then: prepare (draft), review (independent claims check, rules, PDF and
 * DOCX export, ATS check), pauses for answers and for approval, then submits once on approval
 * when the user's switch allows (see `apply/submit.ts`). Every wake-up re-reads Postgres, which decides; a timed-out wait only ever moves the
 * application to `expired`. Step names are part of running instances' state: do not rename them.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep durable steps, hand-off, and stop decisions together so their side-effect ordering remains explicit.
export async function runApplicationFlow(
	step: FlowStep,
	deps: PipelineDeps,
	params: ApplicationWorkflowParams,
): Promise<ApplicationOutcome> {
	const { userId, jobId } = params;
	// A job added by link is read here, so the read survives quitting and waits its turn.
	const reader = deps.postingReader;
	if (reader) {
		const read = await step.do("read posting", () => reader(userId, jobId), {
			retries: 0,
			timeoutSeconds: 300,
		});
		if (!read.ok) return { outcome: "read_failed", reason: read.reason };
	}
	const filtered = await step.do("hard filter", () =>
		filterStep(deps, userId, jobId),
	);
	// Outside a step, so it is not retried: a job the user does not own fails the instance.
	if (!filtered) throw new ApplicationNotFoundError(userId, jobId);
	if (filtered.ended)
		return { outcome: "rejected_by_filter", reason: filtered.result.summary };

	const scored = await step.do(
		"fit score",
		() => scoreStep(deps, userId, jobId),
		{ retries: 3, timeoutSeconds: 600 },
	);
	if ("noProfile" in scored)
		return {
			outcome: "no_profile",
			reason: "No profile imported; the application stays found.",
		};
	if ("capped" in scored)
		return { outcome: "paused", state: "found", waitingFor: scored.capped };
	if (scored.ended)
		return {
			outcome: "low_score",
			score: scored.score,
			reason: scored.reason ?? "low score",
		};

	await step.do("strong match alert", () => alertStep(deps, userId, jobId), {
		retries: 3,
	});

	const store: ApplicationStore = deps.repo;
	const { applicationId } = filtered;
	for (let wake = 0; wake < MAX_WAKEUPS; wake++) {
		const state = await step.do(
			`read state ${wake}`,
			async () => (await store.getState(userId, applicationId)) ?? "found",
		);
		deps.log?.("application state", { applicationId, state, wake });
		const action = nextAction(state);
		if (action.kind === "done") return { outcome: "finished", state };

		// The spending cap pauses preparation: these wait for an event (a cap change wakes them).
		let capped = false;
		// A match waits in scored until the user presses Prepare: tailoring is on demand.
		const requested =
			state === "scored" &&
			(await step.do(`prepare requested ${wake}`, async () =>
				deps.repo.prepareRequested
					? deps.repo.prepareRequested(userId, applicationId)
					: true,
			));
		if (state === "scored" && requested) {
			const started = await step.do(`start preparing ${wake}`, () =>
				startPreparingStep(deps, userId, jobId),
			);
			if (started !== "capped") continue;
			capped = true;
		}

		if (state === "preparing") {
			let prepared: "capped" | "next";
			try {
				prepared = await prepareOnce(step, deps, userId, jobId, wake);
			} catch (error) {
				if (error instanceof FlowPaused) throw error;
				// The steps' own retries are spent: a real error, not a draft the check flagged.
				const message = error instanceof Error ? error.message : String(error);
				await step.do(`fail preparation ${wake}`, () =>
					failPreparationStep(deps, userId, jobId, message),
				);
				deps.log?.("preparation failed", { applicationId, error: message });
				return { outcome: "finished", state: "failed" };
			}
			if (prepared === "capped") capped = true;
			else continue;
		}

		if (state === "ready_for_review" && !capped) {
			// An edit is reviewed again before the user can approve it. A check that keeps failing,
			// or meets the cap, is recorded for this version: the dashboard shows it with a retry
			// instead of "Checking…" forever, and approval stays blocked.
			// A Redraft the user asked for writes its new version first; the review below checks it.
			await redraftInReview(step, deps, userId, jobId, wake);
			let failure: string | null = null;
			try {
				const reviewed = await step.do(
					`review ${wake}`,
					() => reviewStep(deps, userId, jobId),
					{ retries: 2, timeoutSeconds: 900 },
				);
				if (reviewed.outcome === "capped") failure = reviewed.reason;
			} catch (error) {
				if (error instanceof FlowPaused) throw error;
				failure = error instanceof Error ? error.message : String(error);
			}
			if (failure !== null) {
				const message = failure;
				await step.do(`check error ${wake}`, () =>
					checkErrorStep(deps, userId, jobId, message),
				);
				deps.log?.("check failed", { applicationId, error: message });
			}
		}

		// `apply N` belonged to the phase 2 stub; submission uses new step names.
		if (action.kind === "apply" && !capped) {
			const begun = await step.do(`begin submission ${wake}`, () =>
				beginSubmissionStep(deps, userId, applicationId),
			);
			deps.log?.("begin submission", { applicationId, ...begun });
			if (begun.outcome === "started") continue;
		}

		if (action.kind === "submit") {
			// No retries: a step that ran past its claim must never click again. It returns instead
			// of throwing, and an interrupted run is caught by the claim on the next wake-up.
			const submitted = await step.do(
				`submit ${wake}`,
				() => submitStep(deps, userId, applicationId),
				{ retries: 0, timeoutSeconds: 900 },
			);
			deps.log?.("submission", { applicationId, ...submitted });
			continue;
		}

		try {
			const event = await step.waitForEvent<ApplicationUpdatedPayload>(
				`wait ${state} ${wake}`,
				{
					type: APPLICATION_UPDATED_EVENT,
					timeout: action.kind === "wait" ? action.timeout : "30 days",
				},
			);
			await step.do(`consume event ${wake}`, () =>
				store.consumeEvent(userId, applicationId, event.payload.eventId),
			);
		} catch (error) {
			if (error instanceof FlowPaused)
				return { outcome: "paused", state, waitingFor: error.waitingFor };
			// Nothing waits forever in approved: a timeout there just ends the instance.
			if (!isWaitingState(state)) return { outcome: "finished", state };
			const expired = await step.do(`expire ${wake}`, () =>
				expireAfterTimeout(store, userId, applicationId, state),
			);
			if (expired.expired) return { outcome: "finished", state: "expired" };
		}
	}
	return {
		outcome: "paused",
		state: "unknown",
		waitingFor: "wake-up limit reached",
	};
}
