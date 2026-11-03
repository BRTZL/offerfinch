import { type HTMLElement, parse } from "node-html-parser";
import type { SiteReader } from "../sites/provider";
import {
	firstMarker,
	onSite,
	type SitePage,
	type SiteStop,
} from "../sites/read";
import {
	type SearchBackend,
	SearchBackendError,
	type SearchHit,
} from "./search";

/**
 * DuckDuckGo's HTML results page as the search behind job-board search: one results page per
 * query, read in the app's hidden DuckDuckGo tab (its own session), with a pause between pages.
 * Read only: the page is opened and read, nothing is clicked or typed. DuckDuckGo's bot check is a
 * check like any site's: the run waits for the user to solve it in the live sheet, and stops if
 * they don't. Checked against the live page on 2026-11-02 (`real-duckduckgo-*` fixtures).
 */
export const DUCKDUCKGO_ORIGIN = "https://html.duckduckgo.com";

export const DUCKDUCKGO_SELECTORS = {
	/** The results column; present with or without results. */
	results: "#links",
	noResults: ".no-results",
	/** One organic result's title link (its href goes through DuckDuckGo's /l/?uddg= redirect). */
	link: ".result:not(.result--ad) a.result__a",
} as const;

/** The results' snippets: the postings' own words, not DuckDuckGo's. */
export const DUCKDUCKGO_POSTING_TEXT = ".result__snippet";

/** The page has rendered: results, none, or the bot check. */
export const DUCKDUCKGO_READY = `${DUCKDUCKGO_SELECTORS.results}, ${DUCKDUCKGO_SELECTORS.noResults}, .anomaly-modal__modal, #challenge-form`;

export function duckDuckGoUrl(origin: string, query: string): string {
	return `${origin}/html/?q=${encodeURIComponent(query)}`;
}

const MARKERS: { pattern: RegExp; stop: SiteStop; on: "text" | "markup" }[] = [
	{
		pattern: /class="[^"]*\banomaly-modal|id="challenge-form"/i,
		stop: { kind: "captcha", reason: "DuckDuckGo's bot check" },
		on: "markup",
	},
	{
		pattern:
			/bots use duckduckgo too|complete the following challenge|select all squares containing/i,
		stop: { kind: "captcha", reason: "DuckDuckGo's bot check" },
		on: "text",
	},
];

/** The stop a DuckDuckGo page calls for (a bot check, a refusal, another host), or null. */
export function detectDuckDuckGoStop(
	page: SitePage,
	expectedHost = new URL(DUCKDUCKGO_ORIGIN).host,
): SiteStop | null {
	let url: URL;
	try {
		url = new URL(page.url);
	} catch {
		return { kind: "unusual_page", reason: "the browser reported no page URL" };
	}
	if (!onSite(url.host, expectedHost))
		return {
			kind: "unusual_page",
			reason: "the page left DuckDuckGo for another host",
		};
	// The page first, whatever its status: a bot check is the user's to solve (held).
	const marked = firstMarker(
		page,
		DUCKDUCKGO_POSTING_TEXT,
		MARKERS.map(({ pattern, stop, on }) => ({ pattern, on, ...stop })),
	);
	if (marked) return marked;
	if (page.status === 403 || page.status === 429)
		return {
			kind: "blocked",
			reason: `HTTP ${page.status}: DuckDuckGo refused the search`,
		};
	if (page.status !== null && page.status >= 400)
		return { kind: "unusual_page", reason: `HTTP ${page.status}` };
	return null;
}

/** Where a result link points: DuckDuckGo's redirect carries the target in `uddg`. */
function target(href: string): string | null {
	try {
		const url = new URL(href, DUCKDUCKGO_ORIGIN);
		const inner = /\/l\/?$/.test(url.pathname)
			? url.searchParams.get("uddg")
			: url.toString();
		if (!inner) return null;
		const out = new URL(inner);
		if (out.protocol !== "https:" && out.protocol !== "http:") return null;
		if (/(^|\.)duckduckgo\.com$/i.test(out.hostname)) return null;
		return out.toString();
	} catch {
		return null;
	}
}

const text = (el: HTMLElement) => el.textContent.replace(/\s+/g, " ").trim();

/** The organic results of one page (ads skipped); a page that is neither results nor "none" is a stop. */
export function readDuckDuckGoResults(
	html: string,
): { hits: SearchHit[] } | { stop: SiteStop } {
	const root = parse(html, { comment: false });
	if (root.querySelector(DUCKDUCKGO_SELECTORS.noResults)) return { hits: [] };
	const list = root.querySelector(DUCKDUCKGO_SELECTORS.results);
	if (!list)
		return {
			stop: {
				kind: "selectors",
				reason: `DuckDuckGo: "results" (${DUCKDUCKGO_SELECTORS.results}) found nothing`,
			},
		};
	const hits: SearchHit[] = [];
	for (const a of list.querySelectorAll(DUCKDUCKGO_SELECTORS.link)) {
		const url = target(a.getAttribute("href") ?? "");
		if (url) hits.push({ url, title: text(a) });
	}
	return { hits };
}

export interface DuckDuckGoOptions {
	/** Test runs only: a local stand-in. */
	origin?: string;
	/** The pause before every results page but the first, chosen in this range. */
	gapSeconds?: [number, number];
	sleep: (ms: number) => Promise<void>;
	random: () => number;
	/** The page a search stopped on (not a check): kept locally for diagnosis. */
	debug?: (page: SitePage, stop: SiteStop) => Promise<void>;
}

/**
 * Job-board search's backend: DuckDuckGo's results pages in the app's DuckDuckGo tab. The tab is
 * taken at the first search and let go by `close` (the provider calls it when its run ends). A
 * stop ends the run with a SearchBackendError naming it; the next scan searches again.
 */
export class DuckDuckGoSearch implements SearchBackend {
	readonly name = "DuckDuckGo";
	private reader: SiteReader | null = null;
	private pages = 0;
	private readonly origin: string;

	constructor(
		private readonly openReader: (signal?: AbortSignal) => Promise<SiteReader>,
		private readonly options: DuckDuckGoOptions,
	) {
		this.origin = options.origin ?? DUCKDUCKGO_ORIGIN;
	}

	async search(
		query: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<SearchHit[]> {
		signal?.throwIfAborted();
		this.reader ??= await this.openReader(signal);
		if (this.pages > 0) {
			const [min, max] = this.options.gapSeconds ?? [8, 20];
			await this.options.sleep(
				Math.round((min + (max - min) * this.options.random()) * 1000),
			);
			signal?.throwIfAborted();
		}
		this.pages++;
		const page = await this.reader.open(duckDuckGoUrl(this.origin, query));
		const stop =
			detectDuckDuckGoStop(page, new URL(this.origin).host) ??
			(() => {
				const read = readDuckDuckGoResults(page.html);
				return "stop" in read ? read.stop : null;
			})();
		if (stop) {
			if (stop.kind !== "captcha")
				await this.options.debug?.(page, stop).catch(() => {});
			throw new SearchBackendError(
				this.name,
				page.status ?? 0,
				`DuckDuckGo stopped the search: ${stop.reason}`,
				stop,
			);
		}
		const read = readDuckDuckGoResults(page.html);
		return "hits" in read ? read.hits.slice(0, limit) : [];
	}

	async close(): Promise<void> {
		const reader = this.reader;
		this.reader = null;
		this.pages = 0;
		await reader?.close();
	}
}
