import { type HTMLElement, parse } from "node-html-parser";
import type { WorkplaceType } from "../domain/types";
import { htmlToMarkdown } from "../scrape/markdown";
import { LINKEDIN_SELECTORS, type LinkedInSelector } from "./selectors";

/** A required selector found nothing: the layout changed, so the runner stops instead of guessing. */
export class LinkedInSelectorError extends Error {
	constructor(
		readonly selector: LinkedInSelector,
		readonly page: "search" | "job",
	) {
		super(
			`LinkedIn ${page} page: required selector "${selector}" (${LINKEDIN_SELECTORS[selector]}) found nothing`,
		);
		this.name = "LinkedInSelectorError";
	}
}

export interface LinkedInCard {
	/** LinkedIn's job id. */
	jobId: string;
	title: string;
	company: string;
	location: string;
}

export interface LinkedInListing {
	jobId: string;
	title: string;
	company: string;
	locations: string[];
	workplaceType: WorkplaceType;
	employmentType?: string;
	descriptionText: string;
	/** Shown as Easy Apply: handed off to the LinkedIn posting, never applied through it. */
	easyApply: boolean;
	/** The employer's apply link, from the apply control's href when it has one; never opened. */
	externalApplyUrl: string | null;
}

const text = (el: HTMLElement | null) =>
	(el?.textContent ?? "").replace(/\s+/g, " ").trim();

function one(
	root: HTMLElement,
	selector: LinkedInSelector,
	page: "search" | "job",
): HTMLElement {
	const el = root.querySelector(LINKEDIN_SELECTORS[selector]);
	if (!el || !text(el)) throw new LinkedInSelectorError(selector, page);
	return el;
}

/** The page is one of LinkedIn's server-driven (SDUI) screens: the newer layout. */
function isSduiPage(root: HTMLElement): boolean {
	return Boolean(root.querySelector(LINKEDIN_SELECTORS.sduiScreen));
}

/**
 * SDUI shows a search with no results in its results column with no cards. It has no test id
 * for that state, so its message is read (not seen live yet; LinkedIn's long-standing wording).
 */
const SDUI_NO_RESULTS =
	/no matching jobs found|no results found|no jobs found/i;

/** The cards of one search results page. A page with neither results nor a no-results banner is a selector failure. */
export function parseSearchResults(html: string): LinkedInCard[] {
	const root = parse(html);
	if (isSduiPage(root)) return parseSduiResults(root);
	if (!root.querySelector(LINKEDIN_SELECTORS.resultsList))
		throw new LinkedInSelectorError("resultsList", "search");
	const cards = root.querySelectorAll(LINKEDIN_SELECTORS.card);
	if (cards.length === 0) {
		if (root.querySelector(LINKEDIN_SELECTORS.noResults)) return [];
		throw new LinkedInSelectorError("card", "search");
	}
	return cards.map((card) => {
		const jobId =
			card.getAttribute(LINKEDIN_SELECTORS.cardJobIdAttribute) ?? "";
		if (!/^\d+$/.test(jobId))
			throw new LinkedInSelectorError("cardJobIdAttribute", "search");
		// A card LinkedIn has not drawn yet (below the fold: an empty placeholder with the job's
		// id, seen live on Top picks, 2026-11-03). The id is all the runner needs; the job page
		// gives the rest. A drawn card still needs its title and company.
		if (card.children.length === 0 && !text(card))
			return { jobId, title: "", company: "", location: "" };
		return {
			jobId,
			title: text(one(card, "cardTitle", "search")),
			company: text(one(card, "cardCompany", "search")),
			location: text(card.querySelector(LINKEDIN_SELECTORS.cardLocation)),
		};
	});
}

const CARD_KEY = "job-card-component-ref-";

/**
 * SDUI search results: each card once (its inner parts repeat the component key), its id from
 * the key. The runner needs only the id; the title (from the card's dismiss control) is read when
 * shown, and the job page gives everything else.
 */
function parseSduiResults(root: HTMLElement): LinkedInCard[] {
	const list = root.querySelector(LINKEDIN_SELECTORS.sduiResultsList);
	if (!list) throw new LinkedInSelectorError("sduiResultsList", "search");
	const seen = new Set<string>();
	const out: LinkedInCard[] = [];
	for (const card of list.querySelectorAll(LINKEDIN_SELECTORS.sduiCard)) {
		const jobId = (card.getAttribute("componentkey") ?? "").slice(
			CARD_KEY.length,
		);
		if (!/^\d+$/.test(jobId))
			throw new LinkedInSelectorError("sduiCard", "search");
		if (seen.has(jobId)) continue;
		seen.add(jobId);
		const dismiss =
			card
				.querySelector(LINKEDIN_SELECTORS.sduiCardDismiss)
				?.getAttribute("aria-label") ?? "";
		out.push({
			jobId,
			title: dismiss.replace(/^Dismiss\s+/, "").replace(/\s+job$/, ""),
			company: "",
			location: "",
		});
	}
	if (out.length === 0 && !SDUI_NO_RESULTS.test(text(list)))
		throw new LinkedInSelectorError("sduiCard", "search");
	return out;
}

function workplaceOf(value: string): WorkplaceType {
	if (/\bremote\b/i.test(value)) return "remote";
	if (/\bhybrid\b/i.test(value)) return "hybrid";
	if (/\bon-?site\b/i.test(value)) return "onsite";
	return "unknown";
}

