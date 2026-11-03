import { feedDate, feedLine, feedText, workplaceOf } from "./http";
import type { Feed, FeedPosting } from "./provider";

/**
 * Remotive's public API (https://github.com/remotive-com/remote-jobs-api, read 2026-11-03): every
 * active listing in one GET, delayed by 24 hours. Its terms: link back to the listing's Remotive
 * URL and name Remotive as the source; at most 4 requests a day (more than 2 a minute is
 * blocked). One unfiltered request per read; the plan is applied here, never as `search=`.
 */
export const REMOTIVE_URL = "https://remotive.com/api/remote-jobs";

interface RemotiveJob {
	id?: number | string;
	url?: string;
	title?: string;
	company_name?: string;
	category?: string;
	tags?: unknown;
	job_type?: string;
	publication_date?: string;
	candidate_required_location?: string;
	description?: string;
}

/** Remotive's answer as postings; anything without an id, a URL, a title or a company is skipped. */
export function parseRemotive(json: string): FeedPosting[] {
	const data = JSON.parse(json) as { jobs?: RemotiveJob[] };
	const out: FeedPosting[] = [];
	for (const job of Array.isArray(data.jobs) ? data.jobs : []) {
		const title = feedLine(job.title ?? "");
		const company = feedLine(job.company_name ?? "");
		if (job.id === undefined || !job.url || !title || !company) continue;
		const where = feedLine(job.candidate_required_location ?? "");
		out.push({
			externalId: String(job.id),
			url: job.url,
			title,
			company,
			// Every Remotive job is remote; the place is where candidates may live.
			locations: [where ? `Remote (${where})` : "Remote"],
			workplaceType: workplaceOf(where, "remote"),
			descriptionText: feedText(job.description ?? ""),
			tags: Array.isArray(job.tags)
				? job.tags.filter((t): t is string => typeof t === "string")
				: [],
			employmentType: job.job_type?.replace(/_/g, " ") || undefined,
			// Written without a zone ("2026-10-29T18:22:41"): UTC.
			publishedAt: feedDate(
				job.publication_date &&
					!/(?:z|[+-]\d\d:?\d\d)$/i.test(job.publication_date)
					? `${job.publication_date}Z`
					: job.publication_date,
			),
		});
	}
	return out;
}

export const remotiveFeed: Feed = {
	id: "remotive",
	label: "Remotive",
	source: "remotive",
	async read(fetchFeed, signal) {
		return {
			postings: parseRemotive(await fetchFeed(REMOTIVE_URL, "json", signal)),
			requests: 1,
		};
	},
};
