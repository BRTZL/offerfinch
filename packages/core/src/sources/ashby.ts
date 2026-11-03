import type { NormalizedJob, WorkplaceType } from "../domain/types";
import { cleanPostingText, htmlToMarkdown } from "../scrape/markdown";
import {
	BoardNotFoundError,
	type FetchLike,
	fetchJson,
	type JobSource,
	type PostingStatus,
	type RequestPacing,
	readBoard,
	type SourceTarget,
} from "./types";

interface AshbyLocation {
	location?: string;
	address?: {
		postalAddress?: { addressCountry?: string; addressLocality?: string };
	} | null;
}

interface AshbyJob {
	id: string;
	title: string;
	department?: string;
	team?: string;
	employmentType?: string;
	location?: string;
	secondaryLocations?: AshbyLocation[];
	publishedAt?: string;
	isListed?: boolean;
	isRemote?: boolean | null;
	workplaceType?: string | null;
	address?: AshbyLocation["address"];
	jobUrl: string;
	descriptionPlain?: string;
	descriptionHtml?: string;
}

interface AshbyBoard {
	jobs?: AshbyJob[];
}

function ashbyBoardUrl(token: string): string {
	return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`;
}

function workplace(job: AshbyJob): WorkplaceType {
	switch (job.workplaceType?.toLowerCase()) {
		case "remote":
			return "remote";
		case "hybrid":
			return "hybrid";
		case "onsite":
		case "on-site":
			return "onsite";
	}
	if (job.isRemote === true) return "remote";
	return "unknown";
}

function locationText(
	loc: AshbyLocation | undefined,
	fallback?: string,
): string | undefined {
	const name = loc?.location ?? fallback;
	const country = loc?.address?.postalAddress?.addressCountry;
	if (!name) return country;
	if (country && !name.toLowerCase().includes(country.toLowerCase()))
		return `${name}, ${country}`;
	return name;
}

function mapAshbyJob(job: AshbyJob): NormalizedJob {
	const locations = [
		locationText({ location: job.location, address: job.address }),
		...(job.secondaryLocations ?? []).map((loc) => locationText(loc)),
	].filter((value): value is string => Boolean(value));
	return {
		source: "ashby",
		externalId: job.id,
		url: job.jobUrl,
		title: job.title.trim(),
		locations,
		workplaceType: workplace(job),
		department: job.department ?? job.team,
		employmentType: job.employmentType,
		descriptionText:
			htmlToMarkdown(job.descriptionHtml ?? "") ||
			cleanPostingText(job.descriptionPlain ?? ""),
		publishedAt: job.publishedAt ? new Date(job.publishedAt) : undefined,
	};
}

export class AshbySource implements JobSource {
	readonly kind = "ashby" as const;
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	async listJobs({ sourceKey }: SourceTarget): Promise<NormalizedJob[]> {
		const board = await fetchJson<AshbyBoard>(
			this.fetchImpl,
			"ashby",
			sourceKey,
			ashbyBoardUrl(sourceKey),
		);
		// Ashby answers 200 with an empty list for boards that do not exist, so an empty
		// board cannot be told apart from a missing one. Callers that need certainty use discovery.
		if (!Array.isArray(board.jobs))
			throw new BoardNotFoundError("ashby", sourceKey);
		return board.jobs.filter((job) => job.isListed !== false).map(mapAshbyJob);
	}

	/**
	 * Ashby has no public page per posting, so the board is read and the posting looked for. Gone
	 * only when the board lists other postings but not this one, or lists it as unlisted (the scan
	 * never keeps those either). An empty board, a 404 or a body without a list throws: Ashby
	 * answers a missing board the same way, so they say nothing about this posting.
	 */
	async checkPosting(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus> {
		const url = ashbyBoardUrl(sourceKey);
		const answer = await readBoard(this.fetchImpl, url, signal, pacing);
		if (answer.status < 200 || answer.status >= 300)
			throw new Error(`ashby ${sourceKey}: HTTP ${answer.status} from ${url}`);
		const board = (answer.body ?? {}) as AshbyBoard;
		if (!Array.isArray(board.jobs) || board.jobs.length === 0)
			throw new Error(`ashby ${sourceKey}: the board lists no postings`);
		const id = externalId.toLowerCase();
		const job = board.jobs.find((j) => j.id.toLowerCase() === id);
		return job && job.isListed !== false ? "open" : "gone";
	}
}
