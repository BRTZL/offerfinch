import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "../src/domain/types";
import { NoopNotifier } from "../src/notify/ntfy";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import {
	companyFromPageTitle,
	JobBoardSearchProvider,
	nameFromKey,
	type SearchStore,
} from "../src/pipeline/providers";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { FakeLlmProvider } from "../src/scoring/fake";
import type { SiteStop } from "../src/sites/read";
import type { SiteStopRecord, StopStore } from "../src/sites/stops";
import {
	DuckDuckGoSearch,
	detectDuckDuckGoStop,
	readDuckDuckGoResults,
} from "../src/sources/duckduckgo";
import {
	postingFromUrl,
	type SearchBackend,
	SearchBackendError,
	searchQueries,
} from "../src/sources/search";
import { fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

const LEVER_ID = "0f6a2c1e-1b2c-4d5e-8f90-123456789abc";
const ASHBY_ID = "9e8d7c6b-5a49-4382-9170-fedcba987654";

describe("postings from search results", () => {
	it("reads a board, a company and a posting id from each board's URLs", () => {
		expect(
			postingFromUrl(
				"https://boards.greenhouse.io/harbormills/jobs/4012345?gh_src=x",
			),
		).toEqual({
			board: "greenhouse",
			companyKey: "harbormills",
			jobId: "4012345",
			url: "https://boards.greenhouse.io/harbormills/jobs/4012345?gh_src=x",
		});
		expect(
			postingFromUrl("https://job-boards.eu.greenhouse.io/lumen/jobs/77")
				?.companyKey,
		).toBe("lumen");
		expect(
			postingFromUrl(`https://jobs.lever.co/lumen-labs/${LEVER_ID}/apply`),
		).toMatchObject({
			board: "lever",
			companyKey: "lumen-labs",
			jobId: LEVER_ID,
		});
		expect(
			postingFromUrl(`https://jobs.ashbyhq.com/Quarry%20Systems/${ASHBY_ID}`),
		).toMatchObject({
			board: "ashby",
			companyKey: "Quarry Systems",
			jobId: ASHBY_ID,
		});
	});

	it("ignores every other page, a board's front page included", () => {
		for (const url of [
			"https://boards.greenhouse.io/harbormills",
			"https://jobs.lever.co/lumen-labs",
			"https://www.linkedin.com/jobs/view/123",
			"https://example.com/boards.greenhouse.io/x/jobs/1",
		])
			expect(postingFromUrl(url)).toBeNull();
	});

	it("builds bounded searches from titles and where the user can work", () => {
		const queries = searchQueries(
			{
				titles: ["Frontend Engineer", "React Developer"],
				remote: true,
				places: [],
			},
			5,
		);
		expect(queries).toHaveLength(5);
		expect(queries[0]).toBe(
			'site:job-boards.greenhouse.io "Frontend Engineer" remote',
		);
		expect(queries[1]).toBe('site:jobs.lever.co "Frontend Engineer" remote');
		expect(
			searchQueries({
				titles: ["Engineer"],
				remote: false,
				places: ["Porto, Portugal"],
			})[2],
		).toBe('site:jobs.ashbyhq.com "Engineer" "Porto, Portugal"');
	});
});

const fixture = (name: string) =>
	fs.readFileSync(
		path.join(import.meta.dirname, "fixtures/sites", name),
		"utf8",
	);

describe("DuckDuckGo as the search (live markup, 2026-11-02)", () => {
	const DDG = "https://html.duckduckgo.com/html/?q=x";

	it("reads organic results, through DuckDuckGo's redirect, to board postings", () => {
		const read = readDuckDuckGoResults(fixture("real-duckduckgo-ashby.html"));
		expect("hits" in read && read.hits.map((h) => h.url)).toEqual([
			"https://jobs.ashbyhq.com/httpie/17de9aae-7a3c-40fb-a352-ddbbd7c14385",
			"https://jobs.ashbyhq.com/plentific/81e89479-f326-4b12-bf99-e0b05a0e5a7f",
			"https://jobs.ashbyhq.com/kamino/4013c730-d5a6-40a7-99f1-da2fe8338bb9",
			"https://jobs.ashbyhq.com/apexx/823fbea9-6cb1-4620-af6d-02c76f600c84",
		]);
		expect("hits" in read && read.hits[0]?.title).toBe(
			"Senior Frontend Engineer (Remote) @ HTTPie",
		);
		const gh = readDuckDuckGoResults(
			fixture("real-duckduckgo-greenhouse.html"),
		);
		expect(
			"hits" in gh && gh.hits.map((h) => postingFromUrl(h.url)?.companyKey),
		).toEqual(["netcraft", "lumimeds", "gitlab", "reddit"]);
		expect(
			detectDuckDuckGoStop({
				url: DDG,
				status: 200,
				html: fixture("real-duckduckgo-ashby.html"),
			}),
		).toBeNull();
	});

	it("skips ads, says nothing found, and names a changed layout", () => {
		const ad = `<div id="links"><div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x&u3=https%3A%2F%2Fjobs.lever.co%2Fad%2F1">Ad</a></div><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjobs.lever.co%2Fa%2Fb">A</a></div></div>`;
		expect(readDuckDuckGoResults(ad)).toEqual({
			hits: [{ url: "https://jobs.lever.co/a/b", title: "A" }],
		});
		expect(
			readDuckDuckGoResults('<div class="no-results">No results.</div>'),
		).toEqual({ hits: [] });
		expect(readDuckDuckGoResults("<main>new</main>")).toEqual({
			stop: expect.objectContaining({ kind: "selectors" }),
		});
	});

	it("knows its bot check and a refusal", () => {
		expect(
			detectDuckDuckGoStop({
				url: DDG,
				status: 200,
				html: '<div class="anomaly-modal__modal"><div>Unfortunately, bots use DuckDuckGo too.</div></div>',
			})?.kind,
		).toBe("captcha");
		expect(
			detectDuckDuckGoStop({ url: DDG, status: 403, html: "" })?.kind,
		).toBe("blocked");
		expect(
			detectDuckDuckGoStop({
				url: "https://example.com/",
				status: 200,
				html: "",
			})?.kind,
		).toBe("unusual_page");
	});

	it("searches in one tab, pausing between pages, and ends the run at a stop", async () => {
		const opened: string[] = [];
		let closed = 0;
		const sleeps: number[] = [];
		const kept: string[] = [];
		const pages = [
			fixture("real-duckduckgo-ashby.html"),
			"<main>changed</main>",
		];
		const search = new DuckDuckGoSearch(
			async () => ({
				open: async (url: string) => {
					opened.push(url);
					return { url, status: 200, html: pages[opened.length - 1] ?? "" };
				},
				close: async () => {
					closed++;
				},
			}),
			{
				origin: "http://127.0.0.1:4888",
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				random: () => 0.5,
				debug: async (_page, stop) => {
					kept.push(stop.kind);
				},
			},
		);
		expect(
			await search.search('site:jobs.ashbyhq.com "A" remote', 2),
		).toHaveLength(2);
		await expect(search.search("b", 20)).rejects.toBeInstanceOf(
			SearchBackendError,
		);
		await search.close();
		expect(opened).toEqual([
			"http://127.0.0.1:4888/html/?q=site%3Ajobs.ashbyhq.com%20%22A%22%20remote",
			"http://127.0.0.1:4888/html/?q=b",
		]);
		expect(sleeps).toEqual([14_000]);
		expect(kept).toEqual(["selectors"]);
		expect(closed).toBe(1);
	});
});

/** A backend answering each query from a fixed list. */
const backend = (
	urls: string[],
	fail?: string,
	failStop?: SiteStop,
): SearchBackend & { closed: number; searches: number; fail?: string } => ({
	name: "test",
	closed: 0,
	searches: 0,
	fail,
	async search() {
		this.searches++;
		if (this.fail)
			throw new SearchBackendError("test", 429, this.fail, failStop);
		return urls.map((url) => ({ url, title: "" }));
	},
	async close() {
		this.closed++;
	},
});

const job = (externalId: string, title: string): NormalizedJob => ({
	source: "greenhouse",
	externalId,
	url: `https://boards.greenhouse.io/harbormills/jobs/${externalId}`,
	title,
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "React and TypeScript.",
	companyName: "Harbor Mills",
});

function setup(
	urls: string[],
	fail?: string,
	failStop?: SiteStop,
	clock = { now: new Date("2026-11-02T10:00:00Z") },
) {
	const repo = new MemoryRepo({
		files: [
			{
				path: "experience/r1.md",
				content:
					"# Harbor Mills — Frontend Engineer\n\n- **Dates:** 2021 – Present\n",
			},
		],
	});
	repo.onDemand = true;
	const reads: string[] = [];
	const stops = new Map<string, SiteStopRecord>();
	const store: SearchStore & StopStore = {
		stopped: async (_u, source) => stops.get(source) ?? null,
		stop: async (_u, source, record) => {
			stops.set(source, record);
		},
		clearStop: async (_u, source) => {
			stops.delete(source);
		},
		hasPosting: async (_u, source, id) =>
			repo.jobs.some((j) => j.job.source === source && j.job.externalId === id),
		companyFor: async (userId, input) =>
			(
				repo.companies.find((c) => c.sourceKey === input.sourceKey) ??
				repo.addCompany(input, userId)
			).id,
	};
	const runs: unknown[] = [];
	const progress: { query?: string }[] = [];
	const workflows = new LocalWorkflowStarter();
	const search = backend(urls, fail, failStop);
	const provider = new JobBoardSearchProvider(
		search,
		store,
		undefined,
		undefined,
		() => clock.now,
	);
	const deps: PipelineDeps = {
		repo,
		sources: {
			greenhouse: {
				kind: "greenhouse",
				listJobs: async ({ sourceKey }) => {
					reads.push(sourceKey);
					return [
						job("1", "Frontend Engineer"),
						job("2", "Account Executive"),
						job("3", "Senior Frontend Engineer"),
					];
				},
			},
		},
		providers: async () => [provider],
		scanProgress: (_u, p) => {
			progress.push(p);
		},
		recordProviderRun: async (_u, run) => {
			runs.push(run);
		},
		llm: new FakeLlmProvider(),
		claimsLlm: new FakeLlmProvider(),
		exporter: fakeExporter(),
		notifier: new NoopNotifier(),
		workflows,
	};
	workflows.bind(deps);
	// A company on an old watchlist: never scanned once providers run.
	repo.addCompany({
		name: "Old Watchlist Co",
		source: "greenhouse",
		sourceKey: "oldco",
	});
	return { repo, deps, reads, runs, search, stops, clock, progress };
}

describe("the job-board search provider", () => {
	const URLS = [
		"https://boards.greenhouse.io/harbormills/jobs/1",
		"https://boards.greenhouse.io/harbormills/jobs/3?utm=x",
		"https://boards.greenhouse.io/harbormills/jobs/1",
		"https://www.example.com/careers",
	];

	it("keeps only the postings the search found, one board read per company, never the watchlist", async () => {
		const { repo, deps, reads, runs, progress } = setup(URLS);
		const result = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(reads).toEqual(["harbormills"]);
		expect(repo.jobs.map((j) => j.job.externalId).sort()).toEqual(["1", "3"]);
		expect(
			repo.companies.find((c) => c.sourceKey === "harbormills")?.name,
		).toBe("Harbor Mills");
		expect(result.providers?.[0]).toMatchObject({
			found: 2,
			fetched: 2,
			// For the scan history.
			results: 2,
			duplicates: 0,
		});
		expect(result.providers?.[0]?.searches?.[0]).toMatch(/Frontend Engineer/);
		expect(progress.map((p) => p.query)).toEqual(
			result.providers?.[0]?.searches,
		);
		expect(runs).toHaveLength(1);
		expect(result.companies).toEqual([]);
		// Listed, not drafted: tailoring waits for Prepare.
		expect(repo.documents).toEqual([]);

		// The second scan reads no board: both postings are known.
		reads.length = 0;
		const again = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(reads).toEqual([]);
		expect(again.providers?.[0]).toMatchObject({
			found: 0,
			newJobIds: [],
			duplicates: 2,
		});
	});

	it("sets aside, as expired, a posting the search found but the board no longer lists", async () => {
		const { deps } = setup([
			"https://boards.greenhouse.io/harbormills/jobs/1",
			"https://boards.greenhouse.io/harbormills/jobs/9",
		]);
		const result = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(result.providers?.[0]).toMatchObject({ results: 2, fetched: 1 });
		expect(result.providers?.[0]?.dropped).toEqual([
			{
				reason: "expired",
				count: 1,
				examples: [
					{
						title: "9",
						url: "https://boards.greenhouse.io/harbormills/jobs/9",
					},
				],
			},
		]);
	});

	it("records a stopped search as the provider's problem, lets go of its tab, and the scan goes on", async () => {
		const { deps, runs, search } = setup(
			URLS,
			"DuckDuckGo stopped the search: DuckDuckGo's bot check. The next scan searches again.",
		);
		const result = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(result.providers?.[0]?.problem).toMatch(/bot check/);
		expect(runs).toHaveLength(1);
		expect(search.closed).toBe(1);
	});

	it("holds after an unsolved check: the next scan opens nothing until it is cleared", async () => {
		const { deps, search, stops } = setup(URLS, "x", {
			kind: "captcha",
			reason: "DuckDuckGo's bot check",
		});
		const scan = () =>
			runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		const first = await scan();
		expect(first.providers?.[0]?.problem).toMatch(
			/^Stopped: DuckDuckGo's bot check, not solved in time/,
		);
		expect(stops.get("job-board-search")?.kind).toBe("captcha");
		const second = await scan();
		expect(search.searches).toBe(1);
		expect(second.providers?.[0]?.problem).toMatch(/Clear it in Settings/);
	});

	it("backs off after a refusal, and a clean run lifts the stop", async () => {
		const { deps, search, stops, clock } = setup(URLS, "x", {
			kind: "blocked",
			reason: "HTTP 403: DuckDuckGo refused the search",
		});
		const scan = () =>
			runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		await scan();
		expect(stops.get("job-board-search")).toMatchObject({
			kind: "blocked",
			failures: 1,
		});
		clock.now = new Date("2026-11-02T10:30:00Z");
		await scan();
		expect(search.searches).toBe(1);
		search.fail = undefined;
		clock.now = new Date("2026-11-02T11:00:00Z");
		const back = await scan();
		expect(back.providers?.[0]).toMatchObject({ found: 2 });
		expect(stops.has("job-board-search")).toBe(false);
	});

	it("names a company from its board key only when no source names it", () => {
		expect(nameFromKey("lumen-labs")).toBe("Lumen Labs");
	});

	it("reads the employer's name from a Lever or Ashby posting page title", () => {
		expect(
			companyFromPageTitle(
				"lever",
				"<html><title>Lumen Labs &amp; Co - Frontend Engineer</title>",
				"Frontend Engineer",
			),
		).toBe("Lumen Labs & Co");
		expect(
			companyFromPageTitle(
				"ashby",
				"<title> Frontend Engineer @ Quarry Systems</title>",
				" Frontend Engineer",
			),
		).toBe("Quarry Systems");
		expect(
			companyFromPageTitle("lever", "<title>Jobs</title>", "Frontend Engineer"),
		).toBeNull();
	});
});
