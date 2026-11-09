import { LlmPausedError } from "../scoring/llm";
import {
	capReached,
	meteredFor,
	SpendingCapReachedError,
	subscriptionBudgetReached,
} from "../scoring/metered";
import {
	mergeAnswers,
	ownAnswerQuestions,
	type RedraftDocument,
	redraftApplication,
	redraftDocumentsOf,
} from "../tailor/redraft";
import { formAnswersText, parseFormAnswers } from "../tailor/tailor";
import {
	ApplicationNotFoundError,
	FlowPaused,
	type FlowStep,
	type PipelineDeps,
} from "./ports";

/**
 * The Redraft the user asked for on a prepared application (`tailor/redraft.ts`), run in review
 * before its check: the chosen documents get a new version, the others are left as they are, and
 * the review step that follows checks the new version like any new version in review.
 */

type RedraftOutcome =
	| { outcome: "none" }
	| { outcome: "saved"; documents: RedraftDocument[] }
	| { outcome: "paused"; reason: string }
	| { outcome: "conflict" }
	| { outcome: "gone" };

const nowIso = (deps: PipelineDeps) =>
	(deps.now?.() ?? new Date()).toISOString();

/**
 * Writes the pending redraft, if any. A request with a problem waits for the user's Try again.
 * The spending limit and the subscription's call budget are checked first, as Prepare does; a
 * pause is recorded on the request, never an error. Idempotent: the versions and the cleared
 * request are written in one transaction, so a retry after it finds nothing to do.
 */
async function redraftStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
): Promise<RedraftOutcome> {
	const { repo } = deps;
	if (!repo.pendingRedraft || !repo.saveRedraft || !repo.setRedraftProblem)
		return { outcome: "none" };
	const app = await repo.getApplicationByJob(userId, jobId);
	if (!app) throw new ApplicationNotFoundError(userId, jobId);
	if (app.state !== "ready_for_review") return { outcome: "none" };
	const request = await repo.pendingRedraft(userId, app.applicationId);
	if (!request || request.problem) return { outcome: "none" };
	const pause = async (
		reason: string,
		spendingCap = false,
	): Promise<RedraftOutcome> => {
		await repo.setRedraftProblem?.(userId, app.applicationId, request.id, {
			kind: "paused",
			message: reason.slice(0, 500),
			at: nowIso(deps),
			...(spendingCap ? { spendingCap: true } : {}),
		});
		return { outcome: "paused", reason };
	};
	const tailoring = deps.tailorLlm ?? deps.llm;
	const capped =
		(await capReached(deps.spend, userId, [tailoring, deps.claimsLlm])) ??
		(await subscriptionBudgetReached(deps.spend, userId, [tailoring]));
	if (capped) {
		if (!(capped instanceof SpendingCapReachedError))
			await deps.spend?.recordRefusal({
				userId,
				applicationId: app.applicationId,
				task: "tailor",
				provider: tailoring.name,
				error: capped.message,
			});
		return pause(capped.message, capped instanceof SpendingCapReachedError);
	}
	const profile = await repo.getProfile(userId);
	if (!profile) throw new Error(`No profile for ${userId}`);
	const docs = await repo.latestDocuments(userId, app.applicationId);
	const content = (kind: string) => docs.find((d) => d.kind === kind)?.content;
	const currentAnswers = parseFormAnswers(content("form_answers") ?? "[]");
	const documents = redraftDocumentsOf(request.scope);
	let drafted: Awaited<ReturnType<typeof redraftApplication>>;
	try {
		drafted = await redraftApplication(
			meteredFor(tailoring, deps.spend, userId, app.applicationId),
			{
				job: { ...app.job, companyName: app.companyName },
				profile,
				fit: app.fit,
				today: nowIso(deps).slice(0, 10),
				writingStyle: await deps.writingStyle?.(userId),
				redraft: {
					documents,
					instruction: request.instruction,
					current: {
						cv: content("cv"),
						cover_letter: content("cover_letter"),
						form_answers: currentAnswers.length
							? formAnswersText(currentAnswers)
							: undefined,
					},
				},
			},
		);
	} catch (error) {
		if (error instanceof LlmPausedError) return pause(error.message);
		throw error;
	}
	const versions: { kind: RedraftDocument; content: string }[] = [];
	if (drafted.cv !== undefined)
		versions.push({ kind: "cv", content: drafted.cv });
	if (drafted.coverLetter !== undefined)
		versions.push({ kind: "cover_letter", content: drafted.coverLetter });
	if (drafted.formAnswers !== undefined) {
		// Answers the user wrote stay, unless they chose to have those rewritten too.
		const keep =
			request.rewriteOwnAnswers || !repo.documentVersions
				? []
				: ownAnswerQuestions(
						await repo.documentVersions(
							userId,
							app.applicationId,
							"form_answers",
						),
					);
		versions.push({
			kind: "form_answers",
			content: JSON.stringify(
				mergeAnswers(drafted.formAnswers, currentAnswers, keep),
				null,
				2,
			),
		});
	}
	const saved = await repo.saveRedraft(
		userId,
		app.applicationId,
		request.id,
		versions,
		drafted.provider,
	);
	deps.log?.("application redrafted", {
		applicationId: app.applicationId,
		provider: drafted.provider,
		scope: request.scope,
		saved,
	});
	return saved === "saved"
		? { outcome: "saved", documents }
		: { outcome: saved };
}

/** The redraft kept failing after its retries: the error is shown on the request, with Try again. */
async function redraftErrorStep(
	deps: PipelineDeps,
	userId: string,
	jobId: string,
	message: string,
): Promise<void> {
	const app = await deps.repo.getApplicationByJob(userId, jobId);
	if (!app) return;
	const request = await deps.repo.pendingRedraft?.(userId, app.applicationId);
	if (!request || request.problem) return;
	await deps.repo.setRedraftProblem?.(userId, app.applicationId, request.id, {
		kind: "error",
		message: message.slice(0, 500),
		at: nowIso(deps),
	});
}

/**
 * The redraft as the application flow runs it in review, before the check of the current
 * version. Never fails the application: an error after the step's retries is recorded on the
 * request and the documents stay as they were. Step names are part of running instances' state.
 */
export async function redraftInReview(
	step: FlowStep,
	deps: PipelineDeps,
	userId: string,
	jobId: string,
	wake: number,
): Promise<void> {
	try {
		await step.do(`redraft ${wake}`, () => redraftStep(deps, userId, jobId), {
			retries: 2,
			timeoutSeconds: 900,
		});
	} catch (error) {
		if (error instanceof FlowPaused) throw error;
		const message = error instanceof Error ? error.message : String(error);
		await step.do(`redraft error ${wake}`, () =>
			redraftErrorStep(deps, userId, jobId, message),
		);
		deps.log?.("redraft failed", { jobId, error: message });
	}
}
