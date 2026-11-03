import { type HTMLElement, parse } from "node-html-parser";
import { htmlToMarkdown } from "../scrape/markdown";

import type { SiteConfig, SiteSelectors, SiteStopKind } from "./sites";
import { HELD_STOP_KINDS } from "./stops";

/** A page as the browser loaded it. */
export interface SitePage {
	/** Where the browser ended, after any redirect. */
	url: string;
	status: number | null;
	html: string;
	/**
	 * The text the page shows, as the browser rendered it (hidden elements left out), without the
	 * posting's own description. The desktop app's tabs give it; when absent (tests, a page from
	 * elsewhere) it is derived from the markup by `visibleText`.
	 */
	text?: string;
	/** The redirects the load went through before `url`, in order (when the tab reports them). */
	redirects?: string[];
	/**
	 * Set when the browser refused the load (it reached this Mac or a private network): the page
	 * holds no content and is not read.
	 */
	refused?: string;
	/**
	 * The page headed here (a redirect) and the browser did not follow it: no content. Web
	 * search authorizes the target and opens it itself, or sets the result aside.
	 */
	redirect?: string;
}

export interface SiteStop {
	kind: SiteStopKind;
	/** What was seen, without page text or account data. */
	reason: string;
	/** For a selector miss: which one. */
	selector?: keyof SiteSelectors;
}

/**
 * Shared signs of a check or a block, on either site. `markup` markers are read in the page's
 * tags and attributes (an iframe, a script's src, an id); `text` markers in what the page shows.
 * Neither reads inline script bodies: they hold every message a page might ever show ("Too many
 * requests. Try again in an hour." sits in Glassdoor's translations on every normal page).
 */
export interface StopMarker {
	pattern: RegExp;
	kind: SiteStopKind;
	reason: string;
	on: "text" | "markup";
}

