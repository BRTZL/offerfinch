import { countriesInLocation } from "../filter/places";
import { FeedReadError, feedDate, feedLine, feedText } from "./http";
import type { Feed, FeedPosting } from "./provider";

/**
 * Hacker News "Ask HN: Who is hiring?", the monthly thread, through Algolia's public HN Search API
 * (https://hn.algolia.com/api, read 2026-11-03: at most 10,000 requests an hour from one address).
 * Two GETs a read: the newest thread by the `whoishiring` account, then the thread with its
 * comments. HN's own pages are never read (their robots.txt asks a 30 s crawl delay and Y
 * Combinator's terms forbid scraping the site). Each top-level comment's first line is read the
 * way posters write it ("Company | Role | Location | REMOTE | ..."), by rules, never by a model;
 * a comment without that line is not a posting. Commenters' names are never kept.
 */
const HN_SEARCH_URL =
	"https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10";
const HN_ITEM_URL = "https://hn.algolia.com/api/v1/items/";
const HN_POST_URL = "https://news.ycombinator.com/item?id=";

/** A thread older than this is last month's: the new one is not up yet, or none was found. */
const THREAD_MAX_AGE_MS = 40 * 24 * 3_600_000;

const WHO_IS_HIRING = /^Ask HN: Who is hiring\?/i;

interface HnHit {
	objectID?: string;
	title?: string;
	created_at?: string;
}

/** The newest "Who is hiring?" thread's id in a search answer, or null. */
export function hiringThread(json: string, now: Date): string | null {
	const data = JSON.parse(json) as { hits?: HnHit[] };
	const hits = (Array.isArray(data.hits) ? data.hits : [])
		.filter((h) => h.objectID && WHO_IS_HIRING.test(h.title ?? ""))
		.sort(
			(a, b) =>
				(feedDate(b.created_at)?.getTime() ?? 0) -
				(feedDate(a.created_at)?.getTime() ?? 0),
		);
	const newest = hits[0];
	if (!newest?.objectID) return null;
	const at = feedDate(newest.created_at);
	if (at && now.getTime() - at.getTime() > THREAD_MAX_AGE_MS) return null;
	return newest.objectID;
}

interface HnItem {
	id?: number | string;
	type?: string;
	text?: string | null;
	created_at?: string;
	children?: HnItem[];
}

const ROLE_WORDS =
	/\b(engineer|engineering|developer|programmer|designer|manager|scientist|lead|architect|analyst|director|head of|sre|devops|researcher|consultant|specialist|founding|cto|vp|product|marketing|sales|recruiter|writer|administrator|technician|operator|intern|swe|sde|staff|principal|full[- ]?stack|front[- ]?end|back[- ]?end|mobile|ios|android|ml|ai)\b/i;
const WORKPLACE = /\b(remote|on[- ]?site|in[- ]office|hybrid)\b/i;
const SALARY = /[$€£]\s?\d|\b\d{2,3}\s?k\b|\bequity\b|\bsalary\b/i;
const EMPLOYMENT =
	/^(?:full[- ]?time|part[- ]?time|contract(?:or)?|freelance|intern(?:ship)?|permanent|ft|pt)\b/i;
const VISA = /\bvisa\b|\bsponsor/i;
const URL_LIKE = /https?:\/\/|\bwww\.|\.(?:com|io|ai|co|dev|org|net)\b\/?/i;

/** A place: a country the gazetteer knows, a "City, ST" pair, or a city in a known country. */
const isPlace = (segment: string) => countriesInLocation(segment).length > 0;

/** The first line of a comment (up to its first paragraph), as text. */
function firstLine(html: string): string {
	const head = html.split(/<p>|\n/i)[0] ?? "";
	return feedLine(head);
}

/** The employer's own link in a comment: the first one not on Hacker News. */
function employerLink(html: string): string | undefined {
	for (const m of html.matchAll(/href="([^"]+)"/gi)) {
		const url = feedLine(m[1] ?? "");
		if (/^https?:\/\//i.test(url) && !/ycombinator\.com/i.test(url)) return url;
	}
	return undefined;
}

