import type { FieldPlan } from "@offerfinch/core/apply/field-answers";
import type { FormRead } from "@offerfinch/core/apply/form-schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { currentAttemptOf, type ProofShot, stepKeysOf } from "../proof-steps";
import type { Tx } from "../repository/shared";
import { formQuestionText, questionKey } from "../repository/shared";
import {
	applications,
	questions,
	submissionAttempts,
	submissionSettings,
} from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
import { appliedDate, type PendingEvent, StaleAttemptError } from "./shared";

/**
 * Under the application's lock: the attempt a confirmation names must still be the one it is
 * about (`currentAttemptOf`), else nothing changes and the user is told to look again. Null: the
 * user saw no attempt, and there must still be none.
 */
async function expectAttempt(
	tx: Tx,
	userId: string,
	applicationId: string,
	attemptId: string | null,
) {
	const rows = await tx
		.select({
			id: submissionAttempts.id,
			attempt: submissionAttempts.attempt,
			status: submissionAttempts.status,
			url: submissionAttempts.url,
		})
		.from(submissionAttempts)
		.where(
			and(
				eq(submissionAttempts.applicationId, applicationId),
				eq(submissionAttempts.userId, userId),
			),
		)
		.orderBy(desc(submissionAttempts.attempt));
	const current = currentAttemptOf(rows);
	if ((current?.id ?? null) !== attemptId) throw new StaleAttemptError();
	return current;
}

/** The named attempt, while a click on it may have gone through (started or needs_human). */
const unresolvedNamed = (applicationId: string, attemptId: string) =>
	and(
		eq(submissionAttempts.id, attemptId),
		eq(submissionAttempts.applicationId, applicationId),
		inArray(submissionAttempts.status, ["started", "needs_human"]),
	);

