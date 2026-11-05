import type { FilterResult } from "@offerfinch/core/filter/rules";
import { jobFate } from "@offerfinch/core/pipeline/scan-report";
import { applicationInstanceId } from "@offerfinch/core/workflow/types";
import type { Database } from "@offerfinch/db";
import { flowRuns } from "@offerfinch/db/schema/jobs";
import {
	applications,
	companies,
	jobs,
	scanRunJobs,
	scanRuns,
} from "@offerfinch/db/schema/pipeline";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Setup's first search, live (docs/decisions.md, 2026-11-05): the jobs one scan run found, each
 * with where it stands. The scan records each job it inserts as the run's (`scan_run_jobs`), so
 * the list is exactly the scan's jobs while it runs; a job added by link or paste meanwhile is
 * not one of them. A run from before that table reads its sources' `newJobIds` instead.
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
	/** Past the rules, but its scoring paused (the model cannot run now); it waits for a score. */
	paused: boolean;
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
	/** Why its scoring paused, when its last application run ended paused at the fit score. */
	pausedFor?: string | null;
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
		paused: false,
	};
	switch (fate.kind) {
		case "checking":
			// The rules passed (or flagged it) and the result is stored; scoring comes next.
			return job.filterResult && job.filterResult.decision !== "reject"
				? { ...base, state: "fits", paused: Boolean(job.pausedFor) }
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

/**
 * A pause message without the subscription prefix ("Subscription paused (call_budget, claude):"),
 * which the status line already says in its own words. The detail after it was written to follow
 * the colon ("the plan's usage limit is reached…"), so it starts a sentence here.
 */
function pauseReason(message: string): string {
	const detail = message
		.replace(/^Subscription paused \([^)]*\):\s*/, "")
		.trim();
	return detail.charAt(0).toUpperCase() + detail.slice(1);
}

/**
 * The first search's rows and totals over every job the run found. Once the cap binds, the rows
 * keep the jobs still in play (found, fitting, scored) before the set-aside ones, which leave the
 * list anyway: every active job first, then the latest set-aside ones to fill, in found order.
 * `hidden` counts the active jobs the cap left out, for "and N more".
 */
export function firstSearchView(found: FoundJob[], minScore: number) {
	const all = found.map((j) => firstSearchRow(j, minScore));
	const count = (state: FirstSearchState) =>
		all.filter((r) => r.state === state).length;
	const active = all.filter((r) => r.state !== "rejected_by_filter");
	const aside = all.filter((r) => r.state === "rejected_by_filter");
	const keptActive = active.slice(0, FIRST_SEARCH_MAX_ROWS);
	const room = FIRST_SEARCH_MAX_ROWS - keptActive.length;
	const kept = new Set([
		...keptActive,
		...(room > 0 ? aside.slice(-room) : []),
	]);
	const paused = all.filter((r) => r.paused);
	const pausedFor =
		found.find((j) => j.pausedFor && paused.some((r) => r.jobId === j.jobId))
			?.pausedFor ?? null;
	return {
		minScore,
		rows: all.filter((r) => kept.has(r)),
		hidden: active.length - keptActive.length,
		/** Why scoring paused, when a job waits on it: the first paused job's reason. */
		pausedFor: pausedFor ? pauseReason(pausedFor) : null,
		counts: {
			read: all.length,
			found: count("found"),
			fits: count("fits"),
			setAside: count("rejected_by_filter"),
			scored: count("scored"),
			matches: all.filter((r) => r.match).length,
			paused: paused.length,
		},
	};
}

/** The run's jobs: recorded as the scan inserted them, else (an older run) its sources' reports. */
async function jobIdsOf(
	db: Database,
	run: { id: string; userId: string },
): Promise<string[]> {
	const recorded = await db
		.select({ jobId: scanRunJobs.jobId })
		.from(scanRunJobs)
		.where(
			and(
				eq(scanRunJobs.flowRunId, run.id),
				eq(scanRunJobs.userId, run.userId),
			),
		);
	if (recorded.length > 0) return recorded.map((r) => r.jobId);
	const [history] = await db
		.select({ sources: scanRuns.sources })
		.from(scanRuns)
		.where(
			and(eq(scanRuns.flowRunId, run.id), eq(scanRuns.userId, run.userId)),
		);
	return [...new Set((history?.sources ?? []).flatMap((s) => s.newJobIds))];
}

/**
 * For jobs still found: why scoring paused, when the job's application run (one per job) ended
 * paused at the fit score (`{ outcome: "paused", state: "found" }`, the model could not run).
 * A run that is queued or running again is not paused.
 */
async function pausedScoring(
	db: Database,
	userId: string,
	jobIds: string[],
): Promise<Map<string, string>> {
	const paused = new Map<string, string>();
	for (let i = 0; i < jobIds.length; i += 400) {
		const chunk = jobIds.slice(i, i + 400);
		const runs = await db
			.select({
				params: flowRuns.params,
				status: flowRuns.status,
				result: flowRuns.result,
			})
			.from(flowRuns)
			.where(
				and(
					eq(flowRuns.userId, userId),
					inArray(flowRuns.id, chunk.map(applicationInstanceId)),
				),
			);
		for (const run of runs) {
			if (run.status !== "complete" || !run.result) continue;
			let result: { outcome?: unknown; state?: unknown; waitingFor?: unknown };
			try {
				result = JSON.parse(run.result);
			} catch {
				continue;
			}
			const jobId = run.params.jobId;
			if (
				typeof jobId === "string" &&
				result.outcome === "paused" &&
				result.state === "found" &&
				typeof result.waitingFor === "string"
			)
				paused.set(jobId, result.waitingFor);
		}
	}
	return paused;
}

/** The jobs a run found, oldest first, with this user's applications and why scoring paused. */
export async function jobsFoundBy(
	db: Database,
	run: { id: string; userId: string },
): Promise<FoundJob[]> {
	const ids = await jobIdsOf(db, run);
	const rows: (Omit<FoundJob, "filterResult"> & {
		filterResult: unknown;
		createdAt: Date;
	})[] = [];
	// SQLite's variable limit: a few hundred ids per query.
	for (let i = 0; i < ids.length; i += 400)
		rows.push(
			...(await db
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
					createdAt: jobs.createdAt,
				})
				.from(jobs)
				.innerJoin(
					companies,
					and(
						eq(companies.id, jobs.companyId),
						eq(companies.userId, run.userId),
					),
				)
				.leftJoin(
					applications,
					and(
						eq(applications.userId, run.userId),
						eq(applications.jobId, jobs.id),
					),
				)
				.where(
					and(
						eq(jobs.userId, run.userId),
						inArray(jobs.id, ids.slice(i, i + 400)),
					),
				)),
		);
	rows.sort(
		(a, b) =>
			a.createdAt.getTime() - b.createdAt.getTime() ||
			(a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0),
	);
	const paused = await pausedScoring(
		db,
		run.userId,
		rows.filter((r) => r.state === "found").map((r) => r.jobId),
	);
	return rows.map(({ createdAt: _, ...r }) => ({
		...r,
		filterResult: (r.filterResult as FilterResult | null) ?? null,
		pausedFor: paused.get(r.jobId) ?? null,
	}));
}
