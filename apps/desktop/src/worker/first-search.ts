import type { FilterResult } from "@offerfinch/core/filter/rules";
import { jobFate } from "@offerfinch/core/pipeline/scan-report";
import type { Database } from "@offerfinch/db";
import { applications, companies, jobs } from "@offerfinch/db/schema/pipeline";
import { and, asc, eq, gte, lte } from "drizzle-orm";

/**
 * Setup's first search, live (docs/decisions.md, 2026-11-05): the jobs one scan run found, each
 * with where it stands. A scan records its new jobs per source only when that source ends, so the
 * live list reads the jobs this user got while the run was open (created at or after the run, and
 * not after it ended). Only one scan runs at a time (`startManualScan` returns the busy one), so
 * the window is the run's.
 */

/** Where a found job stands: read, past the rules, set aside by one, or scored. */
export type FirstSearchState =
	| "found"
	| "fits"
	| "rejected_by_filter"
	| "scored";

export interface FirstSearchRow {
	applicationId: string | null;
	jobId: string;
	company: string;
	title: string;
	source: string;
	state: FirstSearchState;
	/** For a set-aside job: the rule it broke, in a few words. */
	reason: string | null;
	score: number | null;
	/** Scored at or above the user's minimum score. */
	match: boolean;
}

export interface FoundJob {
	jobId: string;
	applicationId: string | null;
	company: string;
	title: string;
	source: string;
	state: string | null;
	filterResult: FilterResult | null;
	endedReason: string | null;
	score: number | null;
}

/** Rows shown at most; the counts cover every job. */
export const FIRST_SEARCH_MAX_ROWS = 300;

/** One found job as the first search shows it. Later states (a match being prepared) count as scored. */
export function firstSearchRow(
	job: FoundJob,
	minScore: number,
): FirstSearchRow {
	const fate = jobFate(
		job.state
			? {
					state: job.state,
					filterResult: job.filterResult,
					endedReason: job.endedReason,
				}
			: null,
	);
	const base = {
		applicationId: job.applicationId,
		jobId: job.jobId,
		company: job.company,
		title: job.title,
		source: job.source,
		reason: null,
		score: null,
		match: false,
	};
	switch (fate.kind) {
		case "checking":
			// The rules passed (or flagged it) and the result is stored; scoring comes next.
			return job.filterResult && job.filterResult.decision !== "reject"
				? { ...base, state: "fits" }
				: { ...base, state: "found" };
		case "filtered":
			return { ...base, state: "rejected_by_filter", reason: fate.message };
		case "hidden_company":
			return {
				...base,
				state: "rejected_by_filter",
				reason: "From a company you hid",
			};
		default:
			return {
				...base,
				state: "scored",
				score: job.score,
				match: job.score !== null && job.score >= minScore,
			};
	}
}

/** The first search's rows and totals over every job the run found. */
export function firstSearchView(found: FoundJob[], minScore: number) {
	const rows = found.map((j) => firstSearchRow(j, minScore));
	const count = (state: FirstSearchState) =>
		rows.filter((r) => r.state === state).length;
	return {
		minScore,
		rows: rows.slice(0, FIRST_SEARCH_MAX_ROWS),
		counts: {
			read: rows.length,
			found: count("found"),
			fits: count("fits"),
			setAside: count("rejected_by_filter"),
			scored: count("scored"),
			matches: rows.filter((r) => r.match).length,
		},
	};
}

/** The jobs a run found, oldest first: created while the run was open, with their applications. */
export async function jobsFoundBy(
	db: Database,
	run: { userId: string; createdAt: Date; endedAt: Date | null },
): Promise<FoundJob[]> {
	const rows = await db
		.select({
			jobId: jobs.id,
			applicationId: applications.id,
			company: companies.name,
			title: jobs.title,
			source: jobs.source,
			state: applications.state,
			filterResult: applications.filterResult,
			endedReason: applications.endedReason,
			score: applications.score,
		})
		.from(jobs)
		.innerJoin(companies, eq(companies.id, jobs.companyId))
		.leftJoin(applications, eq(applications.jobId, jobs.id))
		.where(
			and(
				eq(jobs.userId, run.userId),
				gte(jobs.createdAt, run.createdAt),
				run.endedAt ? lte(jobs.createdAt, run.endedAt) : undefined,
			),
		)
		.orderBy(asc(jobs.createdAt), asc(jobs.id));
	return rows.map((r) => ({
		...r,
		filterResult: (r.filterResult as FilterResult | null) ?? null,
	}));
}
