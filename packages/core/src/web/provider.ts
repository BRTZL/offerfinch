import type { NormalizedJob } from "../domain/types";
import { companyNameKey, normalizeUrl } from "../domain/url";
import type { PipelineDeps } from "../pipeline/ports";
import {
	NO_SEARCHES,
	nameFromKey,
	type ProviderRun,
	type ScanProvider,
	type SearchStore,
	searchesFor,
} from "../pipeline/providers";
import { meteredFor } from "../scoring/metered";
import { extractPostingWithLlm } from "../scrape/llm-extract";
import { runStart, webQueries } from "../search/adapt";
import type { PlanResult } from "../search/plan";
import type { SiteReader } from "../sites/provider";
import { detectAnySiteCheck, type SitePage } from "../sites/read";
import { DropLog } from "../sites/report";
import {
	clock,
	isHeldStop,
	retryDue,
	type StopStore,
	stopRecord,
} from "../sites/stops";
import { type SearchBackend, SearchBackendError } from "../sources/search";
import { coveredByOtherSource, readableResult, siteKey } from "./hosts";
import { cleanQueries, MAX_WEB_QUERIES } from "./queries";
import { structuredPostings, workplaceFrom } from "./structured";

export interface WebSearchStore extends SearchStore, StopStore {
	/**
	 * The same job is stored already from any source: one of `urls` is a stored job's URL or apply
	 * link, or the company has a job with this title; or the user removed the company.
	 */
	isDuplicate(
		userId: string,
		job: { urls: string[]; company: string; title: string },
	): Promise<boolean>;
}

export interface WebSearchOptions {
	/** Searches a scan makes at most. */
	queries: number;
	/** Results read from one search at most. */
	perQuery: number;
	/** Result pages a scan opens at most, and from one site at most. */
	pages: number;
	perSite: number;
	/** Pages the model reads (no structured data) at most, every attempt counted. */
	aiExtractions: number;
	/** The pause before every result page but the first. */
	gapSeconds: [number, number];
	sleep: (ms: number) => Promise<void>;
	random: () => number;
	now: () => Date;
	/** Which result URLs may be opened (default: public http(s) pages no other source covers). */
	allowUrl: (url: string) => boolean;
}

const DEFAULT_WEB_OPTIONS: Omit<
	WebSearchOptions,
	"sleep" | "random" | "now" | "allowUrl"
> = {
	queries: MAX_WEB_QUERIES,
	perQuery: 10,
	pages: 50,
	perSite: 3,
	aiExtractions: 15,
	gapSeconds: [10, 25],
};

/**
 * A title that names jobs in the plural is a list page's heading (seen on the live web: an
 * aggregator's "Remote Frontend Developer Jobs in Europe" read as one posting).
 */
export const LIST_TITLE =
	/\b(?:jobs|vacancies|openings|open positions|job offers|careers at)\b/i;

/** Redirects one result may go through, each authorized before it is followed. */
const MAX_REDIRECTS = 5;

/** The provider's id, and the row its stop and queries are kept in. */
export const WEB_SEARCH_ID = "web-search";

/** A found posting before it is stored. */
interface Posting {
	title: string;
	company: string;
	locations: string[];
	workplaceType: NormalizedJob["workplaceType"];
	employmentType?: string;
	datePosted?: Date;
	validThrough?: Date;
	description: string;
	url?: string;
}

/** When a posting was posted and, when its page says, when it ends (closed after that). */
const postingDates = (posting: Posting) => ({
	publishedAt: posting.datePosted,
	validThrough: posting.validThrough,
});

/**
 * Web search (PLAN A): job postings anywhere on the web, found with DuckDuckGo (the app's
 * DuckDuckGo tab, shared with job-board search) and read from the pages themselves (the app's web
 * tab), read only and at a human pace. A page's schema.org JobPosting data is read as it is; a
 * page without it is read by the drafting model (metered, at most `aiExtractions` a scan), which
 * picks the posting's lines and fields but writes none of them. Lists, articles and search pages
 * are not postings; expired postings, sites other sources read and jobs already stored from any
 * source are skipped. Jobs are handed off: the user applies on the employer's site.
 *
 * Bounded per scan (searches, pages, pages per site, model reads). A DuckDuckGo check holds the
 * source (shared with job-board search) until the user clears it; a refusal backs off. A result
 * page with a check is skipped, never waited on. robots.txt is honoured for every result page.
 */
