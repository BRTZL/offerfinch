import type { NormalizedJob } from "../domain/types";
import { workplaceOf, xmlBlocks, xmlField } from "../feeds/http";
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
 * Personio's public job feed on the company's own subdomain (no key):
 * `https://{company}.jobs.personio.de/xml` lists every published position with its description
 * sections. The same company answers on `.jobs.personio.com`; the readers use `.de`.
 */

const DOMAIN = "jobs.personio.de";

/** A position's own fields, with its nested lists (descriptions, other offices) taken out. */
function ownFields(position: string): string {
	return position
		.replace(/<jobDescriptions\b[\s\S]*?<\/jobDescriptions>/gi, "")
		.replace(/<additionalOffices\b[\s\S]*?<\/additionalOffices>/gi, "");
}

function description(position: string): string {
	const list = xmlBlocks(position, "jobDescriptions")[0] ?? "";
	return xmlBlocks(list, "jobDescription")
		.map((section) => {
			const name = xmlField(section, "name");
			const text = htmlToMarkdown(xmlField(section, "value") ?? "");
			if (!text) return "";
			return name ? `## ${name}\n\n${text}` : text;
		})
		.filter(Boolean)
		.join("\n\n");
}

function offices(position: string, own: string): string[] {
	const others = xmlBlocks(
		xmlBlocks(position, "additionalOffices")[0] ?? "",
		"office",
	).map((office) => xmlField(`<o>${office}</o>`, "o"));
	return [xmlField(own, "office"), ...others]
		.filter((value): value is string => Boolean(value))
		.filter((value, i, all) => all.indexOf(value) === i);
}

function mapPersonioPosition(
	position: string,
	origin: string,
): NormalizedJob | null {
	const own = ownFields(position);
	const id = xmlField(own, "id");
	const title = xmlField(own, "name");
	if (!id || !/^\d+$/.test(id) || !title) return null;
	const locations = offices(position, own);
	const created = xmlField(own, "createdAt");
	const date = created ? new Date(created) : undefined;
	const employment = [
		xmlField(own, "employmentType"),
		xmlField(own, "schedule"),
	]
		.filter(Boolean)
		.join(", ");
	return {
		source: "personio",
		externalId: id,
		url: `${origin}/job/${id}`,
		title,
		locations,
		workplaceType: workplaceOf([title, ...locations].join(" "), "unknown"),
		department: xmlField(own, "department") || undefined,
		employmentType: employment || undefined,
		descriptionText: description(position),
		publishedAt: date && !Number.isNaN(date.getTime()) ? date : undefined,
		companyName: xmlField(own, "subcompany") || undefined,
	};
}

/** The feed's positions; null when the page is not Personio's feed. */
function positions(xml: string): string[] | null {
	if (!/<workzag-jobs\b/i.test(xml)) return null;
	return xmlBlocks(xml, "position");
}

export class PersonioSource implements JobSource {
	readonly kind = "personio" as const;
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	async listJobs({ sourceKey }: SourceTarget): Promise<NormalizedJob[]> {
		const origin = companyOrigin("personio", sourceKey, DOMAIN);
		const list = positions(
			await fetchXml(this.fetchImpl, "personio", sourceKey, `${origin}/xml`),
		);
		if (!list) throw new Error(`personio ${sourceKey}: not a Personio feed`);
		return list
			.map((position) => mapPersonioPosition(position, origin))
			.filter((job): job is NormalizedJob => job !== null);
	}

	/**
	 * The feed is read and the position looked for: gone only when it lists other positions but
	 * not this one. An empty feed (a company without open positions answers like one that has
	 * none), a 404 or a page that is no feed throws.
	 */
	async checkPosting(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus> {
		const origin = companyOrigin("personio", sourceKey, DOMAIN);
		const url = `${origin}/xml`;
		const answer = await readBoard(this.fetchImpl, url, signal, pacing, "text");
		if (answer.status < 200 || answer.status >= 300)
			throw new Error(
				`personio ${sourceKey}: HTTP ${answer.status} from ${url}`,
			);
		const listed = (positions(String(answer.body ?? "")) ?? [])
			.map((position) => xmlField(ownFields(position), "id"))
			.filter((id): id is string => Boolean(id));
		if (listed.length === 0)
			throw new Error(`personio ${sourceKey}: the feed lists no positions`);
		return listed.includes(externalId) ? "open" : "gone";
	}
}
