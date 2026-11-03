import type { SiteTabId } from "../shared/bridge";
import {
	claimSiteTab,
	openPage,
	type PageDriver,
	peekPage,
	type ReadPage,
	type SiteCaller,
	settlePage,
} from "./site-tab";

/**
 * A site's check, handed to the user (PLAN rule 4): when a reader lands on a CAPTCHA, a "verify
 * you are human" page, a security checkpoint or a sign-in wall, the run pauses, the user is told,
 * and they solve it by hand in the live sheet (the same tab). The run looks at the page again
 * every few seconds with the reader's own detector; once the page is no longer a check it
 * continues, and if the time runs out it hands back the check page, so the reader stops and
 * records it exactly as before. Nothing here touches the check: no clicks, no typing, no
 * solver, no reload while waiting.
 */

export interface CheckStop {
	kind: string;
	reason: string;
}

/** The stops a person can clear in the page. Warnings, refusals and layout changes still stop. */
export const WAIT_FOR_USER: ReadonlySet<string> = new Set([
	"captcha",
	"security_check",
	"login_wall",
]);

export const CHECK_TIMEOUT_MS = 10 * 60_000;
/**
 * The most one run (a scan's provider, a LinkedIn run) waits on the user in total, across all
 * its checks: it keeps the scan step well under its one-hour limit (see SiteSearchProvider).
 * Spent, the next check stops the run at once, as before.
 */
export const CHECK_BUDGET_MS = 20 * 60_000;
export const CHECK_POLL_MS = 2_000;

export interface WaitOptions {
	detect: (page: ReadPage) => CheckStop | null;
	/** The page as it is now (no loading). */
	peek: () => Promise<ReadPage>;
	/** Waits for the reader's content to render, then reads. */
	settle: () => Promise<ReadPage>;
	/** Loads the page asked for again: once, when the user's solve left the tab elsewhere. */
	reopen: () => Promise<ReadPage>;
	onWait: (stop: CheckStop) => void | Promise<void>;
	onDone: (
		stop: CheckStop,
		outcome: "cleared" | "timeout",
	) => void | Promise<void>;
	timeoutMs?: number;
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** The run was stopped (its step ran out of time): stop waiting at once. */
	signal?: AbortSignal;
}