/**
 * LinkedIn's external apply links go through its redirect (`/jobs/view/externalApply/<id>?url=…`
 * or `/safety/go/?url=…`); the employer's URL is the `url` parameter. Only http(s) links are kept.
 */
export function employerApplyUrl(href: string, pageUrl: string): string | null {
	let link: URL;
	try {
		link = new URL(href, pageUrl);
	} catch {
		return null;
	}
	// The classic layout's /jobs/view/externalApply/<id>?url=…, the SDUI layout's /safety/go/?url=….
	const inner = /\/externalApply\/|^\/safety\/go\/?$/.test(link.pathname)
		? link.searchParams.get("url")
		: link.toString();
	if (!inner) return null;
	try {
		const target = new URL(inner);
		if (target.protocol !== "https:" && target.protocol !== "http:")
			return null;
		// A link back into LinkedIn is not the employer's.
		if (/(^|\.)linkedin\.com$/i.test(target.hostname)) return null;
		return target.toString();
	} catch {
		return null;
	}
}

/** One job view page. Title, company and description are required; the rest is read when shown. */
export function parseJobView(
	html: string,
	pageUrl: string,
	jobId: string,
): LinkedInListing {
	const root = parse(html);
	if (isSduiPage(root)) return parseSduiJobView(root, pageUrl, jobId);
	const title = text(one(root, "jobTitle", "job"));
	const company = text(one(root, "jobCompany", "job"));
	const description = one(root, "jobDescription", "job");
	const tertiary = text(root.querySelector(LINKEDIN_SELECTORS.jobTertiary));
	const location = tertiary.split("·")[0]?.trim() ?? "";
	const preferences = text(
		root.querySelector(LINKEDIN_SELECTORS.jobPreferences),
	);
	const apply = root.querySelector(LINKEDIN_SELECTORS.applyButton);
	const applyText = text(apply);
	const href =
		apply?.getAttribute("href") ??
		apply?.querySelector("a[href]")?.getAttribute("href") ??
		null;
	return listingOf({
		jobId,
		title,
		company,
		location,
		preferences,
		description,
		easyApply: /easy apply/i.test(applyText),
		href,
		pageUrl,
	});
}

function listingOf(input: {
	jobId: string;
	title: string;
	company: string;
	location: string;
	preferences: string;
	description: HTMLElement;
	easyApply: boolean;
	href: string | null;
	pageUrl: string;
}): LinkedInListing {
	const employment = input.preferences.match(
		/\b(Full-time|Part-time|Contract|Temporary|Internship)\b/i,
	)?.[1];
	return {
		jobId: input.jobId,
		title: input.title,
		company: input.company,
		locations: input.location ? [input.location] : [],
		workplaceType: workplaceOf(`${input.preferences} ${input.location}`),
		employmentType: employment,
		descriptionText: htmlToMarkdown(input.description.innerHTML),
		easyApply: input.easyApply,
		externalApplyUrl:
			input.href && !input.easyApply
				? employerApplyUrl(input.href, input.pageUrl)
				: null,
	};
}

/**
 * SDUI job view: the title from the page's own title ("Title | Company | LinkedIn"), the company
 * from its labelled block, "About the job" as the description. The location is the first part
 * of the line under the title ("City, Region, Country · 6 days ago · …"), when shown.
 */
function parseSduiJobView(
	root: HTMLElement,
	pageUrl: string,
	jobId: string,
): LinkedInListing {
	const companyEl = root.querySelector(LINKEDIN_SELECTORS.sduiJobCompany);
	const company = (companyEl?.getAttribute("aria-label") ?? "")
		.replace(/^Company,\s*/, "")
		.replace(/\.$/, "")
		.trim();
	if (!company) throw new LinkedInSelectorError("sduiJobCompany", "job");
	const pageTitle = text(root.querySelector(LINKEDIN_SELECTORS.sduiJobTitle))
		// An unread count LinkedIn puts in front: "(3) Title | …".
		.replace(/^\(\d+\+?\)\s*/, "")
		.replace(/\s*\|\s*LinkedIn$/i, "");
	const suffix = ` | ${company}`;
	const title = (
		pageTitle.endsWith(suffix)
			? pageTitle.slice(0, -suffix.length)
			: pageTitle.replace(/\s*\|[^|]*$/, "")
	).trim();
	if (!title) throw new LinkedInSelectorError("sduiJobTitle", "job");
	const description = root.querySelector(LINKEDIN_SELECTORS.sduiJobDescription);
	if (!description || !text(description))
		throw new LinkedInSelectorError("sduiJobDescription", "job");
	// The "… more" control inside the text box is LinkedIn's, not the posting's.
	for (const el of description.querySelectorAll("button")) el.remove();
	const main =
		root.querySelector('section[aria-label="Primary content"]') ?? root;
	const line = main
		.querySelectorAll("p")
		.find((p) => p.firstElementChild?.tagName === "SPAN" && /·/.test(text(p)));
	const location = text(line?.firstElementChild ?? null);
	const chips = root
		.querySelectorAll(LINKEDIN_SELECTORS.sduiJobChips)
		.map((a) => text(a))
		.join(" ");
	const apply = root.querySelector(LINKEDIN_SELECTORS.sduiApply);
	const label = `${apply?.getAttribute("aria-label") ?? ""} ${text(apply)}`;
	return listingOf({
		jobId,
		title,
		company,
		location,
		preferences: chips,
		description,
		easyApply: /easy apply/i.test(label),
		href: apply?.getAttribute("href") ?? null,
		pageUrl,
	});
}
