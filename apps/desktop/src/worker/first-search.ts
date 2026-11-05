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

/**
 * Where a found job stands: read, waiting for its score (`fits`: no rule sets a job aside any
 * more, docs/decisions.md 2026-11-05), set aside (a hidden company, or the job filter of an
 * older version), or scored.
 */
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
	/** For a set-aside job: why, in a few words. */
	reason: string | null;
	score: number | null;
	/** Scored at or above the user's minimum score. */
	match: boolean;
	/** Waiting for its score, but scoring paused (the model cannot run now). */
	paused: boolean;
	/**
	 * Its application run errored before a score (retries spent): it stays found until the next
	 * search's sweep starts it again. `reason` holds the run's error, shortened.
	 */
	failed: boolean;
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
	/** Why its scoring failed, when its application run errored with the job still found. */
	failedFor?: string | null;
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
		failed: false,
	};
	switch (fate.kind) {
		case "checking": {
			// Saved with its application: the fit score is next.
			const state = job.state ? "fits" : "found";
			// Its run errored before a score: failed, with why.
			if (job.failedFor)
				return { ...base, state, failed: true, reason: job.failedFor };
			return {
				...base,
				state,
				paused: state === "fits" && Boolean(job.pausedFor),
			};
		}
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
	const failed = all.filter((r) => r.failed);
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
			/** Jobs whose scoring failed (their run errored); the next search tries them again. */
			failed: failed.length,
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
 * A run's error as a row's reason, in safe words. The stored message is the raw error, which can
 * carry an API key echoed by the vendor or a path on this Mac, so it is never shown: the kind of
 * failure is named, and the rest is left to the logs.
 */
export function failureReason(message: string | null | undefined): string {
	const text = message ?? "";
	const kinds: [RegExp, string][] = [
		[
			/api key|authentication|unauthori[sz]ed|\b401\b|invalid_api_key|not logged in|sign(ed)? ?in/i,
			"The model refused the sign-in or key. Check Settings > Models.",
		],
		[
			/rate.?limit|\b429\b|too many requests|overloaded|\b529\b|quota|usage limit/i,
			"The model was busy. It is tried again later.",
		],
		[
			/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|network|socket/i,
			"The model could not be reached.",
		],
		[/ENOENT|EACCES|EPERM|EISDIR|ENOTDIR/, "A file could not be read."],
		[
			/schema|parse|json|unexpected token|could not be read|invalid (answer|response|output)/i,
			"The model's answer could not be read.",
		],
	];
	for (const [pattern, reason] of kinds) if (pattern.test(text)) return reason;
	return "The model did not answer.";
}

/** The paused run's `waitingFor`, when it ended paused at the fit score; else null. */
function pausedWaitingFor(result: string | null): string | null {
	if (!result) return null;
	let parsed: { outcome?: unknown; state?: unknown; waitingFor?: unknown };
	try {
		parsed = JSON.parse(result);
	} catch {
		return null;
	}
	return parsed.outcome === "paused" &&
		parsed.state === "found" &&
		typeof parsed.waitingFor === "string"
		? parsed.waitingFor
		: null;
}

/**
 * For jobs still found, how the job's application run (one per job) ended without a score:
 * `paused` at the fit score (`{ outcome: "paused", state: "found" }`, the model could not run),
 * with the pause's message, or `failed` (the run errored, its retries spent), with its error
 * shortened. A run that is queued or running again is neither.
 */
async function scoringStops(
	db: Database,
	userId: string,
	jobIds: string[],
): Promise<{ paused: Map<string, string>; failed: Map<string, string> }> {
	const paused = new Map<string, string>();
	const failed = new Map<string, string>();
	for (let i = 0; i < jobIds.length; i += 400) {
		const chunk = jobIds.slice(i, i + 400);
		const runs = await db
			.select({
				params: flowRuns.params,
				status: flowRuns.status,
				result: flowRuns.result,
				error: flowRuns.error,
			})
			.from(flowRuns)
			.where(
				and(
					eq(flowRuns.userId, userId),
					inArray(flowRuns.id, chunk.map(applicationInstanceId)),
				),
			);
		for (const run of runs) {
			const jobId = run.params.jobId;
			if (typeof jobId !== "string") continue;
			if (run.status === "errored") {
				failed.set(jobId, failureReason(run.error));
				continue;
			}
			const waitingFor =
				run.status === "complete" ? pausedWaitingFor(run.result) : null;
			if (waitingFor) paused.set(jobId, waitingFor);
		}
	}
	return { paused, failed };
}

/** The jobs a run found, oldest first, with this user's applications and why scoring stopped. */
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
	const { paused, failed } = await scoringStops(
		db,
		run.userId,
		rows.filter((r) => r.state === "found").map((r) => r.jobId),
	);
	return rows.map(({ createdAt: _, ...r }) => ({
		...r,
		filterResult: (r.filterResult as FilterResult | null) ?? null,
		pausedFor: paused.get(r.jobId) ?? null,
		failedFor: failed.get(r.jobId) ?? null,
	}));
}
