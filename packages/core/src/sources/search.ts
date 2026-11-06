import type { SiteStop } from "../sites/read";

/**
 * Job-board search (PLAN A): postings on the public job boards below at any company, found
 * through a web search (DuckDuckGo's results pages, read in the app's own tab: ./duckduckgo.ts),
 * then read from those boards' public data. No login, nothing to set up.
 */

/** The boards job-board search finds postings on, each with a public reader (`sources/`). */
export const SEARCH_BOARDS = [
	"greenhouse",
	"lever",
	"ashby",
	"smartrecruiters",
	"workable",
	"recruitee",
	"teamtailor",
	"personio",
] as const;
export type SearchBoard = (typeof SEARCH_BOARDS)[number];

export interface SearchHit {
	url: string;
	title: string;
}

export interface SearchBackend {
	readonly name: string;
	/** `signal` aborts when the scan step gives up on the run. */
	search(
		query: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<SearchHit[]>;
	/** The run is over: let go of what the searches held (a browser tab). */
	close?(): Promise<void>;
}

export class SearchBackendError extends Error {
	constructor(
		readonly backend: string,
		readonly status: number,
		message: string,
		/** What stopped the search on the page (a check, a refusal, a layout change). */
		readonly stop?: SiteStop,
	) {
		super(message);
		this.name = "SearchBackendError";
	}
}

/** A posting on one of the boards, read from its URL. */
export interface FoundPosting {
	board: SearchBoard;
	/**
	 * The board's company key: Greenhouse's board token, the company name in Lever's, Ashby's,
	 * SmartRecruiters' and Workable's paths, the subdomain on Recruitee, Teamtailor and Personio.
	 */
	companyKey: string;
	/** The posting's id on the board, as the board's API gives it. */
	jobId: string;
	url: string;
}

/**
 * One DNS label: a company's subdomain on Recruitee, Teamtailor and Personio. No dots, so
 * "a.b.recruitee.com" is not read as company "a.b"; the readers check it again (`companyOrigin`).
 */
const LABEL = "([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
/** The id ends the path segment, or a slug follows it after a dash. */
const END = "(?=[-/?#]|$)";

/**
 * Each board's posting URLs, and the id as its API writes it: Lever's, Ashby's and Recruitee's
 * in lower case, Workable's shortcodes in upper case, the rest digits. The host comes right after
 * the scheme and the path right after the host (no user name, port or other host).
 */
const BOARD_URLS: {
	board: SearchBoard;
	pattern: RegExp;
	id: (raw: string) => string;
}[] = [
	{
		board: "greenhouse",
		pattern:
			/^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/i,
		id: (raw) => raw,
	},
	{
		board: "lever",
		pattern: new RegExp(
			`^https?://jobs(?:\\.eu)?\\.lever\\.co/([\\w.-]+)/${UUID}`,
			"i",
		),
		id: (raw) => raw.toLowerCase(),
	},
	{
		board: "ashby",
		pattern: new RegExp(
			`^https?://jobs\\.ashbyhq\\.com/([^/?#]+)/${UUID}`,
			"i",
		),
		id: (raw) => raw.toLowerCase(),
	},
	{
		// jobs.smartrecruiters.com/{Company}/{id}-{slug}
		board: "smartrecruiters",
		pattern: new RegExp(
			`^https?://jobs\\.smartrecruiters\\.com/([\\w.-]+)/(\\d{6,})${END}`,
			"i",
		),
		id: (raw) => raw,
	},
	{
		// apply.workable.com/{account}/j/{shortcode}
		board: "workable",
		pattern: new RegExp(
			`^https?://apply\\.workable\\.com/([\\w-]+)/j/([0-9a-f]{6,12})${END}`,
			"i",
		),
		id: (raw) => raw.toUpperCase(),
	},
	{
		// {company}.recruitee.com/o/{slug}
		board: "recruitee",
		pattern: new RegExp(
			`^https?://${LABEL}\\.recruitee\\.com/o/([a-z0-9][a-z0-9-]*)${END}`,
			"i",
		),
		id: (raw) => raw.toLowerCase(),
	},
	{
		// {company}.teamtailor.com/jobs/{id}-{slug}, also under a language (/en-GB/jobs/...)
		board: "teamtailor",
		pattern: new RegExp(
			`^https?://${LABEL}\\.teamtailor\\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?jobs/(\\d+)${END}`,
			"i",
		),
		id: (raw) => raw,
	},
	{
		// {company}.jobs.personio.de/job/{id} (or .com)
		board: "personio",
		pattern: new RegExp(
			`^https?://${LABEL}\\.jobs\\.personio\\.(?:de|com)/job/(\\d+)${END}`,
			"i",
		),
		id: (raw) => raw,
	},
];

/** Boards that key the company in the subdomain. */
const BY_SUBDOMAIN: ReadonlySet<SearchBoard> = new Set([
	"recruitee",
	"teamtailor",
	"personio",
]);
/** Subdomains of the boards' own sites, never a company's. */
const NOT_A_COMPANY = new Set(["www", "app", "api", "jobs", "careers"]);

/** The posting a search result points at, or null for any other page. */
export function postingFromUrl(url: string): FoundPosting | null {
	for (const { board, pattern, id } of BOARD_URLS) {
		const m = url.match(pattern);
		if (!m?.[1] || !m[2]) continue;
		let companyKey = decodeURIComponent(m[1]);
		if (BY_SUBDOMAIN.has(board)) {
			companyKey = companyKey.toLowerCase();
			if (NOT_A_COMPANY.has(companyKey)) return null;
		}
		return { board, companyKey, jobId: id(m[2]), url };
	}
	return null;
}

/**
 * Runs the searches and returns each posting once, in the order found, skipping ones `known`
 * already has. A backend error stops the run and is thrown; nothing is retried here.
 */
export async function findPostings(input: {
	backend: SearchBackend;
	queries: string[];
	perQuery: number;
	known: (posting: FoundPosting) => boolean;
	signal?: AbortSignal;
	/** Called before each search (the scan history's live progress). */
	onQuery?: (query: string) => void;
}): Promise<{ postings: FoundPosting[]; hits: number }> {
	const seen = new Set<string>();
	const postings: FoundPosting[] = [];
	let hits = 0;
	for (const query of input.queries) {
		input.onQuery?.(query);
		const results = await input.backend.search(
			query,
			input.perQuery,
			input.signal,
		);
		hits += results.length;
		for (const hit of results) {
			const posting = postingFromUrl(hit.url);
			if (!posting) continue;
			const key = `${posting.board}:${posting.companyKey.toLowerCase()}:${posting.jobId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (!input.known(posting)) postings.push(posting);
		}
	}
	return { postings, hits };
}
