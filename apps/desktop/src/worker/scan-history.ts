import fs from "node:fs";
import path from "node:path";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import {
	dropGroups,
	jobFate,
	type RunState,
	type ScanLog,
	type ScanTrigger,
	type SourceReport,
	type StoredStop,
	scanOutcome,
	scanTotals,
	sourceReport,
} from "@offerfinch/core/pipeline/scan-report";
import {
	beginScanRun,
	type Database,
	listProviders,
	listScanRuns,
	recordIdleSources,
	recordScanSource,
	type ScanRunRow,
	scanJobs,
	setScanProgress,
} from "@offerfinch/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "./routers/procedure";
import { SITE_DEBUG_DIR } from "./site-debug";

/**
 * Scan history in the worker: the ScanLog bound to one scan run (`core/pipeline/scan-report.ts`)
 * and the API the Scans screen reads. Each source's status comes from what Settings › Sources
 * stores after its run; what became of its new jobs is read from their applications.
 */

const LABEL: Record<string, string> = {
	"job-board-search": "Job-board search",
	indeed: "Indeed",
	glassdoor: "Glassdoor",
	linkedin: "LinkedIn",
	"linkedin-top-picks": "LinkedIn Top picks",
	"web-search": "Web search",
};
const labelOf = (id: string) => LABEL[id] ?? id;
const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** The site whose pages a source reads, as site-debug names its files. */
const DEBUG_SITE: Record<string, string> = {
	"job-board-search": "duckduckgo",
	linkedin: "linkedin",
	"linkedin-top-picks": "linkedin",
	indeed: "indeed",
	glassdoor: "glassdoor",
	"web-search": "duckduckgo",
};

/** "cron" scans are the timer's unless started at launch (recorded by whoever starts it). */
function triggerOf(params: Record<string, unknown>): ScanTrigger {
	return params.trigger === "cron" ? "timer" : "manual";
}

const idle = (
	id: string,
	status: "off" | "not_set_up",
	problem?: string,
): SourceReport => ({
	...sourceReport(
		{ provider: id, queries: 0, fetched: 0, newJobIds: [] },
		labelOf(id),
		null,
	),
	status,
	...(problem ? { problem } : {}),
});

/** A page a source's run kept for diagnosis (site-debug), named by site and time; read only. */
function debugSnapshotFor(
	userData: string,
	source: string,
	since: Date,
): string | undefined {
	const site = DEBUG_SITE[source];
	if (!site) return undefined;
	const dir = path.join(userData, SITE_DEBUG_DIR);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return undefined;
	}
	const floor = since.toISOString().replace(/[:.]/g, "-");
	const name = names
		.filter((n) => n.endsWith(".html") && n.includes(`-${site}-`) && n >= floor)
		.sort()
		.at(-1);
	return name ? path.join(dir, name) : undefined;
}

/** The hooks one scan run calls; every write is keyed by the run and safe to repeat. */
export function scanLogFor(
	w: { db: Database; init: { userData: string } },
	run: { id: string; userId: string },
	params: Record<string, unknown>,
): Pick<PipelineDeps, "scanLog" | "scanProgress"> {
	const db = w.db;
	const startedAt = new Date();
	const scanLog: ScanLog = {
		async start(sources) {
			await beginScanRun(db, {
				userId: run.userId,
				flowRunId: run.id,
				trigger: triggerOf(params),
			});
			const states = await listProviders(db, run.userId);
			const rows: SourceReport[] = states
				.filter((s) => !sources.some((r) => r.id === s.provider))
				.map((s) =>
					s.enabled ? idle(s.provider, "not_set_up") : idle(s.provider, "off"),
				);
			await recordIdleSources(db, run.id, rows);
		},
		async progress(progress) {
			await setScanProgress(db, run.id, progress);
		},
		async source(result, label) {
			const states = await listProviders(db, run.userId);
			const stop =
				(states.find((s) => s.provider === result.provider)?.config.stop as
					| StoredStop
					| undefined) ?? null;
			await recordScanSource(
				db,
				run.id,
				sourceReport(
					result,
					label,
					result.problem ? stop : null,
					result.problem
						? debugSnapshotFor(w.init.userData, result.provider, startedAt)
						: undefined,
				),
			);
		},
	};
	return {
		scanLog,
		scanProgress: (_userId, progress) => {
			void setScanProgress(db, run.id, progress).catch(() => {});
		},
	};
}

/** Sources that ran first (in scan order), then the ones that could not, then off. */
const ORDER: Record<string, number> = {
	ok: 0,
	error: 1,
	paused_check: 1,
	needs_sign_in: 1,
	retrying: 1,
	not_set_up: 2,
	off: 3,
};

