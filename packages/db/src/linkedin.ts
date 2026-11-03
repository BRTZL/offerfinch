import { companyNameKey, normalizeUrl } from "@offerfinch/core/domain/url";
import type { LinkedInStop } from "@offerfinch/core/linkedin/detect";
import type { LinkedInListing } from "@offerfinch/core/linkedin/parse";
import type { LinkedInScanStore } from "@offerfinch/core/linkedin/provider";
import {
	LINKEDIN_PACE,
	type LinkedInBlock,
	type LinkedInRunResult,
	type LinkedInStore,
	type SaveOutcome,
} from "@offerfinch/core/linkedin/runner";
import { and, asc, desc, eq, gte, isNotNull, ne, or, sql } from "drizzle-orm";

const DAY_MS = 24 * 3600 * 1000;

import type { Database } from "./client";
import { DrizzlePipelineRepository } from "./repository";
import {
	companies,
	jobs,
	linkedinPages,
	linkedinRuns,
	linkedinSeen,
	linkedinSettings,
} from "./schema/pipeline";

/** Lowercased words of a title, for matching the same role across sources. */
export function titleKey(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\p{L}\d+#]+/gu, " ")
		.trim();
}

/** The LinkedIn runner's side of the database, and its status for Sources. Every call is per user. */
export class DrizzleLinkedInStore implements LinkedInStore, LinkedInScanStore {
	constructor(
		private readonly db: Database,
		private readonly now: () => Date = () => new Date(),
	) {}

	private async row(userId: string) {
		const [row] = await this.db
			.select()
			.from(linkedinSettings)
			.where(eq(linkedinSettings.userId, userId));
		return row ?? null;
	}

	async blocked(userId: string): Promise<LinkedInBlock | null> {
		const row = await this.row(userId);
		return row?.blockedAt
			? {
					at: row.blockedAt,
					kind: row.blockedKind ?? "unknown",
					reason: row.blockedReason ?? "",
				}
			: null;
	}

	/** When the last read began: scans, Retry now and runs of earlier versions; not a linked job. */
	async lastReadAt(userId: string): Promise<Date | null> {
		const [row] = await this.db
			.select({ at: linkedinRuns.startedAt })
			.from(linkedinRuns)
			.where(
				and(eq(linkedinRuns.userId, userId), ne(linkedinRuns.trigger, "link")),
			)
			.orderBy(desc(linkedinRuns.startedAt))
			.limit(1);
		return row?.at ?? null;
	}

	async pagesSince(userId: string, since: Date): Promise<Date[]> {
		const rows = await this.db
			.select({ at: linkedinPages.openedAt })
			.from(linkedinPages)
			.where(
				and(
					eq(linkedinPages.userId, userId),
					gte(linkedinPages.openedAt, since),
				),
			)
			.orderBy(asc(linkedinPages.openedAt));
		return rows.map((r) => r.at);
	}

	pagesUsedSince(userId: string, since: Date): Promise<number> {
		return this.countPagesSince(this.db, userId, since);
	}

	private async countPagesSince(
		db: Pick<Database, "select">,
		userId: string,
		since: Date,
	): Promise<number> {
		const [row] = await db
			.select({ n: sql<number>`count(*)` })
			.from(linkedinPages)
			.where(
				and(
					eq(linkedinPages.userId, userId),
					gte(linkedinPages.openedAt, since),
				),
			);
		return Number(row?.n ?? 0);
	}

	/**
	 * Serializes page reservations and stops of one user. SQLite runs one write transaction at a
	 * time (BEGIN IMMEDIATE, and one at a time in this process), which replaces Postgres'
	 * advisory lock; kept as a named step so the reads below stay inside it.
	 */
	private async lock(_tx: unknown, _userId: string): Promise<void> {}