/** A sleep that ends early (rejecting) when the signal aborts. */
function sleepUnless(
	sleep: (ms: number) => Promise<void>,
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (!signal) return sleep(ms);
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		sleep(ms).then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

const pathOf = (url: string) => {
	try {
		return new URL(url).pathname.replace(/\/$/, "");
	} catch {
		return null;
	}
};

/**
 * The page a reader opened, or, when it was a check the user can clear, the page once they have
 * cleared it. On timeout: the last check page as it is, for the reader to stop on.
 */
export async function waitOutCheck(
	page: ReadPage,
	requested: string,
	o: WaitOptions,
): Promise<ReadPage> {
	const stop = o.detect(page);
	if (!stop || !WAIT_FOR_USER.has(stop.kind)) return page;
	const sleep =
		o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = o.now ?? Date.now;
	const waiting = (p: ReadPage) => {
		const s = o.detect(p);
		return Boolean(s && WAIT_FOR_USER.has(s.kind));
	};
	await o.onWait(stop);
	const deadline = now() + (o.timeoutMs ?? CHECK_TIMEOUT_MS);
	let last = page;
	let reopened = false;
	while (now() < deadline) {
		await sleepUnless(sleep, o.pollMs ?? CHECK_POLL_MS, o.signal);
		// Mid-navigation (the user just submitted the check) a read can fail: look again later.
		const current = await o.peek().catch(() => null);
		if (!current) continue;
		last = current;
		if (waiting(current)) continue;
		let next: ReadPage | null;
		if (pathOf(current.url) === pathOf(requested))
			next = await o.settle().catch(() => current);
		else if (!reopened) {
			// A sign-in often lands on the site's home page: the page asked for, once more.
			reopened = true;
			next = await o.reopen().catch(() => null);
		} else next = current;
		o.signal?.throwIfAborted();
		if (!next) continue;
		last = next;
		if (waiting(next)) continue;
		await o.onDone(stop, "cleared");
		return next;
	}
	await o.onDone(stop, "timeout");
	return (await o.peek().catch(() => null)) ?? last;
}

/* --------------------------------------------------------- live activity */

export interface SiteActivity {
	/** A run holds the site's tab now. */
	running: boolean;
	/** The check the run is waiting on the user for. */
	check: (CheckStop & { since: string }) | null;
	/** How the last check ended. */
	lastCheck: {
		outcome: "cleared" | "timeout";
		reason: string;
		at: string;
	} | null;
}

const activity = new Map<SiteTabId, SiteActivity>();

export function siteActivity(site: SiteTabId): SiteActivity {
	return activity.get(site) ?? { running: false, check: null, lastCheck: null };
}

function patch(site: SiteTabId, value: Partial<SiteActivity>) {
	activity.set(site, { ...siteActivity(site), ...value });
}

/* ------------------------------------------------------------ the reader */

/** What a site reader needs from the worker: the tab channel and what happens on a check. */
export interface SiteTabHost {
	site: SiteCaller;
	checkTimeoutMs?: number;
	checkPollMs?: number;
	/** The total a run may wait on the user (default CHECK_BUDGET_MS). */
	checkBudgetMs?: number;
	/** A run is waiting on the user: notify, show "Needs you". */
	onCheck(site: SiteTabId, stop: CheckStop): void | Promise<void>;
	onCheckDone(
		site: SiteTabId,
		stop: CheckStop,
		outcome: "cleared" | "timeout",
	): void | Promise<void>;
}

export interface TabReader {
	open(url: string): Promise<ReadPage>;
	close(): Promise<void>;
}

/**
 * A reader on the site's hidden tab: each `open` loads one page, waits for the reader's content
 * and reads it. With `waitForUser`, a check the user can clear pauses the run until they do (or
 * the time runs out). `driver` is for tests: a fake instead of main's tab.
 */
export async function openTabReader(
	host: SiteTabHost,
	options: {
		site: SiteTabId;
		ready: string;
		/** The posting's own text, left out of what the check markers read. */
		exclude?: string;
		detect: (page: ReadPage) => CheckStop | null;
		waitForUser: boolean;
		driver?: PageDriver;
		sleep?: (ms: number) => Promise<void>;
		now?: () => number;
		/** Aborts when the run is stopped (its scan step ran out of time). */
		signal?: AbortSignal;
	},
): Promise<TabReader> {
	const { site, detect, signal } = options;
	const spec = { ready: options.ready, exclude: options.exclude };
	const now = options.now ?? Date.now;
	signal?.throwIfAborted();
	const driver = options.driver ?? (await claimSiteTab(host.site, site));
	patch(site, { running: true, check: null });
	/** What is left of this run's budget for waiting on the user. */
	let budget = host.checkBudgetMs ?? CHECK_BUDGET_MS;
	return {
		async open(url) {
			signal?.throwIfAborted();
			const page = await openPage(driver, url, spec);
			signal?.throwIfAborted();
			// No budget left: the check is not waited on, and the reader stops on it.
			if (!options.waitForUser || budget <= 0) return page;
			const started = now();
			try {
				return await waitOutCheck(page, url, {
					detect,
					peek: () => peekPage(driver, spec.exclude),
					settle: () => settlePage(driver, spec),
					reopen: () => openPage(driver, url, spec),
					onWait: async (stop) => {
						patch(site, {
							check: { ...stop, since: new Date().toISOString() },
						});
						await host.onCheck(site, stop);
					},
					onDone: async (stop, outcome) => {
						patch(site, {
							check: null,
							lastCheck: {
								outcome,
								reason: stop.reason,
								at: new Date().toISOString(),
							},
						});
						await host.onCheckDone(site, stop, outcome);
					},
					timeoutMs: Math.min(host.checkTimeoutMs ?? CHECK_TIMEOUT_MS, budget),
					pollMs: host.checkPollMs,
					sleep: options.sleep,
					now,
					signal,
				});
			} finally {
				budget -= now() - started;
				// Stopped mid-wait: nobody is waited on any more.
				if (signal?.aborted) patch(site, { check: null });
			}
		},
		async close() {
			patch(site, { running: false, check: null });
			await driver.release();
		},
	};
}
