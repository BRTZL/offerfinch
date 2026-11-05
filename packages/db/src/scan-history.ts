import type { FilterResult } from "@offerfinch/core/filter/rules";
import {
	type ScanProgress,
	type ScanTrigger,
	type SourceReport,
	scanTotals,
} from "@offerfinch/core/pipeline/scan-report";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	notInArray,
	sql,
} from "drizzle-orm";

import type { Database } from "./client";
import { flowRuns } from "./schema/jobs";
import {
	applications,
	companies,
	jobs,
	scanRunJobs,
	scanRuns,
} from "./schema/pipeline";

/**
 * Scan history (`core/pipeline/scan-report.ts`): a row per scan run, written as the scan goes.
 * Every write is keyed by the runner's run id and safe to repeat (a resumed scan replays).
 */

export const SCAN_HISTORY_KEEP = 100;

/**
 * The run's row, created once: by whoever starts the scan (manual, start) or by the flow itself
 * (timer); later calls keep the first trigger. Older rows past the newest 100 go.
 */
export async function beginScanRun(
	db: Database,
	input: {
		userId: string;
		flowRunId: string;
		trigger: ScanTrigger;
		startedAt?: Date;
	},
): Promise<void> {
	await db
		.insert(scanRuns)
		.values({
			userId: input.userId,
			flowRunId: input.flowRunId,
			trigger: input.trigger,
			startedAt: input.startedAt ?? new Date(),
			sources: [],
		})
		.onConflictDoNothing();
	const keep = await db
		.select({ id: scanRuns.id })
		.from(scanRuns)
		.where(eq(scanRuns.userId, input.userId))
		.orderBy(desc(scanRuns.startedAt), desc(sql`${scanRuns}.rowid`))
		.limit(SCAN_HISTORY_KEEP);
	if (keep.length === SCAN_HISTORY_KEEP) {
		await db.delete(scanRuns).where(
			and(
				eq(scanRuns.userId, input.userId),
				notInArray(
					scanRuns.id,
					keep.map((k) => k.id),
				),
			),
		);
		// Their job lists go with them (this run's row was just written, so it stays).
		await db.delete(scanRunJobs).where(
			and(
				eq(scanRunJobs.userId, input.userId),
				notInArray(
					scanRunJobs.flowRunId,
					db
						.select({ id: scanRuns.flowRunId })
						.from(scanRuns)
						.where(
							and(
								eq(scanRuns.userId, input.userId),
								isNotNull(scanRuns.flowRunId),
							),
						),
				),
			),
		);
	}
}

/**
 * Jobs a scan run inserted, recorded as each is inserted (and again from each source's report as
 * it ends, so a step retried after its insert loses none). Safe to repeat.
 */
export async function recordScanRunJobs(
	db: Database,
	input: { flowRunId: string; userId: string; jobIds: string[] },
): Promise<void> {
	// SQLite's variable limit: a few hundred rows per insert.
	for (let i = 0; i < input.jobIds.length; i += 200)
		await db
			.insert(scanRunJobs)
			.values(
				input.jobIds.slice(i, i + 200).map((jobId) => ({
					flowRunId: input.flowRunId,
					userId: input.userId,
					jobId,
				})),
			)
			.onConflictDoNothing();
}

/** Replaces (or adds) sources by id, keeping their order of first arrival; totals follow. */
async function putSources(
	db: Database,
	flowRunId: string,
	update: (sources: SourceReport[]) => SourceReport[],
	extra: Partial<typeof scanRuns.$inferInsert> = {},
): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ sources: scanRuns.sources })
			.from(scanRuns)
			.where(eq(scanRuns.flowRunId, flowRunId));
		if (!row) return;
		const sources = update(row.sources);
		await tx
			.update(scanRuns)
			.set({ sources, stats: { ...scanTotals(sources) }, ...extra })
			.where(eq(scanRuns.flowRunId, flowRunId));
	});
}

/**
 * The scan's planned sources: the ones that do not run (off, not set up) are recorded now; the
 * running ones arrive as each ends.
 */
export async function recordIdleSources(
	db: Database,
	flowRunId: string,
	idle: SourceReport[],
): Promise<void> {
	await putSources(db, flowRunId, (sources) => {
		const ran = sources.filter((s) => !idle.some((i) => i.id === s.id));
		return [...ran, ...idle.filter((i) => !ran.some((s) => s.id === i.id))];
	});
}

/** A source's report as its step ended; a replay writes the same report again. */
export async function recordScanSource(
	db: Database,
	flowRunId: string,
	report: SourceReport,
): Promise<void> {
	await putSources(db, flowRunId, (sources) =>
		sources.some((s) => s.id === report.id)
			? sources.map((s) => (s.id === report.id ? report : s))
			: [...sources, report],
	);
}

/** What runs now; null when the sources are done (the run's end time is then set). */
export async function setScanProgress(
	db: Database,
	flowRunId: string,
	progress: ScanProgress | null,
): Promise<void> {
	await db
		.update(scanRuns)
		.set(
			progress
				? { progress, finishedAt: null }
				: { progress: null, finishedAt: new Date() },
		)
		.where(eq(scanRuns.flowRunId, flowRunId));
}

export type ScanRunRow = Awaited<ReturnType<typeof listScanRuns>>[number];

/** The newest runs, with the runner's status (a run that died never calls its last hook). */
export async function listScanRuns(
	db: Database,
	userId: string,
	limit = SCAN_HISTORY_KEEP,
) {
	return db
		.select({
			id: scanRuns.id,
			flowRunId: scanRuns.flowRunId,
			trigger: scanRuns.trigger,
			/** Totals; on a row from before the history, the old scan's own counts. */
			stats: scanRuns.stats,
			startedAt: scanRuns.startedAt,
			finishedAt: scanRuns.finishedAt,
			sources: scanRuns.sources,
			progress: scanRuns.progress,
			status: flowRuns.status,
			endedAt: flowRuns.endedAt,
			error: flowRuns.error,
		})
		.from(scanRuns)
		.leftJoin(flowRuns, eq(flowRuns.id, scanRuns.flowRunId))
		.where(eq(scanRuns.userId, userId))
		.orderBy(desc(scanRuns.startedAt), desc(sql`${scanRuns}.rowid`))
		.limit(limit);
}

/** The jobs a scan saved, with what became of each (its application's state and reasons). */
export async function scanJobs(db: Database, userId: string, jobIds: string[]) {
	if (jobIds.length === 0) return [];
	const rows: {
		jobId: string;
		applicationId: string | null;
		title: string;
		company: string;
		url: string;
		state: string | null;
		filterResult: FilterResult | null;
		endedReason: string | null;
		score: number | null;
	}[] = [];
	// SQLite's variable limit: a few hundred ids per query.
	for (let i = 0; i < jobIds.length; i += 400) {
		const chunk = jobIds.slice(i, i + 400);
		rows.push(
			...(await db
				.select({
					jobId: jobs.id,
					applicationId: applications.id,
					title: jobs.title,
					company: companies.name,
					url: jobs.url,
					state: applications.state,
					filterResult: applications.filterResult,
					endedReason: applications.endedReason,
					score: applications.score,
				})
				.from(jobs)
				.innerJoin(companies, eq(companies.id, jobs.companyId))
				.leftJoin(applications, eq(applications.jobId, jobs.id))
				.where(and(eq(jobs.userId, userId), inArray(jobs.id, chunk)))),
		);
	}
	return rows;
}
