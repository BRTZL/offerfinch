import {
	type FeedParse,
	feedDate,
	feedLine,
	feedText,
	field,
	parseEach,
	record,
	tagList,
	webUrl,
	workplaceOf,
} from "./http";
import type { Feed, FeedPosting } from "./provider";

/**
 * Remotive's public API (https://github.com/remotive-com/remote-jobs-api, read 2026-11-03): every
 * active listing in one GET, delayed by 24 hours. Its terms: link back to the listing's Remotive
 * URL and name Remotive as the source; at most 4 requests a day (more than 2 a minute is
 * blocked). One unfiltered request per read; the plan is applied here, never as `search=`.
 */
const REMOTIVE_URL = "https://remotive.com/api/remote-jobs";

/** One Remotive job; "bad" when its fields are not what the API documents. */
function remotiveJob(item: unknown): FeedPosting | "bad" {
	const job = record(item);
	if (!job) return "bad";
	const id = job.id;
	const fields = {
		url: field(job.url),
		title: field(job.title),
		company: field(job.company_name),
		where: field(job.candidate_required_location),
		type: field(job.job_type),
		date: field(job.publication_date),
		description: field(job.description),
	};
	if (Object.values(fields).some((v) => v === null)) return "bad";
	const f = fields as Record<keyof typeof fields, string>;
	const title = feedLine(f.title);
	const company = feedLine(f.company);
	if (
		(typeof id !== "number" && typeof id !== "string") ||
		!webUrl(f.url) ||
		!title ||
		!company
	)
		return "bad";
	const where = feedLine(f.where);
	return {
		externalId: String(id),
		url: f.url,
		title,
		company,
		// Every Remotive job is remote; the place is where candidates may live.
		locations: [where ? `Remote (${where})` : "Remote"],
		workplaceType: workplaceOf(where, "remote"),
		descriptionText: feedText(f.description),
		tags: tagList(job.tags),
		employmentType: f.type.replace(/_/g, " ") || undefined,
		// Written without a zone ("2026-10-29T18:22:41"): UTC.
		publishedAt: feedDate(
			f.date && !/(?:z|[+-]\d\d:?\d\d)$/i.test(f.date) ? `${f.date}Z` : f.date,
		),
	};
}

/** Remotive's answer as postings; an item it can't read is skipped and counted. */
export function parseRemotive(json: string): FeedParse<FeedPosting> {
	const data = record(JSON.parse(json));
	return parseEach(data?.jobs, remotiveJob);
}

export const remotiveFeed: Feed = {
	id: "remotive",
	label: "Remotive",
	source: "remotive",
	async read(fetchFeed, signal) {
		return {
			...parseRemotive(await fetchFeed(REMOTIVE_URL, "json", signal)),
			requests: 1,
		};
	},
};
