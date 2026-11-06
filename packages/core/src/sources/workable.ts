import type { NormalizedJob } from "../domain/types";
import { workplaceOf } from "../feeds/http";
import { htmlToMarkdown } from "../scrape/markdown";
import {
	BoardNotFoundError,
	type FetchLike,
	fetchJson,
	fetchPostingStatus,
	type JobSource,
	type PostingStatus,
	type RequestPacing,
	type SourceTarget,
} from "./types";

/**
 * Workable's public job widget (no key): an account's jobs with their full descriptions
 * (`/api/v1/widget/accounts/{account}?details=true`), and one job's page in its v2 API for the
 * closed-posting check.
 */

interface WorkableLocation {
	city?: string;
	region?: string;
	country?: string;
	hidden?: boolean;
}

interface WorkableJob {
	title: string;
	shortcode: string;
	employment_type?: string;
	telecommuting?: boolean;
	department?: string;
	published_on?: string;
	created_at?: string;
	city?: string;
	state?: string;
	country?: string;
	locations?: WorkableLocation[];
	description?: string;
}

interface WorkableAccount {
	name?: string;
	jobs?: WorkableJob[];
}

const BASE = "https://apply.workable.com";
const accountUrl = (key: string) =>
	`${BASE}/api/v1/widget/accounts/${encodeURIComponent(key)}`;

function place(loc: WorkableLocation): string | undefined {
	const parts = [loc.city, loc.region, loc.country]
		.map((p) => p?.trim())
		.filter((p): p is string => Boolean(p))
		.filter((p, i, all) => all.indexOf(p) === i);
	return parts.length ? parts.join(", ") : undefined;
}

function mapWorkableJob(
	job: WorkableJob,
	key: string,
	company: string | undefined,
): NormalizedJob {
	const shown = (job.locations ?? []).filter((loc) => !loc.hidden);
	const locations = (
		shown.length
			? shown.map(place)
			: [place({ city: job.city, region: job.state, country: job.country })]
	)
		.filter((value): value is string => Boolean(value))
		.filter((value, i, all) => all.indexOf(value) === i);
	const code = job.shortcode.toUpperCase();
	return {
		source: "workable",
		externalId: code,
		// The account's own address for the posting (the widget gives the short /j/ link).
		url: `${BASE}/${encodeURIComponent(key)}/j/${encodeURIComponent(code)}/`,
		title: job.title.trim(),
		locations,
		workplaceType: job.telecommuting
			? "remote"
			: workplaceOf([job.title, ...locations].join(" "), "unknown"),
		department: job.department?.trim() || undefined,
		employmentType: job.employment_type?.trim() || undefined,
		descriptionText: htmlToMarkdown(job.description ?? ""),
		publishedAt: dateOf(job.published_on ?? job.created_at),
		companyName: company?.trim() || undefined,
	};
}

function dateOf(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

const codes = (body: unknown): string[] =>
	Array.isArray((body as WorkableAccount)?.jobs)
		? ((body as WorkableAccount).jobs as WorkableJob[]).map((j) =>
				String(j.shortcode),
			)
		: [];

export class WorkableSource implements JobSource {
	readonly kind = "workable" as const;
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	async listJobs({ sourceKey }: SourceTarget): Promise<NormalizedJob[]> {
		const account = await fetchJson<WorkableAccount>(
			this.fetchImpl,
			"workable",
			sourceKey,
			`${accountUrl(sourceKey)}?details=true`,
		);
		if (!Array.isArray(account?.jobs))
			throw new BoardNotFoundError("workable", sourceKey);
		return account.jobs
			.filter((job) => job?.shortcode && job.title)
			.map((job) => mapWorkableJob(job, sourceKey, account.name));
	}

	/**
	 * The job's page in Workable's v2 API: open while it names this job and is published, gone
	 * when it says the job is closed. A 404 is gone only when the account's widget lists other
	 * jobs but not this one.
	 */
	checkPosting(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus> {
		const code = externalId.toUpperCase();
		return fetchPostingStatus(
			this.fetchImpl,
			"workable",
			{
				url: `${BASE}/api/v2/accounts/${encodeURIComponent(sourceKey)}/jobs/${encodeURIComponent(code)}`,
				id: code,
				isSame: (body) =>
					String((body as { shortcode?: unknown })?.shortcode).toUpperCase() ===
					code,
				closed: (body) => {
					const state = (body as { state?: unknown })?.state;
					return typeof state === "string" && state !== "published";
				},
			},
			// Without details: only the shortcodes are needed.
			{ url: accountUrl(sourceKey), ids: codes },
			{ signal, pacing },
		);
	}
}
