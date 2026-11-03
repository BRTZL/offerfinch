import { feedDate, feedLine, feedText, fixMojibake, workplaceOf } from "./http";
import type { Feed, FeedPosting } from "./provider";

/**
 * Remote OK's public API (https://remoteok.com/api, read 2026-11-03): the latest listings in one
 * GET, the first element being its legal notice. Its terms: link back to the listing's Remote OK
 * URL (a followed link, no nofollow) and name Remote OK as the source; its logo is not to be
 * used. No rate is stated; it is read at the same pace as the other feeds.
 */
const REMOTEOK_URL = "https://remoteok.com/api";

interface RemoteOkJob {
	id?: string | number;
	epoch?: number | string;
	date?: string;
	company?: string;
	position?: string;
	tags?: unknown;
	description?: string;
	location?: string;
	url?: string;
	legal?: string;
}

/** Remote OK's answer as postings; the legal notice and anything incomplete are skipped. */
export function parseRemoteOk(json: string): FeedPosting[] {
	const data = JSON.parse(json) as RemoteOkJob[];
	const out: FeedPosting[] = [];
	for (const job of Array.isArray(data) ? data : []) {
		if (!job || typeof job !== "object" || job.legal !== undefined) continue;
		const title = feedLine(fixMojibake(job.position ?? ""));
		const company = feedLine(fixMojibake(job.company ?? ""));
		if (job.id === undefined || !job.url || !title || !company) continue;
		const place = feedLine(fixMojibake(job.location ?? ""));
		const remote = !place || /^remote$/i.test(place);
		out.push({
			externalId: String(job.id),
			// Its host is written "remoteOK.com"; the same page either way.
			url: job.url.replace(
				/^https:\/\/remoteok\.com\//i,
				"https://remoteok.com/",
			),
			title,
			company,
			locations: [remote ? "Remote" : place],
			// A Remote OK listing is remote unless its place says otherwise.
			workplaceType: remote ? "remote" : workplaceOf(place, "remote"),
			descriptionText: feedText(fixMojibake(job.description ?? "")),
			tags: Array.isArray(job.tags)
				? job.tags.filter((t): t is string => typeof t === "string")
				: [],
			publishedAt: feedDate(job.date) ?? feedDate(Number(job.epoch)),
		});
	}
	return out;
}

export const remoteOkFeed: Feed = {
	id: "remoteok",
	label: "Remote OK",
	source: "remoteok",
	async read(fetchFeed, signal) {
		return {
			postings: parseRemoteOk(await fetchFeed(REMOTEOK_URL, "json", signal)),
			requests: 1,
		};
	},
};
