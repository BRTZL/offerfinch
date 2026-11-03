import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { decodeEntities } from "../domain/text";
import { CHROME_NAME, htmlToMarkdown } from "./markdown";
import { jsonLdNodes, postingLocations } from "./parsers";

export { cleanPostingText, htmlToMarkdown, looksLikeRawPage } from "./markdown";

const POSTING_WORDS =
	/\b(?:requirements?|qualifications?|responsibilit(?:y|ies)|what you(?:'|’)ll do|what you bring|about the (?:role|job|position)|about you|your profile|your tasks|experience (?:with|in)|we offer|benefits|who you are)\b/i;

/** Enough text, with the words a job posting uses. */
export function looksLikePosting(markdown: string): boolean {
	return markdown.length >= 300 && POSTING_WORDS.test(markdown);
}

export interface PagePosting {
	title: string;
	company?: string;
	location?: string;
	employmentType?: string;
	datePosted?: Date;
	/** Markdown, the posting's own words. */
	description: string;
	via: "json-ld" | "readability";
}

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim()
		? decodeEntities(value).trim()
		: undefined;

/** 1. schema.org JobPosting, the page's own structured data. */
export function postingFromJsonLd(html: string): PagePosting | null {
	for (const node of jsonLdNodes(html)) {
		const type = node["@type"];
		if (
			!(Array.isArray(type)
				? type.includes("JobPosting")
				: type === "JobPosting")
		)
			continue;
		const title = str(node.title);
		const description = htmlToMarkdown(str(node.description) ?? "");
		if (!title || description.length < 80) continue;
		const org = node.hiringOrganization;
		const company =
			typeof org === "string"
				? str(org)
				: str((org as { name?: unknown } | undefined)?.name);
		const locations = postingLocations(node);
		const remote = str(node.jobLocationType)?.toUpperCase() === "TELECOMMUTE";
		const location =
			locations.join("; ") || (remote ? "Remote" : undefined) || undefined;
		const employmentType = Array.isArray(node.employmentType)
			? node.employmentType.filter((t) => typeof t === "string").join(", ")
			: str(node.employmentType);
		const posted = str(node.datePosted);
		const datePosted = posted ? new Date(posted) : undefined;
		return {
			title,
			company,
			location,
			employmentType: employmentType || undefined,
			datePosted:
				datePosted && !Number.isNaN(datePosted.getTime())
					? datePosted
					: undefined,
			description,
			via: "json-ld",
		};
	}
	return null;
}

/** "Software Engineer II - Backend job in Dubai | Delivery Hero" → the part before the site. */
function titleWithoutSite(title: string, site?: string): string {
	const parts = title.split(/\s+[|–—-]\s+/);
	if (
		parts.length > 1 &&
		site &&
		parts.at(-1)?.toLowerCase() === site.toLowerCase()
	)
		parts.pop();
	return parts.length > 1 && !site ? (parts[0] ?? title) : parts.join(" - ");
}

/** 2. The page's main content (Mozilla Readability), without menus, banners or footers. */
export function postingFromMainContent(
	html: string,
	pageUrl: string,
): PagePosting | null {
	const { document } = parseHTML(
		html.replace(/<!doctype[^>]*>/gi, "<!doctype html>"),
	);
	const meta = (name: string) =>
		document
			.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
			?.getAttribute("content")
			?.trim() || undefined;
	const site = meta("og:site_name");
	const h1 = document
		.querySelector("h1")
		?.textContent?.replace(/\s+/g, " ")
		.trim();
	// Furniture Readability may keep: cookie banners, skip links, menus.
	for (const el of document.querySelectorAll(
		"nav, header, footer, aside, form, dialog, [role=navigation], [role=banner], [role=contentinfo], [role=dialog], [aria-modal=true]",
	))
		el.remove();
	for (const el of document.querySelectorAll("[id], [class]")) {
		const name = `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""}`;
		if (
			CHROME_NAME.test(name) &&
			el.tagName !== "BODY" &&
			el.tagName !== "MAIN"
		)
			el.remove();
	}
	// The page's own description container, when it names one and holds a posting's worth.
	const own = descriptionContainer(document);
	if (own) {
		const description = htmlToMarkdown(own.innerHTML);
		const company = site;
		const title = titleWithoutSite(
			(h1 && h1.length <= 140 ? h1 : (document.title ?? "")).trim(),
			company,
		);
		if (title && description.length >= 300)
			return {
				title,
				company,
				description,
				via: "readability",
			};
	}
	try {
		Object.defineProperty(document, "documentURI", { value: pageUrl });
	} catch {
		// Only used for relative links, which are dropped anyway.
	}
	const article = new Readability(
		document as unknown as ConstructorParameters<typeof Readability>[0],
		{
			charThreshold: 200,
		},
	).parse();
	if (!article?.content) return null;
	const description = htmlToMarkdown(article.content);
	if (description.length < 80) return null;
	const company = site ?? article.siteName?.trim() ?? undefined;
	const titleSource = h1 && h1.length <= 140 ? h1 : (article.title ?? "");
	const title = titleWithoutSite(titleSource.trim(), company);
	// Readability often repeats the title as the first heading.
	const body = description
		.replace(new RegExp(`^#{1,6} ${escapeRe(title)}\\n+`), "")
		.trim();
	return title
		? {
				title,
				company: company || undefined,
				description: body,
				via: "readability",
			}
		: null;
}

const DESCRIPTION_NAME =
	/job[-_ ]?(?:ad[-_ ]?)?description|jobad|posting[-_ ]?(?:body|description|content)|description[-_ ]?widget|job[-_ ]?details|vacancy[-_ ]?description/i;

type DomElement = {
	getAttribute(name: string): string | null;
	textContent: string | null;
	innerHTML: string;
};

/**
 * The element the page marks as the job description: one labelled exactly so (itemprop or
 * aria-label) first, then one whose id or class says so. The largest of a kind, so a section
 * of the description is not taken for all of it. Null when none holds a posting's worth.
 */
function descriptionContainer(document: {
	querySelectorAll(selector: string): Iterable<unknown>;
}): DomElement | null {
	const tiers: [DomElement | null, number][] = [
		[null, 0],
		[null, 0],
	];
	for (const node of document.querySelectorAll(
		"[itemprop], [aria-label], [id], [class]",
	)) {
		const el = node as DomElement;
		const labelled =
			el.getAttribute("itemprop") === "description" ||
			/^job description$/i.test((el.getAttribute("aria-label") ?? "").trim());
		const named = DESCRIPTION_NAME.test(
			`${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""}`,
		);
		if (!labelled && !named) continue;
		const tier = tiers[labelled ? 0 : 1] as [DomElement | null, number];
		const length = (el.textContent ?? "").replace(/\s+/g, " ").length;
		if (length > tier[1]) {
			tier[0] = el;
			tier[1] = length;
		}
	}
	for (const [el, length] of tiers) if (el && length >= 300) return el;
	return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The page's text for a last-resort read by the model: cleaned, chrome removed. */
export function pageMarkdown(html: string): string {
	return htmlToMarkdown(html);
}

/**
 * Every line of the output appears in the source (after the same cleaning): the guard that the
 * model picked boundaries and fields but wrote nothing of its own.
 */
export function linesFromSource(output: string, source: string): boolean {
	const norm = (l: string) => l.replace(/\s+/g, " ").trim().toLowerCase();
	const have = new Set(source.split("\n").map(norm).filter(Boolean));
	return output
		.split("\n")
		.map(norm)
		.filter(Boolean)
		.every((l) => have.has(l));
}

/** A field the model named, kept only when the source says it (case and spacing aside). */
export function fieldFromSource(
	value: string | undefined,
	source: string,
): string | undefined {
	const v = value?.replace(/\s+/g, " ").trim();
	if (!v) return undefined;
	return source.replace(/\s+/g, " ").toLowerCase().includes(v.toLowerCase())
		? v
		: undefined;
}
