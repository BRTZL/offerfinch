import type { NormalizedJob, WorkplaceType } from "../domain/types";
import { xmlBlocks, xmlField } from "../feeds/http";
import { htmlToMarkdown } from "../scrape/markdown";
import {
	companyOrigin,
	type FetchLike,
	fetchXml,
	type JobSource,
	type PostingStatus,
	type RequestPacing,
	readBoard,
	type SourceTarget,
} from "./types";

/**
 * Teamtailor's public RSS feed on the company's own subdomain (no key):
 * `https://{company}.teamtailor.com/jobs.rss` lists every open job with its HTML description,
 * its places in the `tt:` namespace and its remote status. A job's id is the number its link
 * starts with (`/jobs/{id}-{slug}`); the link itself may be on the company's own domain.
 */

const DOMAIN = "teamtailor.com";

/** Teamtailor's remote status: none, hybrid, temporary or fully. */
function workplace(status: string | undefined): WorkplaceType {
	switch (status?.toLowerCase()) {
		case "fully":
			return "remote";
		case "hybrid":
			return "hybrid";
		case "none":
			return "onsite";
		default:
			// "temporary": remote for now, an office later. Not a remote role.
			return "unknown";
	}
}

function places(item: string): string[] {
	return xmlBlocks(item, "tt:location")
		.map((loc) => {
			const city = xmlField(loc, "tt:city") || xmlField(loc, "tt:name");
			const country = xmlField(loc, "tt:country");
			return [city, country]
				.filter((p): p is string => Boolean(p))
				.filter((p, i, all) => all.indexOf(p) === i)
				.join(", ");
		})
		.filter(Boolean)
		.filter((value, i, all) => all.indexOf(value) === i);
}

interface TeamtailorFeed {
	company?: string;
	items: string[];
}

/** The feed's channel title (the company) and its items; null when it is not an RSS feed. */
function readFeed(xml: string): TeamtailorFeed | null {
	if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) return null;
	const head = xml.split(/<item\b/i)[0] ?? "";
	return {
		company: xmlField(head, "title") || undefined,
		items: xmlBlocks(xml, "item"),
	};
}

/** The job's id and the rest of its path, from its link. */
function jobPath(link: string): { id: string; path: string } | null {
	const m = link.match(/\/jobs\/((\d+)[^/?#]*)/);
	return m?.[1] && m[2] ? { id: m[2], path: m[1] } : null;
}

function mapTeamtailorItem(
	item: string,
	origin: string,
	company: string | undefined,
): NormalizedJob | null {
	const title = xmlField(item, "title");
	const job = jobPath(xmlField(item, "link") ?? "");
	if (!title || !job) return null;
	const published = xmlField(item, "pubDate");
	const date = published ? new Date(published) : undefined;
	return {
		source: "teamtailor",
		externalId: job.id,
		url: `${origin}/jobs/${job.path}`,
		title,
		locations: places(item),
		workplaceType: workplace(xmlField(item, "remoteStatus")),
		department: xmlField(item, "tt:department") || undefined,
		descriptionText: htmlToMarkdown(xmlField(item, "description") ?? ""),
		publishedAt: date && !Number.isNaN(date.getTime()) ? date : undefined,
		companyName: company,
	};
}

function ids(feed: TeamtailorFeed): string[] {
	return feed.items
		.map((item) => jobPath(xmlField(item, "link") ?? "")?.id)
		.filter((id): id is string => Boolean(id));
}

export class TeamtailorSource implements JobSource {
	readonly kind = "teamtailor" as const;
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	async listJobs({ sourceKey }: SourceTarget): Promise<NormalizedJob[]> {
		const origin = companyOrigin("teamtailor", sourceKey, DOMAIN);
		const feed = readFeed(
			await fetchXml(
				this.fetchImpl,
				"teamtailor",
				sourceKey,
				`${origin}/jobs.rss`,
			),
		);
		if (!feed) throw new Error(`teamtailor ${sourceKey}: not an RSS feed`);
		return feed.items
			.map((item) => mapTeamtailorItem(item, origin, feed.company))
			.filter((job): job is NormalizedJob => job !== null);
	}

	/**
	 * Teamtailor has no public page per job in a form to read, so the feed is read and the job
	 * looked for: gone only when the feed lists other jobs but not this one. An empty feed, a 404
	 * or a page that is no feed throws: they say nothing about one job.
	 */
	async checkPosting(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus> {
		const origin = companyOrigin("teamtailor", sourceKey, DOMAIN);
		const url = `${origin}/jobs.rss`;
		const answer = await readBoard(this.fetchImpl, url, signal, pacing, "text");
		if (answer.status < 200 || answer.status >= 300)
			throw new Error(
				`teamtailor ${sourceKey}: HTTP ${answer.status} from ${url}`,
			);
		const feed = readFeed(String(answer.body ?? ""));
		const listed = feed ? ids(feed) : [];
		if (listed.length === 0)
			throw new Error(`teamtailor ${sourceKey}: the feed lists no jobs`);
		return listed.includes(externalId) ? "open" : "gone";
	}
}
