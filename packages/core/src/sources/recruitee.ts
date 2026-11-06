import type { NormalizedJob, WorkplaceType } from "../domain/types";
import { htmlToMarkdown } from "../scrape/markdown";
import {
	BoardNotFoundError,
	companyOrigin,
	type FetchLike,
	fetchJson,
	fetchPostingStatus,
	type JobSource,
	type PostingStatus,
	type RequestPacing,
	type SourceTarget,
} from "./types";

/**
 * Recruitee's public careers API on the company's own subdomain (no key):
 * `https://{company}.recruitee.com/api/offers/` lists every published offer with its
 * description and requirements, and `/api/offers/{slug}` is one offer. Postings are matched by
 * slug: the careers address an offer gives may be the company's own domain.
 */

interface RecruiteeLocation {
	city?: string;
	state?: string;
	country?: string;
	name?: string;
}

interface RecruiteeOffer {
	id: number;
	slug: string;
	title: string;
	status?: string;
	description?: string;
	requirements?: string;
	location?: string;
	city?: string;
	country?: string;
	locations?: RecruiteeLocation[];
	remote?: boolean;
	hybrid?: boolean;
	on_site?: boolean;
	department?: string;
	employment_type_code?: string;
	published_at?: string;
	created_at?: string;
	company_name?: string;
}

const DOMAIN = "recruitee.com";

function workplace(offer: RecruiteeOffer): WorkplaceType {
	if (offer.remote) return "remote";
	if (offer.hybrid) return "hybrid";
	if (offer.on_site) return "onsite";
	return "unknown";
}

function place(loc: RecruiteeLocation): string | undefined {
	const parts = [loc.city ?? loc.name, loc.state, loc.country]
		.map((p) => p?.trim())
		.filter((p): p is string => Boolean(p))
		.filter((p, i, all) => all.indexOf(p) === i);
	return parts.length ? parts.join(", ") : undefined;
}

/** "2026-10-30 16:32:58 UTC", as Recruitee writes it. */
function dateOf(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const date = new Date(value.replace(" ", "T").replace(/\s*UTC$/, "Z"));
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "fulltime_permanent" -> "Full-time, permanent". */
function employment(code: string | undefined): string | undefined {
	if (!code) return undefined;
	const words = code
		.split("_")
		.map((w) =>
			w === "fulltime" ? "full-time" : w === "parttime" ? "part-time" : w,
		)
		.join(", ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function mapRecruiteeOffer(
	offer: RecruiteeOffer,
	origin: string,
): NormalizedJob {
	const locations = (
		offer.locations?.length
			? offer.locations.map(place)
			: [offer.location?.trim()]
	)
		.filter((value): value is string => Boolean(value))
		.filter((value, i, all) => all.indexOf(value) === i);
	const requirements = htmlToMarkdown(offer.requirements ?? "");
	const slug = offer.slug.toLowerCase();
	return {
		source: "recruitee",
		externalId: slug,
		url: `${origin}/o/${encodeURIComponent(slug)}`,
		title: offer.title.trim(),
		locations,
		workplaceType: workplace(offer),
		department: offer.department?.trim() || undefined,
		employmentType: employment(offer.employment_type_code),
		descriptionText: [
			htmlToMarkdown(offer.description ?? ""),
			requirements ? `## Requirements\n\n${requirements}` : "",
		]
			.filter(Boolean)
			.join("\n\n"),
		publishedAt: dateOf(offer.published_at ?? offer.created_at),
		companyName: offer.company_name?.trim() || undefined,
	};
}

const isOffer = (value: unknown): value is RecruiteeOffer =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as RecruiteeOffer).slug === "string" &&
	typeof (value as RecruiteeOffer).title === "string";

export class RecruiteeSource implements JobSource {
	readonly kind = "recruitee" as const;
	constructor(private readonly fetchImpl: FetchLike = fetch) {}

	async listJobs({ sourceKey }: SourceTarget): Promise<NormalizedJob[]> {
		const origin = companyOrigin("recruitee", sourceKey, DOMAIN);
		const body = await fetchJson<{ offers?: unknown }>(
			this.fetchImpl,
			"recruitee",
			sourceKey,
			`${origin}/api/offers/`,
		);
		if (!Array.isArray(body?.offers))
			throw new BoardNotFoundError("recruitee", sourceKey);
		return body.offers
			.filter(isOffer)
			.filter((offer) => !offer.status || offer.status === "published")
			.map((offer) => mapRecruiteeOffer(offer, origin));
	}

	/**
	 * The offer's own page: open while it names this offer and is published. A 404 is gone only
	 * when the company's list answers with other offers and not this one.
	 */
	async checkPosting(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus> {
		const origin = companyOrigin("recruitee", sourceKey, DOMAIN);
		const slug = externalId.toLowerCase();
		return fetchPostingStatus(
			this.fetchImpl,
			"recruitee",
			{
				url: `${origin}/api/offers/${encodeURIComponent(slug)}`,
				id: slug,
				isSame: (body) => {
					const offer = (body as { offer?: unknown })?.offer;
					return isOffer(offer) && offer.slug.toLowerCase() === slug;
				},
				closed: (body) => {
					const status = (body as { offer?: RecruiteeOffer }).offer?.status;
					return Boolean(status) && status !== "published";
				},
			},
			{
				url: `${origin}/api/offers/`,
				ids: (body) => {
					const offers = (body as { offers?: unknown })?.offers;
					return Array.isArray(offers)
						? offers.filter(isOffer).map((o) => o.slug)
						: [];
				},
			},
			{ signal, pacing },
		);
	}
}
