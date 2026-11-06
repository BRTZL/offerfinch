import type {
	CheckableJob,
	CheckOrigin,
	ClosedPostingStore,
} from "@offerfinch/core/pipeline/closed";
import { SEARCH_BOARDS } from "@offerfinch/core/sources/search";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { Database } from "./client";
import { applications, companies, jobs } from "./schema/pipeline";

/**
 * Closed postings (core `pipeline/closed.ts`, docs/decisions.md 2026-11-03): the job carries
 * when and how its posting was found closed. These are the only writes to those columns.
 */

const checkable = {
	jobId: jobs.id,
	source: jobs.source,
	url: jobs.url,
	externalId: jobs.externalId,
	companyKey: companies.sourceKey,
	validThrough: jobs.validThrough,
};

/** Board sources the sweep checks through their public APIs: every board job-board search reads. */
const BOARD_SOURCES = SEARCH_BOARDS;

export class DrizzleClosedPostingStore implements ClosedPostingStore {
	constructor(private readonly db: Database) {}

	async sweepCandidates(
		userId: string,
		options: { foundBefore: Date; checkedBefore: Date; limit: number },
	): Promise<CheckableJob[]> {
		return this.db
			.select(checkable)
			.from(jobs)
			.innerJoin(applications, eq(applications.jobId, jobs.id))
			.innerJoin(companies, eq(companies.id, jobs.companyId))
			.where(
				and(
					eq(jobs.userId, userId),
					inArray(jobs.source, [...BOARD_SOURCES]),
					// Still listed: an open match nobody acted on (the Inbox's Matches).
					eq(applications.state, "scored"),
					isNull(applications.endedReason),
					isNull(applications.prepareRequestedAt),
					isNull(jobs.closedAt),
					isNull(jobs.openConfirmedAt),
					lt(jobs.firstSeenAt, options.foundBefore),
					or(
						isNull(jobs.openCheckedAt),
						lt(jobs.openCheckedAt, options.checkedBefore),
					),
				),
			)
			.orderBy(
				sql`${jobs.openCheckedAt} is not null`,
				asc(jobs.openCheckedAt),
				asc(jobs.firstSeenAt),
			)
			.limit(options.limit);
	}

	async recordCheck(
		userId: string,
		jobId: string,
		check: { at: Date; origin: CheckOrigin; gone?: { reason: string } },
	): Promise<boolean> {
		return this.db.transaction(async (tx) => {
			const [job] = await tx
				.select({
					closedAt: jobs.closedAt,
					openConfirmedAt: jobs.openConfirmedAt,
					state: applications.state,
					prepareRequestedAt: applications.prepareRequestedAt,
				})
				.from(jobs)
				.innerJoin(applications, eq(applications.jobId, jobs.id))
				.where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)));
			if (!job) return false;
			// The user said it is open: a check never closes it again. And a check closes only what
			// it was about, still in that step: a sweep or Prepare check a match nobody asked to
			// prepare, a hand-off check an approved application. A late answer after the user moved
			// on (Prepare pressed, drafting, approval since) only records its time. Read in the same
			// transaction as Prepare's request and the moves, so they never cross.
			const closable =
				check.origin === "handoff"
					? job.state === "approved"
					: job.state === "scored" && !job.prepareRequestedAt;
			const close =
				check.gone !== undefined &&
				closable &&
				!job.closedAt &&
				!job.openConfirmedAt;
			// A "gone" this rule discarded is not a check of the posting as it is now: no time is
			// kept for it, so it moves nothing in the sweep's order and stands in for nothing.
			if (check.gone !== undefined && !close) return false;
			await tx
				.update(jobs)
				.set({
					openCheckedAt: check.at,
					...(close
						? { closedAt: check.at, closedReason: check.gone?.reason }
						: {}),
				})
				.where(eq(jobs.id, jobId));
			return close;
		});
	}
}

/** One application's job, as a check needs it, with its closure and the user's override. */
export async function postingForCheck(
	db: Database,
	userId: string,
	applicationId: string,
) {
	const [row] = await db
		.select({
			...checkable,
			state: applications.state,
			closedAt: jobs.closedAt,
			closedReason: jobs.closedReason,
			openCheckedAt: jobs.openCheckedAt,
			openConfirmedAt: jobs.openConfirmedAt,
		})
		.from(applications)
		.innerJoin(jobs, eq(jobs.id, applications.jobId))
		.innerJoin(companies, eq(companies.id, jobs.companyId))
		.where(
			and(eq(applications.id, applicationId), eq(applications.userId, userId)),
		);
	return row ?? null;
}

/**
 * "It's still open": the check was wrong. The job leaves Closed, goes back where it was, and
 * automatic checks never close it again. Returns false when the application is not the user's.
 */
export async function reopenPosting(
	db: Database,
	userId: string,
	applicationId: string,
	now = new Date(),
): Promise<boolean> {
	const row = await postingForCheck(db, userId, applicationId);
	if (!row) return false;
	await db
		.update(jobs)
		.set({ closedAt: null, closedReason: null, openConfirmedAt: now })
		.where(and(eq(jobs.id, row.jobId), eq(jobs.userId, userId)));
	return true;
}