	async reservePage(userId: string, runId: string) {
		return this.db.transaction(async (tx) => {
			await this.lock(tx, userId);
			const [row] = await tx
				.select()
				.from(linkedinSettings)
				.where(eq(linkedinSettings.userId, userId));
			if (row?.blockedAt) {
				const block: LinkedInBlock = {
					at: row.blockedAt,
					kind: row.blockedKind ?? "unknown",
					reason: row.blockedReason ?? "",
				};
				return { ok: false as const, reason: "blocked" as const, block };
			}
			// Fixed in core: a cap stored by an earlier version is not read.
			const cap = LINKEDIN_PACE.dailyPageCap;
			const at = this.now();
			const used = await this.countPagesSince(
				tx,
				userId,
				new Date(at.getTime() - DAY_MS),
			);
			if (used >= cap)
				return { ok: false as const, reason: "cap" as const, cap };
			await tx.insert(linkedinPages).values({ userId, runId, openedAt: at });
			return { ok: true as const };
		});
	}

	async startRun(userId: string, trigger: string): Promise<string> {
		const [row] = await this.db
			.insert(linkedinRuns)
			.values({ userId, trigger, startedAt: this.now() })
			.returning({ id: linkedinRuns.id });
		if (!row) throw new Error("linkedin run not created");
		return row.id;
	}

	async updateRun(
		runId: string,
		progress: Parameters<LinkedInStore["updateRun"]>[1],
	): Promise<void> {
		await this.db
			.update(linkedinRuns)
			.set(progress)
			.where(eq(linkedinRuns.id, runId));
	}

	async finishRun(runId: string, result: LinkedInRunResult): Promise<void> {
		await this.db
			.update(linkedinRuns)
			.set({
				pagesUsed: result.pagesUsed,
				listingsRead: result.listingsRead,
				jobsInserted: result.jobsInserted,
				duplicates: result.duplicates,
				outcome: result.outcome,
				stopReason: result.stopReason?.slice(0, 500) ?? null,
				finishedAt: this.now(),
			})
			.where(eq(linkedinRuns.id, runId));
	}

	async block(userId: string, stop: LinkedInStop): Promise<void> {
		const value = {
			blockedAt: this.now(),
			blockedKind: stop.kind,
			blockedReason: stop.reason.slice(0, 500),
		};
		await this.db.transaction(async (tx) => {
			// After this commits, no runner of this user can reserve another page.
			await this.lock(tx, userId);
			await tx
				.insert(linkedinSettings)
				.values({ userId, ...value })
				.onConflictDoUpdate({ target: linkedinSettings.userId, set: value });
		});
	}

	/** Lifts a stop (Retry now, or a sign-in that worked). False when nothing was blocked. */
	async clear(userId: string): Promise<boolean> {
		const rows = await this.db
			.update(linkedinSettings)
			.set({
				blockedAt: null,
				blockedKind: null,
				blockedReason: null,
				clearedAt: this.now(),
			})
			.where(
				and(
					eq(linkedinSettings.userId, userId),
					sql`${linkedinSettings.blockedAt} is not null`,
				),
			)
			.returning({ userId: linkedinSettings.userId });
		return rows.length > 0;
	}

