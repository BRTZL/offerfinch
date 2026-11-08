import { lineDiff } from "@offerfinch/core/chat/chat";
import { LlmPausedError } from "@offerfinch/core/scoring/llm";
import {
	meteredFor,
	SpendingCapReachedError,
} from "@offerfinch/core/scoring/metered";
import {
	ANSWER_MAX,
	type AnswerHelperInput,
	runAnswerHelper,
	type StoredSuggestion,
} from "@offerfinch/core/tailor/answer-helper";
import { DashboardRepository, DrizzlePipelineRepository } from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { WorkerApp } from "./app";
import { protectedProcedure } from "./routers/procedure";

const PAUSED_HINT =
	"Connect a model for drafting in Settings › Models, then try again.";

const paused = (message: string) => ({ status: "paused" as const, message });

/** What a failed call tells the user: the pause's reason, never an amount of money. */
function failure(w: WorkerApp, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	// No amounts: costs are not shown anywhere in the app.
	if (error instanceof SpendingCapReachedError)
		return paused(
			"The monthly spending cap is reached. Raise or turn it off in Settings › Spending, then try again.",
		);
	if (error instanceof LlmPausedError)
		return paused(
			/not-connected|Add an|Choose the|not available/i.test(message)
				? `${message} ${PAUSED_HINT}`
				: message,
		);
	w.deps.log?.("answer helper failed", { error: message });
	return {
		status: "error" as const,
		message: `The model could not answer: ${message}`,
	};
}

/** The open question with its posting, and the profile; no input when the profile is empty. */
async function helperInput(
	w: WorkerApp,
	userId: string,
	id: string,
	draft: string,
): Promise<{
	input: AnswerHelperInput | null;
	applicationId: string | null;
}> {
	const repo = new DashboardRepository(w.db);
	const question = (await repo.listQuestions(userId, "open")).find(
		(q) => q.id === id,
	);
	if (!question)
		throw new ORPCError("CONFLICT", {
			message: "This question is answered or gone.",
		});
	const profile = await new DrizzlePipelineRepository(w.db).getProfile(userId);
	if (!profile) return { input: null, applicationId: question.applicationId };
	const app = question.applicationId
		? await repo.getApplication(userId, question.applicationId)
		: null;
	return {
		applicationId: question.applicationId,
		input: {
			question: question.question,
			why: question.context,
			posting: app
				? {
						companyName: app.company.name,
						title: app.job.title,
						text: app.job.descriptionText ?? "",
					}
				: null,
			profile,
			draft,
			writingStyle: await w.settings.get("writingStyle"),
		},
	};
}

/** The drafting model, metered to the question's application. */
const llmFor = (w: WorkerApp, userId: string, applicationId: string | null) =>
	// Drafting's model, as the chat uses: the claims check stays independent of it.
	meteredFor(
		w.deps.tailorLlm ?? w.deps.llm,
		w.deps.spend,
		userId,
		applicationId,
	);

const stored = (result: StoredSuggestion): StoredSuggestion => ({
	answer: result.answer,
	missing: result.missing,
	variants: result.variants,
	unchecked: result.unchecked,
});

/** How long a paused model or a reached cap holds the background sweep off. */
const SWEEP_PAUSE_MS = 10 * 60_000;

interface SweepState {
	running: boolean;
	pausedUntil: number;
	/** Questions whose suggestion failed this session: never retried in a loop. */
	failed: Set<string>;
}
const sweeps = new WeakMap<WorkerApp, SweepState>();

/**
 * Suggests an answer for every open question that has none yet, one at a time, and stores it on
 * the question, so the Questions page opens each one with its suggestion ready. Single-flight per
 * worker; a paused model or a reached spending cap stops it for a while, and a question that
 * failed is not tried again this session. Nothing is saved to the profile here.
 */
export async function sweepSuggestions(w: WorkerApp, userId: string) {
	// Try-it mode's sample questions are not the user's: no model call runs for them unasked.
	if (w.init.demo) return;
	let state = sweeps.get(w);
	if (!state) {
		state = { running: false, pausedUntil: 0, failed: new Set() };
		sweeps.set(w, state);
	}
	if (state.running || Date.now() < state.pausedUntil) return;
	state.running = true;
	try {
		const repo = new DashboardRepository(w.db);
		const open = (await repo.listQuestions(userId, "open"))
			.filter((q) => !q.suggestion && !state.failed.has(q.id))
			// Oldest first: the list shows the newest on top, the user answers from there down.
			.reverse();
		for (const q of open) {
			let loaded: Awaited<ReturnType<typeof helperInput>>;
			try {
				loaded = await helperInput(w, userId, q.id, "");
			} catch {
				continue; // answered or gone meanwhile
			}
			if (!loaded.input) return; // no profile yet: nothing to suggest from
			try {
				const result = await runAnswerHelper(
					llmFor(w, userId, loaded.applicationId),
					loaded.input,
				);
				if (result.status === "ok")
					await repo.setQuestionSuggestion(userId, q.id, stored(result));
				else state.failed.add(q.id);
			} catch (error) {
				if (
					error instanceof LlmPausedError ||
					error instanceof SpendingCapReachedError
				) {
					state.pausedUntil = Date.now() + SWEEP_PAUSE_MS;
					return;
				}
				state.failed.add(q.id);
				w.deps.log?.("suggestion sweep failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	} finally {
		state.running = false;
	}
}

/**
 * The Questions page's answer helper: Suggest (empty box) writes complete answers from the
 * profile, guessing where it is silent; Improve rewrites what the user typed. One call on the
 * drafting model, metered as `answer-helper`. It returns a proposal only; nothing reaches the
 * profile until the user presses Save answer. A paused or limited model comes back as a reason,
 * never as a changed box. Open questions get their suggestion in the background (the sweep).
 */
export function answerHelperRouter(worker: () => WorkerApp) {
	return {
		/** The open or answered questions; listing them also starts the suggestion sweep. */
		list: protectedProcedure
			.input(z.object({ status: z.enum(["open", "answered"]).optional() }))
			.handler(async ({ context, input }) => {
				const w = worker();
				const userId = context.session.user.id;
				if (input.status !== "answered") void sweepSuggestions(w, userId);
				return new DashboardRepository(w.db).listQuestions(
					userId,
					input.status,
				);
			}),
		help: protectedProcedure
			.input(
				z.object({
					id: z.string().uuid(),
					draft: z.string().max(ANSWER_MAX),
				}),
			)
			.handler(async ({ context, input }) => {
				const w = worker();
				const userId = context.session.user.id;
				const loaded = await helperInput(w, userId, input.id, input.draft);
				if (!loaded.input)
					return paused(
						"Your profile is empty. Import your resume or add a record first.",
					);
				const llm = llmFor(w, userId, loaded.applicationId);
				try {
					const result = await runAnswerHelper(llm, loaded.input);
					if (result.status !== "ok") return result;
					// The newest suggestion is the one the page opens with next time.
					if (result.mode === "suggest")
						await new DashboardRepository(w.db).setQuestionSuggestion(
							userId,
							input.id,
							stored(result),
						);
					// Worked out here, where core lives, as the chat's proposal cards are.
					return {
						...result,
						diff: lineDiff(input.draft.trim(), result.answer),
					};
				} catch (error) {
					return failure(w, error);
				}
			}),
	};
}
