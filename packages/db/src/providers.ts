import type { JobSourceKind } from "@offerfinch/core/domain/types";
import { companyNameKey, normalizeUrl } from "@offerfinch/core/domain/url";
import type {
	ProviderRun,
	SearchStore,
} from "@offerfinch/core/pipeline/providers";
import type {
	SiteStopRecord,
	SiteStore,
} from "@offerfinch/core/sites/provider";
import type { SiteId } from "@offerfinch/core/sites/sites";
import type { WebSearchStore } from "@offerfinch/core/web/provider";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import type { Database } from "./client";
import { titleKey } from "./linkedin";
import { companies, jobs, sourceProviders } from "./schema/pipeline";

export const PROVIDER_IDS = [
	"job-board-search",
	// Read in the user's signed-in session: at most every 6 hours (core `LINKEDIN_PACE`).
	"linkedin",
	"indeed",
	"glassdoor",
	// Last: the more specific sources find a job first.
	"web-search",
] as const;
/** Read in the user's browser, or spending AI calls: off until the user turns them on. */
const OFF_BY_DEFAULT: readonly string[] = [
	"linkedin",
	"indeed",
	"glassdoor",
	"web-search",
];
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderState {
	provider: ProviderId;
	enabled: boolean;
	config: Record<string, unknown>;
	lastRunAt: Date | null;
	lastRun: StoredRun | null;
}

/** A run as stored: counts and the problem, not the job ids. */
type StoredRun = Omit<ProviderRun, "newJobIds"> & { newJobs: number };

/** Each provider's settings and last run; a provider never set up is on, with no settings. */
export async function listProviders(
	db: Database,
	userId: string,
): Promise<ProviderState[]> {
	const rows = await db
		.select()
		.from(sourceProviders)
		.where(eq(sourceProviders.userId, userId));
	return PROVIDER_IDS.map((provider) => {
		const row = rows.find((r) => r.provider === provider);
		return {
			provider,
			enabled: row?.enabled ?? !OFF_BY_DEFAULT.includes(provider),
			config: row?.config ?? {},
			lastRunAt: row?.lastRunAt ?? null,
			lastRun: (row?.lastRun as StoredRun | null | undefined) ?? null,
		};
	});
}

export async function updateProvider(
	db: Database,
	userId: string,
	provider: ProviderId,
	input: { enabled?: boolean; config?: Record<string, unknown> },
): Promise<void> {
	const now = new Date();
	await db
		.insert(sourceProviders)
		.values({
			userId,
			provider,
			enabled: input.enabled ?? !OFF_BY_DEFAULT.includes(provider),
			config: input.config ?? {},
		})
		.onConflictDoUpdate({
			target: [sourceProviders.userId, sourceProviders.provider],
			set: {
				...(input.enabled === undefined ? {} : { enabled: input.enabled }),
				...(input.config === undefined ? {} : { config: input.config }),
				updatedAt: now,
			},
		});
}

/** Saves a provider's run (counts, problem; never the postings themselves). */
export async function recordProviderRun(
	db: Database,
	userId: string,
	run: ProviderRun,
	now = new Date(),
): Promise<void> {
	const { newJobIds, ...counts } = run;
	const lastRun: StoredRun = { ...counts, newJobs: newJobIds.length };
	// A run that got through no search keeps the next start where it was.
	if (lastRun.cursor === undefined) {
		const [row] = await db
			.select({ lastRun: sourceProviders.lastRun })
			.from(sourceProviders)
			.where(
				and(
					eq(sourceProviders.userId, userId),
					eq(sourceProviders.provider, run.provider),
				),
			);
		const cursor = (row?.lastRun as StoredRun | null | undefined)?.cursor;
		if (typeof cursor === "number") lastRun.cursor = cursor;
	}
	await db
		.insert(sourceProviders)
		.values({ userId, provider: run.provider, lastRunAt: now, lastRun })
		.onConflictDoUpdate({
			target: [sourceProviders.userId, sourceProviders.provider],
			set: { lastRunAt: now, lastRun, updatedAt: now },
		});
}

/** Where a source's next run starts in its list of searches (0 before any). */
export async function providerCursor(
	db: Database,
	userId: string,
	provider: string,
): Promise<number> {
	const [row] = await db
		.select({ lastRun: sourceProviders.lastRun })
		.from(sourceProviders)
		.where(
			and(
				eq(sourceProviders.userId, userId),
				eq(sourceProviders.provider, provider),
			),
		);
	const cursor = (row?.lastRun as StoredRun | null | undefined)?.cursor;
	return typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0
		? Math.floor(cursor)
		: 0;
}

/** The job-board search provider's view of the database. */
export class SqliteSearchStore implements SearchStore {
	constructor(private readonly db: Database) {}

