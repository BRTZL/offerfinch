import type { JobSourceKind, NormalizedJob } from "../domain/types";
import type { LlmProvider } from "../scoring/llm";

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export interface SourceTarget {
	/** Board token for API sources, careers page URL for the scrape source. */
	sourceKey: string;
	/** Optional per-site parser name for the scrape source. */
	parser?: string | null;
	companyName?: string;
	/**
	 * The model for the scrape source's extraction fallback, metered for the user whose scan this
	 * is (no application), so the spending cap applies. Without it the fallback is skipped.
	 */
	llm?: LlmProvider;
}

export interface JobSource {
	readonly kind: JobSourceKind;
	listJobs(target: SourceTarget): Promise<NormalizedJob[]>;
	/**
	 * Whether one posting is still on its board (docs/decisions.md, 2026-11-03): "gone" only on
	 * the board's definite answer; anything unclear (an error, a timeout, an answer it can't
	 * read) throws, and a throw never closes a job. Boards without a cheap check leave it out.
	 */
	checkPosting?(
		sourceKey: string,
		externalId: string,
		signal?: AbortSignal,
		pacing?: RequestPacing,
	): Promise<PostingStatus>;
}

/**
 * How a run of checks (the scan's sweep) spaces and shares its requests: `before` waits its
 * turn ahead of every request, a board's list included, and a board read once is not read again
 * in the same run.
 */
export interface RequestPacing {
	before(): Promise<void>;
	boards: Map<string, Promise<BoardAnswer>>;
}

/** A board list's answer, kept for the rest of a run. */
export interface BoardAnswer {
	status: number;
	body: unknown;
}

/** One board read for a run of checks: paced, and shared with the run when it has `pacing`. */
export function readBoard(
	fetchImpl: FetchLike,
	url: string,
	signal?: AbortSignal,
	pacing?: RequestPacing,
): Promise<BoardAnswer> {
	const known = pacing?.boards.get(url);
	if (known !== undefined) return known;
	const read = (async () => {
		await pacing?.before();
		const response = await fetchImpl(url, {
			headers: { accept: "application/json", "user-agent": USER_AGENT },
			signal,
		});
		return {
			status: response.status,
			body: response.ok ? await response.json() : null,
		};
	})();
	// A failed read is not kept: the next posting may read the board again.
	pacing?.boards.set(url, read);
	read.catch(() => pacing?.boards.delete(url));
	return read;
}

export type PostingStatus = "open" | "gone";

/** The board does not exist (404, or an empty Ashby board). */
export class BoardNotFoundError extends Error {
	constructor(
		readonly source: JobSourceKind,
		readonly sourceKey: string,
	) {
		super(`${source} board not found: ${sourceKey}`);
		this.name = "BoardNotFoundError";
	}
}

/** A block, challenge or CAPTCHA was detected. The source is handed to the user; never bypassed. */
export class SourceBlockedError extends Error {
	constructor(
		readonly sourceKey: string,
		readonly reason: string,
	) {
		super(`Source blocked (${sourceKey}): ${reason}`);
		this.name = "SourceBlockedError";
	}
}

/** robots.txt disallows fetching this page for our user agent. */
export class RobotsDisallowedError extends Error {
	constructor(readonly url: string) {
		super(`robots.txt disallows ${url}`);
		this.name = "RobotsDisallowedError";
	}
}

/** Honest and identifiable as a bot, but not tied to a person. */
export const USER_AGENT = "OfferFinchBot/0.1 (automated job board reader)";

export async function fetchJson<T>(
	fetchImpl: FetchLike,
	source: JobSourceKind,
	sourceKey: string,
	url: string,
): Promise<T> {
	const response = await fetchImpl(url, {
		headers: { accept: "application/json", "user-agent": USER_AGENT },
	});
	if (response.status === 404) throw new BoardNotFoundError(source, sourceKey);
	if (!response.ok) {
		throw new Error(
			`${source} ${sourceKey}: HTTP ${response.status} from ${url}`,
		);
	}
	return (await response.json()) as T;
}

/**
 * One posting's own API page. A 200 is open when it names the same posting. A 404 says the
 * posting is gone only once the board itself answers and lists other postings but not this one:
 * a renamed or moved board answers 404 for every posting it had (docs/decisions.md,
 * 2026-11-03). Anything else (5xx, 429, 403, a missing or empty board) throws.
 */
export async function fetchPostingStatus(
	fetchImpl: FetchLike,
	source: JobSourceKind,
	posting: { url: string; id: string; isSame: (body: unknown) => boolean },
	board: { url: string; ids: (body: unknown) => string[] },
	{ signal, pacing }: { signal?: AbortSignal; pacing?: RequestPacing } = {},
): Promise<PostingStatus> {
	await pacing?.before();
	const response = await fetchImpl(posting.url, {
		headers: { accept: "application/json", "user-agent": USER_AGENT },
		signal,
	});
	if (response.ok) {
		if (!posting.isSame(await response.json()))
			throw new Error(
				`${source}: ${posting.url} answered with another posting`,
			);
		return "open";
	}
	if (response.status !== 404)
		throw new Error(`${source}: HTTP ${response.status} from ${posting.url}`);
	const listed = await readBoard(fetchImpl, board.url, signal, pacing);
	if (listed.status < 200 || listed.status >= 300)
		throw new Error(
			`${source}: the posting answers 404 and its board answers ${listed.status}`,
		);
	const ids = board.ids(listed.body).map((id) => id.toLowerCase());
	if (ids.length === 0)
		throw new Error(
			`${source}: the posting answers 404 and its board lists no postings`,
		);
	if (ids.includes(posting.id.toLowerCase()))
		throw new Error(
			`${source}: the posting answers 404 but its board still lists it`,
		);
	return "gone";
}
