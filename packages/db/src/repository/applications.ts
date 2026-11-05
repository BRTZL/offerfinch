import type { ApplicationState } from "@offerfinch/core/domain/states";
import type { CheckError } from "@offerfinch/core/pipeline/ports";
import type { FitResult } from "@offerfinch/core/scoring/fit";
import type {
	DismissalSignal,
	RankResult,
} from "@offerfinch/core/scoring/rank";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { dismissals } from "../schema/dismissals";
import {
	applications,
	applicationTransitions,
	jobs,
	questions,
} from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";
import { RESTARTABLE_STATES, type Tx } from "./shared";
export const applicationsMethods = {
	/** True when the user chose this job (one they added) anyway. */
	async chosenAnyway(userId: string, applicationId: string): Promise<boolean> {
		const [row] = await this.db
			.select({ at: applications.chosenAnywayAt, source: jobs.source })
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		// A job the user added by link is chosen on purpose: a low score is a note, not an end.
		return Boolean(row?.at) || row?.source === "manual";
	},

	/** True once the user pressed Prepare on this application, unless its posting is closed. */
	async prepareRequested(
		userId: string,
		applicationId: string,
	): Promise<boolean> {
		const [row] = await this.db
			.select({
				at: applications.prepareRequestedAt,
				closedAt: jobs.closedAt,
			})
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		// A closed posting is never prepared, whatever was requested (closed.ts never closes a
		// job after its request; this holds for older data and every replay of the run).
		return Boolean(row?.at) && !row?.closedAt;
	},

	/**
	 * Restarts preparation of one application (`application:redraft`): to `preparing` (the next
	 * run drafts at once) or `scored` (it re-checks the spending cap and the minimum score first).
	 * A recorded transition outside the state machine, since `failed` is terminal. Answers stay in
	 * the profile and keep their question round spent; questions still open are dismissed; the
	 * draft counter and an ended reason are cleared. Refused for a job never scored and once the
	 * application is approved or beyond, so no approval or submission is discarded.
	 */
	async restartPreparation(
		userId: string,
		applicationId: string,
		to: "preparing" | "scored",
		reason: string,
	): Promise<{ from: ApplicationState; jobId: string; dismissed: number }> {
		return this.db.transaction((tx) =>
			this.restartIn(tx, userId, applicationId, to, reason),
		);
	},

	/** `restartPreparation` inside the caller's transaction. */
	async restartIn(
		tx: Tx,
		userId: string,
		applicationId: string,
		to: "preparing" | "scored",
		reason: string,
	): Promise<{ from: ApplicationState; jobId: string; dismissed: number }> {
		const [app] = await tx
			.select({ state: applications.state, jobId: applications.jobId })
			.from(applications)
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		if (!app) throw new Error(`No application ${applicationId} for ${userId}`);
		if (!RESTARTABLE_STATES.includes(app.state))
			throw new Error(
				`Refused: the application is ${app.state}; only ${RESTARTABLE_STATES.join(", ")} can be re-drafted`,
			);
		const dismissed = await tx
			.update(questions)
			.set({ status: "dismissed" })
			.where(
				and(
					eq(questions.userId, userId),
					eq(questions.applicationId, applicationId),
					eq(questions.status, "open"),
				),
			)
			.returning({ id: questions.id });
		await tx
			.update(applications)
			.set({
				state: to,
				stateChangedAt: new Date(),
				prepareAttempts: 0,
				endedReason: null,
			})
			.where(eq(applications.id, applicationId));
		await tx.insert(applicationTransitions).values({
			userId,
			applicationId,
			fromState: app.state,
			toState: to,
			reason,
			actor: "user",
		});
		return { from: app.state, jobId: app.jobId, dismissed: dismissed.length };
	},

	async setCheckError(
		userId: string,
		applicationId: string,
		error: CheckError | null,
	): Promise<void> {
		await this.db
			.update(applications)
			.set({ checkError: error })
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
					// Clearing touches only a row that has one.
					...(error === null ? [isNotNull(applications.checkError)] : []),
				),
			);
	},

	async setPrepareAttempts(
		userId: string,
		applicationId: string,
		attempts: number,
	): Promise<void> {
		await this.db
			.update(applications)
			.set({ prepareAttempts: attempts })
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
	},

	recordScore(
		userId: string,
		applicationId: string,
		fit: FitResult,
		endedReason: string | null,
		rank?: RankResult,
	): Promise<boolean> {
		return this.move(
			userId,
			applicationId,
			["found"],
			"scored",
			endedReason ?? `Fit score ${fit.score}`,
			"workflow",
			{
				score: fit.score,
				fit,
				scoredAt: new Date(),
				endedReason,
				...(rank ? { rank: rank.rank, rankPenalties: rank.penalties } : {}),
			},
		);
	},

	/**
	 * The user's "Not interested" history for ranking: each dismissed match's company, reasons
	 * and title, newest first (the last 200).
	 */
	async dismissalSignals(userId: string): Promise<DismissalSignal[]> {
		const rows = await this.db
			.select({
				companyId: dismissals.companyId,
				reasons: dismissals.reasons,
				title: jobs.title,
			})
			.from(dismissals)
			.innerJoin(applications, eq(applications.id, dismissals.applicationId))
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.where(eq(dismissals.userId, userId))
			.orderBy(desc(dismissals.createdAt))
			.limit(200);
		return rows.map((r) => ({
			companyId: r.companyId,
			reasons: r.reasons,
			title: r.title,
		}));
	},

	async claimAlert(userId: string, applicationId: string): Promise<boolean> {
		const rows = await this.db
			.update(applications)
			.set({ alertedAt: new Date() })
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
					isNull(applications.alertedAt),
				),
			)
			.returning({ id: applications.id });
		return rows.length > 0;
	},

	async releaseAlert(userId: string, applicationId: string): Promise<void> {
		await this.db
			.update(applications)
			.set({ alertedAt: null })
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
