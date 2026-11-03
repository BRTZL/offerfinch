import { parse } from "node-html-parser";

import { decodeEntities } from "../domain/text";
import type { WorkplaceType } from "../domain/types";
import { htmlToMarkdown } from "../scrape/markdown";
import { postingLocations } from "../scrape/parsers";

/**
 * A job posting a page declares about itself, as schema.org JobPosting structured data: JSON-LD
 * (`<script type="application/ld+json">`, any nesting: @graph, arrays inside arrays) or
 * microdata (`itemtype="https://schema.org/JobPosting"`). Read deterministically: no model.
 */
export interface StructuredPosting {
	title: string;
	company: string;
	locations: string[];
	workplaceType: WorkplaceType;
	employmentType?: string;
	datePosted?: Date;
	/** When the posting closes; postings past it are not kept. Absent when unset or unreadable. */
	validThrough?: Date;
	/** Markdown, the posting's own words (its HTML description converted). */
	description: string;
	/** The posting's own URL when it names one. */
	url?: string;
	via: "json-ld" | "microdata";
}

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim()
		? decodeEntities(value).replace(/\s+/g, " ").trim()
		: undefined;

/**
 * Bounds on what a page's structured data may make the reader do: a hostile page cannot nest
 * deeper than this, hold more nodes, or have more of its HTML read.
 */
const LIMITS = {
	pageBytes: 5 * 1024 * 1024,
	blockBytes: 1024 * 1024,
	depth: 32,
	nodes: 10_000,
	items: 1_000,
};

/** A value as a flat list: arrays inside arrays opened, iteratively and within the bounds. */
function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) return value ? [value] : [];
	const out: unknown[] = [];
	const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 0 }];
	while (stack.length > 0 && out.length < LIMITS.items) {
		const { v, depth } = stack.pop() as { v: unknown; depth: number };
		if (!Array.isArray(v)) {
			out.push(v);
			continue;
		}
		if (depth >= LIMITS.depth) continue;
		for (let i = Math.min(v.length, LIMITS.items) - 1; i >= 0; i--)
			stack.push({ v: v[i], depth: depth + 1 });
	}
	return out;
}

