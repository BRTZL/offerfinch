import type { PipelineDeps } from "../pipeline/ports";
import {
	NO_SEARCHES,
	type ProviderRun,
	type ScanProvider,
	searchesFor,
} from "../pipeline/providers";
import type { SourceStatus } from "../pipeline/scan-report";
import { linkedinSearch, runStart } from "../search/adapt";
import { type PlanResult, rotate } from "../search/plan";
import { HELD_STOP_KINDS } from "../sites/stops";
import type { LinkedInPage, LinkedInStop } from "./detect";
import {
	LINKEDIN_ORIGIN,
	LINKEDIN_PACE,
	type LinkedInBrowser,
	type LinkedInList,
	type LinkedInPart,
	LinkedInRunBlockedError,
	type LinkedInRunResult,
	type LinkedInStore,
	runLinkedIn,
	TOP_PICKS_PATH,
} from "./runner";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const LINKEDIN_ID = "linkedin";
const TOP_PICKS_ID = "linkedin-top-picks";
const TOP_PICKS_LABEL = "LinkedIn Top picks";

/** Searches from the plan one LinkedIn read lists, after Top picks (later reads take the next). */
const SEARCHES_PER_READ = 2;

export interface LinkedInScanStore extends LinkedInStore {
	/** When the last LinkedIn read began (any trigger but a linked job), for the 6-hour wait. */
	lastReadAt(userId: string): Promise<Date | null>;
	/** The pages opened since `since`, oldest first (the rolling 24-hour cap). */
	pagesSince(userId: string, since: Date): Promise<Date[]>;
}

export interface LinkedInScanDeps {
	store: LinkedInScanStore;
	/** LinkedIn's tab for one read. Throws when it can't be had now (a linked job is read). */
	openBrowser(
		signal?: AbortSignal,
	): Promise<LinkedInBrowser & { close(): Promise<void> }>;
	/** A check, sign-in wall or warning stopped LinkedIn: tell the user. */
	alert: (stop: LinkedInStop) => Promise<void>;
	debug?: (page: LinkedInPage, stop: LinkedInStop) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	random?: () => number;
	log?: (message: string, data?: Record<string, unknown>) => void;
	/** Test runs: the local stand-in. */
	origin?: string;
	now?: () => Date;
	/** True once after Retry now: this read does not wait out the 6 hours (the cap still holds). */
	takeReadNow?: () => boolean;
}

/** When LinkedIn may be read again: 6 hours after the last read, and once the cap has room. */
export async function nextLinkedInRead(
	store: Pick<LinkedInScanStore, "lastReadAt" | "pagesSince">,
	userId: string,
	now: Date,
): Promise<{ at: Date; pagesLeft: number }> {
	const last = await store.lastReadAt(userId);
	const pages = await store.pagesSince(
		userId,
		new Date(now.getTime() - DAY_MS),
	);
	const pagesLeft = Math.max(0, LINKEDIN_PACE.dailyPageCap - pages.length);
	let at = last
		? new Date(last.getTime() + LINKEDIN_PACE.everyHours * HOUR_MS)
		: now;
	if (pagesLeft === 0) {
		// The page that frees the first slot: the oldest one still in the window.
		const frees = new Date((pages[0] as Date).getTime() + DAY_MS);
		if (frees > at) at = frees;
	}
	return { at: at > now ? at : now, pagesLeft };
}

/** "~4 h", "~35 min". */
export function inAbout(ms: number): string {
	if (ms < HOUR_MS) return `~${Math.max(1, Math.round(ms / 60_000))} min`;
	return `~${Math.round(ms / HOUR_MS)} h`;
}

function statusOf(kind: string): SourceStatus {
	if (kind === "login_wall") return "needs_sign_in";
	if (HELD_STOP_KINDS.has(kind)) return "paused_check";
	return "retrying";
}

/**
 * LinkedIn in scans (2026-11-03): at most one read every 6 hours, at most 5 pages a read and 10
 * in any 24 hours (Retry now and a linked job count too), 20 to 60 s between pages. A read opens
 * "Top job picks for you" first, then two searches from the shared plan (the next read takes the
 * next two). A check, sign-in wall or warning stops LinkedIn and tells the user, as before;
 * a changed layout ends the read and the next one tries again. Read only; jobs are handed off.
 */
export class LinkedInScanProvider implements ScanProvider {
	readonly id = LINKEDIN_ID;
	readonly label = "LinkedIn";
	/** 5 pages, 60 s gaps, 75 s each, plus the 20 minutes the user may take on checks. */
	readonly timeoutSeconds = 3_600;

	constructor(private readonly deps: LinkedInScanDeps) {}

