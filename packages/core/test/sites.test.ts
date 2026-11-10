import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { submissionModeForSource } from "../src/apply/modes";
import { NoopNotifier } from "../src/notify/ntfy";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { FakeLlmProvider } from "../src/scoring/fake";
import {
	retryDue,
	SiteSearchProvider,
	type SiteStopRecord,
	type SiteStore,
	stopRecord,
} from "../src/sites/provider";
import { detectSiteStop, readJobPage, readSearchPage } from "../src/sites/read";
import { SITES, type SiteId } from "../src/sites/sites";
import { fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

const fixture = (name: string) =>
	fs.readFileSync(
		path.join(import.meta.dirname, "fixtures/sites", name),
		"utf8",
	);
const page = (url: string, html: string, status: number | null = 200) => ({
	url,
	status,
	html,
});

describe("reading Indeed and Glassdoor pages (local fixtures; selectors unproven on the live sites)", () => {
	it("reads a search page's cards and a job page", () => {
		expect(readSearchPage(fixture("indeed-search.html"), SITES.indeed)).toEqual(
			{
				cards: [
					{
						jobId: "a1b2c3d4e5f60718",
						title: "Senior Frontend Engineer",
						company: "Harbor Mills",
						location: "Remote",
					},
					{
						jobId: "0f1e2d3c4b5a6978",
						title: "Frontend Engineer, Payments",
						company: "Lumen Labs",
						location: "Hybrid in Porto",
					},
				],
			},
		);
		expect(
			readSearchPage(fixture("glassdoor-search.html"), SITES.glassdoor),
		).toEqual({
			cards: [
				{
					jobId: "1009876543210",
					title: "Frontend Engineer",
					company: "Quarry Systems",
					location: "Remote",
				},
			],
		});
		const job = readJobPage(fixture("indeed-job.html"), SITES.indeed);
		expect(job).toMatchObject({ title: "Senior Frontend Engineer" });
		expect("description" in job && job.description).toContain(
			"React and TypeScript",
		);
	});

	it("stops and names the selector that found nothing", () => {
		const broken = fixture("indeed-search.html").replaceAll(
			'data-testid="company-name"',
			'data-testid="employer"',
		);
		expect(readSearchPage(broken, SITES.indeed)).toEqual({
			stop: expect.objectContaining({
				kind: "selectors",
				selector: "cardCompany",
			}),
		});
		expect(
			readJobPage(
				'<html><h1 data-test="job-title">X</h1></html>',
				SITES.glassdoor,
			),
		).toEqual({
			stop: expect.objectContaining({ selector: "jobDescription" }),
		});
	});

	it("stops at a sign-in wall, a check, a CAPTCHA, a refusal and another host", () => {
		const host = "https://www.indeed.com";
		expect(
			detectSiteStop(
				page(`${host}/account/login?dest=x`, "<html></html>"),
				SITES.indeed,
			)?.kind,
		).toBe("login_wall");
		expect(
			detectSiteStop(
				page(`${host}/jobs?q=x`, fixture("indeed-login.html")),
				SITES.indeed,
			)?.kind,
		).toBe("login_wall");
		expect(
			detectSiteStop(
				page(
					"https://www.glassdoor.com/Job/jobs.htm",
					fixture("glassdoor-check.html"),
				),
				SITES.glassdoor,
			)?.kind,
		).toBe("security_check");
		expect(
			detectSiteStop(
				page(`${host}/jobs`, '<iframe src="https://hcaptcha.com/x">'),
				SITES.indeed,
			)?.kind,
		).toBe("captcha");
		expect(
			detectSiteStop(page(`${host}/jobs`, "<html></html>", 403), SITES.indeed)
				?.kind,
		).toBe("blocked");
		expect(
			detectSiteStop(
				page("https://example.com/", "<html></html>"),
				SITES.indeed,
			)?.kind,
		).toBe("unusual_page");
		// Indeed's regional hosts are Indeed: a signed-in user lands on tr.indeed.com.
		expect(
			detectSiteStop(
				page("https://tr.indeed.com/", "<html></html>"),
				SITES.indeed,
			),
		).toBeNull();
		expect(
			detectSiteStop(
				page("https://secure.indeed.com/auth?hl=tr", "<html></html>"),
				SITES.indeed,
			)?.kind,
		).toBe("login_wall");
		for (const other of [
			"https://notindeed.com/",
			"https://indeed.com.evil.example/",
		])
			expect(
				detectSiteStop(page(other, "<html></html>"), SITES.indeed)?.kind,
			).toBe("unusual_page");
		// The employer's own words are not the site's: a posting about fraud is not a block.
		expect(
			detectSiteStop(
				page(`${host}/viewjob?jk=1`, fixture("indeed-job.html")),
				SITES.indeed,
			),
		).toBeNull();
	});

	it("hands every Indeed and Glassdoor job off: nothing is filled or sent", () => {
		for (const source of ["indeed", "glassdoor"])
			expect(submissionModeForSource(source, null).mode).toBe("handoff");
	});
});

/** A local stand-in for a site: each URL answered from a fixture, every opened URL recorded. */
function standIn(
	site: SiteId,
	pages: Record<string, { html: string; status?: number; finalUrl?: string }>,
) {
	const opened: string[] = [];
	let closed = 0;
	const origin = "http://127.0.0.1:4777";
	const reader = {
		open: async (url: string) => {
			opened.push(url);
			const path = url.slice(origin.length).replace(/\?.*$/, "");
			const hit = pages[path] ?? { html: "<html>missing</html>", status: 404 };
			return {
				url: hit.finalUrl ?? url,
				status: hit.status ?? 200,
				html: hit.html,
			};
		},
		close: async () => {
			closed++;
		},
	};
	return { reader, opened, origin, closedCount: () => closed, site };
}

function setup(
	stand: ReturnType<typeof standIn>,
	pages = 8,
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
	// One search in the plan (the profile's title, remote worldwide): no country set.
	repo.settings = { ...repo.settings, livesIn: "", keepOnsiteIn: [] };
	const stops = new Map<string, SiteStopRecord>();
	const store: SiteStore = {
		hasPosting: async (_u, source, id) =>
			repo.jobs.some((j) => j.job.source === source && j.job.externalId === id),
		companyFor: async (userId, input) =>
			(
				repo.companies.find(
					(c) => c.sourceKey === input.sourceKey && c.source === input.source,
				) ?? repo.addCompany(input, userId)
			).id,
		stopped: async (_u, site) => stops.get(site) ?? null,
		stop: async (_u, site, stop) => {
			stops.set(site, stop);
		},
		clearStop: async (_u, site) => {
			stops.delete(site);
		},
	};
	const sleeps: number[] = [];
	const debugged: { url: string; kind: string }[] = [];
	const provider = new SiteSearchProvider(
		SITES[stand.site],
		async () => stand.reader,
		store,
		{
			origin: stand.origin,
			pages,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			random: () => 0.5,
			now: () => clock.now,
			debug: async (page, stop) => {
				debugged.push({ url: page.url, kind: stop.kind });
			},
		},
	);
	const workflows = new LocalWorkflowStarter();
	const progress: unknown[] = [];
	const deps: PipelineDeps = {
		repo,
		sources: {},
		providers: async () => [provider],
		scanProgress: (_u, p) => {
			progress.push(p);
		},
		llm: new FakeLlmProvider(),
		claimsLlm: new FakeLlmProvider(),
		exporter: fakeExporter(),
		notifier: new NoopNotifier(),
		workflows,
	};
	workflows.bind(deps);
	const scan = () =>
		runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
	return { repo, scan, sleeps, stops, debugged, clock, progress };
}

describe("the Indeed provider against a local stand-in", () => {
	const pages = {
		"/jobs": { html: fixture("indeed-search.html") },
		"/viewjob": { html: fixture("indeed-job.html") },
	};

	it("reads search then job pages at a human pace, saves jobs as hand-off, and reads nothing twice", async () => {
		const stand = standIn("indeed", pages);
		const { repo, scan, sleeps, progress } = setup(stand);
		const result = await scan();
		expect(progress).toEqual([
			{
				source: "indeed",
				label: "Indeed",
				query: "Frontend Engineer · remote, worldwide",
			},
		]);
		expect(stand.opened).toEqual([
			`${stand.origin}/jobs?q=Frontend%20Engineer&l=Remote`,
			`${stand.origin}/viewjob?jk=a1b2c3d4e5f60718`,
			`${stand.origin}/viewjob?jk=0f1e2d3c4b5a6978`,
		]);
		// A pause before every page but the first, inside 20 to 60 seconds.
		expect(sleeps).toEqual([40_000, 40_000]);
		expect(
			repo.jobs.map((j) => [j.job.source, j.job.externalId, j.job.url]),
		).toEqual([
			[
				"indeed",
				"a1b2c3d4e5f60718",
				"https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60718",
			],
			[
				"indeed",
				"0f1e2d3c4b5a6978",
				"https://www.indeed.com/viewjob?jk=0f1e2d3c4b5a6978",
			],
		]);
		expect(repo.companies.map((c) => c.name)).toContain("Harbor Mills");
		expect(result.providers?.[0]).toMatchObject({
			provider: "indeed",
			queries: 1,
			found: 2,
			fetched: 2,
			// For the scan history.
			searches: ["Frontend Engineer · remote, worldwide"],
			pagesRead: 3,
			results: 2,
			duplicates: 0,
		});
		expect(stand.closedCount()).toBe(1);

		stand.opened.length = 0;
		const again = await scan();
		expect(stand.opened).toEqual([
			`${stand.origin}/jobs?q=Frontend%20Engineer&l=Remote`,
		]);
		expect(again.providers?.[0]).toMatchObject({ results: 2, duplicates: 2 });
	});

	it("keeps under the page cap and says so", async () => {
		const stand = standIn("indeed", pages);
		const { scan } = setup(stand, 2);
		const result = await scan();
		expect(stand.opened).toHaveLength(2);
		expect(result.providers?.[0]?.problem).toMatch(/Page cap of 2 reached/);
		// A cap is a note, not an error.
		expect(result.providers?.[0]?.status).toBe("ok");
	});

	it("stops at a sign-in wall, records it, and opens nothing more until it is cleared", async () => {
		const stand = standIn("indeed", {
			"/jobs": {
				html: fixture("indeed-login.html"),
				finalUrl: "http://127.0.0.1:4777/account/login",
			},
		});
		const { scan, stops } = setup(stand);
		const first = await scan();
		expect(first.providers?.[0]?.problem).toMatch(
			/^Stopped: Indeed sign-in page/,
		);
		expect(stops.get("indeed")?.kind).toBe("login_wall");
		expect(stand.opened).toHaveLength(1);
		const second = await scan();
		expect(stand.opened).toHaveLength(1);
		expect(second.providers?.[0]?.problem).toMatch(
			/Clear it in Settings › Sources/,
		);
	});

	it("stops on a selector miss, names it, keeps the page, and tries again later with backoff", async () => {
		const broken = fixture("glassdoor-search.html").replace(
			'aria-label="Jobs List"',
			'aria-label="Results"',
		);
		const pages: Record<string, { html: string }> = {
			"/Job/jobs.htm": { html: broken },
		};
		const stand = standIn("glassdoor", pages);
		const { scan, stops, debugged, clock } = setup(stand);
		const result = await scan();
		expect(stops.get("glassdoor")).toMatchObject({
			kind: "selectors",
			selector: "resultsList",
			failures: 1,
			retryAt: "2026-11-02T10:59:00.000Z",
		});
		expect(result.providers?.[0]?.problem).toMatch(
			/^Paused after: .*"resultsList".*Tries again/,
		);
		expect(debugged).toEqual([
			{
				url: `${stand.origin}/Job/jobs.htm?sc.keyword=Frontend%20Engineer&locKeyword=Remote`,
				kind: "selectors",
			},
		]);
		// Within the hour: nothing is opened.
		clock.now = new Date("2026-11-02T10:30:00Z");
		await scan();
		expect(stand.opened).toHaveLength(1);
		// The next hourly scan tries again; a second miss in a row waits two hours.
		clock.now = new Date("2026-11-02T11:00:00Z");
		await scan();
		expect(stand.opened).toHaveLength(2);
		expect(stops.get("glassdoor")).toMatchObject({
			failures: 2,
			retryAt: "2026-11-02T12:59:00.000Z",
		});
		// The site is back: the run reads it and the stop is gone.
		pages["/Job/jobs.htm"] = { html: fixture("glassdoor-search.html") };
		pages["/job-listing/index.htm"] = { html: fixture("glassdoor-job.html") };
		clock.now = new Date("2026-11-02T13:00:00Z");
		const back = await scan();
		expect(stops.has("glassdoor")).toBe(false);
		expect(back.providers?.[0]).toMatchObject({ fetched: 1 });
		expect(back.providers?.[0]?.problem).toBeUndefined();
	});

	it("holds at Glassdoor's own check shown with HTTP 403: no retry, no kept page, nothing opened after", async () => {
		const stand = standIn("glassdoor", {
			"/Job/jobs.htm": {
				html: "<h1>Humans only</h1><p>Please verify you are a human.</p>",
				status: 403,
			},
		});
		const { scan, stops, debugged, clock } = setup(stand);
		const first = await scan();
		expect(stops.get("glassdoor")).toMatchObject({ kind: "security_check" });
		expect(stops.get("glassdoor")?.retryAt).toBeUndefined();
		expect(first.providers?.[0]?.problem).toMatch(
			/^Stopped: Glassdoor bot check/,
		);
		expect(debugged).toEqual([]);
		// A day later, still held: nothing is opened until the user clears it.
		clock.now = new Date("2026-11-03T10:00:00Z");
		await scan();
		expect(stand.opened).toHaveLength(1);
	});

	it("does not keep a page it stopped on for a sign-in or a check", async () => {
		const stand = standIn("indeed", {
			"/jobs": { html: fixture("indeed-login.html") },
		});
		const { scan, debugged, stops } = setup(stand);
		await scan();
		expect(stops.get("indeed")?.kind).toBe("login_wall");
		expect(debugged).toEqual([]);
	});
});

describe("stop records", () => {
	const now = new Date("2026-11-02T10:00:00Z");
	const miss = { kind: "selectors" as const, reason: "x" };

	it("double the wait after each transient stop in a row, up to a day", () => {
		let record: SiteStopRecord | null = null;
		const waits: number[] = [];
		for (let i = 0; i < 7; i++) {
			record = stopRecord(miss, record, now);
			waits.push(
				(new Date(record.retryAt as string).getTime() -
					now.getTime() +
					60_000) /
					3_600_000,
			);
		}
		expect(waits).toEqual([1, 2, 4, 8, 16, 24, 24]);
	});

	it("hold a check or sign-in, and treat records from before backoff as due", () => {
		const held = stopRecord({ kind: "captcha", reason: "x" }, null, now);
		expect(held.retryAt).toBeUndefined();
		expect(retryDue(held, now)).toBe(false);
		// The record an earlier version left (Indeed's selector miss, Glassdoor's refusal).
		expect(
			retryDue(
				{ kind: "blocked", reason: "x", at: "2026-11-02T07:12:27Z" },
				now,
			),
		).toBe(true);
		expect(
			stopRecord(miss, { ...miss, at: "2026-11-02T07:00:00Z" }, now).failures,
		).toBe(2);
	});
});

describe("a site provider whose scan step gives up", () => {
	it("stops at the abort: no page after it, and the reader (its tab) is closed", async () => {
		const stand = standIn("indeed", {
			"/jobs": { html: fixture("indeed-search.html") },
			"/viewjob": { html: fixture("indeed-job.html") },
		});
		const { repo } = setup(stand);
		const store: SiteStore = {
			hasPosting: async () => false,
			companyFor: async () => "c1",
			stopped: async () => null,
			stop: async () => {},
			clearStop: async () => {},
		};
		const controller = new AbortController();
		const provider = new SiteSearchProvider(
			SITES.indeed,
			async (signal) => {
				expect(signal).toBe(controller.signal);
				return stand.reader;
			},
			store,
			{
				origin: stand.origin,
				// The gap before the second page never ends: only the abort ends the run.
				sleep: () => {
					setTimeout(() => controller.abort(new Error("step timed out")), 5);
					return new Promise(() => {});
				},
				random: () => 0.5,
			},
		);
		await expect(
			provider.run(
				{ repo } as unknown as PipelineDeps,
				"u1",
				controller.signal,
			),
		).rejects.toThrow("step timed out");
		expect(stand.opened).toHaveLength(1);
		expect(stand.closedCount()).toBe(1);
	});

	it("has a step limit above its worst case of pages and waits", () => {
		const provider = new SiteSearchProvider(
			SITES.indeed,
			async () => {
				throw new Error("not opened");
			},
			{} as SiteStore,
			{ sleep: async () => {}, random: () => 0 },
		);
		// 8 pages: 60 s gaps, 75 s to load and render each, plus a 20 minute wait budget.
		const worst = 8 * 60 + 8 * 75 + 20 * 60;
		expect(provider.timeoutSeconds).toBeGreaterThan(worst);
	});
});
