import type { JobSourceKind } from "../domain/types";
import { routeJobLink } from "../sources/link";
import { postingFromUrl } from "../sources/search";
import type { JobSource, RequestPacing } from "../sources/types";
import { readableResult } from "../web/hosts";
import { type PostingIdentity, postingIdentities } from "../web/structured";

/**
 * Closed postings (docs/decisions.md, 2026-11-03). A match can wait for days; preparing or
 * applying to a posting the employer took down wastes money and time. So the posting is checked
 * where that is cheap and safe:
 * - board postings (Greenhouse, Lever, Ashby) through the board's public API;
 * - other web pages by their stored end date (`validThrough`), else one plain fetch of the page
 *   (no browser, no model): a 404 or 410, or an end date in the page's job data that has passed;
 * - LinkedIn, Indeed and Glassdoor never: a re-read costs their page budget and risks a check.
 *   Their postings show their age instead, with a note past AGE_NOTE_DAYS.
 * Only a definite "gone" closes a job. An error, a timeout or an unclear answer is "unknown" and
 * changes nothing; the user's "It's still open" stops automatic checks from closing it again.
 */

/** Past this many days a LinkedIn, Indeed or Glassdoor posting gets "may be closed". */
const AGE_NOTE_DAYS = 14;

/** The scan's re-check of listed board matches: a few each scan, politely spaced. */
export const CLOSED_SWEEP = {
	/** Postings checked per scan, at most. */
	perScan: 3,
	/** Only matches found at least this long ago. */
	olderThanDays: 7,
	/** A posting is checked again at most this often. */
	recheckHours: 24,
	/** Between two requests. */
	gapMs: 2_000,
	/** One request gives up after this long (unknown, not closed). */
	timeoutMs: 10_000,
} as const;

/** How long a check on a user's action (Prepare, the hand-off) may take before it is skipped. */
export const ACTION_CHECK_TIMEOUT_MS = 8_000;

/** What a check needs to know about a job. */
export interface CheckableJob {
	jobId: string;
	source: JobSourceKind;
	url: string;
	externalId: string;
	/** The board's company key (Greenhouse token, Lever and Ashby company name) for board jobs. */
	companyKey: string;
	validThrough: Date | null;
}

export type OpenCheck =
	| { status: "open" }
	/** Definite: the board or the page says the posting is gone. `reason` in plain words. */
	| { status: "gone"; reason: string }
	/** No clear answer (an error, a timeout, a page without job data). Never closes anything. */
	| { status: "unknown"; reason: string }
	/** Not checked by design (LinkedIn, Indeed, Glassdoor) or no way to check. */
	| { status: "not_checked"; reason: string };

/** A page as the check read it: where it ended up, and every URL on the way (the first included). */
interface FetchedPage {
	status: number;
	html: string;
	/** The final URL, after redirects. Unset: the requested one. */
	url?: string;
	/** Every URL requested, in order. Unset: no redirect. */
	redirects?: string[];
}

export interface OpenCheckDeps {
	sources: Partial<Record<JobSourceKind, JobSource>>;
	/**
	 * One plain GET of a page, every hop checked (no private network), no browser and no
	 * model; throws on a network error. Unset: pages are judged by their stored end date only.
	 */
	fetchPage?: (url: string, signal: AbortSignal) => Promise<FetchedPage>;
	now?: () => Date;
	timeoutMs?: number;
	/** The sweep's: every board request waits its turn, and a board is read once per sweep. */
	pacing?: RequestPacing;
}

const BOARD_LABEL = {
	greenhouse: "Greenhouse",
	lever: "Lever",
	ashby: "Ashby",
} as const;
type Board = keyof typeof BOARD_LABEL;

const SITE_READ = new Set<string>(["linkedin", "indeed", "glassdoor"]);

type Route =
	| { kind: "board"; board: Board; key: string; id: string }
	| { kind: "page"; url: string }
	| { kind: "site" }
	| { kind: "none" };

/**
 * How a job's posting can be checked. Board jobs by their stored board key and id (a
 * Greenhouse posting's URL is often the employer's own careers page); a job added by link by
 * where its link points.
 */