	async run(
		pipeline: PipelineDeps,
		userId: string,
		signal?: AbortSignal,
		plan?: PlanResult,
		cursor?: number,
	): Promise<ProviderRun> {
		const d = this.deps;
		const now = d.now?.() ?? new Date();
		const out: ProviderRun = {
			provider: this.id,
			queries: 0,
			found: 0,
			fetched: 0,
			newJobIds: [],
		};
		const blocked = await d.store.blocked(userId);
		if (blocked) {
			out.status = statusOf(blocked.kind);
			out.problem = `Stopped: ${blocked.reason}. Sign in or choose Retry now in Settings › Sources once LinkedIn looks normal.`;
			return out;
		}
		const next = await nextLinkedInRead(d.store, userId, now);
		const readNow = d.takeReadNow?.() ?? false;
		if (next.pagesLeft === 0 || (next.at > now && !readNow)) {
			out.status = "waiting";
			out.retryAt = next.at.toISOString();
			out.problem = `Next LinkedIn read in ${inAbout(next.at.getTime() - now.getTime())}${next.pagesLeft === 0 ? ` (${LINKEDIN_PACE.dailyPageCap} pages a day)` : ""}.`;
			return out;
		}
		const { settings, searches } = await searchesFor(pipeline, userId, plan);
		const origin = d.origin ?? LINKEDIN_ORIGIN;
		const start = runStart(
			cursor,
			now,
			SEARCHES_PER_READ,
			LINKEDIN_PACE.everyHours,
		);
		const lists: LinkedInList[] = [
			{
				kind: "top-picks",
				label: "Top job picks for you",
				url: `${LINKEDIN_ORIGIN}${TOP_PICKS_PATH}`,
			},
			...rotate(searches, start, SEARCHES_PER_READ).map((s) => ({
				kind: "search" as const,
				...linkedinSearch(s, settings.livesIn),
			})),
		];
		pipeline.scanProgress?.(userId, {
			source: this.id,
			label: this.label,
			query: "Top job picks for you",
		});
		const browser = await d.openBrowser(signal);
		let result: LinkedInRunResult;
		try {
			result = await runLinkedIn(
				{
					store: d.store,
					browser,
					alert: d.alert,
					debug: d.debug,
					sleep: d.sleep,
					random: d.random,
					log: d.log,
				},
				{
					userId,
					trigger: "scan",
					origin: origin === LINKEDIN_ORIGIN ? undefined : origin,
					lists,
					maxPages: Math.min(LINKEDIN_PACE.runPages, next.pagesLeft),
					signal,
				},
			);
		} catch (error) {
			// Another run stopped LinkedIn between the check above and this read.
			if (!(error instanceof LinkedInRunBlockedError)) throw error;
			out.status = statusOf(error.block.kind);
			out.problem = error.message;
			return out;
		} finally {
			await browser.close().catch(() => {});
		}
		const report = linkedinRunReport(result, searches.length === 0);
		// Only the searches it opened are done (Top picks or the page budget may use the rest).
		const opened = result.parts.searches.opened;
		return opened > 0 ? { ...report, cursor: start + opened } : report;
	}
}

const part = (
	id: string,
	p: LinkedInPart,
): Omit<ProviderRun, "parts" | "problem"> => ({
	provider: id,
	queries: p.searches.length,
	found: p.listingsRead,
	fetched: p.listingsRead,
	newJobIds: p.newJobIds,
	searches: p.searches,
	pagesRead: p.pagesRead,
	results: p.results,
	duplicates: p.duplicates,
});

/**
 * A read as the scan records it: the searches as LinkedIn's row, Top picks as a row of its own.
 * A stop names the whole read's outcome on the row it happened in (the searches' when both).
 */
function linkedinRunReport(
	result: LinkedInRunResult,
	noSearches = false,
): ProviderRun {
	const searches = part(LINKEDIN_ID, result.parts.searches);
	const topPicks: Omit<ProviderRun, "parts"> & { label: string } = {
		...part(TOP_PICKS_ID, result.parts.topPicks),
		label: TOP_PICKS_LABEL,
		...(result.parts.topPicks.problem
			? { problem: result.parts.topPicks.problem }
			: {}),
	};
	const out: ProviderRun = { ...searches, parts: [topPicks] };
	const ended = result.outcome;
	if (ended === "page_cap") {
		// The day's pages are used: a note, not a problem.
		out.problem = result.stopReason ?? ended;
		out.status = "ok";
	} else if (ended === "refused_blocked") {
		out.problem = result.stopReason ?? ended;
		out.status = "paused_check";
	} else if (ended !== "done" && ended !== "no_searches") {
		out.status = statusOf(ended);
		out.problem = `Stopped: ${result.stopReason ?? ended}.`;
		topPicks.status = out.status;
	}
	if (noSearches && !out.problem) out.problem = NO_SEARCHES;
	return out;
}
