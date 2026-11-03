import { lineDiff } from "@offerfinch/core/chat/chat";
import { LlmPausedError } from "@offerfinch/core/scoring/llm";
import {
	meteredFor,
	SpendingCapReachedError,
} from "@offerfinch/core/scoring/metered";
import { runAnswerChoices } from "@offerfinch/core/tailor/answer-choices";
import {
	ANSWER_MAX,
	type AnswerHelperInput,
	runAnswerHelper,
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
		},
	};
}

/**
 * The Questions page's answer helper: Suggest (empty box) drafts an answer from the profile,
 * Improve rewrites what the user typed. One call on the drafting model, metered as
 * `answer-helper`. It returns a proposal only; nothing is saved until the user presses Save
 * answer. A paused or limited model comes back as a reason, never as a changed box.
 */
export function answerHelperRouter(worker: () => WorkerApp) {
	/** The drafting model, metered to the question's application. */
	const llmFor = (w: WorkerApp, userId: string, applicationId: string | null) =>
		// Drafting's model, as the chat uses: the claims check stays independent of it.
		meteredFor(
			w.deps.tailorLlm ?? w.deps.llm,
			w.deps.spend,
			userId,
			applicationId,
		);
	return {
		/**
		 * Help me remember: the question as a few multiple-choice asks. Options are memory jogs;
		 * only what the user ticks reaches the box, and nothing is saved here.
		 */
		choices: protectedProcedure
			.input(z.object({ id: z.string().uuid() }))
			.handler(async ({ context, input }) => {
				const w = worker();
				const userId = context.session.user.id;
				const loaded = await helperInput(w, userId, input.id, "");
				if (!loaded.input)
					return paused(
						"Your profile is empty. Import your resume or add a record first.",
					);
				try {
					return await runAnswerChoices(
						llmFor(w, userId, loaded.applicationId),
						loaded.input,
					);
				} catch (error) {
					return failure(w, error);
				}
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
