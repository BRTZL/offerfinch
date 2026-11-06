import type { JobSourceKind, NormalizedJob } from "../domain/types";
import { boardQueries, runStart } from "../search/adapt";
import { type PlanResult, rulesPlan } from "../search/plan";
import type { SiteStop } from "../sites/read";
import { DropLog } from "../sites/report";
import {
	clock,
	isHeldStop,
	retryDue,
	type StopStore,
	stopRecord,
} from "../sites/stops";
import {
	type FoundPosting,
	findPostings,
	SEARCH_BOARDS,
	type SearchBackend,
	SearchBackendError,
	type SearchBoard,
} from "../sources/search";
import { BoardNotFoundError } from "../sources/types";
import type { PipelineDeps } from "./ports";
import type { ProviderRunReport } from "./scan-report";

/**
 * Where a scan looks for jobs (PLAN A). The user never adds companies: each provider finds
 * postings on the internet, and a company is data on the job. Each run is one retryable step.
 */
export interface ScanProvider {
	readonly id: string;
	readonly label: string;
	/** How long the scan step may take (default 900 s); site readers may wait on the user. */
	readonly timeoutSeconds?: number;
	/**
	 * `signal` aborts when the scan step gives up on the run: stop and let go of what is held.
	 * `plan` is the scan's shared search plan; without one the rules' plan from Job search is used.
	 * `cursor` is where in its list of searches this run starts (`PipelineDeps.providerCursor`);
	 * without one, by the hour.
	 */
	run(
		deps: PipelineDeps,
		userId: string,
		signal?: AbortSignal,
		plan?: PlanResult,
		cursor?: number,
	): Promise<ProviderRun>;
}

/**
 * A provider's run. The optional fields of `ProviderRunReport` (searches, pages read, results,
 * duplicates, dropped with reasons, status) feed the scan history (`scan-report.ts`).
 */
export interface ProviderRun extends ProviderRunReport {
	provider: string;
	/** Searches made. */
	queries: number;
	/** Postings found that were new to the app. */
	found: number;
	/** Jobs read from the boards. */
	fetched: number;
	newJobIds: string[];
	/** Why the run stopped short: a refused key, a block, a limit. The scan moves on. */
	problem?: string;
	/** Internal to a provider's run: the page stop behind `problem`, before it is recorded. */
	stop?: SiteStop;
	/**
	 * Parts of the same run reported as sources of their own in the scan history (LinkedIn's
	 * Top picks), with their own counts and new jobs; `newJobIds` above does not repeat theirs.
	 */
	parts?: (Omit<ProviderRun, "parts"> & { label: string })[];
	/**
	 * Job-board search: each board its searches found postings on, in board order. `found`
	 * counts the postings found there (ones the app had included), `new` the jobs it added. Only
	 * on a run that searched; boards with nothing found are left out.
	 */
	boards?: BoardCount[];
}

/** One board's share of a job-board search run (Settings › Sources). */
interface BoardCount {
	board: SearchBoard;
	found: number;
	new: number;
}

/** What the job-board search provider stores, beyond the pipeline's repository. */
export interface SearchStore {
	/** True when the app already has this posting (by board and posting id). */
	hasPosting(
		userId: string,
		source: JobSourceKind,
		externalId: string,
	): Promise<boolean>;
	/** The company a found posting belongs to, created on first sight; never scanned by itself. */
	companyFor(
		userId: string,
		input: { name: string; source: JobSourceKind; sourceKey: string },
	): Promise<string>;
}

/**
 * The searches a provider runs: the scan's shared plan, or (a provider run on its own, as in
 * tests) the rules' plan from Job search and the profile. With Job search's settings.
 */
export async function searchesFor(
	deps: PipelineDeps,
	userId: string,
	plan?: PlanResult,
) {
	const settings = await deps.repo.getFilterSettings(userId);
	const searches =
		plan?.searches ??
		rulesPlan(settings, await deps.repo.getProfile(userId)).map((s) => ({
			...s,
			by: "rules" as const,
		}));
	return { settings, searches };
}

export const NO_SEARCHES =
	"No searches: add job titles in Settings › Job search, or roles to your profile";

const decode = (text: string) =>
	text
		.replace(/&amp;/g, "&")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();

/**
 * The employer's name from a posting page's title: Lever's "Company - Job title", Ashby's
 * "Job title @ Company". Null when the title does not have that shape.
 */
