import type {
	JobSourceKind,
	NormalizedJob,
	WorkplaceType,
} from "../domain/types";
import { companyNameKey } from "../domain/url";
import type { PipelineDeps } from "../pipeline/ports";
import {
	NO_SEARCHES,
	type ProviderRun,
	type ScanProvider,
	searchesFor,
} from "../pipeline/providers";
import { feedKeywordsMatch, feedWhereMatch } from "../search/adapt";
import {
	describeSearch,
	type PlanResult,
	type PlanSearch,
} from "../search/plan";
import { DropLog } from "../sites/report";
import {
	clock,
	retryDue,
	type SiteStopRecord,
	stopRecord,
} from "../sites/stops";
import type { FetchLike } from "../sources/types";
import type { WebSearchStore } from "../web/provider";
import { type FeedFetch, FeedReadError, feedFetcher } from "./http";

/**
 * Remote-job feeds (Remotive, Remote OK, We Work Remotely, Hacker News "Who is hiring?"): public
 * APIs and RSS read with plain GETs, no browser and no sign-in. Each is read whole at most every
 * 6 hours (Remotive asks for at most 4 requests a day; the others are held to the same pace) and
 * kept here when one of the shared search plan's searches finds them (no rule sets a job aside:
 * the fit score judges place and work rights), at most 25 new ones a read: every stored job is
 * scored by a model. Jobs link back to
 * the feed's own page, which names the feed (their terms ask for it), and are handed off.
 */

/** A posting as a feed gives it, before the plan and the dedupe. */
export interface FeedPosting {
	externalId: string;
	/** The posting on the feed's own site: the link back its terms ask for. */
	url: string;
	title: string;
	company: string;
	locations: string[];
	workplaceType: WorkplaceType;
	descriptionText: string;
	/** The feed's tags or categories, matched like the title's words. */
	tags?: string[];
	employmentType?: string;
	publishedAt?: Date;
	/** We Work Remotely: past this the posting is closed. */
	expiresAt?: Date;
	/** The employer's own link, when the feed gives one (HN comments). */
	applyUrl?: string;
}

/** One feed: its provider id and label, the source its jobs carry, and how a read goes. */
export interface Feed {
	readonly id: string;
	readonly label: string;
	readonly source: JobSourceKind;
	read(
		fetchFeed: FeedFetch,
		signal: AbortSignal | undefined,
		now: Date,
	): Promise<{ postings: FeedPosting[]; requests: number; skipped?: number }>;
}

/**
 * How often a feed is read, fixed in code: at most once every 6 hours and 4 times in any 24 hours,
 * whatever the scans do (hourly, Scan now, Retry now), counted from reads recorded before each
 * request, so a crash or a step retry never makes a second request early.
 */
export const FEED_PACE = { everyHours: 6, readsPerDay: 4 } as const;
/** New postings stored per feed per read at most (the newest first); the rest wait. */
export const FEED_NEW_CAP = 25;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** What a feed posting is matched on against the jobs the app has. */
export interface FeedDuplicateQuery {
	/** Its feed page, and the employer's link when the feed gives one. */
	urls: string[];
	applyUrl?: string;
	company: string;
	title: string;
	workplaceType: WorkplaceType;
	locations: string[];
}

/**
 * The feed provider's view of the database: web search's posting, company and stop store, its
 * own duplicate check, and its reads.
 */
export interface FeedStore extends Omit<WebSearchStore, "isDuplicate"> {
	/**
	 * The same job is stored already: a stored job's URL or apply link is one of `urls`; or the
	 * company and title match, both postings are remote or name no place, the stored one is not
	 * closed, and the two don't name different apply links. Or the user removed the company.
	 */
	sameJobStored(userId: string, posting: FeedDuplicateQuery): Promise<boolean>;
	/** When the feed was read in the last 24 hours (or more), oldest first. */
	reads(userId: string, feed: string): Promise<Date[]>;
	/** Records a read, before its request is made. */
	markRead(userId: string, feed: string, at: Date): Promise<void>;
}

/**
 * When a feed may be read next, from its recorded reads. A read recorded in the future (the clock
 * was set back) is ignored: kept, it would hold the feed a pace past "now" on every scan, a wait
 * that slides forward and never ends. The next read records the clock's time again.
 */