export const submissionMethods = {
	/**
	 * The global switch, per user. Turning submissions on wakes every approved application; the
	 * claim before each click reads the switch again, so pausing stops anything not yet clicked.
	 * Idempotent: only the change from paused (no row counts as paused) to on wakes anything, so
	 * turning them on twice sends no second round of events.
	 */
	async setSubmissionsPaused(
		userId: string,
		paused: boolean,
	): Promise<{ paused: boolean; events: PendingEvent[] }> {
		return this.database.transaction(async (tx) => {
			const [before] = await tx
				.select({ paused: submissionSettings.paused })
				.from(submissionSettings)
				.where(eq(submissionSettings.userId, userId));
			const wasPaused = before?.paused ?? true;
			await tx
				.insert(submissionSettings)
				.values({ userId, paused })
				.onConflictDoUpdate({
					target: submissionSettings.userId,
					set: { paused, updatedAt: new Date() },
				});
			if (paused || !wasPaused) return { paused, events: [] };
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
	 * approved or needs_human; records a manual attempt and moves to applied. `confirmedNotSent`:
	 * the user said an earlier clicked attempt did not go through and sent it by hand; that
	 * attempt is recorded as not sent instead of as the one that went through. `attemptId`: the
	 * attempt the user saw (`currentAttempt`); refused when it is no longer the current one.
	 */
	async markSubmittedManually(input: {
		userId: string;
		applicationId: string;
		attemptId: string | null;
		idempotencyKey: string;
		/** The day the user submitted it (YYYY-MM-DD); default today. Never in the future. */
		appliedOn?: string;
		confirmedNotSent?: boolean;
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
			const current = await expectAttempt(
				tx,
				input.userId,
				input.applicationId,
				input.attemptId,
			);
			if (current)
				await tx
					.update(submissionAttempts)
					.set(
						input.confirmedNotSent
							? {
									status: "not_sent",
									resolution: "The user confirmed it did not go through",
									finishedAt: new Date(),
								}
							: {
									status: "submitted",
									resolution: "The user confirmed it went through",
									finishedAt: new Date(),
								},
					)
					.where(unresolvedNamed(input.applicationId, current.id));
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
	 * its outcome is unknown, the user must first confirm it did not go through. `attemptId`: the
	 * attempt the user saw (`currentAttempt`); refused when it is no longer the current one.
	 */
	async retrySubmission(input: {
		userId: string;
		applicationId: string;
		attemptId: string | null;
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
			await expectAttempt(
				tx,
				input.userId,
				input.applicationId,
				input.attemptId,
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
					.where(unresolvedNamed(input.applicationId, blocking.id));
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

	/**
	 * "It didn't go through", recorded before Finish it yourself opens the form: the named attempt
	 * (`currentAttempt`), while a click on it may have sent the application, becomes not sent. Only
	 * after a stop (needs_human); refused when the attempt changed since the user saw it. A repeat
	 * changes nothing. Returns the attempt's number, or null when nothing needed confirming.
	 */
	async confirmNotSent(input: {
		userId: string;
		applicationId: string;
		attemptId: string;
	}): Promise<{ attempt: number | null }> {
		return this.database.transaction(async (tx) => {
			const row = await this.lockOwned(tx, input.userId, input.applicationId);
			if (row.state !== "needs_human")
				throw new Error(
					`Refusing: only a handed-over application can be confirmed not sent (it is ${row.state})`,
				);
			const current = await expectAttempt(
				tx,
				input.userId,
				input.applicationId,
				input.attemptId,
			);
			if (current?.status !== "started" && current?.status !== "needs_human")
				return { attempt: null };
			await tx
				.update(submissionAttempts)
				.set({
					status: "not_sent",
					resolution: "The user confirmed it did not go through",
					finishedAt: new Date(),
				})
				.where(unresolvedNamed(input.applicationId, current.id));
			return { attempt: current.attempt };
		});
	},

	/**
	 * Before the form opens in the user's browser (Finish it yourself, the hand-off's link): the
	 * application is the user's, approved or stopped, the named attempt is still the current one,
	 * and no click on it may have sent the application unless the user recorded that it did not
	 * (`confirmNotSent`). Returns the attempt (its stored URL), or null when there is none.
	 */
	async formLinkAttempt(
		userId: string,
		applicationId: string,
		attemptId: string | null,
	): Promise<{ attempt: number; url: string | null } | null> {
		return this.database.transaction(async (tx) => {
			const row = await this.lockOwned(tx, userId, applicationId);
			if (row.state !== "approved" && row.state !== "needs_human")
				throw new Error(
					`Refusing: the form opens from here only before it is submitted (it is ${row.state})`,
				);
			const current = await expectAttempt(tx, userId, applicationId, attemptId);
			if (current?.status === "started" || current?.status === "needs_human")
				throw new Error(
					`Refusing: attempt ${current.attempt} may have gone through. Tick "It didn't go through" before finishing it yourself`,
				);
			return current ? { attempt: current.attempt, url: current.url } : null;
		});
	},

	/**
	 * Why the form cannot be read again for this application, or null when it can: only after a
	 * stop (needs_human) and only when no attempt reached the click (docs/auto-apply-plan.md, step 7).
	 */
	async readFormAgainRefusal(
		userId: string,
		applicationId: string,
	): Promise<string | null> {
		return this.database.transaction(async (tx) => {
			const row = await this.lockOwned(tx, userId, applicationId);
			if (row.state !== "needs_human")
				return `Refusing: the form is read again only after a stop (it is ${row.state})`;
			const blocking = await this.blockingAttempt(tx, applicationId);
			return blocking
				? `Refusing: attempt ${blocking.attempt} may have gone through. Check the employer's portal or your email first`
				: null;
		});
	},

	/**
	 * After a stop on a changed form: stores the new read, adds the saved answers it needs to the
	 * form answers (a new version), asks the questions nothing answers, revokes the approval and,
	 * with no question open, sends the application back to review. One transaction; refused while
	 * an attempt may have gone through. `event` wakes the workflow when the state moved.
	 */
	async readFormAgain(input: {
		userId: string;
		applicationId: string;
		read: Extract<FormRead, { status: "read" }>;
		add: FieldPlan["add"];
		ask: FieldPlan["ask"];
		idempotencyKey: string;
	}): Promise<{ event: PendingEvent | null; asked: number }> {
		return this.database.transaction(async (tx) => {
			const repeat = await this.existingEvent(
				tx,
				input.userId,
				input.idempotencyKey,
			);
			if (repeat) return { event: repeat, asked: 0 };
			const { userId, applicationId } = input;
			const row = await this.lockOwned(tx, userId, applicationId);
			if (row.state !== "needs_human")
				throw new Error(
					`Refusing: the form is read again only after a stop (it is ${row.state})`,
				);
			const blocking = await this.blockingAttempt(tx, applicationId);
			if (blocking)
				throw new Error(
					`Refusing: attempt ${blocking.attempt} may have gone through. Check the employer's portal or your email first`,
				);
			await this.writeFormRead(tx, userId, applicationId, input.read);
			await this.mergeFormAnswers(
				tx,
				userId,
				applicationId,
				input.add.map(({ question, answer }) => ({ question, answer })),
			);
			const board = input.read.schema.board;
			for (const q of input.ask) {
				const text = formQuestionText(q.label, q.options);
				const formField = {
					label: q.label,
					options: q.options,
					kind: q.kind,
					board,
				};
				const context = `Asked by the ${board === "web" ? "employer's" : board} application form (required), read again after it changed.${q.answered ? ` The approved answer "${q.answered}" is not one of its options.` : ""}`;
				await tx
					.insert(questions)
					.values({
						userId,
						applicationId,
						key: questionKey(text),
						question: text,
						context,
						formField,
					})
					.onConflictDoUpdate({
						target: [questions.applicationId, questions.key],
						set: {
							status: "open",
							answer: null,
							answeredAt: null,
							suggestion: null,
							context,
							formField,
						},
					});
			}
			await this.revokeApproval(
				tx,
				userId,
				applicationId,
				"The application form was read again after it changed",
			);
			const [open] = await tx
				.select({ n: sql<number>`count(*)` })
				.from(questions)
				.where(
					and(
						eq(questions.applicationId, applicationId),
						eq(questions.status, "open"),
					),
				);
			const asked = open?.n ?? 0;
			// Questions open: it waits here; answering the last one sends it back to review.
			if (asked > 0) return { event: null, asked };
			await this.move(
				userId,
				applicationId,
				["needs_human"],
				"ready_for_review",
				"The application form was read again after it changed; review what will be sent and approve again",
				"user",
				{ approvedAt: null },
				tx,
			);
			const event = await this.addEvent(
				tx,
				userId,
				applicationId,
				input.idempotencyKey,
				{ action: "form_read_again" },
			);
			return { event, asked };
		});
	},

	/** A proof screenshot the user owns: before or after the click, or a step (`step-1` …). */
	async getProof(userId: string, attemptId: string, which: ProofShot) {
		const [row] = await this.database
			.select({
				before: submissionAttempts.screenshotBeforeKey,
				after: submissionAttempts.screenshotAfterKey,
				proof: submissionAttempts.proof,
			})
			.from(submissionAttempts)
			.where(
				and(
					eq(submissionAttempts.id, attemptId),
					eq(submissionAttempts.userId, userId),
				),
			);
		if (!row) return null;
		if (which === "before" || which === "after") return row[which] ?? null;
		return stepKeysOf(row.proof)[Number(which.slice(5)) - 1] ?? null;
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;
