import type { NormalizedJob, WorkplaceType } from "../domain/types";
import { cleanPostingText, htmlToMarkdown } from "../scrape/markdown";
import {
	type FetchLike,
	fetchJson,
	fetchPostingStatus,
	type JobSource,
	type PostingStatus,
	type RequestPacing,
	type SourceTarget,
} from "./types";

interface LeverPosting {
	id: string;
	text: string;
	hostedUrl: string;
	categories?: {
		commitment?: string;
		location?: string;
		team?: string;
		department?: string;
		allLocations?: string[];
	};
	country?: string;
	workplaceType?: string;
	descriptionPlain?: string;
	description?: string;
	lists?: { text: string; content: string }[];
	additionalPlain?: string;
	createdAt?: number;
}

function leverBoardUrl(token: string): string {
	return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`;
}

function workplace(value: string | undefined): WorkplaceType {
	switch (value?.toLowerCase()) {
		case "remote":
			return "remote";
		case "hybrid":
			return "hybrid";
		case "on-site":
		case "onsite":
			return "onsite";
		default:
			return "unknown";
	}
}

const COUNTRY_NAMES: Record<string, string> = {
	TR: "Türkiye",
	US: "United States",
	GB: "United Kingdom",
	DE: "Germany",
	ES: "Spain",
	NL: "Netherlands",
	PL: "Poland",
	PT: "Portugal",
	FR: "France",
	IE: "Ireland",
	CA: "Canada",
};

function mapLeverPosting(posting: LeverPosting): NormalizedJob {
	const cat = posting.categories ?? {};
	const country = posting.country
		? (COUNTRY_NAMES[posting.country] ?? posting.country)
		: undefined;
	const raw = cat.allLocations?.length
		? cat.allLocations
		: cat.location
			? [cat.location]
			: [];
	const locations = raw.map((loc) =>
		country && !loc.toLowerCase().includes(country.toLowerCase())
			? `${loc}, ${country}`
			: loc,
	);
	if (locations.length === 0 && country) locations.push(country);
	const sections = (posting.lists ?? []).map(
		(list) => `## ${list.text.trim()}\n\n${htmlToMarkdown(list.content)}`,
	);
	const description = [
		htmlToMarkdown(posting.description ?? "") ||
			cleanPostingText(posting.descriptionPlain ?? ""),
		...sections,
		cleanPostingText(posting.additionalPlain ?? ""),
	]
		.filter(Boolean)
		.join("\n\n");
	return {
		source: "lever",
		externalId: posting.id,
		url: posting.hostedUrl,
		title: posting.text.trim(),
		locations,
		workplaceType: workplace(posting.workplaceType),
		department: cat.department ?? cat.team,
		employmentType: cat.commitment,
		descriptionText: description,
		publishedAt: posting.createdAt ? new Date(posting.createdAt) : undefined,
	};
}

export class LeverSource implements JobSource {
	readonly kind = "lever" as const;
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	async listJobs({ sourceKey }: SourceTarget): Promise<NormalizedJob[]> {
		const postings = await fetchJson<LeverPosting[]>(
			this.fetchImpl,
			"lever",
			sourceKey,
			leverBoardUrl(sourceKey),
		);
		return postings.map(mapLeverPosting);
	}

	/** The posting's own page in the postings API: 404 once it is taken down (the board confirms). */
	checkPosting(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus> {
		const base = `https://api.lever.co/v0/postings/${encodeURIComponent(sourceKey)}`;
		return fetchPostingStatus(
			this.fetchImpl,
			"lever",
			{
				url: `${base}/${encodeURIComponent(externalId)}`,
				id: externalId,
				isSame: (body) =>
					String((body as { id?: unknown })?.id).toLowerCase() ===
					externalId.toLowerCase(),
			},
			{
				url: `${base}?mode=json`,
				ids: (body) =>
					Array.isArray(body)
						? (body as LeverPosting[]).map((p) => String(p.id))
						: [],
			},
			{ signal, pacing },
		);
	}
}