export function nextFeedRead(reads: Date[], now: Date): Date {
	const past = reads.filter((r) => r.getTime() <= now.getTime());
	const recent = past
		.filter((r) => now.getTime() - r.getTime() < DAY_MS)
		.sort((a, b) => a.getTime() - b.getTime());
	const last = past.reduce<Date | null>((m, r) => (!m || r > m ? r : m), null);
	let at = last
		? new Date(last.getTime() + FEED_PACE.everyHours * HOUR_MS)
		: now;
	if (recent.length >= FEED_PACE.readsPerDay) {
		// The read that frees a slot: the oldest one still in the window.
		const frees = new Date(
			(recent[recent.length - FEED_PACE.readsPerDay] as Date).getTime() +
				DAY_MS,
		);
		if (frees > at) at = frees;
	}
	return at > now ? at : now;
}

/** "~4 h", "~35 min". */
function inAbout(ms: number): string {
	if (ms < HOUR_MS) return `~${Math.max(1, Math.round(ms / 60_000))} min`;
	return `~${Math.round(ms / HOUR_MS)} h`;
}

export interface FeedProviderOptions {
	now: () => Date;
	cap: number;
}

export class FeedProvider implements ScanProvider {
	readonly id: string;
	readonly label: string;
	/** One or two GETs of 30 s at most, then the database: well under the default. */
	readonly timeoutSeconds = 300;
	private readonly fetchFeed: FeedFetch;
	private readonly options: FeedProviderOptions;

	constructor(
		private readonly feed: Feed,
		private readonly store: FeedStore,
		fetchImpl: FetchLike,
		options: Partial<FeedProviderOptions> = {},
	) {
		this.id = feed.id;
		this.label = feed.label;
		this.fetchFeed = feedFetcher(fetchImpl);
		this.options = { now: () => new Date(), cap: FEED_NEW_CAP, ...options };
	}

	/**
	 * A read: not before its pace allows (the scan records "Not due" with the next read), the read
	 * recorded first, then one or two GETs. A refusal or a check page where the feed should be is
	 * a stop that backs off (1 hour, 2, 4 ... a day); a network or server error is the run's
	 * problem. Nothing is thrown for either, so a step retry never repeats the request.
	 */
	async run(
		deps: PipelineDeps,
		userId: string,
		signal?: AbortSignal,
		plan?: PlanResult,
	): Promise<ProviderRun> {
		const now = this.options.now();
		const out: ProviderRun = {
			provider: this.id,
			queries: 0,
			found: 0,
			fetched: 0,
			newJobIds: [],
		};
		const stopped = await this.store.stopped(userId, this.id);
		if (stopped && !retryDue(stopped, now)) {
			out.problem = `Paused after: ${stopped.reason}. Tries again with the first scan after ${clock(stopped.retryAt ?? now.toISOString())}.`;
			return out;
		}
		const next = nextFeedRead(await this.store.reads(userId, this.id), now);
		if (next > now) {
			out.status = "waiting";
			out.retryAt = next.toISOString();
			out.problem = `Next ${this.label} read in ${inAbout(next.getTime() - now.getTime())}.`;
			return out;
		}
		const { searches } = await searchesFor(deps, userId, plan);
		if (searches.length === 0) {
			out.problem = NO_SEARCHES;
			return out;
		}
		deps.scanProgress?.(userId, { source: this.id, label: this.label });
		await this.store.markRead(userId, this.id, now);
		let postings: FeedPosting[];
		let skipped = 0;
		try {
			const read = await this.feed.read(this.fetchFeed, signal, now);
			postings = read.postings;
			skipped = read.skipped ?? 0;
			out.pagesRead = read.requests;
		} catch (error) {
			signal?.throwIfAborted();
			out.problem = await this.failed(userId, error, stopped, now);
			return out;
		}
		if (stopped) await this.store.clearStop(userId, this.id);
		// Counted once the feed was read: a failed read searched nothing.
		out.queries = searches.length;
		out.searches = searches.map(describeSearch);
		out.results = postings.length;
		out.fetched = postings.length;
		const drops = new DropLog();
		const kept = plausible(postings, searches, now, drops);
		const waiting = await this.save(deps, userId, kept, out, signal);
		out.dropped = drops.report();
		// Notes, not failures: the source ran (as web search's caps).
		const notes = [
			waiting > 0
				? `Cap of ${this.options.cap} new postings a read reached; ${waiting} more wait for the next read`
				: "",
			skipped > 0
				? `${skipped} ${skipped === 1 ? "item" : "items"} in the feed could not be read and ${skipped === 1 ? "was" : "were"} skipped`
				: "",
		].filter(Boolean);
		if (notes.length > 0) {
			out.problem = notes.join("; ");
			out.status = "ok";
		}
		return out;
	}

