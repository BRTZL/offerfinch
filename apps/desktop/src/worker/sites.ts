import type { SiteReader } from "@offerfinch/core/sites/provider";
import {
	detectAnySiteCheck,
	detectSiteStop,
} from "@offerfinch/core/sites/read";
import type { SiteId } from "@offerfinch/core/sites/sites";
import { SITES } from "@offerfinch/core/sites/sites";
import {
	DUCKDUCKGO_ORIGIN,
	DUCKDUCKGO_POSTING_TEXT,
	DUCKDUCKGO_READY,
	detectDuckDuckGoStop,
} from "@offerfinch/core/sources/duckduckgo";
import type { SiteTabId } from "../shared/bridge";

import { openTabReader, type SiteTabHost } from "./checks";

/**
 * Test runs only: the sites' pages served by a local stand-in (OFFERFINCH_SITE_ORIGINS, a JSON
 * map of site to origin). Never read outside test mode.
 */
export function siteOrigins(
	test: boolean,
): Partial<Record<SiteId | SiteTabId, string>> {
	if (!test || !process.env.OFFERFINCH_SITE_ORIGINS) return {};
	try {
		return JSON.parse(process.env.OFFERFINCH_SITE_ORIGINS);
	} catch {
		return {};
	}
}

/**
 * Indeed or Glassdoor in the site's hidden tab inside OfferFinch (its own session,
 * `persist:site-<id>`), with Electron's defaults: nothing hidden or disguised (PLAN rule 4).
 * Pages are only opened and read, never clicked or typed into; pop-ups are refused during a run.
 * In test runs main lets the tab load the stand-in's origin only, so a run never reaches the
 * real site. With `waitForUser` (scans), a check the user can clear pauses the run for them.
 */
export async function openSiteReader(
	host: SiteTabHost,
	site: SiteId,
	origin: string | undefined,
	waitForUser = true,
	signal?: AbortSignal,
): Promise<SiteReader> {
	const config = SITES[site];
	const expectedHost = new URL(origin ?? config.origin).host;
	const ready = [
		config.selectors.resultsList,
		config.selectors.noResults,
		config.selectors.jobDescription,
	].join(", ");
	return openTabReader(host, {
		site,
		ready,
		exclude: config.selectors.jobDescription,
		detect: (page) => detectSiteStop(page, config, expectedHost),
		waitForUser,
		signal,
	});
}

/**
 * DuckDuckGo's results pages, for job-board search, in its own hidden tab (`persist:site-
 * duckduckgo`), with Electron's defaults. Opened and read only. Its bot check is one the user can
 * clear: the run waits for them in the live sheet (scans), and stops if they don't.
 */
export async function openDuckDuckGoReader(
	host: SiteTabHost,
	origin: string | undefined,
	signal?: AbortSignal,
): Promise<SiteReader> {
	const expectedHost = new URL(origin ?? DUCKDUCKGO_ORIGIN).host;
	return openTabReader(host, {
		site: "duckduckgo",
		ready: DUCKDUCKGO_READY,
		exclude: DUCKDUCKGO_POSTING_TEXT,
		detect: (page) => detectDuckDuckGoStop(page, expectedHost),
		waitForUser: true,
		signal,
	});
}

/**
 * Web search's result pages, on any site, in their own hidden tab (`persist:site-web`), with
 * Electron's defaults. Opened and read only; a page with a check is skipped, never waited on (it
 * is not a site the user chose). In main, this tab reaches no private network address.
 */
export async function openWebPageReader(
	host: SiteTabHost,
	signal?: AbortSignal,
): Promise<SiteReader> {
	return openTabReader(host, {
		site: "web",
		// Structured data, or the page's main text: whatever comes first, then the read.
		ready:
			'script[type="application/ld+json"], [itemtype*="JobPosting"], main, article, h1',
		detect: (page) => detectAnySiteCheck(page),
		waitForUser: false,
		signal,
	});
}
