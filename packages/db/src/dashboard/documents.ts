import type {
	StoredDocument,
	StoredDocumentKind,
} from "@offerfinch/core/pipeline/ports";
import { parseFormAnswers } from "@offerfinch/core/tailor/tailor";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { firstPer } from "../repository";
import {
	applications,
	applicationTransitions,
	approvals,
	companies,
	documents,
	jobs,
	questions,
	submissionAttempts,
} from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
import {
	EditConflictError,
	type PendingEvent,
	subscriptionPauseOf,
} from "./shared";

/**
 * Whether the posting could be read, how old it is, and whether it was found closed (when, and
 * how in words; null while open) or the user said "It's still open" (checks no longer close it).
 */
function postingState(job: typeof jobs.$inferSelect) {
	return {
		readStatus: job.readStatus,
		readError: job.readError,
		publishedAt: job.publishedAt,
		firstSeenAt: job.firstSeenAt,
		closedAt: job.closedAt,
		closedReason: job.closedReason,
		openConfirmedAt: job.openConfirmedAt,
	};
}

export const documentsMethods = {
	async getApplication(userId: string, applicationId: string) {
		const [row] = await this.database
			.select({ app: applications, job: jobs, company: companies })
			.from(applications)
			.innerJoin(
				jobs,
				and(eq(jobs.id, applications.jobId), eq(jobs.userId, userId)),
			)
			.innerJoin(
				companies,
				and(eq(companies.id, jobs.companyId), eq(companies.userId, userId)),
			)
			.where(
				and(
					eq(applications.id, applicationId),
					eq(applications.userId, userId),
				),
			);
		if (!row) return null;
		const [docs, exports, review, approval, appQuestions, history, attempts] =
			await Promise.all([
				this.latestDocuments(userId, applicationId),
				this.database
					.select({
						id: documents.id,
						kind: documents.kind,
						format: documents.format,
						version: documents.version,
						sourceVersion: documents.sourceVersion,
						meta: documents.meta,
						createdAt: documents.createdAt,
					})
					.from(documents)
					.where(
						and(
							eq(documents.applicationId, applicationId),
							eq(documents.userId, userId),
							inArray(documents.format, ["pdf", "docx"]),
						),
					)
					.orderBy(documents.kind, documents.format, desc(documents.version))
					.then((rows) => firstPer(rows, (r) => `${r.kind}:${r.format}`)),
				this.latestReview(userId, applicationId),
				this.database
					.select()
					.from(approvals)
					.where(
						and(
							eq(approvals.applicationId, applicationId),
							eq(approvals.userId, userId),
						),
					)
					.orderBy(desc(approvals.approvedAt), desc(sql`${approvals}.rowid`)),
				this.database
					.select()
					.from(questions)
					.where(
						and(
							eq(questions.applicationId, applicationId),
							eq(questions.userId, userId),
						),
					)
					.orderBy(asc(questions.createdAt), asc(sql`${questions}.rowid`)),
				this.database
					.select()
					.from(applicationTransitions)
					.where(
						and(
							eq(applicationTransitions.applicationId, applicationId),
							eq(applicationTransitions.userId, userId),
						),
					)
					.orderBy(
						asc(applicationTransitions.createdAt),
						asc(sql`${applicationTransitions}.rowid`),
					),
				this.database
					.select({
						id: submissionAttempts.id,
						attempt: submissionAttempts.attempt,
						status: submissionAttempts.status,
						mode: submissionAttempts.mode,
						board: submissionAttempts.board,
						url: submissionAttempts.url,
						hasBefore:
							sql<boolean>`${submissionAttempts.screenshotBeforeKey} is not null`.mapWith(
								Boolean,
							),
						hasAfter:
							sql<boolean>`${submissionAttempts.screenshotAfterKey} is not null`.mapWith(
								Boolean,
							),
						proof: submissionAttempts.proof,
						error: submissionAttempts.error,
						resolution: submissionAttempts.resolution,
						startedAt: submissionAttempts.startedAt,
						finishedAt: submissionAttempts.finishedAt,
					})
					.from(submissionAttempts)
					.where(
						and(
							eq(submissionAttempts.applicationId, applicationId),
							eq(submissionAttempts.userId, userId),
						),
					)
					.orderBy(desc(submissionAttempts.attempt)),
			]);
		const currentHashes = await this.currentHashes(
			this.database,
			userId,
			applicationId,
		);
		const cost = await this.applicationCost(userId, applicationId);
		return {
			id: row.app.id,
			state: row.app.state,
			score: row.app.score,
			rank: row.app.rank,
			/** Why the match is ranked below its score, biggest first. */
			rankPenalties: row.app.rankPenalties ?? [],
			fit: row.app.fit,
			filter: row.app.filterResult,
			flags: row.app.flags,
			endedReason: row.app.endedReason,
			approvedAt: row.app.approvedAt,
			/** When the user pressed Prepare; a scored match waits for it. */
			prepareRequestedAt: row.app.prepareRequestedAt,
			/** The check of a version that kept failing; the API shows it only for the current version. */
			checkError: row.app.checkError,
			redraft: row.app.redraft ?? null,
			appliedAt: row.app.appliedAt,
			appliedVia: row.app.appliedVia,
			stateChangedAt: row.app.stateChangedAt,
			job: {
				id: row.job.id,
				title: row.job.title,
				url: row.job.url,
				locations: row.job.locations,
				workplaceType: row.job.workplaceType,
				descriptionText: row.job.descriptionText,
				source: row.job.source,
				externalId: row.job.externalId,
				applyUrl: row.job.applyUrl,
				...postingState(row.job),
			},
			/** The application run's queue state: "queued" while it waits its turn. */
			runStatus: await this.runStatus(row.job.id),
			documents: docs,
			exports,
			review,
			approvals: approval,
			activeApproval: approval.find((a) => a.revokedAt === null) ?? null,
			questions: appQuestions,
			history,
			currentHashes,
			attempts,
			submissionsPaused: await this.submissionsPaused(userId),
			/** Estimated LLM cost of this application: every call, its model and tokens. */
			cost,
			/** Why it waits on a subscription (usage limit, logout), with how it resumes. */
			subscriptionPause: subscriptionPauseOf(row.app.state, cost.calls),
			/** A clicked attempt the user has not resolved: a retry needs their confirmation. */
			unresolvedAttempt:
				attempts.find(
					(a) => a.status === "needs_human" || a.status === "started",
				) ?? null,
			company: {
				id: row.company.id,
				name: row.company.name,
				key: row.company.sourceKey,
			},
		};
	},

	/**
	 * Saves an edited document as a new version. Allowed while the application is in review or
	 * approved; an edit to an approved application sends it back to review and revokes the
	 * approval. The workflow is told so it re-runs the claims check on the new version.
	 */
	async editDocument(input: {
		userId: string;
		applicationId: string;
		kind: StoredDocumentKind;
		content: string;
		baseVersion: number;
	}): Promise<{ version: number; revoked: boolean; event: PendingEvent }> {
		if (input.kind === "form_answers") parseFormAnswers(input.content);
		return this.database.transaction(async (tx) => {
			const app = await this.lockOwned(tx, input.userId, input.applicationId);
			if (app.state !== "ready_for_review" && app.state !== "approved")
				throw new Error(
					`Documents can be edited in review or after approval, not while ${app.state}`,
				);
			const [latest] = await tx
				.select({ version: documents.version, content: documents.content })
				.from(documents)
				.where(
					and(
						eq(documents.applicationId, input.applicationId),
						eq(documents.kind, input.kind),
						inArray(documents.format, ["markdown", "json"]),
					),
				)
				.orderBy(desc(documents.version))
				.limit(1);
			const current = latest?.version ?? 0;
			if (current !== input.baseVersion) {
				// A repeated save of the same text is a no-op, not a conflict.
				if (latest?.content === input.content) {
					const event = await this.addEvent(
						tx,
						input.userId,
						input.applicationId,
						`edit-${input.applicationId}-${input.kind}-${current}`,
						{ kind: input.kind, version: current },
					);
					return { version: current, revoked: false, event };
				}
				throw new EditConflictError(current);
			}
			const version = await this.insertVersion(
				tx,
				input.userId,
				input.applicationId,
				input.kind,
				input.kind === "form_answers" ? "json" : "markdown",
				input.content,
				"user",
			);
			let revoked = false;
			if (app.state === "approved" && input.kind !== "notes") {
				revoked = await this.move(
					input.userId,
					input.applicationId,
					["approved"],
					"ready_for_review",
					`${input.kind.replace("_", " ")} edited after approval (version ${version}); approval revoked`,
					"user",
					{},
					tx,
				);
			}
			const event = await this.addEvent(
				tx,
				input.userId,
				input.applicationId,
				`edit-${input.applicationId}-${input.kind}-${version}`,
				{ kind: input.kind, version },
			);
			return { version, revoked, event };
		});
	},

	/** An export file the user owns, for download. */
	async getExport(userId: string, documentId: string) {
		const [row] = await this.database
			.select({
				storageKey: documents.storageKey,
				format: documents.format,
				kind: documents.kind,
				version: documents.version,
			})
			.from(documents)
			.where(
				and(
					eq(documents.id, documentId),
					eq(documents.userId, userId),
					isNull(documents.content),
				),
			);
		return row?.storageKey ? row : null;
	},

	documentsByKind(docs: StoredDocument[]) {
		return Object.fromEntries(docs.map((d) => [d.kind, d])) as Partial<
			Record<StoredDocumentKind, StoredDocument>
		>;
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;