	/** The run's problem for a failed read; a refusal or a check page is kept as a stop. */
	private async failed(
		userId: string,
		error: unknown,
		stopped: SiteStopRecord | null,
		now: Date,
	): Promise<string> {
		if (error instanceof SyntaxError)
			return "The feed could not be read (not the format it publishes).";
		const message = (
			error instanceof Error ? error.message : String(error)
		).slice(0, 200);
		if (!(error instanceof FeedReadError && error.refused))
			return `Could not read the feed: ${message}.`;
		const backoff = stopRecord(
			{ kind: "blocked", reason: message },
			stopped,
			now,
		);
		// Never before the pace allows the next read (this one counted): a retry time the pace
		// overrules would show a stale stop and offer a Retry now that can't read.
		const paced = nextFeedRead(await this.store.reads(userId, this.id), now);
		const record =
			backoff.retryAt && new Date(backoff.retryAt) >= paced
				? backoff
				: { ...backoff, retryAt: paced.toISOString() };
		await this.store.stop(userId, this.id, record);
		return `Paused after: ${record.reason}. Tries again with the first scan after ${clock(record.retryAt ?? now.toISOString())}.`;
	}

	/**
	 * Stores the plausible postings not already in the app (by this feed's id, a stored job's URL
	 * or apply link, or the company and title from any source), at most `cap`. Returns how many
	 * new ones were left for the next read.
	 */
	private async save(
		deps: PipelineDeps,
		userId: string,
		kept: FeedPosting[],
		out: ProviderRun,
		signal?: AbortSignal,
	): Promise<number> {
		out.duplicates = 0;
		let waiting = 0;
		for (const p of kept) {
			signal?.throwIfAborted();
			const urls = [p.url, ...(p.applyUrl ? [p.applyUrl] : [])];
			if (
				(await this.store.hasPosting(userId, this.feed.source, p.externalId)) ||
				(await this.store.sameJobStored(userId, {
					urls,
					...(p.applyUrl ? { applyUrl: p.applyUrl } : {}),
					company: p.company,
					title: p.title,
					workplaceType: p.workplaceType,
					locations: p.locations,
				}))
			) {
				out.duplicates++;
				continue;
			}
			out.found++;
			if (out.newJobIds.length >= this.options.cap) {
				waiting++;
				continue;
			}
			const companyId = await this.store.companyFor(userId, {
				name: p.company,
				source: this.feed.source,
				sourceKey: `${this.feed.source}:${companyNameKey(p.company) || p.company.toLowerCase()}`,
			});
			const { jobId, inserted } = await deps.repo.upsertJob(
				userId,
				companyId,
				this.job(p),
			);
			if (inserted) out.newJobIds.push(jobId);
			else out.duplicates++;
		}
		return waiting;
	}

	private job(p: FeedPosting): NormalizedJob {
		return {
			source: this.feed.source,
			externalId: p.externalId,
			url: p.url,
			title: p.title,
			locations: p.locations,
			workplaceType: p.workplaceType,
			employmentType: p.employmentType,
			descriptionText: p.descriptionText,
			publishedAt: p.publishedAt,
			companyName: p.company,
			...(p.applyUrl ? { applyUrl: p.applyUrl } : {}),
		};
	}
}

/**
 * The postings worth storing, newest first (a capped read keeps the newest; the next read the
 * rest): open, and found by one of the plan's searches (its words in the title or tags, and the
 * kind of work it looks for: remote or office). Each other one is logged with its reason for the
 * scan history.
 */
export function plausible(
	postings: FeedPosting[],
	searches: PlanSearch[],
	now: Date,
	drops: DropLog,
): FeedPosting[] {
	return postings
		.filter((p) => {
			const example = { title: p.title, company: p.company, url: p.url };
			if (p.expiresAt && p.expiresAt < now) {
				drops.add("expired", example);
				return false;
			}
			const fits = searches.some(
				(s) => feedKeywordsMatch(p, s) && feedWhereMatch(p, s),
			);
			if (!fits) drops.add("off_search", example);
			return fits;
		})
		.sort(
			(a, b) =>
				(b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
		);
}