	async hasPosting(userId: string, source: JobSourceKind, externalId: string) {
		const [row] = await this.db
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.userId, userId),
					eq(jobs.source, source),
					eq(jobs.externalId, externalId),
				),
			)
			.limit(1);
		return Boolean(row);
	}

	/**
	 * The company a found posting belongs to: data on the job, created on first sight with
	 * `discovered_from` "job-board search". Scans never read a company's board by itself.
	 */
	async companyFor(
		userId: string,
		input: { name: string; source: JobSourceKind; sourceKey: string },
	) {
		await this.db
			.insert(companies)
			.values({
				userId,
				name: input.name,
				nameKey: companyNameKey(input.name),
				source: input.source,
				sourceKey: input.sourceKey,
				discoveredFrom: "job-board search",
			})
			.onConflictDoNothing();
		const [row] = await this.db
			.select({ id: companies.id })
			.from(companies)
			.where(
				and(
					eq(companies.userId, userId),
					eq(companies.source, input.source),
					eq(companies.sourceKey, input.sourceKey),
				),
			);
		if (!row) throw new Error("company insert returned nothing");
		return row.id;
	}
}

/** Indeed, Glassdoor and job-board search: the search store, plus the stop a run recorded (in the config). */
export class SqliteSiteStore extends SqliteSearchStore implements SiteStore {
	constructor(private readonly database: Database) {
		super(database);
	}

	async stopped(
		userId: string,
		site: SiteId | ProviderId,
	): Promise<SiteStopRecord | null> {
		const state = (await listProviders(this.database, userId)).find(
			(p) => p.provider === site,
		);
		return (state?.config.stop as SiteStopRecord | undefined) ?? null;
	}

	async stop(
		userId: string,
		site: SiteId | ProviderId,
		stop: SiteStopRecord,
	): Promise<void> {
		const state = (await listProviders(this.database, userId)).find(
			(p) => p.provider === site,
		);
		await updateProvider(this.database, userId, site, {
			config: { ...(state?.config ?? {}), stop },
		});
	}

	/** A run read the site again: its transient stop is over (the run's note stays). */
	async clearStop(userId: string, site: SiteId | ProviderId): Promise<void> {
		const state = (await listProviders(this.database, userId)).find(
			(p) => p.provider === site,
		);
		if (!state?.config.stop) return;
		const { stop: _over, ...config } = state.config;
		await updateProvider(this.database, userId, site, { config });
	}
}

/**
 * Job-board search's settings from versions that searched through Brave Search or a SearXNG
 * server: the search is DuckDuckGo now, with nothing to set up, so the old choice is dropped
 * (whether the source is on stays as the user left it). Returns the rows changed.
 */
export async function retireSearchBackends(db: Database): Promise<number> {
	const rows = await db
		.select()
		.from(sourceProviders)
		.where(eq(sourceProviders.provider, "job-board-search"));
	let changed = 0;
	for (const row of rows) {
		const config = (row.config ?? {}) as Record<string, unknown>;
		if (!("backend" in config) && !("searxngUrl" in config)) continue;
		const { backend: _b, searxngUrl: _u, ...rest } = config;
		await db
			.update(sourceProviders)
			.set({ config: rest, updatedAt: new Date() })
			.where(
				and(
					eq(sourceProviders.userId, row.userId),
					eq(sourceProviders.provider, row.provider),
				),
			);
		changed++;
	}
	return changed;
}

/** The user cleared a site's stop: the next scan may read it again. */
export async function clearProviderStop(
	db: Database,
	userId: string,
	provider: ProviderId,
): Promise<void> {
	const state = (await listProviders(db, userId)).find(
		(p) => p.provider === provider,
	);
	if (!state?.config.stop) return;
	const { stop: _cleared, ...config } = state.config;
	await updateProvider(db, userId, provider, { config });
	// The stopped run's note goes with it: the source reads as not run until the next scan.
	await db
		.update(sourceProviders)
		.set({ lastRun: null, lastRunAt: null })
		.where(
			and(
				eq(sourceProviders.userId, userId),
				eq(sourceProviders.provider, provider),
			),
		);
}

/**
 * Web search's view of the database: the site store (its stop) and whether a found posting is a
 * job stored already from any source.
 */
export class SqliteWebStore extends SqliteSiteStore implements WebSearchStore {
	constructor(private readonly web: Database) {
		super(web);
	}

	async isDuplicate(
		userId: string,
		job: { urls: string[]; company: string; title: string },
	): Promise<boolean> {
		const nameKey = companyNameKey(job.company);
		const removed = await this.web
			.select({ id: companies.id })
			.from(companies)
			.where(
				and(
					eq(companies.userId, userId),
					eq(companies.nameKey, nameKey),
					eq(companies.status, "removed"),
				),
			)
			.limit(1);
		if (nameKey && removed.length > 0) return true;
		const urls = new Set(job.urls.map(normalizeUrl));
		const rows = await this.web
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
						nameKey ? eq(companies.nameKey, nameKey) : undefined,
						inArray(jobs.urlNormalized, [...urls]),
						isNotNull(jobs.applyUrl),
					),
				),
			);
		const title = titleKey(job.title);
		return rows.some(
			(r) =>
				(r.urlNormalized !== null && urls.has(r.urlNormalized)) ||
				(r.applyUrl !== null && urls.has(normalizeUrl(r.applyUrl))) ||
				(Boolean(nameKey) &&
					r.nameKey === nameKey &&
					titleKey(r.title) === title),
		);
	}
}
