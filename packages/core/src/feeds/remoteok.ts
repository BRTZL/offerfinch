import {
	type FeedParse,
	feedDate,
	feedLine,
	feedText,
	field,
	fixMojibake,
	parseEach,
	record,
	tagList,
	webUrl,
	workplaceOf,
} from "./http";
import type { Feed, FeedPosting } from "./provider";

/**
 * Remote OK's public API (https://remoteok.com/api, read 2026-11-03): the latest listings in one
 * GET, the first element being its legal notice. Its terms: link back to the listing's Remote OK
 * URL (a followed link, no nofollow) and name Remote OK as the source; its logo is not to be
 * used. No rate is stated; it is read at the same pace as the other feeds.
 */
const REMOTEOK_URL = "https://remoteok.com/api";

/** One Remote OK listing; null for its legal notice, "bad" when the fields are not text. */
function remoteOkJob(item: unknown): FeedPosting | null | "bad" {
	const job = record(item);
	if (!job) return "bad";
	if (job.legal !== undefined) return null;
	const id = job.id;
	const fields = {
		url: field(job.url),
		position: field(job.position),
		company: field(job.company),
		location: field(job.location),
		description: field(job.description),
		date: field(job.date),
	};
	if (Object.values(fields).some((v) => v === null)) return "bad";
	const f = fields as Record<keyof typeof fields, string>;
	const title = feedLine(fixMojibake(f.position));
	const company = feedLine(fixMojibake(f.company));
	if (
		(typeof id !== "number" && typeof id !== "string") ||
		!webUrl(f.url) ||
		!title ||
		!company
	)
		return "bad";
	const place = feedLine(fixMojibake(f.location));
	const remote = !place || /^remote$/i.test(place);
	return {
		externalId: String(id),
		// Its host is written "remoteOK.com"; the same page either way.
		url: f.url.replace(/^https:\/\/remoteok\.com\//i, "https://remoteok.com/"),
		title,
		company,
		locations: [remote ? "Remote" : place],
		// A Remote OK listing is remote unless its place says otherwise.
		workplaceType: remote ? "remote" : workplaceOf(place, "remote"),
		descriptionText: feedText(fixMojibake(f.description)),
		tags: tagList(job.tags),
		publishedAt:
			feedDate(f.date || undefined) ?? feedDate(Number(job.epoch) || undefined),
	};
}

/** Remote OK's answer as postings; the legal notice is no posting, a broken item is counted. */
export function parseRemoteOk(json: string): FeedParse<FeedPosting> {
	return parseEach(JSON.parse(json), remoteOkJob);
}

export const remoteOkFeed: Feed = {
	id: "remoteok",
	label: "Remote OK",
	source: "remoteok",
	async read(fetchFeed, signal) {
		return {
			...parseRemoteOk(await fetchFeed(REMOTEOK_URL, "json", signal)),
			requests: 1,
		};
	},
};
