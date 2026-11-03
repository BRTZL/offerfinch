import type {
	JobSourceKind,
	NormalizedJob,
	WorkplaceType,
} from "../domain/types";
import type { PipelineDeps } from "../pipeline/ports";
import {
	NO_SEARCHES,
	type ProviderRun,
	type ScanProvider,
	type SearchStore,
	searchesFor,
} from "../pipeline/providers";
import { runStart, siteSearch } from "../search/adapt";
import { type PlanResult, rotate } from "../search/plan";
import {
	detectSiteStop,
	readJobPage,
	readSearchPage,
	type SitePage,
	type SiteStop,
} from "./read";
import type { SiteConfig, SiteId } from "./sites";
import {
	clock,
	isHeldStop,
	retryDue,
	type SiteStopRecord,
	stopRecord,
} from "./stops";

export {
	isHeldStop,
	retryDue,
	type SiteStopRecord,
	stopRecord,
} from "./stops";

/** The user's local browser, one page at a time. Opening only: nothing is clicked or typed. */
export interface SiteReader {
	open(url: string): Promise<SitePage>;
	close(): Promise<void>;
}

export interface SiteStore extends SearchStore {
	/** The stop a run recorded: held until cleared, or transient until its retry. */
	stopped(userId: string, site: SiteId): Promise<SiteStopRecord | null>;
	stop(userId: string, site: SiteId, stop: SiteStopRecord): Promise<void>;
	/** A run read the site again without a stop: the transient stop is over. */
	clearStop(userId: string, site: SiteId): Promise<void>;
}

export interface SiteOptions {
	/** Pages a run opens at most (searches and job pages together). */
	pages: number;
	/** Searches a run makes at most, from the shared plan (later scans take the next ones). */
	searches: number;
	/** New jobs a search's results are read for at most. */
	perSearch: number;
	/** The pause before every page but the first, chosen in this range. */
	gapSeconds: [number, number];
	sleep: (ms: number) => Promise<void>;
	random: () => number;
	/** Test runs only: the site's pages served elsewhere (a local stand-in). */
	origin?: string;
	/** The page a run stopped on (not a check or sign-in): kept locally for diagnosis. */
	debug?: (page: SitePage, stop: SiteStop) => Promise<void>;
	now?: () => Date;
}

export const DEFAULT_SITE_OPTIONS: Omit<SiteOptions, "sleep" | "random"> = {
	pages: 8,
	searches: 2,
	perSearch: 3,
	gapSeconds: [20, 60],
};

/** The promise, or the abort's reason as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

class Stopped extends Error {
	constructor(
		readonly stop: SiteStop,
		readonly page: SitePage | null = null,
	) {
		super(stop.reason);
	}
}

function workplace(location: string): WorkplaceType {
	if (/\bremote\b/i.test(location)) return "remote";
	if (/\bhybrid\b/i.test(location)) return "hybrid";
	return "unknown";
}

/**
 * Indeed or Glassdoor search for the user's titles, read in their browser at a human pace under
 * a small page cap. Any sign-in wall, CAPTCHA, check, refusal, unexpected page or missing
 * selector stops the run and is recorded. A check or sign-in holds the source until the user
 * clears it; anything else is retried by a later scan, with backoff (see `stopRecord`). Jobs
 * from these sites are always handed off: the user applies on the site, nothing is filled or sent.
 */
export class SiteSearchProvider implements ScanProvider {
	readonly id: SiteId;
	readonly label: string;
	/**
	 * The scan step's limit. At most 8 pages: gaps of up to 60 s (8 min), each page up to 75 s
	 * to load and render (10 min), plus the reader's whole budget for checks the user solves
	 * (20 min in the desktop app, shared by every page of the run): under 40 minutes. If the
	 * step still runs out, `signal` stops the run and its tab is let go before any retry.
	 */
	readonly timeoutSeconds = 3_600;
	private readonly options: SiteOptions;

	constructor(
		private readonly site: SiteConfig,
		private readonly openReader: (signal?: AbortSignal) => Promise<SiteReader>,
		private readonly store: SiteStore,
		options: Partial<SiteOptions> & Pick<SiteOptions, "sleep" | "random">,
	) {
		this.id = site.id;
		this.label = site.label;
		this.options = { ...DEFAULT_SITE_OPTIONS, ...options };
	}

