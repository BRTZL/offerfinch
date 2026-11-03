/**
 * Where the runner reads a LinkedIn page, one CSS selector per field. When a required one finds
 * nothing the runner stops and records which; it never tries another selector or guesses from
 * the page text.
 *
 * LinkedIn serves two layouts. The server-driven one (SDUI, `data-sdui-screen` on the page) is
 * what a signed-in account got on 2026-11-02: hashed class names that change with every release,
 * so its selectors use only LinkedIn's own component keys, test ids, ARIA labels and the page
 * title (checked against the live site; sanitized pages in core's `real-linkedin-*` fixtures).
 * The classic layout (class names below) is kept for accounts still on it and for the local
 * stand-in in apps/desktop/e2e/linkedin-fixture.ts.
 */
export const LINKEDIN_SELECTORS = {
	/** Classic layout. The results list of a search page; present with or without results. */
	resultsList: ".scaffold-layout__list",
	/** Shown instead of cards when a search has no results. */
	noResults: ".jobs-search-no-results-banner",
	/** One result card; its job id is in the attribute below. */
	card: "li[data-occludable-job-id]",
	cardJobIdAttribute: "data-occludable-job-id",
	cardTitle: ".job-card-container__link",
	cardCompany: ".artdeco-entity-lockup__subtitle",
	cardLocation: ".artdeco-entity-lockup__caption",

	/** Job view page (/jobs/view/<id>/). */
	jobTitle: ".job-details-jobs-unified-top-card__job-title",
	jobCompany: ".job-details-jobs-unified-top-card__company-name",
	/** "Location · posted · applicants"; the location is its first part. Optional. */
	jobTertiary:
		".job-details-jobs-unified-top-card__tertiary-description-container",
	/** Workplace and employment type chips ("Remote", "Full-time"). Optional. */
	jobPreferences: ".job-details-fit-level-preferences",
	jobDescription: "#job-details",
	/** The apply control. Read only: its text says Easy Apply or not, its href (if any) the employer's link. */
	applyButton: ".jobs-apply-button",

	/** SDUI layout: the page is one of LinkedIn's server-driven screens. */
	sduiScreen: "[data-sdui-screen]",
	/** The search results column; present with or without results. */
	sduiResultsList: '[componentkey="SearchResultsMainContent"]',
	/** One result card: the job id ends its component key. Inner parts repeat the key. */
	sduiCard: '[role="button"][componentkey^="job-card-component-ref-"]',
	/** The card's "Dismiss <title> job" control: the only unhashed place its title is. Optional. */
	sduiCardDismiss: 'button[aria-label^="Dismiss "]',
	/** Job view: the page's own title, "Title | Company | LinkedIn". */
	sduiJobTitle: "title",
	/** Job view: the company block ("Company, Acme."). */
	sduiJobCompany: '[aria-label^="Company, "]',
	/** "About the job". */
	sduiJobDescription: '[data-testid="expandable-text-box"]',
	/** Workplace and employment type chips: links back to the job itself. Optional. */
	sduiJobChips: 'section[aria-label="Primary content"] a[href*="/jobs/view/"]',
	/** The apply control (an employer link through /safety/go/, or Easy Apply). Optional. */
	sduiApply:
		'a[aria-label^="Apply"], a[aria-label*="Easy Apply"], button[aria-label*="Easy Apply"]',
} as const;

export type LinkedInSelector = keyof typeof LINKEDIN_SELECTORS;