	async isKnown(userId: string, linkedinJobId: string): Promise<boolean> {
		const [seen] = await this.db
			.select({ id: linkedinSeen.linkedinJobId })
			.from(linkedinSeen)
			.where(
				and(
					eq(linkedinSeen.userId, userId),
					eq(linkedinSeen.linkedinJobId, linkedinJobId),
				),
			)
			.limit(1);
		if (seen) return true;
		const [row] = await this.db
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.userId, userId),
					eq(jobs.source, "linkedin"),
					eq(jobs.externalId, linkedinJobId),
				),
			)
			.limit(1);
		return Boolean(row);
	}

	async saveListing(
		userId: string,
		listing: LinkedInListing,
		url: string,
	): Promise<{ outcome: SaveOutcome; jobId: string | null }> {
		const { outcome, jobId } = await this.store(userId, listing, url);
		await this.db
			.insert(linkedinSeen)
			.values({ userId, linkedinJobId: listing.jobId, outcome })
			.onConflictDoUpdate({
				target: [linkedinSeen.userId, linkedinSeen.linkedinJobId],
				set: { outcome, seenAt: this.now() },
			});
		return { outcome, jobId };
	}

	private async store(
		userId: string,
		listing: LinkedInListing,
		url: string,
	): Promise<{ outcome: SaveOutcome; jobId: string | null }> {
		const nameKey = companyNameKey(listing.company);
		const known = await this.db
			.select({
				id: companies.id,
				source: companies.source,
				status: companies.status,
			})
			.from(companies)
			.where(and(eq(companies.userId, userId), eq(companies.nameKey, nameKey)));
		if (known.some((c) => c.status === "removed"))
			return { outcome: "removed_company", jobId: null };

		// The same role found elsewhere: by the employer's apply link, or employer and title.
		const applyKey = listing.externalApplyUrl
			? normalizeUrl(listing.externalApplyUrl)
			: null;
		const sameTitle = titleKey(listing.title);
		const existing = await this.db
			.select({
				urlNormalized: jobs.urlNormalized,
				applyUrl: jobs.applyUrl,
				title: jobs.title,
				nameKey: companies.nameKey,
			})
			.from(jobs)
			.innerJoin(
				companies,
				and(eq(companies.id, jobs.companyId), eq(companies.userId, userId)),
			)
			.where(
				and(
					eq(jobs.userId, userId),
					or(
						eq(companies.nameKey, nameKey),
						applyKey ? eq(jobs.urlNormalized, applyKey) : undefined,
						applyKey ? isNotNull(jobs.applyUrl) : undefined,
					),
				),
			);
		const duplicate = existing.some(
			(j) =>
				(applyKey !== null &&
					(j.urlNormalized === applyKey ||
						(j.applyUrl !== null && normalizeUrl(j.applyUrl) === applyKey))) ||
				(j.nameKey === nameKey && titleKey(j.title) === sameTitle),
		);
		if (duplicate) return { outcome: "duplicate", jobId: null };

		let companyId = known.find((c) => c.source === "linkedin")?.id;
		if (!companyId) {
			await this.db
				.insert(companies)
				.values({
					userId,
					name: listing.company,
					nameKey,
					source: "linkedin",
					sourceKey: `linkedin:${nameKey}`,
					discoveredFrom: "linkedin runner",
				})
				.onConflictDoNothing();
			const [row] = await this.db
				.select({ id: companies.id })
				.from(companies)
				.where(
					and(
						eq(companies.userId, userId),
						eq(companies.source, "linkedin"),
						eq(companies.sourceKey, `linkedin:${nameKey}`),
					),
				);
			companyId = row?.id;
		}
		if (!companyId) throw new Error("linkedin company not created");
		const { inserted, jobId } = await new DrizzlePipelineRepository(
			this.db,
		).upsertJob(userId, companyId, {
			source: "linkedin",
			externalId: listing.jobId,
			url,
			title: listing.title,
			locations: listing.locations,
			workplaceType: listing.workplaceType,
			employmentType: listing.employmentType,
			descriptionText: listing.descriptionText,
			applyUrl: listing.externalApplyUrl ?? undefined,
		});
		return inserted
			? { outcome: "inserted", jobId }
			: { outcome: "duplicate", jobId: null };
	}

	/** What Sources shows: the stop, the last runs and the pages of the last 24 hours. */
	async status(userId: string) {
		const blocked = await this.blocked(userId);
		const runs = await this.db
			.select()
			.from(linkedinRuns)
			.where(eq(linkedinRuns.userId, userId))
			.orderBy(desc(linkedinRuns.startedAt), desc(sql`${linkedinRuns}.rowid`))
			.limit(5);
		const pagesUsed24h = await this.pagesUsedSince(
			userId,
			new Date(this.now().getTime() - DAY_MS),
		);
		return {
			blocked,
			runs,
			pagesUsed24h,
			dailyPageCap: LINKEDIN_PACE.dailyPageCap,
		};
	}
}