function checkRoute(
	job: Pick<CheckableJob, "source" | "url" | "externalId" | "companyKey">,
): Route {
	if (job.source in BOARD_LABEL)
		return {
			kind: "board",
			board: job.source as Board,
			key: job.companyKey,
			id: job.externalId,
		};
	if (SITE_READ.has(job.source)) return { kind: "site" };
	if (job.source === "web" || job.source === "scrape")
		return { kind: "page", url: job.url };
	if (job.source !== "manual") return { kind: "none" };
	let url: URL;
	try {
		url = new URL(job.url);
	} catch {
		return { kind: "none" };
	}
	const route = routeJobLink(url);
	// The board readers ask the US APIs only; there, an EU-hosted posting answers 404 like a
	// removed one. So an EU board link is checked as a page (404 or 410 from the page itself).
	if (route.kind === "board" && /\.eu\./i.test(url.hostname))
		return { kind: "page", url: url.toString() };
	if (route.kind === "board") {
		const posting = postingFromUrl(url.toString());
		if (posting)
			return {
				kind: "board",
				board: posting.board,
				key: posting.companyKey,
				id: posting.jobId,
			};
	}
	if (route.kind === "page") return { kind: "page", url: url.toString() };
	return { kind: "site" };
}

/** True for postings read from LinkedIn, Indeed or Glassdoor: shown with their age, never re-read. */
function isSiteRead(
	job: Pick<CheckableJob, "source" | "url" | "externalId" | "companyKey">,
): boolean {
	return checkRoute(job).kind === "site";
}

/**
 * A posting's age for the "may be closed" note: from when it was posted when the source said,
 * else from when the app first saw it. `mayBeClosed` only for site-read postings past
 * AGE_NOTE_DAYS; every other posting is checked instead.
 */
export function postingAge(
	job: Pick<CheckableJob, "source" | "url" | "externalId" | "companyKey"> & {
		publishedAt: Date | null;
		firstSeenAt: Date;
	},
	now: Date,
): { days: number; since: Date; mayBeClosed: boolean } {
	const since = job.publishedAt ?? job.firstSeenAt;
	const days = Math.max(
		0,
		Math.floor((now.getTime() - since.getTime()) / 86_400_000),
	);
	return { days, since, mayBeClosed: isSiteRead(job) && days > AGE_NOTE_DAYS };
}

const day = (d: Date) =>
	d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});