/** A row from before the history (no runner run, no sources recorded). */
function isLegacy(row: Pick<ScanRunRow, "flowRunId" | "sources">): boolean {
	return !row.flowRunId && row.sources.length === 0;
}

/**
 * The run's state from the runner. A row whose runner run is gone (a row from before the
 * history, or a run since cleared) is done when it finished and interrupted when it did not;
 * it never reads as running.
 */
export function runStatus(
	row: Pick<ScanRunRow, "status" | "finishedAt" | "flowRunId">,
): RunState {
	if (!row.flowRunId || row.status === null)
		return row.finishedAt ? "done" : "interrupted";
	if (row.status === "complete") return "done";
	if (row.status === "errored") return "errored";
	if (row.status === "queued") return "queued";
	return "running";
}

/** An old scan's own counts (`jobsFetched`, `jobsInserted`), when it kept them. */
function legacyCounts(stats: Record<string, unknown> | null) {
	const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : null);
	return { read: n(stats?.jobsFetched), newJobs: n(stats?.jobsInserted) };
}

/** Each run with its sources, its new jobs' fates, the drops and the outcome line. */
export async function scanHistoryViews(
	db: Database,
	userId: string,
	rows: ScanRunRow[],
) {
	const ids = [
		...new Set(rows.flatMap((r) => r.sources.flatMap((s) => s.newJobIds))),
	];
	const jobs = new Map(
		(await scanJobs(db, userId, ids)).map((j) => [j.jobId, j]),
	);
	return rows.map((row) => {
		const status = runStatus(row);
		const sources = [...row.sources]
			.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
			.map((report) => {
				const found = report.newJobIds.map((id) => {
					const job = jobs.get(id);
					return {
						jobId: id,
						applicationId: job?.applicationId ?? null,
						title: job?.title ?? "A job no longer in the app",
						company: job?.company ?? "",
						url: job?.url ?? null,
						score: job?.score ?? null,
						fate: jobFate(
							job?.state
								? {
										state: job.state,
										filterResult: job.filterResult,
										endedReason: job.endedReason,
									}
								: null,
						),
					};
				});
				const drops = dropGroups(
					report,
					found.map((f) => ({
						fate: f.fate,
						title: f.title,
						company: f.company,
					})),
				);
				return { report, found, drops };
			});
		const legacy = isLegacy(row) ? legacyCounts(row.stats) : null;
		const outcome = legacy
			? status === "done"
				? `${legacy.newJobs !== null ? `${plural(legacy.newJobs, "new job")}; ` : ""}scanned before the history kept details`
				: "Interrupted before it finished; scanned before the history kept details"
			: scanOutcome(
					sources.map((s) => ({
						report: s.report,
						fates: s.found.map((f) => f.fate),
					})),
					{ status, error: row.error },
				);
		const listed = sources.reduce(
			(n, s) => n + s.found.filter((f) => f.fate.kind === "listed").length,
			0,
		);
		return {
			id: row.id,
			flowRunId: row.flowRunId,
			trigger: row.trigger as ScanTrigger,
			status,
			startedAt: row.startedAt,
			endedAt: row.finishedAt ?? row.endedAt,
			error: row.error,
			progress: status === "running" ? row.progress : null,
			totals: {
				...scanTotals(row.sources),
				...(legacy
					? { read: legacy.read ?? 0, newJobs: legacy.newJobs ?? 0 }
					: {}),
				listed,
			},
			legacy: Boolean(legacy),
			outcome,
			sources,
		};
	});
}

export function scanHistoryRouter(worker: () => { db: Database }) {
	return {
		/** The newest runs (up to 100), each with its outcome line and totals. */
		list: protectedProcedure.handler(async ({ context }) => {
			const w = worker();
			const userId = context.session.user.id;
			const rows = await listScanRuns(w.db, userId);
			return (await scanHistoryViews(w.db, userId, rows)).map(
				({ sources, ...run }) => ({
					...run,
					sourceCount: sources.filter((s) => s.report.status !== "off").length,
				}),
			);
		}),
		/** One run in full: each source's searches, funnel, drops with examples and problems. */
		get: protectedProcedure
			.input(z.object({ id: z.string().uuid() }))
			.handler(async ({ context, input }) => {
				const w = worker();
				const userId = context.session.user.id;
				const rows = (await listScanRuns(w.db, userId)).filter(
					(r) => r.id === input.id,
				);
				const [view] = await scanHistoryViews(w.db, userId, rows);
				if (!view) throw new ORPCError("NOT_FOUND");
				return view;
			}),
	};
}
