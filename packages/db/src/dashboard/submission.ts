import { and, eq, inArray, sql } from "drizzle-orm";
import {
	applications,
	questions,
	submissionAttempts,
	submissionSettings,
} from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
import { appliedDate, type PendingEvent } from "./shared";
export const submissionMethods = {
	/**
	 * The global switch, per user. Turning submissions on wakes every approved application; the
	 * claim before each click reads the switch again, so pausing stops anything not yet clicked.
	 */
	async setSubmissionsPaused(
		userId: string,
		paused: boolean,
	): Promise<{ paused: boolean; events: PendingEvent[] }> {
		return this.database.transaction(async (tx) => {
			await tx
				.insert(submissionSettings)
				.values({ userId, paused })
				.onConflictDoUpdate({
					target: submissionSettings.userId,
					set: { paused, updatedAt: new Date() },
				});
			if (paused) return { paused, events: [] };
			const approved = await tx
				.select({ id: applications.id })
				.from(applications)
				.where(
					and(
						eq(applications.userId, userId),
						eq(applications.state, "approved"),
					),
				);
			const stamp = Date.now();
			const events: PendingEvent[] = [];
			for (const app of approved)
				events.push(
					await this.addEvent(
						tx,
						userId,
						app.id,
						`unpaused-${app.id}-${stamp}`,
						{
							action: "submissions_on",
						},
					),
				);
			return { paused, events };
		});
	},

	/**
	 * The user submitted it themselves, or checked that an unknown attempt went through. From
	 * approved or needs_human; records a manual attempt and moves to applied.
	 */
	async markSubmittedManually(input: {
		userId: string;
		applicationId: string;
		idempotencyKey: string;
		/** The day the user submitted it (YYYY-MM-DD); default today. Never in the future. */
		appliedOn?: string;
	}): Promise<PendingEvent> {
		const appliedAt = appliedDate(input.appliedOn, new Date());
		return this.database.transaction(async (tx) => {
			const repeat = await this.existingEvent(
				tx,
				input.userId,
				input.idempotencyKey,
			);
			if (repeat) return repeat;
			const row = await this.lockOwned(tx, input.userId, input.applicationId);
			if (row.state !== "approved" && row.state !== "needs_human")
				throw new Error(
					`Refusing: only an approved or handed-over application can be marked submitted (it is ${row.state})`,
				);
			await tx
				.update(submissionAttempts)
				.set({
					status: "submitted",
					resolution: "The user confirmed it went through",
					finishedAt: new Date(),
				})
				.where(
					and(
						eq(submissionAttempts.applicationId, input.applicationId),
						eq(submissionAttempts.userId, input.userId),
						inArray(submissionAttempts.status, ["started", "needs_human"]),
					),
				);
			await tx.insert(submissionAttempts).values({
				userId: input.userId,
				applicationId: input.applicationId,
				attempt: await this.nextAttempt(tx, input.applicationId),
				status: "submitted",
				mode: "manual",
				resolution: `Submitted by the user on ${appliedAt.toISOString().slice(0, 10)}`,
				finishedAt: new Date(),
			});
			await this.move(
				input.userId,
				input.applicationId,
				[row.state],
				"applied",
				`Marked submitted by the user in the dashboard (submitted ${appliedAt.toISOString().slice(0, 10)})`,
				"user",
				{ appliedAt, appliedVia: "manual" },
				tx,
			);
			return this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				input.idempotencyKey,
				{
					action: "submitted_manually",
				},
			);
		});
	},

	/**
	 * Retries an automatic submission from needs_human. When an earlier attempt was clicked and
	 * its outcome is unknown, the user must first confirm it did not go through.
	 */
	async retrySubmission(input: {
		userId: string;
		applicationId: string;
		idempotencyKey: string;
		confirmedNotSent: boolean;
	}): Promise<PendingEvent> {
		return this.database.transaction(async (tx) => {
			const repeat = await this.existingEvent(
				tx,
				input.userId,
				input.idempotencyKey,
			);
			if (repeat) return repeat;
			const row = await this.lockOwned(tx, input.userId, input.applicationId);
			if (row.state !== "needs_human")
				throw new Error(
					`Refusing: only a handed-over application can be retried (it is ${row.state})`,
				);
			const blocking = await this.blockingAttempt(tx, input.applicationId);
			if (blocking?.status === "submitted")
				throw new Error("Refusing: this application was already submitted");
			if (blocking && !input.confirmedNotSent)
				throw new Error(
					`Refusing: attempt ${blocking.attempt} may have gone through. Check the employer's portal or your email, then confirm it did not before retrying`,
				);
			if (blocking)
				await tx
					.update(submissionAttempts)
					.set({
						status: "not_sent",
						resolution: "The user confirmed it did not go through",
					})
					.where(
						and(
							eq(submissionAttempts.applicationId, input.applicationId),
							inArray(submissionAttempts.status, ["started", "needs_human"]),
						),
					);
			const [open] = await tx
				.select({ n: sql<number>`count(*)` })
				.from(questions)
				.where(
					and(
						eq(questions.applicationId, input.applicationId),
						eq(questions.status, "open"),
					),
				);
			if ((open?.n ?? 0) > 0)
				throw new Error(
					"Refusing: answer the application form's questions in the question inbox first",
				);
			await this.move(
				input.userId,
				input.applicationId,
				["needs_human"],
				"applying",
				"Retry requested in the dashboard",
				"user",
				{},
				tx,
			);
			return this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				input.idempotencyKey,
				{
					action: "retry_submission",
				},
			);
		});
	},

	/** A proof screenshot the user owns. */
	async getProof(userId: string, attemptId: string, which: "before" | "after") {
		const [row] = await this.database
			.select({
				before: submissionAttempts.screenshotBeforeKey,
				after: submissionAttempts.screenshotAfterKey,
			})
			.from(submissionAttempts)
			.where(
				and(
					eq(submissionAttempts.id, attemptId),
					eq(submissionAttempts.userId, userId),
				),
			);
		return (which === "before" ? row?.before : row?.after) ?? null;
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;
