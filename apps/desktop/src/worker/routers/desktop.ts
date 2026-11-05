import { DashboardRepository, DrizzleSpendStore } from "@offerfinch/db";
import { flowRuns } from "@offerfinch/db/schema/jobs";
import { applications, companies, jobs } from "@offerfinch/db/schema/pipeline";
import {
	APPLICATION_KIND,
	hourlyScanId,
	recentScans,
} from "@offerfinch/runner";
import { ORPCError } from "@orpc/server";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import { findChrome } from "../browser";
import { firstSearchView, jobsFoundBy } from "../first-search";
import { scanProgressOf } from "../scan-history";
import { nextScan } from "../schedule";
import { protectedProcedure } from "./procedure";
import { providerStatus, WAITING_ON_YOU, worker } from "./shared";

export const desktopStatusRouter = {
	status: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		const chrome = findChrome();
		const status = await w.status();
		const userId = context.session.user.id;
		const [thisHour] = await w.db
			.select({ id: flowRuns.id })
			.from(flowRuns)
			.where(eq(flowRuns.id, hourlyScanId(userId, new Date())));
		return {
			...status,
			/** When the next hourly scan is due, and why (paused, no profile, test runs). */
			next: nextScan({
				now: new Date(),
				paused: status.paused,
				hasProfile: Boolean(
					await new DashboardRepository(w.db).profileFiles(userId),
				),
				scheduleOff: Boolean(w.init.test?.noSchedule),
				thisHourRan: Boolean(thisHour),
			}),
			version: w.init.version,
			chrome: chrome ? chrome.name : null,
			roles: w.roles,
		};
	}),
	scanNow: protectedProcedure
		.input(
			z.object({
				companyIds: z.array(z.string().uuid()).max(500).optional(),
			}),
		)
		.handler(({ input }) => worker().scanNow(input.companyIds)),
	setPaused: protectedProcedure
		.input(z.object({ paused: z.boolean() }))
		.handler(async ({ input }) => ({
			paused: await worker().setPaused(input.paused),
		})),
	/**
	 * Home in one read: what waits for the user (with company and role), recent matches with
	 * their fit, the scan schedule and stops, and this month's AI spend. Reads only.
	 */
	home: protectedProcedure.handler(async ({ context }) => {
		const w = worker();
		const userId = context.session.user.id;
		const repo = new DashboardRepository(w.db);
		const row = {
			id: applications.id,
			state: applications.state,
			score: applications.score,
			since: applications.stateChangedAt,
			scoredAt: applications.scoredAt,
			title: jobs.title,
			company: companies.name,
			source: jobs.source,
		};
		const joined = () =>
			w.db
				.select(row)
				.from(applications)
				.innerJoin(jobs, eq(jobs.id, applications.jobId))
				.innerJoin(companies, eq(companies.id, jobs.companyId));
		const providers = await providerStatus(w, userId);
		const [waiting, recent, questions, scans, spending] = await Promise.all([
			joined()
				.where(
					and(
						eq(applications.userId, userId),
						inArray(applications.state, [...WAITING_ON_YOU]),
						// A closed posting waits in Closed, not here; one being submitted stays.
						or(isNull(jobs.closedAt), eq(applications.state, "needs_human")),
					),
				)
				.orderBy(desc(applications.stateChangedAt))
				.limit(50),
			joined()
				.where(
					and(
						eq(applications.userId, userId),
						isNotNull(applications.score),
						// A match the re-filter rejected keeps its score, but is hidden.
						ne(applications.state, "rejected_by_filter"),
						isNull(jobs.closedAt),
						gte(
							applications.scoredAt,
							new Date(Date.now() - 7 * 24 * 3600_000),
						),
					),
				)
				.orderBy(desc(applications.scoredAt))
				.limit(6),
			repo.listQuestions(userId, "open"),
			recentScans(w.db, userId, 1),
			repo.spending(userId),
		]);
		const openQuestions = new Map<string, number>();
		for (const q of questions)
			if (q.applicationId)
				openQuestions.set(
					q.applicationId,
					(openQuestions.get(q.applicationId) ?? 0) + 1,
				);
		const order = (s: string) => WAITING_ON_YOU.indexOf(s as never);
		const [last] = scans;
		const [thisHour] = await w.db
			.select({ id: flowRuns.id })
			.from(flowRuns)
			.where(eq(flowRuns.id, hourlyScanId(userId, new Date())));
		const status = await w.status();
		const subscriptionRoles = w.roles.filter(
			(r) => r.billing === "subscription",
		);
		return {
			waiting: waiting
				.map((a) => ({ ...a, questions: openQuestions.get(a.id) ?? 0 }))
				.sort((a, b) => order(a.state) - order(b.state)),
			recent,
			scan: {
				state: status.state,
				paused: status.paused,
				last: last
					? {
							id: last.id,
							status: last.status,
							trigger: (last.params as { trigger?: string }).trigger ?? "cron",
							at: (last.endedAt ?? last.createdAt).toISOString(),
							error: last.error,
							result: last.result
								? (JSON.parse(last.result) as {
										jobsFetched?: number;
										jobsInserted?: number;
										failedCompanies?: unknown[];
									})
								: null,
						}
					: null,
				next: nextScan({
					now: new Date(),
					paused: status.paused,
					hasProfile: Boolean(await repo.profileFiles(userId)),
					scheduleOff: Boolean(w.init.test?.noSchedule),
					thisHourRan: Boolean(thisHour),
				}),
				// PLAN A: what scans search, and each provider's problem from its last run.
				watching: providers.filter((p) => p.ready).length,
				unset: providers
					.filter(
						(p) => p.provider === "job-board-search" && p.enabled && !p.ready,
					)
					.map((p) => p.label),
				// A site's recorded stop, or the search service's last problem. A site's page cap
				// is a note, not a stop.
				stopped: providers
					.filter((p) =>
						p.provider === "job-board-search"
							? p.enabled && Boolean(p.stop || p.lastRun?.problem)
							: p.enabled && Boolean(p.stop),
					)
					.map((p) => ({
						id: p.provider,
						name: p.label,
						health: "error",
						reason: p.stop?.reason ?? p.lastRun?.problem ?? null,
					})),
			},
			spend: {
				enabled: spending.enabled,
				spentMicros: spending.spentMicros + spending.reservedMicros,
				capMicros: spending.capMicros,
				reached: spending.reached,
				/** Plans stopped after a paid call, until the user resumes them. */
				paidStops: Object.entries(
					await new DrizzleSpendStore(w.db).paidStops(userId),
				)
					.filter(([, at]) => at !== null)
					.map(([vendor]) => (vendor === "openai" ? "Codex" : "Claude")),
				subscriptionCalls: spending.subscriptionCalls,
				callBudget: subscriptionRoles.length
					? await new DrizzleSpendStore(w.db).subscriptionBudget(userId)
					: null,
				subscriptionRoles: subscriptionRoles.map((r) => r.role),
			},
		};
	}),
	/**
	 * Scoring still to come: application runs not ended for a job not scored yet (queued,
	 * running, or paused for the model, which scores after a later scan). A scan ends before its
	 * jobs are scored, so setup's first search waits on this, not on the scan: a paused score
	 * never reads as "no matches".
	 */
	scoring: protectedProcedure.handler(async ({ context }) => {
		const userId = context.session.user.id;
		// A queued run may not have made its application row yet: no row counts as not scored.
		const [row] = await worker()
			.db.select({ n: sql<number>`count(*)` })
			.from(flowRuns)
			.leftJoin(
				applications,
				and(
					eq(applications.userId, userId),
					eq(
						applications.jobId,
						sql`json_extract(${flowRuns.params}, '$.jobId')`,
					),
				),
			)
			.where(
				and(
					eq(flowRuns.userId, userId),
					eq(flowRuns.kind, APPLICATION_KIND),
					inArray(flowRuns.status, ["queued", "running", "waiting"]),
					or(isNull(applications.id), eq(applications.state, "found")),
				),
			);
		return { pending: Number(row?.n ?? 0) };
	}),
	/** The latest scans with their outcome, for Home and the first-scan progress. */
	scans: protectedProcedure.handler(async ({ context }) => {
		const rows = await recentScans(worker().db, context.session.user.id, 5);
		return rows.map((r) => ({
			id: r.id,
			status: r.status,
			trigger: (r.params as { trigger?: string }).trigger ?? "cron",
			createdAt: r.createdAt,
			endedAt: r.endedAt,
			error: r.error,
			result: r.result
				? (JSON.parse(r.result) as Record<string, unknown>)
				: null,
		}));
	}),
	/**
	 * One scan run's progress: sources (or, for a company scan, companies) done of all, what runs
	 * now, and what it found so far.
	 */
	scan: protectedProcedure
		.input(z.object({ id: z.string().max(200) }))
		.handler(async ({ input }) => {
			const w = worker();
			const [run] = await w.db
				.select()
				.from(flowRuns)
				.where(eq(flowRuns.id, input.id));
			if (!run) throw new ORPCError("NOT_FOUND");
			const steps = w.db.$client
				.prepare(
					"select key, status from flow_steps where run_id = ? and key like 'scan %'",
				)
				.all(input.id) as { key: string; status: string }[];
			const listed = w.db.$client
				.prepare(
					"select result from flow_steps where run_id = ? and key = 'list companies#1'",
				)
				.get(input.id) as { result: string } | undefined;
			const result = run.result
				? (JSON.parse(run.result) as Record<string, unknown>)
				: null;
			if (listed)
				return {
					status: run.status,
					total: (JSON.parse(listed.result) as unknown[]).length,
					done: steps.filter(
						(s) => s.status === "complete" || s.status === "failed",
					).length,
					unit: "companies" as const,
					line: null,
					source: null,
					error: run.error,
					result,
				};
			// A scan of sources lists no companies: its progress is in the scan history.
			const sources = await scanProgressOf(w.db, {
				id: run.id,
				userId: run.userId,
			});
			return {
				status: run.status,
				total: sources?.total ?? null,
				done: sources?.done ?? 0,
				unit: "sources" as const,
				line: sources?.line ?? null,
				source: sources?.source ?? null,
				error: run.error,
				result,
			};
		}),
	/**
	 * The jobs one scan run found, for setup's live first search: each with its state (found, fits
	 * the rules, set aside with the rule's reason, scored with its fit and whether it is a match),
	 * in the order they arrived, and totals. Reads only.
	 */
	scanJobs: protectedProcedure
		.input(z.object({ id: z.string().max(200) }))
		.handler(async ({ context, input }) => {
			const w = worker();
			const userId = context.session.user.id;
			const [run] = await w.db
				.select({
					userId: flowRuns.userId,
					createdAt: flowRuns.createdAt,
					endedAt: flowRuns.endedAt,
				})
				.from(flowRuns)
				.where(and(eq(flowRuns.id, input.id), eq(flowRuns.userId, userId)));
			if (!run) throw new ORPCError("NOT_FOUND");
			const { minScore } = await new DashboardRepository(
				w.db,
			).getFilterSettings(userId);
			return firstSearchView(
				await jobsFoundBy(w.db, {
					userId,
					createdAt: run.createdAt,
					endedAt: run.endedAt ?? null,
				}),
				minScore,
			);
		}),
};
