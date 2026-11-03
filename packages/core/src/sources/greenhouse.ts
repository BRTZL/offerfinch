import type { NormalizedJob, WorkplaceType } from "../domain/types";
import { htmlToMarkdown } from "../scrape/markdown";
import {
	type FetchLike,
	fetchJson,
	fetchPostingStatus,
	type JobSource,
	type PostingStatus,
	type RequestPacing,
	type SourceTarget,
} from "./types";

interface GreenhouseJob {
	id: number;
	title: string;
	absolute_url: string;
	location?: { name?: string };
	offices?: { name?: string; location?: string | null }[];
	departments?: { name?: string }[];
	content?: string;
	first_published?: string;
	updated_at?: string;
	company_name?: string;
}

interface GreenhouseBoard {
	jobs?: GreenhouseJob[];
}

function greenhouseBoardUrl(token: string): string {
	return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
}

/** Greenhouse has no workplace field; infer it from the location and title wording. */
function workplace(texts: string[]): WorkplaceType {
	const joined = texts.join(" ").toLowerCase();
	if (/\bhybrid\b/.test(joined)) return "hybrid";
	if (/\bremote\b|\banywhere\b|\bwork from home\b/.test(joined))
		return "remote";
	if (/\bon-?site\b|\bin[- ]office\b/.test(joined)) return "onsite";
	return "unknown";
}

function mapGreenhouseJob(job: GreenhouseJob): NormalizedJob {
	const locations = [
		job.location?.name,
		...(job.offices ?? []).map((office) => office.location || office.name),
	]
		.filter((value): value is string => Boolean(value?.trim()))
		.filter((value, index, all) => all.indexOf(value) === index);
	return {
		source: "greenhouse",
		externalId: String(job.id),
		url: job.absolute_url,
		title: job.title.trim(),
		locations,
		workplaceType: workplace([...locations, job.title]),
		department: job.departments?.[0]?.name,
		descriptionText: htmlToMarkdown(job.content ?? ""),
		publishedAt: job.first_published
			? new Date(job.first_published)
			: undefined,
		companyName: job.company_name?.trim() || undefined,
	};
}

export class GreenhouseSource implements JobSource {
	readonly kind = "greenhouse" as const;
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	async listJobs({ sourceKey }: SourceTarget): Promise<NormalizedJob[]> {
		const board = await fetchJson<GreenhouseBoard>(
			this.fetchImpl,
			"greenhouse",
			sourceKey,
			greenhouseBoardUrl(sourceKey),
		);
		return (board.jobs ?? []).map(mapGreenhouseJob);
	}

	/** The posting's own page in the board API: 404 once it is taken down (the board confirms). */
	checkPosting(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus> {
		const board = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(sourceKey)}/jobs`;
		return fetchPostingStatus(
			this.fetchImpl,
			"greenhouse",
			{
				url: `${board}/${encodeURIComponent(externalId)}`,
				id: externalId,
				isSame: (body) => String((body as { id?: unknown })?.id) === externalId,
			},
			// Without content: only the ids are needed.
			{
				url: board,
				ids: (body) =>
					((body as GreenhouseBoard)?.jobs ?? []).map((j) => String(j.id)),
			},
			{ signal, pacing },
		);
	}
}