/** What one part of the first line is. */
function partKind(part: string): "location" | "employment" | "role" | "other" {
	// A header field is short; a long part is the post's prose run into the line (no break
	// after the header), never a place or a role.
	if (part.length > 80) return "other";
	// Pay first: "$150K, or local average outside the US" names a country, not a place.
	if (SALARY.test(part) && !WORKPLACE.test(part)) return "other";
	if (WORKPLACE.test(part) || (isPlace(part) && !ROLE_WORDS.test(part)))
		return "location";
	if (EMPLOYMENT.test(part)) return "employment";
	if (VISA.test(part) || URL_LIKE.test(part)) return "other";
	return "role";
}

interface HeaderLine {
	company: string;
	title: string;
	locations: string[];
	workplaceType: FeedPosting["workplaceType"];
	employmentType?: string;
}

/**
 * The conventional first line, read by rules: the first part is the company (its tags in
 * brackets dropped); parts naming remote, on-site or hybrid work, or a place, are the locations;
 * pay, employment type, visa notes and links are set aside; the role is the first remaining part
 * that reads like one. Null when the line has no `|` or names no role.
 */
export function parseHiringLine(line: string): HeaderLine | null {
	if (!line.includes("|")) return null;
	const parts = line
		.split("|")
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length < 2) return null;
	const company = (parts[0] as string)
		.replace(/\s*[([][^)\]]*[)\]]/g, "")
		.trim()
		.slice(0, 120);
	if (!company) return null;
	const locations: string[] = [];
	const roles: string[] = [];
	let employmentType: string | undefined;
	for (const part of parts.slice(1)) {
		const kind = partKind(part);
		if (kind === "location") locations.push(part.slice(0, 160));
		else if (kind === "employment") employmentType ??= part.slice(0, 60);
		else if (kind === "role") roles.push(part);
	}
	const title = (roles.find((r) => ROLE_WORDS.test(r)) ?? roles[0])
		?.replace(/\s+/g, " ")
		.slice(0, 200);
	if (!title) return null;
	const where = locations.join(" ");
	const workplaceType = /\bremote\b/i.test(where)
		? "remote"
		: /\bhybrid\b/i.test(where)
			? "hybrid"
			: /\bon[- ]?site\b|\bin[- ]office\b/i.test(where)
				? "onsite"
				: "unknown";
	return { company, title, locations, workplaceType, employmentType };
}

/** The thread's top-level comments as postings (replies, deleted and free-form comments skipped). */
export function parseHiringThread(json: string): FeedPosting[] {
	const thread = JSON.parse(json) as HnItem;
	const out: FeedPosting[] = [];
	for (const comment of Array.isArray(thread.children) ? thread.children : []) {
		if (comment.type && comment.type !== "comment") continue;
		const html = comment.text ?? "";
		if (!html || comment.id === undefined) continue;
		const header = parseHiringLine(firstLine(html));
		if (!header) continue;
		out.push({
			externalId: String(comment.id),
			url: `${HN_POST_URL}${comment.id}`,
			title: header.title,
			company: header.company,
			locations: header.locations,
			workplaceType: header.workplaceType,
			employmentType: header.employmentType,
			descriptionText: feedText(html),
			applyUrl: employerLink(html),
			publishedAt: feedDate(comment.created_at),
		});
	}
	return out;
}

export const hackerNewsFeed: Feed = {
	id: "hn-hiring",
	label: "HN Who is hiring",
	source: "hackernews",
	async read(fetchFeed, signal, now) {
		const thread = hiringThread(
			await fetchFeed(HN_SEARCH_URL, "json", signal),
			now,
		);
		if (!thread)
			throw new FeedReadError(
				"no Who is hiring thread from the last 40 days",
				null,
				false,
			);
		return {
			postings: parseHiringThread(
				await fetchFeed(`${HN_ITEM_URL}${thread}`, "json", signal),
			),
			requests: 2,
		};
	},
};