export class WebSearchProvider implements ScanProvider {
	readonly id = WEB_SEARCH_ID;
	readonly label = "Web search";
	/**
	 * 8 searches (20 s gaps, 75 s each), 50 pages (25 s gaps, 75 s each, robots.txt), 15 model
	 * reads and the 20-minute budget for a DuckDuckGo check the user solves: under 150 minutes.
	 */
	readonly timeoutSeconds = 9_000;
	private readonly options: WebSearchOptions;

	constructor(
		private readonly backend: SearchBackend,
		private readonly openPages: (signal?: AbortSignal) => Promise<SiteReader>,
		private readonly store: WebSearchStore,
		private readonly robotsAllow: (url: string) => Promise<boolean>,
		options: Partial<WebSearchOptions> &
			Pick<WebSearchOptions, "sleep" | "random">,
	) {
		this.options = {
			...DEFAULT_WEB_OPTIONS,
			now: () => new Date(),
			allowUrl: readableResult,
			...options,
		};
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
		const o = this.options;
		const stopped = await this.store.stopped(userId, this.id);
		if (stopped && (isHeldStop(stopped) || !retryDue(stopped, o.now()))) {
			out.problem = isHeldStop(stopped)
				? `Stopped: ${stopped.reason}. Clear it in Settings › Sources to search again.`
				: `Paused after: ${stopped.reason}. Tries again with the first scan after ${clock(stopped.retryAt as string)}.`;
			return out;
		}
		const notes: string[] = [];
		const { settings, searches } = await searchesFor(deps, userId, plan);
		const start = runStart(cursor, o.now(), o.queries);
		const queries = cleanQueries(
			webQueries(searches, settings.livesIn, o.queries, start),
			o.queries,
		);
		if (queries.length === 0) {
			out.problem = NO_SEARCHES;
			return out;
		}

		out.searches = queries;
		out.results = 0;
		out.duplicates = 0;
		out.pagesRead = 0;
		const drops = new DropLog();
		// 1. The searches: result URLs on sites no other source covers, each once.
		const candidates: string[] = [];
		const seen = new Set<string>();
		try {
			for (const query of queries) {
				signal?.throwIfAborted();
				deps.scanProgress?.(userId, {
					source: this.id,
					label: this.label,
					query,
				});
				const hits = await this.backend.search(query, o.perQuery, signal);
				out.queries++;
				for (const hit of hits) {
					const key = normalizeUrl(hit.url);
					if (seen.has(key)) continue;
					seen.add(key);
					out.results++;
					if (!o.allowUrl(hit.url)) {
						drops.add("other", {
							title: coveredByOtherSource(hit.url)
								? "read by another source"
								: "not a public web page",
							url: hit.url,
						});
						continue;
					}
					if (await this.store.hasPosting(userId, "web", key)) {
						out.duplicates++;
						continue;
					}
					candidates.push(hit.url);
				}
			}
		} catch (error) {
			if (!(error instanceof SearchBackendError)) throw error;
			if (error.stop) {
				const record = stopRecord(error.stop, stopped, o.now());
				await this.store.stop(userId, this.id, record);
				out.problem = isHeldStop(record)
					? `Stopped: ${record.reason}, not solved in time. Clear it in Settings › Sources to search again.`
					: `Paused after: ${record.reason}. Tries again with the first scan after ${clock(record.retryAt as string)}.`;
			} else out.problem = error.message;
			return out;
		} finally {
			await this.backend.close?.();
		}
		if (stopped) await this.store.clearStop(userId, this.id);

		// 2. The pages: read only, a pause between them, a few per site.
		const perSite = new Map<string, number>();
		let pages = 0;
		let aiUsed = 0;
		let aiOff = false;
		let aiCapped = false;
		const reader = candidates.length ? await this.openPages(signal) : null;
		try {
			for (const url of candidates) {
				if (pages >= o.pages) {
					notes.push(`page cap of ${o.pages} reached`);
					break;
				}
				const site = siteKey(url);
				if ((perSite.get(site) ?? 0) >= o.perSite) continue;
				signal?.throwIfAborted();
				if (!(await this.robotsAllow(url).catch(() => false))) {
					drops.add("other", { title: "robots.txt refuses it", url });
					continue;
				}
				if (pages > 0) {
					const [min, max] = o.gapSeconds;
					await o.sleep(Math.round((min + (max - min) * o.random()) * 1000));
					signal?.throwIfAborted();
				}
				pages++;
				out.pagesRead = pages;
				perSite.set(site, (perSite.get(site) ?? 0) + 1);
				// Sites this result has a page reserved on (a redirect's destination reserves its own).
				const reserved = new Set([site]);
				// The tab follows no redirect: each one comes back here, and is opened only once it
				// is authorized (a site web search reads, robots.txt's leave, a page left on its site).
				let current = url;
				let page: SitePage | null = null;
				let refusedHop: string | null = null;
				const visited = new Set([normalizeUrl(url)]);
				for (let hop = 0; ; hop++) {
					page = await (reader as SiteReader).open(current).catch(() => null);
					const target = page?.redirect;
					if (!target) break;
					// To itself, or back to a page of this chain: a loop, never followed.
					if (visited.has(normalizeUrl(target))) {
						refusedHop = "it redirects to itself";
						break;
					}
					visited.add(normalizeUrl(target));
					refusedHop = await this.authorizeRedirect(target, hop, {
						reserved,
						perSite,
						pages,
					});
					if (refusedHop) break;
					pages++;
					out.pagesRead = pages;
					current = target;
				}
				if (refusedHop) {
					drops.add("other", { title: refusedHop, url: page?.redirect ?? url });
					continue;
				}
				if (page?.refused) {
					// Never parsed or kept: the browser stopped it at a private address.
					drops.add("other", { title: `refused: ${page.refused}`, url });
					continue;
				}
				if (!page || !this.readable(page)) {
					drops.add("other", { title: "the page could not be read", url });
					continue;
				}
				// A reader that followed redirects by itself: every hop and where the load ended are
				// held to the same rules afterwards (and the page is not read if one fails).
				const hops = [...(page.redirects ?? []), page.url].filter(
					(h) => normalizeUrl(h) !== normalizeUrl(current),
				);
				for (const hop of hops) {
					if (!o.allowUrl(hop))
						refusedHop = "redirected to a site it may not read";
					else if (!(await this.robotsAllow(hop).catch(() => false)))
						refusedHop = "robots.txt refuses where it redirected";
					if (refusedHop) break;
				}
				if (refusedHop) {
					drops.add("other", { title: refusedHop, url: page.url });
					continue;
				}
				const destination = siteKey(page.url);
				if (!reserved.has(destination)) {
					if ((perSite.get(destination) ?? 0) >= o.perSite) {
						drops.add("other", {
							title: "the site's page limit was reached (after a redirect)",
							url: page.url,
						});
						continue;
					}
					perSite.set(destination, (perSite.get(destination) ?? 0) + 1);
				}
				let posting: Posting | null = null;
				let structured: ReturnType<typeof structuredPostings>;
				try {
					structured = structuredPostings(page.html);
				} catch {
					// One malformed page never ends the scan.
					drops.add("other", {
						title: "the page's job data could not be read",
						url,
					});
					continue;
				}
				// Several postings on one page: a list (search results, a careers index), not one job.
				if (structured.length > 1) {
					drops.add("not_a_job", { title: "a list of jobs", url });
					continue;
				}
				if (structured.length === 1) posting = structured[0] as Posting;
				else if (!aiOff && aiUsed >= o.aiExtractions) aiCapped = true;
				else if (!aiOff) {
					aiUsed++;
					try {
						const ai = await extractPostingWithLlm(
							draftingModel(deps, userId),
							page.html,
							page.url,
						);
						if (ai)
							posting = {
								title: ai.title,
								company: ai.company,
								locations: ai.location ? [ai.location] : [],
								workplaceType: workplaceFrom(`${ai.location} ${ai.title}`),
								description: ai.description,
							};
					} catch (error) {
						// The model is not available now: the rest of this scan reads structured data only.
						aiOff = true;
						notes.push(
							`pages without job data were not read (${message(error)})`,
						);
					}
				}
				if (!posting) {
					drops.add("not_a_job", { title: "not a job posting", url });
					continue;
				}
				// "Remote Frontend Developer Jobs in Europe": a list's heading, not one job's title.
				if (LIST_TITLE.test(posting.title)) {
					drops.add("not_a_job", { title: posting.title, url });
					continue;
				}
				if (posting.validThrough && posting.validThrough < o.now()) {
					drops.add("expired", {
						title: posting.title,
						company: posting.company,
						url,
					});
					continue;
				}
				out.found++;
				const company =
					posting.company ||
					nameFromKey(site.split(".").slice(-2, -1)[0] ?? site);
				const urls = [page.url, url, ...(posting.url ? [posting.url] : [])];
				if (
					await this.store.isDuplicate(userId, {
						urls,
						company,
						title: posting.title,
					})
				) {
					out.duplicates++;
					continue;
				}
				const externalId = normalizeUrl(page.url);
				const job: NormalizedJob = {
					source: "web",
					externalId,
					url: page.url,
					title: posting.title,
					locations: posting.locations,
					workplaceType: posting.workplaceType,
					employmentType: posting.employmentType,
					descriptionText: posting.description,
					...postingDates(posting),
					companyName: company,
				};
				const companyId = await this.store.companyFor(userId, {
					name: company,
					source: "web",
					sourceKey: `web:${companyNameKey(company) || site}`,
				});
				const { jobId, inserted } = await deps.repo.upsertJob(
					userId,
					companyId,
					job,
				);
				out.fetched++;
				if (inserted) out.newJobIds.push(jobId);
			}
		} finally {
			await reader?.close();
		}
		out.dropped = drops.report();
		if (aiCapped) notes.push(`AI read cap of ${o.aiExtractions} reached`);
		return withNotes({ ...out, cursor: start + queries.length }, notes);
	}