function message(error: unknown): string {
	if (error instanceof Error && error.name === "TimeoutError")
		return "no answer in time";
	return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** Query parameters that only say where a click came from; ignored when telling postings apart. */
const TRACKING =
	/^(?:utm_\w+|gclid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi)$/i;

const parse = (url: string, base?: string): URL | null => {
	try {
		const u = new URL(url, base);
		return /^https?:$/.test(u.protocol) ? u : null;
	} catch {
		return null;
	}
};

/** The same host and port, whatever the scheme. */
function sameSite(a: URL, b: URL): boolean {
	return (
		a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.port === b.port
	);
}

/**
 * Closure evidence needs the posting's own URL, compared strictly (not the dedupe normalizer):
 * the same host and port whatever the scheme, the same path (a trailing slash aside), and the
 * same query parameters with the same values, tracking parameters (utm_*, gclid, ...) aside.
 * `?ref=123` and `?ref=456` are two postings.
 */
function samePostingUrl(a: URL, b: URL): boolean {
	const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
	const query = (u: URL) =>
		[...u.searchParams]
			.filter(([key]) => !TRACKING.test(key))
			.map(([key, value]) => `${key}=${value}`)
			.sort()
			.join("&");
	return sameSite(a, b) && path(a) === path(b) && query(a) === query(b);
}

/**
 * The URLs that are this posting: its stored URL, and the page it ended on when every redirect
 * on the way stayed on the stored URL's site (a posting moved to its canonical address). A
 * redirect to another site makes the final page something else.
 */
function postingUrls(job: CheckableJob, page: FetchedPage): URL[] {
	const stored = parse(job.url);
	if (!stored) return [];
	const chain = (page.redirects ?? [job.url]).map((u) => parse(u));
	const final = parse(page.url ?? job.url);
	const onSite = chain.every((u) => u !== null && sameSite(u, stored));
	return onSite && final ? [stored, final] : [stored];
}

/** Every redirect stayed on the stored URL's site (or there was none). */
function stayedOnSite(job: CheckableJob, page: FetchedPage): boolean {
	return postingUrls(job, page).length === 2 || !page.redirects;
}

/**
 * The page's job data for this posting: only when the page declares exactly one JobPosting
 * (counted before any filtering) and it names itself as this job, by its URL (read against the
 * final page, compared strictly) or its identifier. A title is never enough. Several postings
 * (related jobs, a careers index a removed posting redirects to), a posting naming another URL,
 * or one naming none says nothing: null.
 */
function ownPosting(
	job: CheckableJob,
	page: FetchedPage,
): PostingIdentity | null {
	const postings = postingIdentities(page.html);
	const [only] = postings;
	if (postings.length !== 1 || !only) return null;
	const declared =
		only.url !== undefined ? parse(only.url, page.url ?? job.url) : null;
	const sameUrl =
		declared !== null &&
		postingUrls(job, page).some((u) => samePostingUrl(declared, u));
	const sameId =
		only.identifier !== undefined && only.identifier === job.externalId;
	return sameUrl || sameId ? only : null;
}

async function checkPage(
	url: string,
	job: CheckableJob,
	deps: OpenCheckDeps,
	signal: AbortSignal,
	now: Date,
): Promise<OpenCheck> {
	if (job.validThrough && job.validThrough < now)
		return {
			status: "gone",
			reason: `Its end date (${day(job.validThrough)}) has passed`,
		};
	if (!deps.fetchPage)
		return { status: "not_checked", reason: "Pages can't be read here" };
	let page: FetchedPage;
	try {
		page = await deps.fetchPage(url, signal);
	} catch (error) {
		return { status: "unknown", reason: message(error) };
	}
	// 404 Not Found and 410 Gone are the site's own answer, when the page is still on its site;
	// any other error is not, and neither is another site's.
	if ((page.status === 404 || page.status === 410) && stayedOnSite(job, page))
		return {
			status: "gone",
			reason: `Its page answers ${page.status} (${page.status === 410 ? "gone" : "not found"})`,
		};
	if (page.status >= 400)
		return { status: "unknown", reason: `the page answered ${page.status}` };
	const own = ownPosting(job, page);
	if (!own)
		return {
			status: "unknown",
			reason: "the page has no job data for this posting alone",
		};
	if (own.validThrough && own.validThrough < now)
		return {
			status: "gone",
			reason: `Its page gives an end date (${day(own.validThrough)}) that has passed`,
		};
	return { status: "open" };
}

/** What `politePageFetcher` needs: one request without following redirects, and robots.txt. */
export interface PolitePageDeps {
	/** One GET, no redirect followed (a 3xx comes back with its Location). Throws on a network error. */
	fetchOnce(
		url: string,
	): Promise<{ status: number; location?: string; html: string }>;
	/** Whether robots.txt lets OfferFinch's reader fetch this URL. */
	robotsAllow(url: string): Promise<boolean>;
	maxRedirects?: number;
}

/**
 * The page check's fetcher, under web search's rules (docs/decisions.md, 2026-11-03): before
 * the first request and before every redirect, the URL must be a public page on a site no other
 * source reads (never LinkedIn, Indeed or Glassdoor, nor a job board's page) and robots.txt must
 * allow it. A refusal throws, which the check reports as unknown: it never closes a job.
 */
export function politePageFetcher(
	deps: PolitePageDeps,
): NonNullable<OpenCheckDeps["fetchPage"]> {
	return async (url, signal) => {
		let target = url;
		const redirects: string[] = [];
		for (let hop = 0; hop <= (deps.maxRedirects ?? 5); hop++) {
			signal.throwIfAborted();
			if (!readableResult(target))
				throw new Error(
					`not read: ${new URL(target).host} is LinkedIn, Indeed or Glassdoor, a job board, or not a public page`,
				);
			if (!(await deps.robotsAllow(target)))
				throw new Error(`robots.txt does not allow reading ${target}`);
			const page = await deps.fetchOnce(target);
			redirects.push(target);
			if (page.status >= 300 && page.status < 400 && page.location) {
				target = new URL(page.location, target).href;
				continue;
			}
			return { status: page.status, html: page.html, url: target, redirects };
		}
		throw new Error("the page redirects too many times");
	};
}

/** Is this posting still open? Never throws; only `gone` may close the job. */
export async function checkPostingOpen(
	job: CheckableJob,
	deps: OpenCheckDeps,
): Promise<OpenCheck> {
	const now = deps.now?.() ?? new Date();
	const route = checkRoute(job);
	const signal = AbortSignal.timeout(deps.timeoutMs ?? ACTION_CHECK_TIMEOUT_MS);
	if (route.kind === "site")
		return {
			status: "not_checked",
			reason:
				"LinkedIn, Indeed and Glassdoor postings are not re-read; check the posting before applying",
		};
	if (route.kind === "none")
		return {
			status: "not_checked",
			reason: "This posting has no link to check",
		};
	if (route.kind === "page")
		return checkPage(route.url, job, deps, signal, now);
	const source = deps.sources[route.board];
	if (!source?.checkPosting)
		return { status: "not_checked", reason: "The board can't be read here" };
	try {
		const status = await source.checkPosting(
			route.key,
			route.id,
			signal,
			deps.pacing,
		);
		return status === "open"
			? { status: "open" }
			: {
					status: "gone",
					reason: `${BOARD_LABEL[route.board]} no longer lists it`,
				};
	} catch (error) {
		return { status: "unknown", reason: message(error) };
	}
}

/**
 * What started a check: the scan's sweep or Prepare (each about a listed match nobody asked to
 * prepare), or the hand-off of an approved application. Only a check about the application's
 * current step may close it (`ClosedPostingStore.recordCheck`).
 */
export type CheckOrigin = "sweep" | "prepare" | "handoff";

/** Where the sweep keeps what it learns. */
export interface ClosedPostingStore {
	/**
	 * Listed board matches (an open match nobody acted on) found before `foundBefore`, not
	 * closed, not confirmed open by the user, last checked before `checkedBefore` (or never),
	 * the longest-unchecked first.
	 */
	sweepCandidates(
		userId: string,
		options: { foundBefore: Date; checkedBefore: Date; limit: number },
	): Promise<CheckableJob[]>;
	/**
	 * Saves a check: always its time; for `gone`, closes the job with `reason` unless the user
	 * confirmed it open, or the application has moved past what the check was about: a sweep or
	 * Prepare check closes only a match nobody asked to prepare, a hand-off check only an approved
	 * application. Returns true when it closed the job now.
	 */
	recordCheck(
		userId: string,
		jobId: string,
		check: { at: Date; origin: CheckOrigin; gone?: { reason: string } },
	): Promise<boolean>;
}

export interface ClosedSweepResult {
	checked: number;
	closed: string[];
	/** No clear answer this time (errors, timeouts); left open. */
	unknown: number;
}

/**
 * The scan's re-check of listed board matches older than a week: at most `perScan` postings,
 * one at a time with a gap, each with a short timeout. Never throws for a posting: an error
 * leaves it open, and its check time moves it to the back of the line.
 */
export async function sweepClosedPostings(
	deps: OpenCheckDeps & {
		store: ClosedPostingStore;
		sleep?: (ms: number) => Promise<void>;
		log?: (message: string, data?: Record<string, unknown>) => void;
		/**
		 * Runs each part as a durable step (the scan's), so a replay after a crash re-uses the
		 * postings this scan picked and the checks it finished, and never checks more than the
		 * cap. Unset: plain calls.
		 */
		journal?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
	},
	userId: string,
	options: Partial<typeof CLOSED_SWEEP> = {},
): Promise<ClosedSweepResult> {
	const o = { ...CLOSED_SWEEP, ...options };
	const journal =
		deps.journal ?? (<T>(_name: string, fn: () => Promise<T>) => fn());
	const candidates = await journal("closed postings: pick", async () => {
		const now = deps.now?.() ?? new Date();
		const picked = await deps.store.sweepCandidates(userId, {
			foundBefore: new Date(now.getTime() - o.olderThanDays * 86_400_000),
			checkedBefore: new Date(now.getTime() - o.recheckHours * 3_600_000),
			limit: o.perScan,
		});
		return picked.slice(0, o.perScan);
	});
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	// Every request waits `gapMs` after the one before it, a board's list included.
	let sent = 0;
	const pacing: RequestPacing = {
		before: async () => {
			if (sent++ > 0) await sleep(o.gapMs);
		},
		boards: new Map(),
	};
	const result: ClosedSweepResult = { checked: 0, closed: [], unknown: 0 };
	for (const job of candidates) {
		// Board postings only: the sweep never fetches a web page or a site the user reads.
		if (checkRoute(job).kind !== "board") continue;
		const one = await journal(
			`closed postings: check ${job.jobId}`,
			async () => {
				const check = await checkPostingOpen(job, {
					...deps,
					timeoutMs: o.timeoutMs,
					pacing,
				});
				const closed = await deps.store.recordCheck(userId, job.jobId, {
					at: deps.now?.() ?? new Date(),
					origin: "sweep",
					...(check.status === "gone"
						? {
								gone: { reason: `${check.reason} (found by the scan's check)` },
							}
						: {}),
				});
				return { status: check.status, closed };
			},
		);
		result.checked++;
		if (one.status === "unknown") result.unknown++;
		if (one.closed) result.closed.push(job.jobId);
		deps.log?.("posting checked", { jobId: job.jobId, status: one.status });
	}
	return result;
}