/**
 * The objects in a page's JSON-LD blocks: each block (at most LIMITS.blockBytes) parsed on its
 * own, then walked without recursion through arrays, @graph and mainEntity, at most
 * LIMITS.depth deep and LIMITS.nodes in all. A block that does not parse is skipped.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep structured-data traversal and normalization in order so earlier job candidates retain precedence.
function ldNodes(html: string): Record<string, unknown>[] {
	const root = parse(html, { blockTextElements: { script: true } });
	const nodes: Record<string, unknown>[] = [];
	for (const script of root.querySelectorAll(
		'script[type="application/ld+json"]',
	)) {
		const text = script.rawText;
		if (text.length > LIMITS.blockBytes) continue;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			continue;
		}
		const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 0 }];
		while (stack.length > 0 && nodes.length < LIMITS.nodes) {
			const { v, depth } = stack.pop() as { v: unknown; depth: number };
			if (depth > LIMITS.depth || !v || typeof v !== "object") continue;
			if (Array.isArray(v)) {
				for (let i = Math.min(v.length, LIMITS.items) - 1; i >= 0; i--)
					stack.push({ v: v[i], depth: depth + 1 });
				continue;
			}
			const node = v as Record<string, unknown>;
			nodes.push(node);
			for (const key of ["mainEntity", "@graph"])
				if (node[key]) stack.push({ v: node[key], depth: depth + 1 });
		}
	}
	return nodes;
}

/** `JobPosting`, `schema:JobPosting` or `https://schema.org/JobPosting`. */
function isJobPosting(type: unknown): boolean {
	return list(type).some(
		(t) => typeof t === "string" && /(?:^|[/:#])JobPosting$/.test(t.trim()),
	);
}

function date(value: unknown): Date | undefined {
	const text = str(value);
	if (!text) return;
	const d = new Date(text);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

function organization(value: unknown): string {
	for (const org of list(value)) {
		const name =
			typeof org === "string"
				? str(org)
				: str((org as { name?: unknown } | null)?.name);
		if (name) return name;
	}
	return "";
}

/** Remote when the posting says so (TELECOMMUTE) or its places do; hybrid likewise. */
export function workplaceFrom(
	text: string,
	telecommute = false,
): WorkplaceType {
	if (
		telecommute ||
		/\bremote\b|\btelecommute\b|\bwork from home\b/i.test(text)
	)
		return "remote";
	if (/\bhybrid\b/i.test(text)) return "hybrid";
	return "unknown";
}

function fromJsonLd(node: Record<string, unknown>): StructuredPosting | null {
	const title = str(node.title) ?? str(node.name);
	const description = htmlToMarkdown(
		typeof node.description === "string"
			? decodeEntities(node.description)
			: "",
	);
	if (!title || description.length < 80) return null;
	const locations = postingLocations(node);
	const telecommute = list(node.jobLocationType).some(
		(t) => typeof t === "string" && t.toUpperCase() === "TELECOMMUTE",
	);
	if (telecommute && locations.length === 0) locations.push("Remote");
	const employment = list(node.employmentType)
		.map((t) => str(t))
		.filter(Boolean)
		.join(", ");
	return {
		title,
		company: organization(node.hiringOrganization),
		locations,
		workplaceType: workplaceFrom(
			`${locations.join(" ")} ${title}`,
			telecommute,
		),
		employmentType: employment || undefined,
		datePosted: date(node.datePosted),
		validThrough: date(node.validThrough),
		description,
		url: str(node.url),
		via: "json-ld",
	};
}

/** Microdata: an element with itemtype JobPosting and itemprop children. */
function fromMicrodata(html: string): StructuredPosting[] {
	const root = parse(html, { comment: false });
	const out: StructuredPosting[] = [];
	for (const scope of root.querySelectorAll("[itemscope][itemtype]")) {
		if (!isJobPosting(scope.getAttribute("itemtype"))) continue;
		const prop = (name: string) => {
			const el = scope.querySelector(`[itemprop="${name}"]`);
			if (!el) return;
			return el.getAttribute("content") ?? el.getAttribute("datetime") ?? el;
		};
		const textOf = (v: unknown) =>
			typeof v === "string" ? str(v) : str((v as { text?: string })?.text);
		const title = textOf(prop("title"));
		const descEl = scope.querySelector('[itemprop="description"]');
		const description = htmlToMarkdown(descEl?.innerHTML ?? "");
		if (!title || description.length < 80) continue;
		const orgEl = scope.querySelector('[itemprop="hiringOrganization"]');
		const company =
			str(orgEl?.querySelector('[itemprop="name"]')?.text) ??
			str(orgEl?.getAttribute("content")) ??
			str(orgEl?.text) ??
			"";
		const locations = scope
			.querySelectorAll('[itemprop="jobLocation"]')
			.map((el) => str(el.text))
			.filter((l): l is string => Boolean(l));
		const telecommute =
			String(textOf(prop("jobLocationType")) ?? "").toUpperCase() ===
			"TELECOMMUTE";
		if (telecommute && locations.length === 0) locations.push("Remote");
		out.push({
			title,
			company,
			locations,
			workplaceType: workplaceFrom(
				`${locations.join(" ")} ${title}`,
				telecommute,
			),
			employmentType: textOf(prop("employmentType")),
			datePosted: date(textOf(prop("datePosted"))),
			validThrough: date(textOf(prop("validThrough"))),
			description,
			via: "microdata",
		});
	}
	return out;
}

/**
 * Every JobPosting a page declares. One is a posting page; more than one is a list (search
 * results, a careers index), which web search does not read as a posting.
 */
export function structuredPostings(input: string): StructuredPosting[] {
	const html = input.slice(0, LIMITS.pageBytes);
	// A WebPage whose mainEntity is the posting counts too (ldNodes walks into it).
	const fromLd = ldNodes(html)
		.filter((node) => isJobPosting(node["@type"]))
		.map(fromJsonLd)
		.filter((p): p is StructuredPosting => p !== null);
	return fromLd.length > 0 ? fromLd : fromMicrodata(html);
}

/** What says which posting a JobPosting is, and when it ends: for the closed-posting check. */
export interface PostingIdentity {
	url?: string;
	identifier?: string;
	validThrough?: Date;
}

function identifierOf(value: unknown): string | undefined {
	for (const id of list(value)) {
		const text =
			typeof id === "string" || typeof id === "number"
				? str(String(id))
				: str((id as { value?: unknown } | null)?.value);
		if (text) return text;
	}
	return;
}

/**
 * Every JobPosting the page declares, in JSON-LD and microdata, before any filtering (a short
 * description still counts): the closed-posting check reads an end date only from a page that
 * declares exactly one, and only when that one is the job's own.
 */
export function postingIdentities(input: string): PostingIdentity[] {
	const html = input.slice(0, LIMITS.pageBytes);
	const out: PostingIdentity[] = ldNodes(html)
		.filter((node) => isJobPosting(node["@type"]))
		.map((node) => ({
			url: str(node.url),
			identifier: identifierOf(node.identifier),
			validThrough: date(node.validThrough),
		}));
	const root = parse(html, { comment: false });
	for (const scope of root.querySelectorAll("[itemscope][itemtype]")) {
		if (!isJobPosting(scope.getAttribute("itemtype"))) continue;
		const prop = (name: string) => {
			const el = scope.querySelector(`[itemprop="${name}"]`);
			return (
				el?.getAttribute("content") ??
				el?.getAttribute("datetime") ??
				el?.getAttribute("href") ??
				el?.text
			);
		};
		out.push({
			url: str(prop("url")),
			identifier: str(prop("identifier")),
			validThrough: date(prop("validThrough")),
		});
	}
	return out;
}