	async run(
		deps: PipelineDeps,
		userId: string,
		signal?: AbortSignal,
		plan?: PlanResult,
		cursor?: number,
	): Promise<ProviderRun> {
		const out: ProviderRun = {
			provider: this.id,
			queries: 0,
			found: 0,
			fetched: 0,
			newJobIds: [],
		};
		const now = () => this.options.now?.() ?? new Date();
		const stopped = await this.store.stopped(userId, this.id);
		if (stopped && isHeldStop(stopped)) {
			out.problem = `Stopped: ${stopped.reason}. Clear it in Settings › Sources to run again.`;
			return out;
		}
		if (stopped && !retryDue(stopped, now())) {
			out.problem = `Paused after: ${stopped.reason}. Tries again with the first scan after ${clock(stopped.retryAt as string)}.`;
			return out;
		}
		const { settings, searches: planned } = await searchesFor(
			deps,
			userId,
			plan,
		);
		if (planned.length === 0) {
			out.problem = NO_SEARCHES;
			return out;
		}
		const standIn = Boolean(this.options.origin);
		const base = this.options.origin ?? this.site.origin;
		// Regional hosts of the site (tr.indeed.com) count as the site.
		const host = new URL(base).host;
		const start = runStart(cursor, now(), this.options.searches);
		const searches = rotate(planned, start, this.options.searches).map((s) =>
			siteSearch(this.id, s, settings.livesIn, base, standIn),
		);
		out.searches = searches.map((s) => s.label);
		out.pagesRead = 0;
		out.results = 0;
		out.duplicates = 0;
		const source = this.id as JobSourceKind;
		const o = this.options;
		let pages = 0;
		const visit = async (url: string): Promise<SitePage | null> => {
			if (pages >= o.pages) return null;
			signal?.throwIfAborted();
			if (pages > 0) {
				const [min, max] = o.gapSeconds;
				await abortable(
					o.sleep(Math.round((min + (max - min) * o.random()) * 1000)),
					signal,
				);
			}
			pages++;
			out.pagesRead = pages;
			const page = await reader.open(url);
			signal?.throwIfAborted();
			const stop = detectSiteStop(page, this.site, host);
			if (stop) throw new Stopped(stop, page);
			return page;
		};

		signal?.throwIfAborted();
		const reader = await this.openReader(signal);
		try {
			reading: for (const search of searches) {
				deps.scanProgress?.(userId, {
					source: this.id,
					label: this.label,
					query: search.label,
				});
				const page = await visit(
					this.site.searchUrl(search.origin, search.query, search.location),
				);
				if (!page) break;
				out.queries++;
				const read = readSearchPage(page.html, this.site);
				if ("stop" in read) throw new Stopped(read.stop, page);
				let opened = 0;
				out.results = (out.results ?? 0) + read.cards.length;
				for (const card of read.cards) {
					if (opened >= o.perSearch) break;
					if (await this.store.hasPosting(userId, source, card.jobId)) {
						out.duplicates = (out.duplicates ?? 0) + 1;
						continue;
					}
					out.found++;
					const jobPage = await visit(
						this.site.jobUrl(search.origin, card.jobId),
					);
					if (!jobPage) {
						out.problem = `Page cap of ${o.pages} reached; the rest waits for the next scan`;
						out.status = "ok";
						break reading;
					}
					opened++;
					const job = readJobPage(jobPage.html, this.site);
					if ("stop" in job) throw new Stopped(job.stop, jobPage);
					const normalized: NormalizedJob = {
						source,
						externalId: card.jobId,
						// A stand-in's pages are stored as the site's own.
						url: this.site.jobUrl(
							standIn ? this.site.origin : search.origin,
							card.jobId,
						),
						title: job.title || card.title,
						locations: card.location ? [card.location] : [],
						workplaceType: workplace(card.location),
						descriptionText: job.description,
						companyName: card.company,
					};
					const companyId = await this.store.companyFor(userId, {
						name: card.company,
						source,
						sourceKey: card.company.toLowerCase().replace(/\s+/g, "-"),
					});
					const { jobId, inserted } = await deps.repo.upsertJob(
						userId,
						companyId,
						normalized,
					);
					out.fetched++;
					if (inserted) out.newJobIds.push(jobId);
				}
			}
			// Read to the end: a transient stop before this run is over.
			if (stopped) await this.store.clearStop(userId, this.id);
		} catch (error) {
			if (!(error instanceof Stopped)) throw error;
			const record = stopRecord(error.stop, stopped, now());
			await this.store.stop(userId, this.id, record);
			if (error.page && !isHeldStop(error.stop))
				await this.options.debug?.(error.page, error.stop).catch(() => {});
			out.problem = isHeldStop(error.stop)
				? `Stopped: ${error.stop.reason}. Nothing more is read until you clear it in Settings › Sources.`
				: `Paused after: ${error.stop.reason}. Tries again with the first scan after ${clock(record.retryAt as string)}.`;
		} finally {
			await reader.close();
		}
		// The searches whose result page was read are done; a stop before the first keeps the start.
		if (out.queries > 0) out.cursor = start + out.queries;
		return out;
	}
}
