import {
	type FeedParse,
	feedDate,
	feedLine,
	feedText,
	parseEach,
	rssItems,
	webUrl,
	workplaceOf,
} from "./http";
import type { Feed, FeedPosting } from "./provider";

/**
 * We Work Remotely's public RSS feed of all jobs (https://weworkremotely.com/remote-job-rss-feed,
 * read 2026-11-03 through the Internet Archive's copy of 2026-10-25: the live page shows a browser
 * check). Its terms: "Anyone can use the feed, all we ask is that you attribute the links back to
 * We Work Remotely." The all-jobs feed holds the newest jobs of every category in one GET.
 */
const WWR_URL = "https://weworkremotely.com/remote-jobs.rss";

/** "Company: Job title" (the company is everything before the first colon). */
function splitTitle(raw: string): { company: string; title: string } | null {
	const at = raw.indexOf(": ");
	if (at <= 0) return null;
	return {
		company: raw.slice(0, at).trim(),
		title: raw.slice(at + 2).trim(),
	};
}

/** One item; "bad" without "Company: Title" or a web link. */
function wwrItem(raw: unknown): FeedPosting | "bad" {
	const item = raw as Record<string, string>;
	const named = splitTitle(feedLine(item.title ?? ""));
	const url = feedLine(item.link ?? item.guid ?? "");
	if (!named?.company || !named.title || !webUrl(url)) return "bad";
	// Where candidates may live ("Anywhere in the World", "USA Only"). The item's country and
	// state are the company's headquarters, not a limit on the job, so they are not a place.
	const region = feedLine(item.region ?? "");
	return {
		externalId: url.replace(/^https?:\/\/[^/]+/, "").replace(/\/$/, ""),
		url,
		title: named.title,
		company: named.company,
		locations: [region ? `Remote (${region})` : "Remote"],
		workplaceType: workplaceOf(region, "remote"),
		descriptionText: feedText(item.description ?? ""),
		tags: [item.category, item.skills]
			.flatMap((t) => feedLine(t ?? "").split(/,\s*|\s+and\s+/))
			.filter(Boolean),
		employmentType: feedLine(item.type ?? "") || undefined,
		publishedAt: feedDate(feedLine(item.pubdate ?? "")),
		expiresAt: feedDate(feedLine(item.expires_at ?? "")),
	};
}

/** The feed's items as postings (past `expires_at` kept for the provider to drop); a broken one is counted. */
export function parseWeWorkRemotely(xml: string): FeedParse<FeedPosting> {
	return parseEach(rssItems(xml), wwrItem);
}

export const weWorkRemotelyFeed: Feed = {
	id: "weworkremotely",
	label: "We Work Remotely",
	source: "weworkremotely",
	async read(fetchFeed, signal) {
		return {
			...parseWeWorkRemotely(await fetchFeed(WWR_URL, "xml", signal)),
			requests: 1,
		};
	},
};
