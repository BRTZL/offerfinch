import {
	detectLinkedInStop,
	LINKEDIN_POSTING_TEXT,
} from "@offerfinch/core/linkedin/detect";
import {
	type LinkedInListing,
	parseJobView,
} from "@offerfinch/core/linkedin/parse";
import type { LinkedInScanDeps } from "@offerfinch/core/linkedin/provider";
import {
	LINKEDIN_ORIGIN,
	type LinkedInBrowser,
} from "@offerfinch/core/linkedin/runner";
import { LINKEDIN_SELECTORS } from "@offerfinch/core/linkedin/selectors";
import { isHeldStop } from "@offerfinch/core/sites/stops";
import { DrizzleLinkedInStore } from "@offerfinch/db";

import type { WorkerApp } from "./app";
import { openTabReader } from "./checks";
import { LOCAL_USER_ID } from "./settings";
import { saveDebugSnapshot } from "./site-debug";

/**
 * LinkedIn from the app: core's runner (read only, human pace, daily cap, checks held for the
 * user), reading in LinkedIn's hidden tab inside OfferFinch (its own session,
 * `persist:site-linkedin`, signed in through the sign-in sheet). Electron's defaults, nothing
 * hidden (PLAN rule 4). A check the user can clear (CAPTCHA, security check, sign-in wall)
 * pauses the read for them; anything else stops it. Scans read it at most every 3 hours
 * (core `LinkedInScanProvider`); a linked job is one page.
 */

const RENDERED = [
	LINKEDIN_SELECTORS.resultsList,
	LINKEDIN_SELECTORS.noResults,
	LINKEDIN_SELECTORS.jobTitle,
	// The server-driven layout: its results column and a job's "About the job".
	LINKEDIN_SELECTORS.sduiResultsList,
	LINKEDIN_SELECTORS.sduiJobDescription,
].join(", ");

/** LinkedIn's tab for one read. Test runs: the local stand-in, no gaps. */
async function openLinkedIn(
	app: WorkerApp,
	waitForUser: boolean,
	signal?: AbortSignal,
): Promise<LinkedInBrowser & { close(): Promise<void> }> {
	const host = new URL(app.init.test?.linkedinOrigin ?? LINKEDIN_ORIGIN)
		.hostname;
	const reader = await openTabReader(app.siteHost(), {
		site: "linkedin",
		ready: RENDERED,
		exclude: LINKEDIN_POSTING_TEXT,
		detect: (page) => detectLinkedInStop(page, host),
		waitForUser,
		signal,
	});
	return {
		open: (url) => reader.open(url),
		close: () => reader.close(),
	};
}

/** One LinkedIn read at a time in this worker: a scan's, or a linked job's. */
let busy = false;
/** Retry now: the next scan reads LinkedIn without waiting out the 3 hours (the cap holds). */
let readNow = false;

export function readLinkedInNow() {
	readNow = true;
}

/**
 * What LinkedIn needs in a scan: the store, its tab (refused while a linked job is read), the
 * notice for a held stop, the pages kept for diagnosis, the pace (none against a stand-in).
 */
export function linkedinScanDeps(app: WorkerApp): LinkedInScanDeps {
	const origin = app.init.test?.linkedinOrigin;
	return {
		store: new DrizzleLinkedInStore(app.db),
		origin,
		openBrowser: async (signal) => {
			if (busy)
				throw new Error(
					"LinkedIn is being read for a job you linked; the next scan reads it",
				);
			busy = true;
			try {
				const browser = await openLinkedIn(app, true, signal);
				return {
					open: (url) => browser.open(url),
					close: async () => {
						busy = false;
						await browser.close();
					},
				};
			} catch (error) {
				busy = false;
				throw error;
			}
		},
		alert: async (stop) =>
			app.notifyStop(
				"LinkedIn stopped",
				`It saw ${stop.kind.replace("_", " ")} and stopped; nothing more is read until you check LinkedIn and choose Sign in or Retry now in Settings › Sources.`,
			),
		debug: async (page, stop) => {
			const file = saveDebugSnapshot(app.init.userData, "linkedin", page, stop);
			app.log("info", "site page kept for diagnosis", {
				site: "linkedin",
				kind: stop.kind,
				file,
			});
		},
		sleep: (ms) =>
			origin ? Promise.resolve() : new Promise((done) => setTimeout(done, ms)),
		log: (message, data) => app.log("info", message, data),
		takeReadNow: () => {
			const now = readNow;
			readNow = false;
			return now;
		},
	};
}

/**
 * One LinkedIn job a user linked, read in the runner's own profile: one page, counted against the
 * daily cap. Any wall or check records a stop (as a run would) and nothing more is read; a stop
 * already in place refuses at once. Never clicks, never Easy Apply.
 */
export async function readLinkedInJob(
	app: WorkerApp,
	jobId: string,
): Promise<{ listing: LinkedInListing; url: string } | { stop: string }> {
	if (busy) return { stop: "LinkedIn is being read; try again in a minute" };
	const store = new DrizzleLinkedInStore(app.db);
	const blocked = await store.blocked(LOCAL_USER_ID);
	if (blocked) return { stop: `LinkedIn is stopped: ${blocked.reason}` };
	const runId = await store.startRun(LOCAL_USER_ID, "link");
	const none = {
		searches: [],
		pagesRead: 0,
		results: 0,
		duplicates: 0,
		listingsRead: 0,
		newJobIds: [],
		opened: 0,
	};
	const finish = (outcome: string, stopReason: string | null, pages: number) =>
		store.finishRun(runId, {
			runId,
			pagesUsed: pages,
			listingsRead: outcome === "done" ? 1 : 0,
			jobsInserted: 0,
			duplicates: 0,
			outcome,
			stopReason,
			parts: { topPicks: none, searches: none },
		});
	const slot = await store.reservePage(LOCAL_USER_ID, runId);
	if (!slot.ok) {
		const reason =
			slot.reason === "cap"
				? `LinkedIn's ${slot.cap} pages a day are used; try again later`
				: `LinkedIn is stopped: ${slot.block.reason}`;
		await finish(
			slot.reason === "cap" ? "page_cap" : "refused_blocked",
			reason,
			0,
		);
		return { stop: reason };
	}
	busy = true;
	const origin = app.init.test?.linkedinOrigin;
	const host = new URL(origin ?? LINKEDIN_ORIGIN).hostname;
	const url = `${origin ?? LINKEDIN_ORIGIN}/jobs/view/${jobId}/`;
	let browser: Awaited<ReturnType<typeof openLinkedIn>> | null = null;
	try {
		// One page the user asked for: a check stops it at once, as before.
		browser = await openLinkedIn(app, false);
		const page = await browser.open(url);
		const stop = detectLinkedInStop(page, host);
		if (stop) {
			// A check, sign-in or warning blocks; anything else ends this one read only.
			if (isHeldStop(stop)) await store.block(LOCAL_USER_ID, stop);
			await finish(stop.kind, stop.reason, 1);
			return { stop: `LinkedIn stopped the read: ${stop.reason}` };
		}
		const listing = parseJobView(page.html, page.url, jobId);
		await finish("done", null, 1);
		return { listing, url: `${LINKEDIN_ORIGIN}/jobs/view/${jobId}/` };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await finish("error", reason, 1).catch(() => {});
		return { stop: `LinkedIn could not be read: ${reason}` };
	} finally {
		await browser?.close().catch(() => {});
		busy = false;
	}
}