export function companyFromPageTitle(
	board: "lever" | "ashby" | "greenhouse",
	html: string,
	jobTitle: string,
): string | null {
	const raw = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
	if (!raw) return null;
	const title = decode(raw);
	const job = decode(jobTitle);
	let name: string | undefined;
	if (board === "lever" && title.endsWith(` - ${job}`))
		name = title.slice(0, -(job.length + 3));
	else if (board === "ashby") name = title.match(/ @ (.+)$/)?.[1];
	name = name?.trim();
	return name && name.length <= 120 ? name : null;
}

/** "acme-robotics" -> "Acme Robotics": a company's name when no source names it. */
export function nameFromKey(key: string): string {
	return key
		.replace(/[-_.]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
}

/**
 * The employer's display name for a board posting: the board's API gives it on the job (every
 * board but Lever and Ashby); for Lever and Ashby it is read from one public posting page's
 * title. The board key ("acme-robotics" -> "Acme Robotics") only when neither says.
 */
export async function companyNameFor(
	posting: Pick<FoundPosting, "board" | "companyKey">,
	jobs: NormalizedJob[],
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const named = jobs.find((j) => j.companyName)?.companyName;
	if (named) return named;
	const job = jobs[0];
	if (job && (posting.board === "lever" || posting.board === "ashby"))
		try {
			const res = await fetchImpl(job.url, {
				headers: { Accept: "text/html" },
			});
			if (res.ok) {
				const name = companyFromPageTitle(
					posting.board,
					await res.text(),
					job.title,
				);
				if (name) return name;
			}
		} catch {
			// The page is only for the name; the key stands in.
		}
	return nameFromKey(posting.companyKey);
}

/** Per-board counts for one run; `list` keeps board order and grows as boards are seen. */
function boardCounts() {
	const list: BoardCount[] = [];
	const of = (board: SearchBoard) => {
		let count = list.find((c) => c.board === board);
		if (!count) {
			count = { board, found: 0, new: 0 };
			list.push(count);
			list.sort(
				(a, b) =>
					SEARCH_BOARDS.indexOf(a.board) - SEARCH_BOARDS.indexOf(b.board),
			);
		}
		return count;
	};
	return {
		list,
		found: (board: SearchBoard) => {
			of(board).found += 1;
		},
		added: (board: SearchBoard) => {
			of(board).new += 1;
		},
	};
}

/**
 * Postings on the public job boards (`SEARCH_BOARDS`: Greenhouse, Lever, Ashby, SmartRecruiters,
 * Workable, Recruitee, Teamtailor, Personio) at any company, found through a web search
 * (DuckDuckGo's results pages in the app's own tab), then read from each board's public data:
 * one read per company, keeping only the postings the search found.
 */
export class JobBoardSearchProvider implements ScanProvider {
	readonly id = "job-board-search";
	readonly label = "Job-board search";
	/**
	 * Ten results pages with up to 20 s between them, each up to 75 s to load (about 16 min), plus
	 * the reader's budget for a check the user solves (20 min), then the boards' public data: at
	 * most 40 companies, one read each (a SmartRecruiters company one page per found posting,
	 * 1 s apart): under an hour.
	 */
	readonly timeoutSeconds = 3_600;
	constructor(
		private readonly backend: SearchBackend,
		private readonly store: SearchStore & Partial<StopStore>,
		private readonly limits = { queries: 10, perQuery: 20, companies: 40 },
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly now: () => Date = () => new Date(),
	) {}

	/**
	 * A stop the search met is kept like a site's: an unsolved check holds the source until the
	 * user clears it (no new check, notice or wait every hour); a refusal or a changed page is
	 * tried again by a later scan, with backoff. A clean run lifts it.
	 */
	async run(
		deps: PipelineDeps,
		userId: string,
		signal?: AbortSignal,
		plan?: PlanResult,
		cursor?: number,
	): Promise<ProviderRun> {
		const stopped = (await this.store.stopped?.(userId, this.id)) ?? null;
		if (stopped && (isHeldStop(stopped) || !retryDue(stopped, this.now())))
			return {
				provider: this.id,
				queries: 0,
				found: 0,
				fetched: 0,
				newJobIds: [],
				problem: isHeldStop(stopped)
					? `Stopped: ${stopped.reason}. Clear it in Settings › Sources to search again.`
					: `Paused after: ${stopped.reason}. Tries again with the first scan after ${clock(stopped.retryAt as string)}.`,
			};
		let out: ProviderRun;
		try {
			out = await this.runOnce(deps, userId, signal, plan, cursor);
		} finally {
			await this.backend.close?.();
		}
		if (out.stop) {
			const record = stopRecord(out.stop, stopped, this.now());
			await this.store.stop?.(userId, this.id, record);
			out.problem = isHeldStop(record)
				? `Stopped: ${record.reason}, not solved in time. Clear it in Settings › Sources to search again.`
				: `Paused after: ${record.reason}. Tries again with the first scan after ${clock(record.retryAt as string)}.`;
		} else if (stopped && !out.problem)
			await this.store.clearStop?.(userId, this.id);
		delete out.stop;
		return out;
	}

	private async runOnce(
		deps: PipelineDeps,
		userId: string,
		signal?: AbortSignal,
		plan?: PlanResult,
		cursor?: number,
	): Promise<ProviderRun> {
		const out: ProviderRun = {
			provider: this.id,
			queries: 0,
			found: 0,
			fetched: 0,
			newJobIds: [],
		};
		const { settings, searches } = await searchesFor(deps, userId, plan);
		if (searches.length === 0) {
			out.problem = NO_SEARCHES;
			return out;
		}
		// One board per query; a scan makes a few, the next scans the rest of the plan.
		const start = runStart(cursor, this.now(), this.limits.queries);
		const queries = boardQueries(
			searches,
			settings.livesIn,
			this.limits.queries,
			start,
		);
		out.queries = queries.length;
		out.searches = queries;
		const drops = new DropLog();
		const counts = boardCounts();
		let postings: FoundPosting[];
		try {
			const known = new Set<string>();
			// Checked before any board is read: a posting the app has is never fetched again.
			const found = await findPostings({
				backend: this.backend,
				queries,
				perQuery: this.limits.perQuery,
				known: () => false,
				signal,
				onQuery: (query) =>
					deps.scanProgress?.(userId, {
						source: this.id,
						label: this.label,
						query,
					}),
			});
			for (const p of found.postings)
				if (await this.store.hasPosting(userId, p.board, p.jobId))
					known.add(`${p.board}:${p.jobId}`);
			postings = found.postings.filter(
				(p) => !known.has(`${p.board}:${p.jobId}`),
			);
			out.pagesRead = queries.length;
			out.cursor = start + queries.length;
			out.results = found.postings.length;
			out.duplicates = known.size;
			for (const p of found.postings) counts.found(p.board);
		} catch (error) {
			if (error instanceof SearchBackendError) {
				out.problem = error.message;
				out.stop = error.stop;
				return out;
			}
			throw error;
		}
		out.found = postings.length;
		out.boards = counts.list;
		const byCompany = new Map<string, FoundPosting[]>();
		for (const p of postings) {
			const key = `${p.board}:${p.companyKey}`;
			byCompany.set(key, [...(byCompany.get(key) ?? []), p]);
		}
		for (const group of [...byCompany.values()].slice(
			0,
			this.limits.companies,
		)) {
			const first = group[0] as FoundPosting;
			const source = deps.sources[first.board];
			if (!source) continue;
			let jobs: NormalizedJob[];
			try {
				jobs = await source.listJobs({
					sourceKey: first.companyKey,
					postingIds: group.map((p) => p.jobId),
				});
			} catch (error) {
				// A posting taken down since the search: nothing to read.
				if (error instanceof BoardNotFoundError) {
					for (const p of group)
						drops.add("expired", { title: p.jobId, url: p.url });
					continue;
				}
				throw error;
			}
			// Ids compare in any case: Workable's shortcodes are upper case, Lever's ids lower.
			const wanted = new Set(group.map((p) => p.jobId.toLowerCase()));
			const matched = jobs.filter((j) =>
				wanted.has(j.externalId.toLowerCase()),
			);
			out.fetched += matched.length;
			// Found by the search but no longer on the board.
			const listed = new Set(matched.map((j) => j.externalId.toLowerCase()));
			for (const p of group)
				if (!listed.has(p.jobId.toLowerCase()))
					drops.add("expired", { title: p.jobId, url: p.url });
			if (matched.length === 0) continue;
			const companyId = await this.store.companyFor(userId, {
				name: await companyNameFor(first, matched, this.fetchImpl),
				source: first.board,
				sourceKey: first.companyKey,
			});
			for (const job of matched) {
				const { jobId, inserted } = await deps.repo.upsertJob(
					userId,
					companyId,
					job,
				);
				if (inserted) {
					out.newJobIds.push(jobId);
					counts.added(first.board);
				}
			}
		}
		out.dropped = drops.report();
		return out;
	}
}