const COMMON: StopMarker[] = [
	{
		pattern:
			/<iframe[^>]+(?:captcha|arkoselabs|funcaptcha|recaptcha|hcaptcha)|id="px-captcha"/i,
		kind: "captcha",
		reason: "CAPTCHA on the page",
		on: "markup",
	},
	{
		pattern: /challenges\.cloudflare\.com|cf-chl-|<title>\s*just a moment/i,
		kind: "security_check",
		reason: "a browser check",
		on: "markup",
	},
	{
		pattern:
			/checking your browser|verify (?:that )?you(?:'|’)?re (?:a )?human|verify (?:that )?you are (?:a )?human|are you a robot/i,
		kind: "security_check",
		reason: "a browser check",
		on: "text",
	},
	{
		pattern:
			/access (?:to this page )?(?:has been )?denied|unusual (?:traffic|activity)|too many requests/i,
		kind: "blocked",
		reason: "the site refused the request",
		on: "text",
	},
];

/**
 * A check, CAPTCHA or refusal on any site's page (web search's results): the shared markers only.
 * Such a page is skipped, never waited on: it is not a source the user signed up to.
 */
export function detectAnySiteCheck(page: SitePage): SiteStop | null {
	return firstMarker(page, "[data-none]", COMMON);
}

/**
 * The stop a page calls for: a sign-in wall, a CAPTCHA or check, a refusal, or a page that is
 * not on the site. Null for a normal page. There is no retry or workaround: a stop ends the run
 * (in the desktop app, after the user had the chance to solve a check by hand).
 */
export function detectSiteStop(
	page: SitePage,
	site: SiteConfig,
	host = site.host,
): SiteStop | null {
	let url: URL;
	try {
		url = new URL(page.url);
	} catch {
		return { kind: "unusual_page", reason: "the browser reported no page URL" };
	}
	for (const { pattern, kind, reason } of site.stopPaths)
		if (pattern.test(url.pathname)) return { kind, reason };
	if (!onSite(url.host, host))
		return {
			kind: "unusual_page",
			reason: `the page left ${site.label} for another host`,
		};
	// The page first, whatever its status: Cloudflare serves its check with HTTP 403, and a check
	// or sign-in is the user's to clear in the live sheet (held), never a refusal to retry.
	const marked = firstMarker(page, site.selectors.jobDescription, [
		...site.stopMarkers,
		...COMMON,
	]);
	if (marked) return marked;
	if (page.status === 403 || page.status === 429)
		return {
			kind: "blocked",
			reason: `HTTP ${page.status}: ${site.label} refused the request`,
		};
	if (page.status !== null && page.status >= 400)
		return { kind: "unusual_page", reason: `HTTP ${page.status}` };
	return null;
}

/**
 * The page is on the site: its host, or a regional host of the same site (Indeed sends a
 * signed-in user from www.indeed.com to tr.indeed.com, uk.indeed.com, ...).
 */
export function onSite(actual: string, expected: string): boolean {
	if (actual === expected) return true;
	const base = expected.replace(/^www\./, "");
	// A local stand-in (127.0.0.1:port) or a bare domain has no regional hosts.
	if (base === expected || /^[\d.:]+$/.test(base)) return false;
	return actual === base || actual.endsWith(`.${base}`);
}

/**
 * The first marker the page shows: checks and sign-in walls before refusals, so a page that is
 * both (a check saying "too many requests") is held for the user.
 */
export function firstMarker<K extends string>(
	page: SitePage,
	description: string,
	markers: {
		pattern: RegExp;
		kind: K;
		reason: string;
		on: "text" | "markup";
	}[],
): { kind: K; reason: string } | null {
	const own = pageOwn(page.html, description, page.text);
	const ordered = [
		...markers.filter((m) => HELD_STOP_KINDS.has(m.kind)),
		...markers.filter((m) => !HELD_STOP_KINDS.has(m.kind)),
	];
	for (const { pattern, kind, reason, on } of ordered)
		if (pattern.test(on === "text" ? own.text : own.markup))
			return { kind, reason };
	return null;
}

/** Elements the browser does not render: their text is not what the page shows. */
const NOT_SHOWN =
	"script, style, template, noscript, head, [hidden], [style*='display:none'], [style*='display: none'], [style*='visibility:hidden'], [style*='visibility: hidden']";

/**
 * The text a page shows, from its markup, when the browser did not give it: the body's text
 * without elements that are not rendered (`hidden`, inline display:none or visibility:hidden,
 * scripts, styles, templates) and without `description` (the posting's own text).
 */
export function visibleText(html: string, description: string): string {
	const root = parse(html, { comment: false });
	const body = root.querySelector("body") ?? root;
	for (const el of body.querySelectorAll(
		`${NOT_SHOWN}, ${description}, .grecaptcha-badge, .grecaptcha-logo`,
	))
		el.remove();
	return body.textContent.replace(/\s+/g, " ").trim();
}

/**
 * What the site itself shows on a page, for its stop markers. `text`: what it shows (the
 * browser's rendered text when given, else `visibleText`). `markup`: its tags and attributes,
 * without the employer's own description (which may say anything), inline script bodies or
 * styles, and without reCAPTCHA's invisible badge, which sits on normal Indeed pages and is not a
 * challenge. A script's src stays in the markup: a check page is known by the scripts it loads.
 */
export function pageOwn(
	html: string,
	description: string,
	shown?: string,
): { text: string; markup: string } {
	const root = parse(html, { comment: false });
	for (const el of root.querySelectorAll(
		`${description}, .grecaptcha-badge, .grecaptcha-logo`,
	))
		el.remove();
	for (const el of root.querySelectorAll("script, style, template"))
		el.set_content("");
	const markup = root.toString();
	const text = (shown ?? visibleText(html, description)).replace(/\s+/g, " ");
	return { text, markup };
}

export interface SiteCard {
	jobId: string;
	title: string;
	company: string;
	location: string;
}

const text = (el: HTMLElement | null | undefined) =>
	(el?.textContent ?? "").replace(/\s+/g, " ").trim();

const miss = (site: SiteConfig, selector: keyof SiteSelectors): SiteStop => ({
	kind: "selectors",
	reason: `${site.label}: "${selector}" (${site.selectors[selector]}) found nothing`,
	selector,
});

/** A search page's cards; a missing required selector is a stop naming it. */
export function readSearchPage(
	html: string,
	site: SiteConfig,
): { cards: SiteCard[] } | { stop: SiteStop } {
	const root = parse(html, { comment: false });
	const s = site.selectors;
	if (root.querySelector(s.noResults)) return { cards: [] };
	if (!root.querySelector(s.resultsList))
		return { stop: miss(site, "resultsList") };
	const cards = root.querySelectorAll(s.card);
	if (cards.length === 0) return { stop: miss(site, "card") };
	const out: SiteCard[] = [];
	for (const card of cards) {
		// The id is on the card itself (Glassdoor's <li data-jobid>) or on an element inside it.
		const id =
			card.getAttribute(s.cardJobIdAttribute) ??
			card.querySelector(s.cardJobId)?.getAttribute(s.cardJobIdAttribute);
		if (!id) return { stop: miss(site, "cardJobId") };
		const title = text(card.querySelector(s.cardTitle));
		if (!title) return { stop: miss(site, "cardTitle") };
		const company = text(card.querySelector(s.cardCompany));
		if (!company) return { stop: miss(site, "cardCompany") };
		out.push({
			jobId: id,
			title,
			company,
			location: text(card.querySelector(s.cardLocation)),
		});
	}
	return { cards: out };
}

/** A job page's description; a missing required selector is a stop naming it. */
export function readJobPage(
	html: string,
	site: SiteConfig,
): { title: string; description: string } | { stop: SiteStop } {
	const root = parse(html, { comment: false });
	const title = text(root.querySelector(site.selectors.jobTitle));
	if (!title) return { stop: miss(site, "jobTitle") };
	const body = root.querySelector(site.selectors.jobDescription);
	if (!body) return { stop: miss(site, "jobDescription") };
	const description = htmlToMarkdown(body.innerHTML);
	if (!description) return { stop: miss(site, "jobDescription") };
	return { title, description };
}
