import { HELD_STOP_KINDS } from "../sites/stops";
import {
	detectLinkedInStop,
	type LinkedInPage,
	type LinkedInStop,
} from "./detect";
import {
	type LinkedInCard,
	type LinkedInListing,
	LinkedInSelectorError,
	parseJobView,
	parseSearchResults,
} from "./parse";

/**
 * The LinkedIn runner: reads LinkedIn's "Top job picks for you" and job searches made from the
 * shared search plan, in the user's signed-in session, one page at a time, at a human pace and
 * under a low daily page cap, and feeds new listings into the pipeline as hand-off jobs. Read
 * only: it opens list pages and job pages, never clicks anything (no Easy Apply, no apply
 * control, no "show more"). A login wall, security check, CAPTCHA or account warning stops it
 * until the user clears it; a changed layout or a page that would not load ends the run only,
 * and the next run tries again.
 */

export const LINKEDIN_ORIGIN = "https://www.linkedin.com";

/**
 * LinkedIn's pace (2026-11-03, the user's decision): at most 10 pages in any 24 hours, by every
 * run (scans, Retry now and a linked job together); a scan reads LinkedIn at most once every 6
 * hours, at most 5 pages a read; 20 to 60 s between pages; at most 2 new jobs opened per list.
 * Fixed in code: there are no per-source settings.
 */
export const LINKEDIN_PACE = {
	dailyPageCap: 10,
	runPages: 5,
	everyHours: 6,
	minGapSeconds: 20,
	maxGapSeconds: 60,
	perList: 2,
} as const;

/** LinkedIn's "Top job picks for you" collection. */
export const TOP_PICKS_PATH = "/jobs/collections/recommended/";

/** A list a run reads: Top picks, or one job search. */
export interface LinkedInList {
	kind: "top-picks" | "search";
	/** In words, for the scan history. */
	label: string;
	url: string;
}

/** What one kind of list gave in a run, for its own row in the scan history. */
export interface LinkedInPart {
	searches: string[];
	pagesRead: number;
	results: number;
	duplicates: number;
	listingsRead: number;
	newJobIds: string[];
	/** Lists whose first page was read (a list cut by the page budget before it is not). */
	opened: number;
	/** Why this part stopped short while the run went on (a Top picks layout LinkedIn changed). */
	problem?: string;
}

export interface LinkedInBlock {
	at: Date;
	kind: string;
	reason: string;
}

export type SaveOutcome = "inserted" | "duplicate" | "removed_company";

export interface LinkedInStore {
	/** The stop a run recorded, until the user clears it. */
	blocked(userId: string): Promise<LinkedInBlock | null>;
	/** Pages opened at or after `since`, by every run (a rolling 24 hours). */
	pagesUsedSince(userId: string, since: Date): Promise<number>;
	/**
	 * Reserves one page, timestamped now, just before it is opened. In one transaction shared by
	 * every runner of the user, it re-reads the stop and the cap and refuses when the user is
	 * blocked or the last 24 hours already hold `LINKEDIN_PACE.dailyPageCap` pages.
	 */
	reservePage(
		userId: string,
		runId: string,
	): Promise<
		| { ok: true }
		| { ok: false; reason: "blocked"; block: LinkedInBlock }
		| { ok: false; reason: "cap"; cap: number }
	>;
	startRun(userId: string, trigger: string): Promise<string>;
	/** Progress saved after every page, for the run's record (the cap counts reserved pages). */
	updateRun(
		runId: string,
		progress: Omit<
			LinkedInRunResult,
			"outcome" | "stopReason" | "runId" | "parts"
		>,
	): Promise<void>;
	finishRun(runId: string, result: LinkedInRunResult): Promise<void>;
	/** Records the stop and refuses every later run until `clear`. */
	block(userId: string, stop: LinkedInStop): Promise<void>;
	/** True when this LinkedIn job id is already stored for the user. */
	isKnown(userId: string, linkedinJobId: string): Promise<boolean>;
	/**
	 * Saves a listing as a `linkedin` job under its employer, unless the same job is already
	 * stored from any source (LinkedIn id, the employer's apply link, or employer and title) or
	 * the user removed that employer. `jobId` is the new job's, when inserted.
	 */
	saveListing(
		userId: string,
		listing: LinkedInListing,
		url: string,
	): Promise<{ outcome: SaveOutcome; jobId: string | null }>;
}

