import type { StoredSuggestion } from "@offerfinch/core/tailor/answer-helper";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Tx } from "../repository/shared";
import {
	applications,
	companies,
	jobs,
	profileFacts,
	questions,
} from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
import type { PendingEvent } from "./shared";

async function stateOf(tx: Tx, applicationId: string) {
	const [app] = await tx
		.select({ state: applications.state })
		.from(applications)
		.where(eq(applications.id, applicationId));
	return app?.state ?? null;
}

/**
 * The last answer to a question the application form asked at submit time: the answers join the
 * form answers and the application goes back to review, so the user approves them before
 * anything is sent.
 */
async function backToReview(
	self: DashboardRepositoryContext,
	tx: Tx,
	input: {
		userId: string;
		applicationId: string;
		questionId: string;
		state: string | null;
	},
): Promise<{
	applicationId: string;
	event: PendingEvent | null;
	next?: "review";
}> {
	const { userId, applicationId } = input;
	if (input.state !== "needs_human") return { applicationId, event: null };
	const resumed = await self.resumeWithFormAnswers(
		tx,
		userId,
		applicationId,
		"needs_human",
		"user",
	);
	if (!resumed) return { applicationId, event: null };
	const event = await self.addEvent(
		tx,
		userId,
		applicationId,
		`answered-${input.questionId}`,
		{ action: "answered_form" },
	);
	return { applicationId, event, next: "review" };
}

export const questionsMethods = {
	async listQuestions(userId: string, status?: "open" | "answered") {
		return this.database
			.select({
				id: questions.id,
				question: questions.question,
				context: questions.context,
				status: questions.status,
				answer: questions.answer,
				suggestion: questions.suggestion,
				answeredAt: questions.answeredAt,
				createdAt: questions.createdAt,
				applicationId: questions.applicationId,
				applicationState: applications.state,
				title: jobs.title,
				companyName: companies.name,
			})
			.from(questions)
			.leftJoin(
				applications,
				and(
					eq(applications.id, questions.applicationId),
					eq(applications.userId, userId),
				),
			)
			.leftJoin(jobs, eq(jobs.id, applications.jobId))
			.leftJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(questions.userId, userId),
					status ? eq(questions.status, status) : undefined,
					// A job the filter rejected is hidden, and so are its questions.
					or(
						isNull(applications.state),
						ne(applications.state, "rejected_by_filter"),
					),
				),
			)
			.orderBy(desc(questions.createdAt), desc(sql`${questions}.rowid`));
	},

	/** Stores Suggest's latest answer on an open question; an answered one is left alone. */
	async setQuestionSuggestion(
		userId: string,
		questionId: string,
		suggestion: StoredSuggestion,
	): Promise<void> {
		await this.database
			.update(questions)
			.set({ suggestion })
			.where(
				and(
					eq(questions.id, questionId),
					eq(questions.userId, userId),
					eq(questions.status, "open"),
				),
			);
	},

	/**
	 * Saves the answer to the user's profile store (with date and source) and, when it was the
	 * application's last open question, moves it back to preparing so tailoring resumes.
	 */
	async answerQuestion(input: {
		userId: string;
		questionId: string;
		answer: string;
	}): Promise<{
		applicationId: string | null;
		event: PendingEvent | null;
		/** Where the application went: tailoring resumes, or form answers back to review. */
		next?: "preparing" | "review";
	}> {
		const answer = input.answer.trim();
		if (!answer) throw new Error("An answer cannot be empty");
		return this.database.transaction(async (tx) => {
			// Serialize on the application row before touching its questions, so two answers to
			// its last two questions cannot each count the other as still open.
			const [owner] = await tx
				.select({ applicationId: questions.applicationId })
				.from(questions)
				.where(
					and(
						eq(questions.id, input.questionId),
						eq(questions.userId, input.userId),
					),
				);
			if (owner?.applicationId)
				await this.lockOwned(tx, input.userId, owner.applicationId);
			const [question] = await tx
				.select()
				.from(questions)
				.where(
					and(
						eq(questions.id, input.questionId),
						eq(questions.userId, input.userId),
					),
				);
			if (!question) throw new Error(`Question ${input.questionId} not found`);
			if (question.status === "open") {
				await tx
					.update(questions)
					.set({
						status: "answered",
						answer,
						answeredAt: new Date(),
						profilePath: "answers.md",
					})
					.where(eq(questions.id, question.id));
				await tx.insert(profileFacts).values({
					userId: input.userId,
					questionId: question.id,
					applicationId: question.applicationId,
					question: question.question,
					answer,
					source: "dashboard question inbox",
					questionSource: question.formField ? "board" : "pipeline",
					board: question.formField?.board ?? null,
				});
			}
			const applicationId = question.applicationId;
			if (!applicationId) return { applicationId: null, event: null };
			const [open] = await tx
				.select({ n: sql<number>`count(*)` })
				.from(questions)
				.where(
					and(
						eq(questions.applicationId, applicationId),
						eq(questions.status, "open"),
					),
				);
			if ((open?.n ?? 0) > 0) return { applicationId, event: null };
			const state = question.formField
				? await stateOf(tx, applicationId)
				: null;
			// A form question asked before review (the form was read while preparing) resumes
			// preparation like any other question; one asked at submit time goes back to review.
			if (question.formField && state !== "needs_answers")
				return backToReview(this, tx, {
					userId: input.userId,
					applicationId,
					questionId: question.id,
					state,
				});
			const moved = await this.move(
				input.userId,
				applicationId,
				["needs_answers"],
				"preparing",
				"All questions answered; tailoring resumes",
				"user",
				// The draft count is kept: the answer round adds a draft, not two more checks.
				{},
				tx,
			);
			if (!moved) return { applicationId, event: null };
			const event = await this.addEvent(
				tx,
				input.userId,
				applicationId,
				`answered-${question.id}`,
				{ action: "answered" },
			);
			return { applicationId, event, next: "preparing" };
		});
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;
