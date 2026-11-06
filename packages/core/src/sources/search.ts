import type { SiteStop } from "../sites/read";

/**
 * Job-board search (PLAN A): postings on Ashby, Greenhouse and Lever at any company, found through
 * a web search (DuckDuckGo's results pages, read in the app's own tab: ./duckduckgo.ts), then
 * read from those boards' public data. No login, nothing to set up.
 */

type SearchBoard = "ashby" | "greenhouse" | "lever";

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

/** A posting on one of the three boards, read from its URL. */
export interface FoundPosting {
	board: SearchBoard;
	/** The board's company key (Greenhouse board token, Lever and Ashby company name). */
	companyKey: string;
	/** The posting's id on the board, as the board's API gives it. */
	jobId: string;
	url: string;
}

const BOARD_URLS: { board: SearchBoard; pattern: RegExp }[] = [
	{
		board: "greenhouse",
		pattern:
			/^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/i,
	},
	{
		board: "lever",
		pattern:
			/^https?:\/\/jobs(?:\.eu)?\.lever\.co\/([\w.-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
	},
	{
		board: "ashby",
		pattern:
			/^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
	},
];

/** The posting a search result points at, or null for any other page. */
export function postingFromUrl(url: string): FoundPosting | null {
	for (const { board, pattern } of BOARD_URLS) {
		const m = url.match(pattern);
		if (m?.[1] && m[2])
			return {
				board,
				companyKey: decodeURIComponent(m[1]),
				jobId: board === "greenhouse" ? m[2] : m[2].toLowerCase(),
				url,
			};
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