	/**
	 * Whether a redirect may be followed, decided before its page is requested: at most
	 * MAX_REDIRECTS, to a site web search reads, allowed by that site's robots.txt, within the
	 * scan's page cap, and with a page left on the destination site, which is reserved now. Null
	 * when it may; else why not.
	 */
	private async authorizeRedirect(
		target: string,
		hop: number,
		state: {
			reserved: Set<string>;
			perSite: Map<string, number>;
			pages: number;
		},
	): Promise<string | null> {
		const o = this.options;
		if (hop >= MAX_REDIRECTS) return "too many redirects";
		if (!o.allowUrl(target)) return "redirected to a site it may not read";
		if (!(await this.robotsAllow(target).catch(() => false)))
			return "robots.txt refuses where it redirected";
		if (state.pages >= o.pages) return `page cap of ${o.pages} reached`;
		const destination = siteKey(target);
		if (!state.reserved.has(destination)) {
			if ((state.perSite.get(destination) ?? 0) >= o.perSite)
				return "the site's page limit was reached (after a redirect)";
			state.perSite.set(destination, (state.perSite.get(destination) ?? 0) + 1);
			state.reserved.add(destination);
		}
		return null;
	}

	/** A result page worth reading: loaded, still on a site web search reads, no check on it. */
	private readable(page: SitePage): boolean {
		if (page.status !== null && page.status >= 400) return false;
		if (!this.options.allowUrl(page.url)) return false;
		return detectAnySiteCheck(page) === null;
	}
}

/** Notes (a cap reached, no model now) are the run's problem line; the source ran, no error. */
function withNotes(out: ProviderRun, notes: string[]): ProviderRun {
	if (notes.length === 0) return out;
	return { ...out, problem: notes.join("; "), status: "ok" };
}

/** The drafting model for the user, metered like every call (llm_usage, the spending cap). */
function draftingModel(deps: PipelineDeps, userId: string) {
	return meteredFor(deps.tailorLlm ?? deps.llm, deps.spend, userId, null);
}

function message(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}
