import { ENDED_COMPANY_HIDDEN } from "@offerfinch/core/domain/dismissal";
import type {
	CompanyRef,
	NormalizedJob,
	SourceHealth,
} from "@offerfinch/core/domain/types";
import { normalizeUrl } from "@offerfinch/core/domain/url";
import type { ApplicationRecord } from "@offerfinch/core/pipeline/ports";
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	like,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { COMPANY_HIDDEN_REASON, companyHidden } from "../dismissals";
import {
	applications,
	applicationTransitions,
	companies,
	jobs,
} from "../schema/pipeline";
import type { DrizzlePipelineRepositoryContext } from "./context";

/** A date a source gave, or null when it gave none or one that doesn't parse. */
const validDate = (date: Date | undefined) =>
	date && !Number.isNaN(date.getTime()) ? date : null;

export const jobsMethods = {
	async listActiveCompanies(
		userId: string,
		companyIds?: string[],
	): Promise<CompanyRef[]> {
		const rows = await this.db
			.select({
				id: companies.id,
				userId: companies.userId,
				name: companies.name,
				source: companies.source,
				sourceKey: companies.sourceKey,
				scrapeParser: companies.scrapeParser,
			})
			.from(companies)
			.where(
				and(
					eq(companies.userId, userId),
					eq(companies.status, "active"),
					// LinkedIn employers are found by the local runner, never scanned as a board.
					ne(companies.source, "linkedin"),
					// Sources that hit a block or robots.txt stay paused until the user looks at them.
					inArray(companies.health, ["ok", "error"]),
					// Added by hand: there is no board to scan.
					ne(companies.source, "manual"),
					companyIds?.length ? inArray(companies.id, companyIds) : undefined,
				),
			)
			.orderBy(asc(companies.name));
		return rows;
	},

	async setCompanyHealth(
		userId: string,
		companyId: string,
		health: SourceHealth,
		reason: string | null,
	): Promise<void> {
		await this.db
			.update(companies)
			.set({ health, healthReason: reason, lastScannedAt: new Date() })
			.where(and(eq(companies.id, companyId), eq(companies.userId, userId)));
	},

	async upsertJob(
		userId: string,
		companyId: string,
		job: NormalizedJob,
	): Promise<{ jobId: string; inserted: boolean }> {
		const urlNormalized = normalizeUrl(job.url);
		return this.db.transaction(async (tx) => {
			const [company] = await tx
				.select({ id: companies.id })
				.from(companies)
				.where(and(eq(companies.id, companyId), eq(companies.userId, userId)));
			if (!company)
				throw new Error(`Company ${companyId} is not owned by user ${userId}`);
			const sameJob = or(
				and(eq(jobs.source, job.source), eq(jobs.externalId, job.externalId)),
				eq(jobs.urlNormalized, urlNormalized),
			);
			let [existing] = await tx
				.select({ id: jobs.id })
				.from(jobs)
				.where(and(eq(jobs.userId, userId), sameJob))
				.limit(1);
			// The same posting already found as another source's apply link (a LinkedIn listing
			// that links to this board posting): one job, not two.
			if (!existing && job.externalId) {
				const linked = await tx
					.select({ id: jobs.id, applyUrl: jobs.applyUrl })
					.from(jobs)
					.where(
						and(
							eq(jobs.userId, userId),
							isNotNull(jobs.applyUrl),
							like(jobs.applyUrl, `%${job.externalId}%`),
						),
					);
				existing = linked.find(
					(j) =>
						j.applyUrl !== null && normalizeUrl(j.applyUrl) === urlNormalized,
				);
			}
			if (existing) {
				await tx
					.update(jobs)
					.set({ lastSeenAt: new Date() })
					.where(eq(jobs.id, existing.id));
				return { jobId: existing.id, inserted: false };
			}
			const [row] = await tx
				.insert(jobs)
				.values({
					userId,
					companyId,
					source: job.source,
					externalId: job.externalId,
					url: job.url,
					urlNormalized,
					title: job.title,
					locations: job.locations,
					workplaceType: job.workplaceType,
					department: job.department ?? null,
					employmentType: job.employmentType ?? null,
					descriptionText: job.descriptionText,
					applyUrl: job.applyUrl ?? null,
					publishedAt: validDate(job.publishedAt),
					validThrough: validDate(job.validThrough),
				})
				.onConflictDoNothing()
				.returning({ id: jobs.id });
			if (!row) {
				// A concurrent scan inserted it first.
				const [raced] = await tx
					.select({ id: jobs.id })
					.from(jobs)
					.where(and(eq(jobs.userId, userId), sameJob))
					.limit(1);
				if (!raced)
					throw new Error(`Job insert conflicted but no row found: ${job.url}`);
				return { jobId: raced.id, inserted: false };
			}
			const [app] = await tx
				.insert(applications)
				.values({ userId, jobId: row.id })
				.onConflictDoNothing()
				.returning({ id: applications.id });
			if (app) {
				await tx.insert(applicationTransitions).values({
					userId,
					applicationId: app.id,
					fromState: null,
					toState: "found",
					reason: "job found",
					actor: "system",
				});
				// From a company the user hid: dismissed before any model reads it. A job the user
				// added themselves is theirs to keep.
				if (
					job.source !== "manual" &&
					(await companyHidden(tx, userId, companyId))
				)
					await this.move(
						userId,
						app.id,
						["found"],
						"dismissed",
						COMPANY_HIDDEN_REASON,
						"system",
						{ endedReason: ENDED_COMPANY_HIDDEN },
						tx,
					);
			}
			return { jobId: row.id, inserted: true };
		});
	},

	async listUnstartedJobIds(userId: string, limit: number): Promise<string[]> {
		const rows = await this.db
			.select({ jobId: applications.jobId })
			.from(applications)
			.where(
				and(
					eq(applications.userId, userId),
					isNull(applications.workflowStartedAt),
				),
			)
			.orderBy(asc(applications.createdAt), asc(sql`${applications}.rowid`))
			.limit(limit);
		return rows.map((r) => r.jobId);
	},

	async markWorkflowsStarted(
		userId: string,
		jobIds: string[],
		runtime: string,
	): Promise<void> {
		if (jobIds.length === 0) return;
		await this.db
			.update(applications)
			.set({
				workflowStartedAt: new Date(),
				workflowRuntime: runtime,
				workflowInstanceId: sql`'job-' || ${applications.jobId}`,
			})
			.where(
				and(
					eq(applications.userId, userId),
					inArray(applications.jobId, jobIds),
					isNull(applications.workflowStartedAt),
				),
			);
	},

	async listStuckFoundJobIds(
		userId: string,
		startedBefore: Date,
		limit: number,
	): Promise<string[]> {
		const rows = await this.db
			.select({ jobId: applications.jobId })
			.from(applications)
			.where(
				and(
					eq(applications.userId, userId),
					eq(applications.state, "found"),
					sql`${applications.workflowStartedAt} < ${startedBefore}`,
				),
			)
			.orderBy(
				asc(applications.workflowStartedAt),
				asc(sql`${applications}.rowid`),
			)
			.limit(limit);
		return rows.map((r) => r.jobId);
	},

	async getApplicationByJob(
		userId: string,
		jobId: string,
	): Promise<ApplicationRecord | null> {
		const [row] = await this.db
			.select({ app: applications, job: jobs, companyName: companies.name })
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
				and(eq(applications.jobId, jobId), eq(applications.userId, userId)),
			)
			.limit(1);
		if (!row) return null;
		return {
			applicationId: row.app.id,
			userId: row.app.userId,
			jobId,
			state: row.app.state,
			companyName: row.companyName,
			companyId: row.job.companyId,
			job: {
				source: row.job.source,
				externalId: row.job.externalId,
				url: row.job.url,
				title: row.job.title,
				locations: row.job.locations,
				workplaceType: row.job.workplaceType,
				department: row.job.department ?? undefined,
				employmentType: row.job.employmentType ?? undefined,
				descriptionText: row.job.descriptionText,
				applyUrl: row.job.applyUrl ?? undefined,
				publishedAt: row.job.publishedAt ?? undefined,
			},
			filter: row.app.filterResult ?? null,
			score: row.app.score,
			fit: row.app.fit ?? null,
			endedReason: row.app.endedReason,
			prepareAttempts: row.app.prepareAttempts,
		};
	},
} satisfies Record<string, unknown> &
	ThisType<DrizzlePipelineRepositoryContext>;
