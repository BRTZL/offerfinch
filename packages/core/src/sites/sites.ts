/**
 * Indeed and Glassdoor as job sources (PLAN A): their own search pages, read in the user's local
 * browser, one page at a time at a human pace, read only. Nothing is clicked, filled or
 * submitted, and jobs from them always end at the hand-off.
 *
 * The selectors were checked against the live sites on 2026-11-02 (Indeed signed in, Glassdoor
 * signed out); the sanitized pages are the `real-*` fixtures in core's tests. Where a site serves
 * two layouts (Indeed's job page), a field's selector lists both, newest first. A required
 * selector that finds nothing stops the run and names itself, and the page is kept in
 * site-debug for diagnosis; the runner never guesses from the page text.
 */

export const SITE_IDS = ["indeed", "glassdoor"] as const;
export type SiteId = (typeof SITE_IDS)[number];

export interface SiteSelectors {
	/** The results list of a search page; present with or without results. */
	resultsList: string;
	/** Shown instead of results when a search found nothing. */
	noResults: string;
	/** One result card. */
	card: string;
	/** Inside a card: the element whose attribute holds the job id. */
	cardJobId: string;
	cardJobIdAttribute: string;
	cardTitle: string;
	cardCompany: string;
	/** Optional. */
	cardLocation: string;
	/** Job page. */
	jobTitle: string;
	jobDescription: string;
}

export interface SiteConfig {
	id: SiteId;
	label: string;
	origin: string;
	host: string;
	searchUrl(origin: string, query: string, location: string): string;
	jobUrl(origin: string, jobId: string): string;
	selectors: SiteSelectors;
	/** URL paths that mean a sign-in page or a challenge, whatever the page says. */
	stopPaths: { pattern: RegExp; kind: SiteStopKind; reason: string }[];
	/** What the page shows (`text`) or holds in its tags (`markup`) that means a wall or a check. */
	stopMarkers: {
		pattern: RegExp;
		kind: SiteStopKind;
		reason: string;
		on: "text" | "markup";
	}[];
}

export type SiteStopKind =
	| "login_wall"
	| "captcha"
	| "security_check"
	| "blocked"
	| "unusual_page"
	| "selectors";

const q = encodeURIComponent;

export const SITES: Record<SiteId, SiteConfig> = {
	indeed: {
		id: "indeed",
		label: "Indeed",
		origin: "https://www.indeed.com",
		host: "www.indeed.com",
		searchUrl: (origin, query, location) =>
			`${origin}/jobs?q=${q(query)}&l=${q(location)}`,
		jobUrl: (origin, id) => `${origin}/viewjob?jk=${q(id)}`,
		selectors: {
			resultsList: "#mosaic-provider-jobcards",
			noResults: ".jobsearch-NoResult-messageContainer",
			card: "div.job_seen_beacon",
			cardJobId: "a[data-jk]",
			cardJobIdAttribute: "data-jk",
			// An <h3> since late 2026 (an <h2> before).
			cardTitle: ".jobTitle span[title]",
			cardCompany: '[data-testid="company-name"]',
			cardLocation: '[data-testid="text-location"]',
			// The job page's newer layout first, then the classic one.
			jobTitle:
				'[data-testid="vj-job-title"], [data-testid="jobsearch-JobInfoHeader-title"]',
			jobDescription: ".simple-job-description-html, #jobDescriptionText",
		},
		stopPaths: [
			{
				pattern: /^\/(?:account\/login|auth|m\/login)\b/i,
				kind: "login_wall",
				reason: "Indeed sign-in page",
			},
		],
		stopMarkers: [
			{
				pattern: /additional verification required/i,
				kind: "security_check",
				reason: "Indeed verification page",
				on: "text",
			},
			{
				pattern: /sign in to (?:continue|see more jobs|view this job)/i,
				kind: "login_wall",
				reason: "Indeed asks to sign in",
				on: "text",
			},
		],
	},
	glassdoor: {
		id: "glassdoor",
		label: "Glassdoor",
		origin: "https://www.glassdoor.com",
		host: "www.glassdoor.com",
		searchUrl: (origin, query, location) =>
			`${origin}/Job/jobs.htm?sc.keyword=${q(query)}&locKeyword=${q(location)}`,
		jobUrl: (origin, id) => `${origin}/job-listing/index.htm?jl=${q(id)}`,
		selectors: {
			resultsList: 'ul[aria-label="Jobs List"]',
			noResults: '[data-test="jobs-list-no-results"]',
			card: 'li[data-test="jobListing"]',
			// On the card's own <li>; an inner element as a fallback.
			cardJobId: "[data-jobid]",
			cardJobIdAttribute: "data-jobid",
			cardTitle: 'a[data-test="job-title"]',
			cardCompany: '[class*="EmployerProfile_compactEmployerName"]',
			cardLocation: '[data-test="emp-location"]',
			// The job's own heading: a job page also lists similar jobs, whose links carry
			// data-test="job-title" too. A comma list matches in page order, so the variants never
			// both appear on one page.
			jobTitle: 'h1[id^="jd-job-title-"], h1[data-test="job-title"]',
			jobDescription: '[class*="JobDetails_jobDescription"]',
		},
		stopPaths: [
			{
				pattern: /^\/(?:profile\/login|member\/|signin)/i,
				kind: "login_wall",
				reason: "Glassdoor sign-in page",
			},
		],
		stopMarkers: [
			{
				pattern: /help us protect glassdoor/i,
				kind: "security_check",
				reason: "Glassdoor bot check",
				on: "text",
			},
			{
				// Glassdoor's own check page (with HTTP 403 or 200).
				pattern: /humans only|please verify you are (?:a )?human/i,
				kind: "security_check",
				reason: "Glassdoor bot check",
				on: "text",
			},
			{
				pattern: /sign in to see|join to see|create an account to continue/i,
				kind: "login_wall",
				reason: "Glassdoor asks to sign in",
				on: "text",
			},
		],
	},
};