export interface LinkedInBrowser {
	/** Opens `url` in the one visible tab and returns where it ended and its HTML. Never clicks. */
	open(url: string): Promise<LinkedInPage>;
}

export interface LinkedInRunResult {
	runId: string;
	pagesUsed: number;
	listingsRead: number;
	jobsInserted: number;
	duplicates: number;
	/** done, page_cap, no_searches, refused_blocked (another run stopped), or a stop kind. */
	outcome: string;
	stopReason: string | null;
	/** Top picks and the searches, each counted on its own. */
	parts: { topPicks: LinkedInPart; searches: LinkedInPart };
}

export interface LinkedInRunnerDeps {
	store: LinkedInStore;
	browser: LinkedInBrowser;
	/** Tells the user the runner is stopped (held stops); must carry no URL, page text or account data. */
	alert: (stop: LinkedInStop) => Promise<void>;
	/** The page a run ended on for a changed layout or an unexpected page: kept locally for diagnosis. */
	debug?: (page: LinkedInPage, stop: LinkedInStop) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	random?: () => number;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface LinkedInRunOptions {
	userId: string;
	trigger: string;
	/**
	 * Where LinkedIn is. Always LINKEDIN_ORIGIN except in tests, which point it at a local
	 * fixture; list URLs are re-based onto it.
	 */
	origin?: string;
	/** The lists to read, in order (Top picks first, then searches from the plan). */
	lists: LinkedInList[];
	/** New jobs a list's results are opened for at most: one list never takes the day's cap. */
	perList?: number;
	/** Pages this run opens at most (its share of the day's cap). */
	maxPages?: number;
	/** Aborts when the scan step gives up on the run: no page is opened after it. */
	signal?: AbortSignal;
}

/** Stops the user has to act on (a check, sign-in or warning) block every later run until cleared. */
const HELD = HELD_STOP_KINDS;

export class LinkedInRunBlockedError extends Error {
	constructor(readonly block: LinkedInBlock) {
		super(
			`The LinkedIn runner is stopped since ${block.at.toISOString()} (${block.kind}: ${block.reason}). Check LinkedIn yourself in Settings › Sources, then choose Clear stop.`,
		);
		this.name = "LinkedInRunBlockedError";
	}
}

function rebase(url: string, origin: string): string {
	if (origin === LINKEDIN_ORIGIN) return url;
	const parsed = new URL(url);
	return `${origin}${parsed.pathname}${parsed.search}`;
}

const newPart = (): LinkedInPart => ({
	searches: [],
	pagesRead: 0,
	results: 0,
	duplicates: 0,
	listingsRead: 0,
	newJobIds: [],
	opened: 0,
});

const UNREADABLE: LinkedInStop = {
	kind: "unusual_page",
	reason: "the page could not be loaded or read",
};

/** The pause before a page: 20 to 60 seconds. */
const gapMs = (random: () => number) =>
	Math.round(
		(LINKEDIN_PACE.minGapSeconds +
			random() * (LINKEDIN_PACE.maxGapSeconds - LINKEDIN_PACE.minGapSeconds)) *
			1000,
	);

/** Why a page could not be reserved, as the run's end. */
const refusal = (
	slot:
		| { reason: "cap"; cap: number }
		| { reason: "blocked"; block: LinkedInBlock },
) =>
	slot.reason === "cap"
		? {
				end: "page_cap",
				reason: `LinkedIn's ${slot.cap} pages a day are used (rolling 24 hours)`,
			}
		: {
				end: "refused_blocked",
				reason: `Stopped while running (${slot.block.kind}); Sign in or Retry now in Settings › Sources after checking LinkedIn`,
			};

/**
 * Top picks' layout is not LinkedIn's search layout everywhere: a changed or unknown one ends
 * Top picks for this run (the page kept for diagnosis), and the searches go on. Checks, sign-in
 * walls and warnings stop the whole run, as on any page. True when the run goes on.
 */
async function partStop(
	deps: LinkedInRunnerDeps,
	counted: LinkedInPart,
	kind: LinkedInList["kind"],
	stop: LinkedInStop,
	page?: LinkedInPage,
): Promise<boolean> {
	if (kind !== "top-picks" || HELD.has(stop.kind)) return false;
	counted.problem = `Top picks could not be read: ${stop.reason}`;
	if (page)
		await deps
			.debug?.(page, stop)
			.catch((error: unknown) =>
				deps.log?.("linkedin debug snapshot failed", { error: String(error) }),
			);
	return true;
}

/** A saved listing, counted on the run and on its list's part. */
function countSaved(
	result: LinkedInRunResult,
	counted: LinkedInPart,
	saved: { outcome: SaveOutcome; jobId: string | null },
) {
	result.listingsRead += 1;
	counted.listingsRead += 1;
	if (saved.outcome === "inserted") {
		result.jobsInserted += 1;
		if (saved.jobId) counted.newJobIds.push(saved.jobId);
	} else {
		result.duplicates += 1;
		counted.duplicates += 1;
	}
}

/** Reads the lists once. Throws LinkedInRunBlockedError while a stop is uncleared. */
export async function runLinkedIn(
	deps: LinkedInRunnerDeps,
	options: LinkedInRunOptions,
): Promise<LinkedInRunResult> {
	const random = deps.random ?? Math.random;
	const origin = options.origin ?? LINKEDIN_ORIGIN;
	const host = new URL(origin).hostname;
	const blocked = await deps.store.blocked(options.userId);
	if (blocked) throw new LinkedInRunBlockedError(blocked);
	const signal = options.signal;

	const runId = await deps.store.startRun(options.userId, options.trigger);
	const result: LinkedInRunResult = {
		runId,
		pagesUsed: 0,
		listingsRead: 0,
		jobsInserted: 0,
		duplicates: 0,
		outcome: "done",
		stopReason: null,
		parts: { topPicks: newPart(), searches: newPart() },
	};
	const finish = async (outcome: string, reason: string | null = null) => {
		result.outcome = outcome;
		result.stopReason = reason;
		await deps.store.finishRun(runId, result);
		deps.log?.("linkedin run finished", { ...result });
		return result;
	};
	const lists = options.lists;
	if (lists.length === 0)
		return finish(
			"no_searches",
			"No searches: add job titles in Settings › Job search",
		);
	const perList = options.perList ?? LINKEDIN_PACE.perList;
	const maxPages = options.maxPages ?? LINKEDIN_PACE.runPages;

	/**
	 * One page: the gap first (except the run's first page), then a reservation, then open. The
	 * reservation is made right before the navigation, so a stop or pages recorded by another run
	 * in the meantime (another Chrome profile, another process) are seen. `end` ends the run.
	 */
	const visit = async (
		url: string,
		counted: LinkedInPart,
	): Promise<
		{ page: LinkedInPage | null } | { end: string; reason: string }
	> => {
		if (result.pagesUsed >= maxPages)
			return { end: "done", reason: `This read's ${maxPages} pages are used` };
		signal?.throwIfAborted();
		if (result.pagesUsed > 0)
			await abortable(deps.sleep(gapMs(random)), signal);
		const slot = await deps.store.reservePage(options.userId, runId);
		if (!slot.ok) return refusal(slot);
		result.pagesUsed += 1;
		counted.pagesRead += 1;
		await deps.store.updateRun(runId, {
			pagesUsed: result.pagesUsed,
			listingsRead: result.listingsRead,
			jobsInserted: result.jobsInserted,
			duplicates: result.duplicates,
		});
		try {
			const page = await deps.browser.open(url);
			signal?.throwIfAborted();
			return { page };
		} catch (error) {
			if (signal?.aborted) throw error;
			// A page that would not load or changed while being read (a script redirect to a
			// check does that) is an unusual page. Playwright's message holds URLs: not kept.
			deps.log?.("linkedin page could not be read", {
				error: error instanceof Error ? error.name : "error",
			});
			return { page: null };
		}
	};

	const stopFor = async (stop: LinkedInStop, page?: LinkedInPage) => {
		if (!HELD.has(stop.kind)) {
			// A layout change or a page that would not load: this run ends, the next one tries again.
			if (page)
				await deps.debug?.(page, stop).catch((error: unknown) =>
					deps.log?.("linkedin debug snapshot failed", {
						error: String(error),
					}),
				);
			return finish(stop.kind, stop.reason);
		}
		await deps.store.block(options.userId, stop);
		await finish(stop.kind, stop.reason);
		await deps
			.alert(stop)
			.catch((error: unknown) =>
				deps.log?.("linkedin alert failed", { error: String(error) }),
			);
		return result;
	};

	try {
		return await readLists();
	} catch (error) {
		// Not LinkedIn's doing (the database, a bug): the run is recorded as failed, not blocked.
		await finish(
			"error",
			error instanceof Error ? error.message.slice(0, 200) : "error",
		).catch(() => {});
		throw error;
	}

	async function readLists(): Promise<LinkedInRunResult> {
		const run: RunContext = {
			deps,
			userId: options.userId,
			result,
			host,
			origin,
			perList,
			visit,
			stopFor,
			finish,
		};
		for (const list of lists) {
			const ended = await readList(run, list);
			if (ended) return ended;
		}
		return finish("done");
	}
}

/** One run's state and steps, shared by the list readers below. */
interface RunContext {
	deps: LinkedInRunnerDeps;
	userId: string;
	result: LinkedInRunResult;
	host: string;
	origin: string;
	perList: number;
	visit(
		url: string,
		counted: LinkedInPart,
	): Promise<{ page: LinkedInPage | null } | { end: string; reason: string }>;
	stopFor(stop: LinkedInStop, page?: LinkedInPage): Promise<LinkedInRunResult>;
	finish(outcome: string, reason?: string | null): Promise<LinkedInRunResult>;
}

/** One list's page, then its new jobs. The run's result when the run ended; null to go on. */
async function readList(
	run: RunContext,
	list: LinkedInList,
): Promise<LinkedInRunResult | null> {
	const { deps, result } = run;
	const counted =
		list.kind === "top-picks" ? result.parts.topPicks : result.parts.searches;
	counted.searches.push(list.label);
	const visited = await run.visit(rebase(list.url, run.origin), counted);
	if ("end" in visited) return run.finish(visited.end, visited.reason);
	counted.opened++;
	const page = visited.page;
	const stop = page ? detectLinkedInStop(page, run.host) : UNREADABLE;
	if (stop) {
		if (await partStop(deps, counted, list.kind, stop, page ?? undefined))
			return null;
		return run.stopFor(stop, page ?? undefined);
	}
	let cards: LinkedInCard[];
	try {
		cards = parseSearchResults((page as LinkedInPage).html);
	} catch (error) {
		if (!(error instanceof LinkedInSelectorError)) throw error;
		const layout: LinkedInStop = { kind: "selectors", reason: error.message };
		if (await partStop(deps, counted, list.kind, layout, page ?? undefined))
			return null;
		return run.stopFor(layout, page ?? undefined);
	}
	counted.results += cards.length;
	return readCards(run, counted, cards);
}

/** The new jobs of a list, at most `perList`, each page read and saved. */
async function readCards(
	run: RunContext,
	counted: LinkedInPart,
	cards: LinkedInCard[],
): Promise<LinkedInRunResult | null> {
	const { deps, result } = run;
	let opened = 0;
	for (const card of cards) {
		if (opened >= run.perList) break;
		if (await deps.store.isKnown(run.userId, card.jobId)) {
			result.duplicates += 1;
			counted.duplicates += 1;
			continue;
		}
		const visited = await run.visit(
			`${run.origin}/jobs/view/${card.jobId}/`,
			counted,
		);
		if ("end" in visited) return run.finish(visited.end, visited.reason);
		const view = visited.page;
		if (!view) return run.stopFor(UNREADABLE);
		opened += 1;
		const viewStop = detectLinkedInStop(view, run.host);
		if (viewStop) return run.stopFor(viewStop, view);
		let listing: LinkedInListing;
		try {
			listing = parseJobView(view.html, view.url, card.jobId);
		} catch (error) {
			if (error instanceof LinkedInSelectorError)
				return run.stopFor({ kind: "selectors", reason: error.message }, view);
			throw error;
		}
		countSaved(
			result,
			counted,
			await deps.store.saveListing(
				run.userId,
				listing,
				`${LINKEDIN_ORIGIN}/jobs/view/${card.jobId}/`,
			),
		);
	}
	return null;
}

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
