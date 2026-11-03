export const JOB_SOURCES = [
	"ashby",
	"greenhouse",
	"lever",
	"scrape",
	"linkedin",
	// Read from their search pages in the user's browser (core/sites); always handed off.
	"indeed",
	"glassdoor",
	// Found by web search on any other site (core/web); always handed off.
	"web",
	// Added by hand (`dev:seed-job`): no board claimed.
	"manual",
] as const;
export type JobSourceKind = (typeof JOB_SOURCES)[number];

export type WorkplaceType = "remote" | "hybrid" | "onsite" | "unknown";

/** A job posting as returned by any source, before it is stored. */
export interface NormalizedJob {
	source: JobSourceKind;
	externalId: string;
	url: string;
	title: string;
	/** Every location string the source reported, primary first. */
	locations: string[];
	workplaceType: WorkplaceType;
	department?: string;
	employmentType?: string;
	/** Plain text description, used by the filter and scorer. */
	descriptionText: string;
	/** The employer's own apply link when the source shows one (LinkedIn); never opened by the pipeline. */
	applyUrl?: string;
	publishedAt?: Date;
	/** The posting's end date when its page gives one (schema.org `validThrough`); past it, closed. */
	validThrough?: Date;
	/** The employer's name as the source shows it (Greenhouse's company_name), when it gives one. */
	companyName?: string;
}

export const COMPANY_STATUSES = ["active", "removed"] as const;

/** Health of the source behind a company, separate from whether the user watches it. */
export const SOURCE_HEALTH = [
	"ok",
	"needs_human",
	"robots_disallowed",
	"error",
] as const;
export type SourceHealth = (typeof SOURCE_HEALTH)[number];

export interface CompanyRef {
	id: string;
	userId: string;
	name: string;
	source: JobSourceKind;
	/** Board token for API sources, careers page URL for scrape sources. */
	sourceKey: string;
	scrapeParser?: string | null;
}
