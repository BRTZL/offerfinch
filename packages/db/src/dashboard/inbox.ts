import type { ApplicationState } from "@offerfinch/core/domain/states";
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	like,
	or,
	sql,
} from "drizzle-orm";
import {
	applications,
	applicationTransitions,
	companies,
	jobs,
	llmUsage,
	questions,
} from "../schema/pipeline";
import type { DashboardRepositoryContext } from "./context";
import {
	type ApplicationFilters,
	type InboxView,
	inboxViewWhere,
} from "./shared";
export const inboxMethods = {
	async countsByState(userId: string) {
		const rows = await this.database
			.select({
				state: applications.state,
				n: sql<number>`count(*)`,
			})
			.from(applications)
			.where(eq(applications.userId, userId))
			.groupBy(applications.state);
		return Object.fromEntries(rows.map((r) => [r.state, r.n])) as Partial<
			Record<ApplicationState, number>
		>;
	},

	/**
	 * How many applications each Inbox view holds (the same predicates as the list), plus jobs
	 * the user added by link that are still being read, checked or scored.
	 */
	async inboxCounts(
		userId: string,
	): Promise<Record<InboxView, number> & { added: number }> {
		const n = (where: ReturnType<typeof inboxViewWhere>) =>
			sql<number>`coalesce(sum(case when ${where} then 1 else 0 end), 0)`;
		const [row] = await this.database
			.select({
				matches: n(inboxViewWhere("matches")),
				drafting: n(inboxViewWhere("drafting")),
				review: n(inboxViewWhere("review")),
				approved: n(inboxViewWhere("approved")),
				closed: n(inboxViewWhere("closed")),
				all: n(inboxViewWhere("all")),
				added: n(
					sql`(${applications.state} = 'found' and ${jobs.source} = 'manual')`,
				),
			})
			.from(applications)
			.innerJoin(jobs, eq(jobs.id, applications.jobId))
			.where(eq(applications.userId, userId));
		return {
			matches: Number(row?.matches ?? 0),
			drafting: Number(row?.drafting ?? 0),
			review: Number(row?.review ?? 0),
			approved: Number(row?.approved ?? 0),
			closed: Number(row?.closed ?? 0),
			all: Number(row?.all ?? 0),
			added: Number(row?.added ?? 0),
		};
	},

	async listApplications(userId: string, filters: ApplicationFilters = {}) {
		const search = filters.search?.trim();
		const openQuestions = sql<number>`(select count(*) from ${questions} q where q.application_id = ${applications.id} and q.status = 'open')`;
		const costMicros = sql<number>`(select coalesce(sum(case when u.status = 'settled' then u.cost_micros else u.estimate_micros end), 0) from ${llmUsage} u where u.application_id = ${applications.id})`;
		const subscriptionCalls = sql<number>`(select count(*) from ${llmUsage} u where u.application_id = ${applications.id} and u.billing = 'subscription')`;
		const apiCalls = sql<number>`(select count(*) from ${llmUsage} u where u.application_id = ${applications.id} and u.billing = 'api')`;
		return this.database
			.select({
				id: applications.id,
				jobId: applications.jobId,
				state: applications.state,
				score: applications.score,
				/** The order of Matches (score minus penalties); null before ranking. */
				rank: applications.rank,
				/** The biggest penalty, shown as "Ranked lower: …". */
				rankReason: sql<
					string | null
				>`json_extract(${applications.rankPenalties}, '$[0].reason')`,
				flags: applications.flags,
				filterDecision: applications.filterDecision,
				filterSummary: sql<
					string | null
				>`${applications.filterResult}->>'summary'`,
				/** The rule that set it aside, in the filter's words ("Needs US citizenship"). */
				filterReason: sql<
					string | null
				>`(select json_extract(r.value, '$.message') from json_each(${applications.filterResult}, '$.reasons') r where json_extract(r.value, '$.outcome') = 'reject' limit 1)`,
				endedReason: applications.endedReason,
				stateChangedAt: applications.stateChangedAt,
				approvedAt: applications.approvedAt,
				appliedAt: applications.appliedAt,
				appliedVia: applications.appliedVia,
				title: jobs.title,
				url: jobs.url,
				locations: jobs.locations,
				workplaceType: jobs.workplaceType,
				source: jobs.source,
				readStatus: jobs.readStatus,
				readError: jobs.readError,
				/** The posting was found closed (shown as "Posting closed"); null while open. */
				closedAt: jobs.closedAt,
				runStatus: sql<
					string | null
				>`(select r.status from flow_runs r where r.id = 'job-' || ${jobs.id})`,
				companyId: companies.id,
				companyName: companies.name,
				/** The company's normalized name: one employer across sources (Inbox groups by it). */
				companyKey: companies.nameKey,
				prepareRequestedAt: applications.prepareRequestedAt,
				openQuestions,
				/** Estimated LLM cost of this application so far, micro-dollars. */
				costMicros,
				/** Calls on a subscription ($0, shown as "Subscription") and on API keys. */
				subscriptionCalls,
				apiCalls,
			})
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
					eq(applications.userId, userId),
					filters.view
						? filters.includeAdded
							? or(
									inboxViewWhere(filters.view),
									and(
										eq(jobs.source, "manual"),
										eq(applications.state, "found"),
									),
								)
							: inboxViewWhere(filters.view)
						: filters.states?.length
							? filters.includeAdded
								? or(
										inArray(applications.state, filters.states),
										and(
											eq(jobs.source, "manual"),
											eq(applications.state, "found"),
										),
									)
								: inArray(applications.state, filters.states)
							: undefined,
					filters.minScore !== undefined
						? filters.includeAdded
							? or(
									sql`${applications.score} >= ${filters.minScore}`,
									eq(applications.state, "found"),
								)
							: sql`${applications.score} >= ${filters.minScore}`
						: undefined,
					filters.companyId ? eq(companies.id, filters.companyId) : undefined,
					search
						? or(
								like(jobs.title, `%${search}%`),
								like(companies.name, `%${search}%`),
							)
						: undefined,
				),
			)
			.orderBy(
				...(filters.sort === "fit"
					? [
							// Best fit is the rank: the score lowered for an unclear place, a
							// seniority mismatch and the like (core/scoring/rank.ts).
							desc(
								sql`coalesce(${applications.rank}, ${applications.score}, -1)`,
							),
							desc(sql`coalesce(${applications.score}, -1)`),
							desc(applications.stateChangedAt),
						]
					: [desc(applications.stateChangedAt), desc(applications.score)]),
				desc(sql`${applications}.rowid`),
			)
			.limit(filters.limit ?? 200)
			.offset(filters.offset ?? 0);
	},

	async runStatus(jobId: string): Promise<string | null> {
		const [row] = await this.database.all<{ status: string }>(
			sql`select status from flow_runs where id = ${`job-${jobId}`}`,
		);
		return row?.status ?? null;
	},

	async listApplied(userId: string) {
		return this.database
			.select({
				id: applications.id,
				appliedAt: applications.appliedAt,
				appliedVia: applications.appliedVia,
				score: applications.score,
				title: jobs.title,
				url: jobs.url,
				companyName: companies.name,
			})
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
				and(eq(applications.userId, userId), eq(applications.state, "applied")),
			)
			.orderBy(desc(applications.appliedAt), desc(sql`${applications}.rowid`));
	},

	/**
	 * Jobs turned down, with the reason: low scores and user rejections. The job filter's rejects
	 * are hidden everywhere, so never here.
	 */
	async listRejected(userId: string, limit = 300) {
		return this.database
			.select({
				id: applications.id,
				state: applications.state,
				score: applications.score,
				filterResult: applications.filterResult,
				endedReason: applications.endedReason,
				stateChangedAt: applications.stateChangedAt,
				title: jobs.title,
				url: jobs.url,
				locations: jobs.locations,
				companyName: companies.name,
				userReason: sql<
					string | null
				>`(select t.reason from ${applicationTransitions} t where t.application_id = ${applications.id} and t.to_state = 'rejected' order by t.created_at desc limit 1)`,
			})
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
					eq(applications.userId, userId),
					or(
						eq(applications.state, "rejected"),
						and(
							eq(applications.state, "scored"),
							isNotNull(applications.endedReason),
						),
					),
				),
			)
			.orderBy(
				desc(applications.stateChangedAt),
				desc(sql`${applications}.rowid`),
			)
			.limit(limit);
	},

	async listCompanies(userId: string) {
		return this.database
			.select({
				id: companies.id,
				name: companies.name,
				source: companies.source,
				sourceKey: companies.sourceKey,
				status: companies.status,
				health: companies.health,
				healthReason: companies.healthReason,
				lastScannedAt: companies.lastScannedAt,
				// Qualified by hand: in a single-table select Drizzle renders the column as a bare
				// "id", which inside the subquery means the job's id and counted nothing.
				jobs: sql<number>`(select count(*) from ${jobs} j where j.company_id = "companies"."id")`,
			})
			.from(companies)
			.where(eq(companies.userId, userId))
			.orderBy(asc(companies.status), asc(companies.name));
	},
} satisfies Record<string, unknown> & ThisType<DashboardRepositoryContext>;
