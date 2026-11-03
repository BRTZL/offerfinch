import { parse } from "node-html-parser";

import { htmlToText } from "../domain/text";
import type { WorkplaceType } from "../domain/types";
import { htmlToMarkdown } from "./markdown";

/** A job found on a careers page. Description and location are filled from the detail page when missing. */
export interface ScrapedJob {
	url: string;
	title: string;
	externalId?: string;
	locations?: string[];
	workplaceType?: WorkplaceType;
	descriptionText?: string;
	employmentType?: string;
	publishedAt?: Date;
}

export type PageParser = (html: string, pageUrl: string) => ScrapedJob[];

function absolute(href: string, base: string): string | null {
	try {
		const url = new URL(href, base);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

export function jsonLdNodes(html: string): Record<string, unknown>[] {
	const root = parse(html, { blockTextElements: { script: true } });
	const nodes: Record<string, unknown>[] = [];
	const visit = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") {
			const node = value as Record<string, unknown>;
			nodes.push(node);
			if (node["@graph"]) visit(node["@graph"]);
		}
	};
	for (const script of root.querySelectorAll(
		'script[type="application/ld+json"]',
	)) {
		try {
			visit(JSON.parse(script.rawText));
		} catch {
			// Ignore malformed blocks; other parsers still run.
		}
	}
	return nodes;
}

function hasType(node: Record<string, unknown>, type: string): boolean {
	const t = node["@type"];
	return Array.isArray(t) ? t.includes(type) : t === type;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function postingLocations(node: Record<string, unknown>): string[] {
	const raw = node.jobLocation;
	const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
	const locations = list
		.map((loc) => {
			const address = (loc as { address?: Record<string, unknown> | string })
				?.address;
			if (typeof address === "string") return address;
			// biome-ignore lint/complexity/noUselessUndefined: map requires an explicit value for a missing address.
			if (!address) return undefined;
			const country = address.addressCountry;
			const countryName =
				typeof country === "string"
					? country
					: str((country as { name?: unknown })?.name);
			return [
				str(address.addressLocality),
				str(address.addressRegion),
				countryName,
			]
				.filter(Boolean)
				.join(", ");
		})
		.filter((value): value is string => Boolean(value));
	const applicant = node.applicantLocationRequirements;
	const applicantList = Array.isArray(applicant)
		? applicant
		: applicant
			? [applicant]
			: [];
	for (const req of applicantList) {
		const name = str((req as { name?: unknown })?.name);
		if (name) locations.push(`Remote (${name})`);
	}
	return locations;
}

/** schema.org JobPosting blocks, the most reliable signal a careers page can give. */
export const jsonLdJobPostings: PageParser = (html, pageUrl) =>
	jsonLdNodes(html)
		.filter((node) => hasType(node, "JobPosting"))
		.map((node) => {
			const identifier = node.identifier as
				| { value?: unknown }
				| string
				| undefined;
			const remote = str(node.jobLocationType)?.toUpperCase() === "TELECOMMUTE";
			return {
				url: absolute(str(node.url) ?? pageUrl, pageUrl) ?? pageUrl,
				title: str(node.title) ?? "",
				externalId:
					typeof identifier === "string" ? identifier : str(identifier?.value),
				locations: postingLocations(node),
				workplaceType: remote ? ("remote" as const) : undefined,
				descriptionText: htmlToMarkdown(str(node.description) ?? ""),
				employmentType: Array.isArray(node.employmentType)
					? node.employmentType.join(", ")
					: str(node.employmentType),
				publishedAt: str(node.datePosted)
					? new Date(str(node.datePosted) as string)
					: undefined,
			};
		})
		.filter((job) => job.title);

/** schema.org ItemList of job links, as on tessera.example/careers. */
export const jsonLdItemList: PageParser = (html, pageUrl) =>
	jsonLdNodes(html)
		.filter((node) => hasType(node, "ItemList"))
		.flatMap((node) =>
			Array.isArray(node.itemListElement) ? node.itemListElement : [],
		)
		.map((item) => {
			const entry = item as Record<string, unknown>;
			const url =
				str(entry.url) ??
				str((entry.item as { "@id"?: unknown })?.["@id"]) ??
				str(entry.item);
			return {
				url: url ? absolute(url, pageUrl) : null,
				title: str(entry.name) ?? "",
			};
		})
		.filter((job): job is { url: string; title: string } =>
			Boolean(job.url && job.title),
		)
		.filter((job) => job.url !== pageUrl);

const JOB_PATH =
	/\/(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|roles?|kariyer|ilanlar?)\/[^/?#]{3,}/i;

/** Same-site links whose path looks like a job page. Last resort before the LLM. */
export const jobLinks: PageParser = (html, pageUrl) => {
	const root = parse(html);
	const base = new URL(pageUrl);
	const seen = new Set<string>();
	const jobs: ScrapedJob[] = [];
	for (const anchor of root.querySelectorAll("a[href]")) {
		const url = absolute(anchor.getAttribute("href") ?? "", pageUrl);
		if (!url) continue;
		const parsed = new URL(url);
		if (
			parsed.hostname.replace(/^www\./, "") !==
			base.hostname.replace(/^www\./, "")
		)
			continue;
		if (
			!JOB_PATH.test(parsed.pathname) ||
			parsed.pathname.replace(/\/$/, "") === base.pathname.replace(/\/$/, "")
		)
			continue;
		const title = anchor.textContent.replace(/\s+/g, " ").trim();
		if (title.length < 4 || title.length > 120) continue;
		const key = `${parsed.origin}${parsed.pathname}`;
		if (seen.has(key)) continue;
		seen.add(key);
		jobs.push({ url, title });
	}
	return jobs;
};

/** Per-site parsers, chosen with a company's `scrape_parser`. */
const SITE_PARSERS: Record<string, PageParser> = {
	"json-ld": jsonLdJobPostings,
	"item-list": jsonLdItemList,
	links: jobLinks,
	tesseraapp: (html, pageUrl) =>
		jsonLdItemList(html, pageUrl).filter((job) => !/\/tr\//.test(job.url)),
};

/** Default chain: JSON-LD postings, then an ItemList, then job-looking links. */
export function parseListing(
	html: string,
	pageUrl: string,
	parser?: string | null,
): ScrapedJob[] {
	if (parser && SITE_PARSERS[parser])
		return SITE_PARSERS[parser](html, pageUrl);
	for (const candidate of [jsonLdJobPostings, jsonLdItemList, jobLinks]) {
		const jobs = candidate(html, pageUrl);
		if (jobs.length > 0) return jobs;
	}
	return [];
}

/** Visible text and links of a page, for the LLM fallback. */
export function pageDigest(
	html: string,
	pageUrl: string,
): { text: string; links: { text: string; url: string }[] } {
	const root = parse(html);
	for (const el of root.querySelectorAll("script, style, noscript, svg"))
		el.remove();
	const links = root
		.querySelectorAll("a[href]")
		.map((a) => ({
			text: a.textContent.replace(/\s+/g, " ").trim(),
			url: absolute(a.getAttribute("href") ?? "", pageUrl),
		}))
		.filter((l): l is { text: string; url: string } =>
			Boolean(l.url && l.text),
		);
	return {
		text: htmlToText(root.toString()).slice(0, 20_000),
		links: links.slice(0, 400),
	};
}
