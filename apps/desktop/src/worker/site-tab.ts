import type { SiteTabId } from "../shared/bridge";
import type { SiteCall, SiteSnapshot } from "../shared/worker-protocol";

/**
 * The page-driving layer under the site readers (LinkedIn, Indeed, Glassdoor): the site's hidden
 * tab in main (src/main/site-browser.ts), reached through the worker protocol, or a fake in
 * tests. The readers' selectors, parsing, stop rules, pacing and caps stay in core; this layer
 * only opens a page, waits for it to render and reads it. Nothing is clicked or typed.
 */

/** A page as the readers see it (core's SitePage and LinkedInPage). */
export interface ReadPage {
	url: string;
	status: number | null;
	html: string;
	/** What the page shows (rendered text), without the reader's excluded posting text. */
	text?: string;
	/** The redirects the load went through (web tab). */
	redirects?: string[];
	/** The load was refused (a private address): no content, never read. */
	refused?: string;
	/** Web tab: the page headed here and was stopped (not followed): no content. */
	redirect?: string;
}

export type SiteCaller = (call: SiteCall) => Promise<unknown>;

/** Where a load ended, its status, its redirects and whether the browser refused it. */
interface NavigateResult {
	url: string;
	status: number | null;
	redirects?: string[];
	refused?: string;
	/** Web tab: a redirect stopped before its request, for the worker to authorize. */
	redirect?: string;
}

export interface PageDriver {
	navigate(url: string): Promise<NavigateResult>;
	/** True once the selector matches; false when the time ran out. */
	waitFor(selector: string, timeoutMs: number): Promise<boolean>;
	/** The page as it is now, without loading anything; `exclude`: elements left out of its text. */
	snapshot(exclude?: string): Promise<SiteSnapshot>;
	/** The run is over: the tab closes (unless a sheet shows it). */
	release(): Promise<void>;
}

/** Takes the site's tab for one run. Refused while its sign-in sheet is open. */
export async function claimSiteTab(
	call: SiteCaller,
	site: SiteTabId,
): Promise<PageDriver> {
	await call({ op: "claim", site });
	let released = false;
	return {
		navigate: (url) =>
			call({ op: "navigate", site, url }) as Promise<NavigateResult>,
		waitFor: (selector, timeoutMs) =>
			call({ op: "waitFor", site, selector, timeoutMs }) as Promise<boolean>,
		snapshot: (exclude) =>
			call({ op: "snapshot", site, exclude }) as Promise<SiteSnapshot>,
		release: async () => {
			if (released) return;
			released = true;
			await call({ op: "release", site });
		},
	};
}

/** How long a page may take to show the reader's content before it is read anyway. */
const RENDER_WAIT_MS = 15_000;

const asPage = (s: SiteSnapshot): ReadPage => ({
	url: s.url,
	status: s.status,
	html: s.refused || s.redirect ? "" : s.html,
	text: s.refused || s.redirect ? "" : s.text,
	...(s.refused ? { refused: s.refused } : {}),
	...(s.redirect ? { redirect: s.redirect } : {}),
});

/** How a reader reads its pages: when they have rendered, and what is the posting's own text. */
export interface ReadSpec {
	ready: string;
	/** Left out of the page's text (the employer's words), for the check markers. */
	exclude?: string;
	waitMs?: number;
}

/** Waits for the reader's "rendered" selector (or the time), then reads the page. */
export async function settlePage(
	driver: PageDriver,
	spec: ReadSpec,
): Promise<ReadPage> {
	await driver.waitFor(spec.ready, spec.waitMs ?? RENDER_WAIT_MS);
	return asPage(await driver.snapshot(spec.exclude));
}

/** Opens one page as the Chrome readers did: load, wait for its content, read. */
export async function openPage(
	driver: PageDriver,
	url: string,
	spec: ReadSpec,
): Promise<ReadPage> {
	const nav = await driver.navigate(url);
	// A stopped redirect: nothing to wait for or read.
	if (nav.redirect)
		return {
			url: nav.url,
			status: nav.status,
			html: "",
			text: "",
			redirect: nav.redirect,
			...(nav.redirects?.length ? { redirects: nav.redirects } : {}),
		};
	const page = await settlePage(driver, spec);
	const refused = page.refused ?? nav.refused;
	return {
		...page,
		...(nav.redirects?.length ? { redirects: nav.redirects } : {}),
		...(refused ? { refused, html: "", text: "" } : {}),
	};
}

export async function peekPage(
	driver: PageDriver,
	exclude?: string,
): Promise<ReadPage> {
	return asPage(await driver.snapshot(exclude));
}
