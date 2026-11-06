import type { NormalizedJob, WorkplaceType } from "../domain/types";
import { htmlToMarkdown } from "../scrape/markdown";
import {
	type FetchLike,
	fetchPostingStatus,
	type JobSource,
	type PostingStatus,
	type RequestPacing,
	type SourceTarget,
	USER_AGENT,
} from "./types";

/**
 * SmartRecruiters' public Posting API (no key): a company's list
 * (`/v1/companies/{company}/postings`, paged, no descriptions) and each posting's own page
 * (`.../postings/{id}`, with the job ad's sections). Job-board search reads only the pages of
 * the postings it found, one after another.
 */

interface SrPosting {
	id: string;
	name: string;
	company?: { identifier?: string; name?: string };
	releasedDate?: string;
	location?: {
		city?: string;
		region?: string;
		country?: string;
		fullLocation?: string;
		remote?: boolean;
		hybrid?: boolean;
	};
	department?: { label?: string };
	function?: { label?: string };
	typeOfEmployment?: { label?: string };
	postingUrl?: string;
	active?: boolean;
	jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

interface SrList {
	totalFound?: number;
	content?: SrPosting[];
}

const API = "https://api.smartrecruiters.com/v1/companies";
/** The job ad's sections in the order its page shows them. */
const SECTIONS = [
	"companyDescription",
	"jobDescription",
	"qualifications",
	"additionalInformation",
];
/** Postings read per company: a scan's search finds a few; a list read alone takes the newest. */
const MAX_POSTINGS = 20;

const companyUrl = (key: string) => `${API}/${encodeURIComponent(key)}`;
const postingUrl = (key: string, id: string) =>
	`${companyUrl(key)}/postings/${encodeURIComponent(id)}`;

function workplace(location: SrPosting["location"]): WorkplaceType {
	if (location?.remote) return "remote";
	if (location?.hybrid) return "hybrid";
	if (location?.remote === false && location.hybrid === false) return "onsite";
	return "unknown";
}

/** "Austin, , United States" -> "Austin, United States". */
function locationText(location: SrPosting["location"]): string | undefined {
	const parts = (
		location?.fullLocation?.split(",") ?? [location?.city, location?.region]
	)
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part));
	return parts.length ? parts.join(", ") : undefined;
}

function mapSmartRecruitersPosting(
	posting: SrPosting,
	key: string,
): NormalizedJob {
	const sections = posting.jobAd?.sections ?? {};
	const description = SECTIONS.map((name) => {
		const section = sections[name];
		const text = htmlToMarkdown(section?.text ?? "");
		if (!text) return "";
		return section?.title?.trim()
			? `## ${section.title.trim()}\n\n${text}`
			: text;
	})
		.filter(Boolean)
		.join("\n\n");
	const location = locationText(posting.location);
	return {
		source: "smartrecruiters",
		externalId: String(posting.id),
		url:
			posting.postingUrl ??
			`https://jobs.smartrecruiters.com/${encodeURIComponent(key)}/${encodeURIComponent(posting.id)}`,
		title: posting.name.trim(),
		locations: location ? [location] : [],
		workplaceType: workplace(posting.location),
		department: posting.department?.label ?? posting.function?.label,
		employmentType: posting.typeOfEmployment?.label,
		descriptionText: description,
		publishedAt: posting.releasedDate
			? new Date(posting.releasedDate)
			: undefined,
		companyName: posting.company?.name?.trim() || undefined,
	};
}

const isPosting = (body: unknown): body is SrPosting =>
	typeof body === "object" &&
	body !== null &&
	typeof (body as SrPosting).id === "string" &&
	typeof (body as SrPosting).name === "string";

export class SmartRecruitersSource implements JobSource {
	readonly kind = "smartrecruiters" as const;
	constructor(
		private readonly fetchImpl: FetchLike = fetch,
		/** Between two posting pages of one read. */
		private readonly gapMs = 1_000,
	) {}

	private async get(url: string): Promise<Response> {
		return this.fetchImpl(url, {
			headers: { accept: "application/json", "user-agent": USER_AGENT },
		});
	}

	/**
	 * The postings' own pages: the ones asked for (`postingIds`), else the newest on the list. A
	 * posting that answers 404 (taken down) or 400 (another company's) is left out; the list
	 * cannot tell a missing company from one with no postings, so neither throws.
	 */
	async listJobs({
		sourceKey,
		postingIds,
	}: SourceTarget): Promise<NormalizedJob[]> {
		let ids = postingIds;
		if (!ids) {
			const response = await this.get(
				`${companyUrl(sourceKey)}/postings?limit=${MAX_POSTINGS}`,
			);
			if (!response.ok)
				throw new Error(
					`smartrecruiters ${sourceKey}: HTTP ${response.status} from its list`,
				);
			const list = (await response.json()) as SrList;
			ids = (Array.isArray(list?.content) ? list.content : []).map((p) =>
				String(p.id),
			);
		}
		const jobs: NormalizedJob[] = [];
		for (const [index, id] of ids.slice(0, MAX_POSTINGS).entries()) {
			if (index > 0 && this.gapMs > 0)
				await new Promise((resolve) => setTimeout(resolve, this.gapMs));
			const response = await this.get(postingUrl(sourceKey, id));
			if (response.status === 404 || response.status === 400) continue;
			if (!response.ok)
				throw new Error(
					`smartrecruiters ${sourceKey}: HTTP ${response.status} from posting ${id}`,
				);
			const body: unknown = await response.json();
			if (!isPosting(body) || body.id !== id || body.active === false) continue;
			jobs.push(mapSmartRecruitersPosting(body, sourceKey));
		}
		return jobs;
	}

	/**
	 * The posting's own page: open while it names this posting and is active; inactive is gone. A
	 * 404 is gone only when the company's list (its first page) answers with postings and not
	 * this one: SmartRecruiters answers a company that does not exist with an empty list, and a
	 * posting of another company with 400.
	 */
	checkPosting(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus> {
		return fetchPostingStatus(
			this.fetchImpl,
			"smartrecruiters",
			{
				url: postingUrl(sourceKey, externalId),
				id: externalId,
				isSame: (body) => isPosting(body) && body.id === externalId,
				closed: (body) => (body as SrPosting).active === false,
			},
			{
				url: `${companyUrl(sourceKey)}/postings?limit=100`,
				ids: (body) =>
					((body as SrList)?.totalFound ?? 0) > 0 &&
					Array.isArray((body as SrList).content)
						? ((body as SrList).content as SrPosting[]).map((p) => String(p.id))
						: [],
			},
			{ signal, pacing },
		);
	}
}
