import { describe, expect, it } from "vitest";

import { submissionModeForSource } from "../src/apply/modes";
import { NoopNotifier } from "../src/notify/ntfy";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { FakeLlmProvider } from "../src/scoring/fake";
import { LlmPausedError } from "../src/scoring/llm";
import type { SiteStopRecord } from "../src/sites/stops";
import { type SearchBackend, SearchBackendError } from "../src/sources/search";
import { coveredByOtherSource, readableResult } from "../src/web/hosts";
import {
	LIST_TITLE,
	WebSearchProvider,
	type WebSearchStore,
} from "../src/web/provider";
import { cleanQueries, cleanQuery } from "../src/web/queries";
import { structuredPostings } from "../src/web/structured";
import { fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

const LONG =
	"<p>You will build the payments web app in React and TypeScript.</p><ul><li>Requirements: five years of frontend work</li><li>Responsibilities: own features end to end</li></ul>";
const ld = (value: unknown) =>
	`<html><head><script type="application/ld+json">${JSON.stringify(value)}</script></head><body><main>Page</main></body></html>`;
const posting = (extra: Record<string, unknown> = {}) => ({
	"@context": "https://schema.org",
	"@type": "JobPosting",
	title: "Senior Frontend Engineer",
	hiringOrganization: { "@type": "Organization", name: "Harbor Mills" },
	description: LONG,
	datePosted: "2026-10-30",
	...extra,
});

describe("schema.org JobPosting, as pages write it", () => {
	it("reads a plain block: title, company, places, type, dates, description from HTML", () => {
		const [p] = structuredPostings(
			ld(
				posting({
					employmentType: ["FULL_TIME", "CONTRACTOR"],
					validThrough: "2026-12-31T00:00:00Z",
					url: "https://careers.harbormills.example/jobs/42",
					jobLocation: [
						{
							"@type": "Place",
							address: {
								addressLocality: "Porto",
								addressCountry: "PT",
							},
						},
						{
							"@type": "Place",
							address: { addressLocality: "Lisbon", addressCountry: "PT" },
						},
					],
				}),
			),
		);
		expect(p).toMatchObject({
			title: "Senior Frontend Engineer",
			company: "Harbor Mills",
			locations: ["Porto, PT", "Lisbon, PT"],
			workplaceType: "unknown",
			employmentType: "FULL_TIME, CONTRACTOR",
			url: "https://careers.harbormills.example/jobs/42",
			via: "json-ld",
		});
		expect(p?.validThrough?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
		expect(p?.description).toContain("- Requirements: five years");
		expect(p?.description).not.toContain("<li>");
	});

	it("finds it in @graph, nested arrays, a WebPage's mainEntity, and by prefixed or full type names", () => {
		const shapes = [
			{ "@graph": [{ "@type": "WebPage" }, posting()] },
			[[{ "@type": "BreadcrumbList" }], [posting()]],
			{ "@type": "WebPage", mainEntity: posting() },
			posting({ "@type": "schema:JobPosting" }),
			posting({ "@type": ["Thing", "http://schema.org/JobPosting"] }),
		];
		for (const shape of shapes)
			expect(structuredPostings(ld(shape)), JSON.stringify(shape)).toHaveLength(
				1,
			);
	});

	it("reads remote work, entity-encoded HTML, and companies as a string or a list", () => {
		const [remote] = structuredPostings(
			ld(
				posting({
					jobLocationType: "TELECOMMUTE",
					applicantLocationRequirements: { "@type": "Country", name: "Poland" },
					hiringOrganization: "Lumen &amp; Co",
					description: `&lt;p&gt;Remote role.&lt;/p&gt;${LONG}`,
				}),
			),
		);
		expect(remote).toMatchObject({
			company: "Lumen & Co",
			workplaceType: "remote",
			locations: ["Remote (Poland)"],
		});
		expect(remote?.description).not.toContain("&lt;");
		const [listed] = structuredPostings(
			ld(posting({ hiringOrganization: [{ name: "" }, { name: "Quarry" }] })),
		);
		expect(listed?.company).toBe("Quarry");
	});

	it("ignores an unreadable validThrough, and sees a list page as several postings", () => {
		const [p] = structuredPostings(ld(posting({ validThrough: "soon" })));
		expect(p?.validThrough).toBeUndefined();
		expect(
			structuredPostings(
				ld({
					"@type": "ItemList",
					itemListElement: [],
					"@graph": [posting(), posting({ title: "Backend Engineer" })],
				}),
			),
		).toHaveLength(2);
	});

	it("reads microdata when there is no JSON-LD", () => {
		const html = `<div itemscope itemtype="https://schema.org/JobPosting"><h1 itemprop="title">Platform Engineer</h1><div itemprop="hiringOrganization" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Nimbus</span></div><span itemprop="jobLocation">Berlin, Germany</span><meta itemprop="validThrough" content="2027-01-31"><div itemprop="description">${LONG}</div></div>`;
		expect(structuredPostings(html)).toEqual([
			expect.objectContaining({
				title: "Platform Engineer",
				company: "Nimbus",
				locations: ["Berlin, Germany"],
				via: "microdata",
			}),
		]);
	});
});

describe("which results are read", () => {
	it("skips the sites other sources read, in every country", () => {
		for (const url of [
			"https://www.linkedin.com/jobs/view/1",
			"https://uk.linkedin.com/jobs/view/1",
			"https://www.indeed.co.uk/viewjob?jk=1",
			"https://de.indeed.com/viewjob?jk=1",
			"https://www.indeed.com.br/viewjob?jk=1",
			"https://indeed.com/q-x.html",
			"https://www.glassdoor.de/job-listing/x",
			"https://www.glassdoor.co.uk/job-listing/x",
			"https://jobs.ashbyhq.com/acme/1",
			"https://job-boards.eu.greenhouse.io/acme/jobs/1",
			"https://boards.greenhouse.io/acme/jobs/1",
			"https://jobs.eu.lever.co/acme/1",
		])
			expect(coveredByOtherSource(url), url).toBe(true);
		for (const url of [
			"https://careers.harbormills.example/jobs/42",
			"https://indeed-careers.example.com/jobs/1",
			"https://myindeed.com/jobs/1",
			"https://greenhouse.example.com/jobs/1",
			"https://linkedin.example.org/jobs",
		])
			expect(coveredByOtherSource(url), url).toBe(false);
	});

	it("opens only public http(s) pages", () => {
		expect(readableResult("https://careers.harbormills.example/jobs/42")).toBe(
			true,
		);
		for (const url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"http://localhost:8080/jobs",
			"http://127.0.0.1/jobs",
			"http://10.0.0.5/jobs",
			"http://192.168.1.1/",
			"http://[::1]/",
			"http://[::ffff:10.0.0.1]/",
			"https://user:pass@example.com/jobs",
		])
			expect(readableResult(url), url).toBe(false);
	});
});

describe("web search queries", () => {
	it("are plain words: no operators, links or repeats, at most eight", () => {
		expect(
			cleanQuery('site:linkedin.com "senior backend engineer" Go remote'),
		).toBe('"senior backend engineer" Go remote');
		expect(
			cleanQuery("frontend engineer https://evil.example/x inurl:jobs"),
		).toBe("frontend engineer");
		expect(
			cleanQueries([
				"React developer remote",
				"react developer REMOTE",
				"ab",
				...Array.from({ length: 10 }, (_, i) => `engineer ${i}`),
			]),
		).toEqual([
			"React developer remote",
			...Array.from({ length: 7 }, (_, i) => `engineer ${i}`),
		]);
	});
});

/* --------------------------------------------------------------- provider */

const SITE = "https://careers.harbormills.example";

function harness(input: {
	results?: string[];
	pages?: Record<string, { html: string; status?: number; url?: string }>;
	fail?: SearchBackendError;
	llm?: FakeLlmProvider;
	duplicates?: string[];
	robots?: (url: string) => boolean;
	now?: Date;
}) {
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
	const stops = new Map<string, SiteStopRecord>();
	const searched: string[] = [];
	const opened: string[] = [];
	let closed = 0;
	const backend: SearchBackend = {
		name: "test",
		search: async (q) => {
			searched.push(q);
			if (input.fail) throw input.fail;
			return (input.results ?? []).map((url) => ({ url, title: "" }));
		},
		close: async () => {},
	};
	const store: WebSearchStore = {
		hasPosting: async (_u, source, id) =>
			repo.jobs.some((j) => j.job.source === source && j.job.externalId === id),
		companyFor: async (userId, c) =>
			(
				repo.companies.find((x) => x.sourceKey === c.sourceKey) ??
				repo.addCompany(c, userId)
			).id,
		stopped: async (_u, s) => stops.get(s) ?? null,
		stop: async (_u, s, r) => {
			stops.set(s, r);
		},
		clearStop: async (_u, s) => {
			stops.delete(s);
		},
		isDuplicate: async (_u, job) =>
			(input.duplicates ?? []).some(
				(d) => job.urls.includes(d) || d === `${job.company}|${job.title}`,
			),
	};
	const llm = input.llm ?? new FakeLlmProvider();
	const provider = new WebSearchProvider(
		backend,
		async () => ({
			open: async (url) => {
				opened.push(url);
				const p = input.pages?.[url];
				return {
					url: p?.url ?? url,
					status: p?.status ?? (p ? 200 : 404),
					html: p?.html ?? "",
				};
			},
			close: async () => {
				closed++;
			},
		}),
		store,
		async (url) => input.robots?.(url) ?? true,
		{
			sleep: async () => {},
			random: () => 0.5,
			now: () => input.now ?? new Date("2026-11-02T10:00:00Z"),
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
		llm,
		tailorLlm: llm,
		claimsLlm: new FakeLlmProvider(),
		exporter: fakeExporter(),
		notifier: new NoopNotifier(),
		workflows,
	};
	workflows.bind(deps);
	const scan = async () =>
		(await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" }))
			.providers?.[0];
	return {
		repo,
		scan,
		searched,
		opened,
		stops,
		closed: () => closed,
		llm,
		provider,
		deps,
		progress,
	};
}

/** A page without structured data, as the fake model reads it (a posting by its words). */
const plainPosting = (title: string) =>
	`<html><head><meta property="og:site_name" content="Nimbus"></head><body><main><h1>${title}</h1><p>About the role: you will build our design system at Nimbus, remote in Europe.</p><p>Requirements: React, TypeScript and five years of frontend work.</p><p>Responsibilities: own components end to end, review code, mentor others on the team.</p></main></body></html>`;

describe("the web search provider", () => {
	it("writes the day's searches, reads structured and plain postings, skips the rest", async () => {
		const h = harness({
			results: [
				`${SITE}/jobs/42`,
				"https://www.linkedin.com/jobs/view/1",
				"http://192.168.1.10/jobs",
				"https://blog.example.org/how-to-hire",
				"https://nimbus.example/careers/design-engineer",
				"https://jobs.example.net/search?q=react",
				"https://old.example.com/job/1",
				`${SITE}/jobs/42?utm_source=ddg`,
			],
			pages: {
				[`${SITE}/jobs/42`]: { html: ld(posting()) },
				"https://blog.example.org/how-to-hire": {
					html: "<html><body><article><h1>How to hire</h1><p>Short tips.</p></article></body></html>",
				},
				"https://nimbus.example/careers/design-engineer": {
					html: plainPosting("Design Engineer"),
				},
				"https://jobs.example.net/search?q=react": {
					html: ld({ "@graph": [posting(), posting({ title: "Other" })] }),
				},
				"https://old.example.com/job/1": {
					html: ld(posting({ validThrough: "2026-10-01" })),
				},
			},
		});
		const run = await h.scan();
		// The shared plan's searches (the profile's title, remote worldwide and in the office
		// where the user lives) as plain words.
		expect(h.searched).toEqual([
			"Frontend Engineer jobs remote",
			"Frontend Engineer jobs Türkiye",
		]);
		// The LinkedIn result, the private address and the repeat are never opened.
		expect(h.opened).toEqual([
			`${SITE}/jobs/42`,
			"https://blog.example.org/how-to-hire",
			"https://nimbus.example/careers/design-engineer",
			"https://jobs.example.net/search?q=react",
			"https://old.example.com/job/1",
		]);
		expect(
			h.repo.jobs.map((j) => [j.job.source, j.job.title, j.job.companyName]),
		).toEqual([
			["web", "Senior Frontend Engineer", "Harbor Mills"],
			["web", "Design Engineer", "Nimbus"],
		]);
		expect(run).toMatchObject({ queries: 2, fetched: 2 });
		// For the scan history: what it searched, read and set aside.
		expect(run?.searches).toEqual(h.searched);
		expect(run).toMatchObject({ pagesRead: 5, results: 7, duplicates: 0 });
		expect(
			Object.fromEntries((run?.dropped ?? []).map((d) => [d.reason, d.count])),
		).toEqual({ other: 2, not_a_job: 2, expired: 1 });
		expect(
			run?.dropped
				?.find((d) => d.reason === "other")
				?.examples?.map((e) => e.title),
		).toEqual(["read by another source", "not a public web page"]);
		// Live progress: each search as it runs.
		expect(h.progress).toEqual(
			h.searched.map((query) => ({
				source: "web-search",
				label: "Web search",
				query,
			})),
		);
		expect(run?.newJobIds).toHaveLength(2);
		expect(h.closed()).toBe(1);
		// The model read only the plain posting: structured pages need none, and the short article
		// is too little text to ask about.
		expect(
			h.llm.calls.filter((c) => c.task === "extract-posting"),
		).toHaveLength(1);
		// Web jobs end at the hand-off.
		expect(submissionModeForSource("web", null).mode).toBe("handoff");

		// The next scan opens nothing already stored, and keeps the day's searches.
		h.opened.length = 0;
		const again = await h.scan();
		expect(h.opened).not.toContain(`${SITE}/jobs/42`);
		expect(again?.newJobIds).toEqual([]);
	});

	it("does not keep a list page the model took for a posting (its title names jobs)", async () => {
		const url =
			"https://www.frontendengineers.example/remote-frontend-jobs-europe";
		const h = harness({
			results: [url],
			pages: {
				[url]: {
					html: plainPosting("Remote Frontend Developer Jobs in Europe"),
				},
			},
		});
		const run = await h.scan();
		expect(h.repo.jobs).toEqual([]);
		expect(run?.dropped).toEqual([
			{
				reason: "not_a_job",
				count: 1,
				examples: [{ title: "Remote Frontend Developer Jobs in Europe", url }],
			},
		]);
		expect(LIST_TITLE.test("Senior Frontend Engineer, Payments")).toBe(false);
	});

	it("keeps to its caps: pages per site, pages per scan, model reads (every attempt counted)", async () => {
		const many = Array.from(
			{ length: 80 },
			(_, i) => `https://s${i % 20}.example/job/${i}`,
		);
		const h = harness({
			results: many,
			pages: Object.fromEntries(
				many.map((u) => [
					u,
					{
						html: `<html><body><article><h1>News</h1><p>${"A long article about the company's year, its offices and its plans for next year. ".repeat(4)}</p></article></body></html>`,
					},
				]),
			),
		});
		const run = await h.scan();
		expect(h.opened).toHaveLength(50);
		const perSite = new Map<string, number>();
		for (const u of h.opened) {
			const host = new URL(u).host;
			perSite.set(host, (perSite.get(host) ?? 0) + 1);
		}
		expect(Math.max(...perSite.values())).toBe(3);
		expect(
			h.llm.calls.filter((c) => c.task === "extract-posting"),
		).toHaveLength(15);
		// The scan history says which caps were reached; still a run, not an error.
		expect(run?.problem).toMatch(/page cap of 50 reached/);
		expect(run?.problem).toMatch(/AI read cap of 15 reached/);
		expect(run?.status).toBe("ok");
		// At most 8 DuckDuckGo searches a scan, however long the plan.
		expect(h.searched.length).toBeLessThanOrEqual(8);
	});

	it("skips duplicates from any source, pages robots.txt refuses, and pages with a check", async () => {
		const pages = {
			[`${SITE}/jobs/1`]: { html: ld(posting()) },
			[`${SITE}/jobs/2`]: { html: ld(posting({ title: "Backend Engineer" })) },
			"https://x.example/job": {
				html: "<html><body><h1>Checking your browser</h1></body></html>",
				status: 403,
			},
			"https://y.example/job": {
				html: ld(posting({ title: "Data Engineer" })),
			},
		};
		const h = harness({
			results: Object.keys(pages),
			pages,
			duplicates: [`${SITE}/jobs/1`, "Harbor Mills|Backend Engineer"],
			robots: (url) => !url.startsWith("https://y.example"),
		});
		await h.scan();
		expect(h.repo.jobs).toEqual([]);
		expect(h.opened).not.toContain("https://y.example/job");
	});

	it("holds at DuckDuckGo's check: nothing opened, the next scan searches nothing", async () => {
		const h = harness({
			results: [`${SITE}/jobs/42`],
			fail: new SearchBackendError("DuckDuckGo", 200, "x", {
				kind: "captcha",
				reason: "DuckDuckGo's bot check",
			}),
		});
		const run = await h.scan();
		expect(run?.problem).toMatch(/^Stopped: DuckDuckGo's bot check/);
		expect(h.stops.get("web-search")?.kind).toBe("captcha");
		expect(h.opened).toEqual([]);
		await h.scan();
		expect(h.searched).toHaveLength(1);
	});

	it("goes on without the model: structured pages only, a note; the scan is not stopped", async () => {
		const paused = new FakeLlmProvider({
			"extract-posting": () => {
				throw new LlmPausedError("Spending cap reached");
			},
		});
		const h = harness({
			llm: paused,
			results: ["https://nimbus.example/careers/a", `${SITE}/jobs/42`],
			pages: {
				"https://nimbus.example/careers/a": {
					html: plainPosting("Design Engineer"),
				},
				[`${SITE}/jobs/42`]: { html: ld(posting()) },
			},
		});
		const run = await h.scan();
		expect(h.searched[0]).toBe("Frontend Engineer jobs remote");
		expect(h.repo.jobs.map((j) => j.job.title)).toEqual([
			"Senior Frontend Engineer",
		]);
		expect(run?.problem).toMatch(/pages without job data were not read/);
	});
});

describe("web search, hostile pages and redirects (Codex review)", () => {
	it("skips the covered brands under any public suffix, and only the whole label", () => {
		for (const url of [
			"https://linkedin.jobs/x",
			"https://indeed.careers/x",
			"https://glassdoor.work/x",
			"https://ashbyhq.org/x",
			"https://greenhouse.com/x",
			"https://lever.io/x",
			"https://www.indeed.co.jp/x",
			"https://ｌｉｎｋｅｄｉｎ.com/jobs/view/1",
		])
			expect(coveredByOtherSource(url), url).toBe(true);
		for (const url of [
			"https://cleverbridge.com/jobs",
			"https://leverage.io/jobs",
			"https://greenhouses.example/jobs",
			"https://xn--80ak6aa92e.com/jobs",
			"https://linkedin.example.co.uk/jobs",
		])
			expect(coveredByOtherSource(url), url).toBe(false);
	});

	it("opens no private address, whatever form it is written in", () => {
		for (const host of [
			"2130706433",
			"0x7f000001",
			"0177.0.0.1",
			"127。0。0。1",
			"127.99.1.2",
			"169.254.169.254",
			"[::]",
			"[::1]",
			"[fc00::1]",
			"[fe80::1]",
			"[::ffff:127.0.0.1]",
			"[::ffff:7f00:1]",
			"ｌｏｃａｌｈｏｓｔ",
			"printer.local",
		])
			expect(readableResult(`http://${host}/jobs`), host).toBe(false);
	});

	it("reads a posting nested to a hostile depth without overflowing, and the scan goes on", async () => {
		const depth = 15_000;
		const json = `{"@type":"JobPosting","title":"Engineer","hiringOrganization":"Acme","description":"${"Requirements: build things. ".repeat(5)}","jobLocationType":${"[".repeat(depth)}"TELECOMMUTE"${"]".repeat(depth)}}`;
		const html = `<script type="application/ld+json">${json}</script>`;
		expect(() => structuredPostings(html)).not.toThrow();
		const huge = `<script type="application/ld+json">${JSON.stringify(posting({ title: "x".repeat(2 * 1024 * 1024) }))}</script>`;
		expect(structuredPostings(huge)).toEqual([]);
		const h = harness({
			results: ["https://deep.example/job", `${SITE}/jobs/42`],
			pages: {
				"https://deep.example/job": { html },
				[`${SITE}/jobs/42`]: { html: ld(posting()) },
			},
		});
		await h.scan();
		expect(h.repo.jobs.map((j) => j.job.title)).toEqual([
			"Engineer",
			"Senior Frontend Engineer",
		]);
	});

	it("holds a redirect's destination to robots.txt and the per-site cap", async () => {
		const results = Array.from(
			{ length: 4 },
			(_, i) => `https://alias${i}.example/job`,
		);
		const pages = Object.fromEntries(
			results.map((url, i) => [
				url,
				{
					url: `https://target.example/job/${i}`,
					html: ld(posting({ title: `Engineer ${i}` })),
				},
			]),
		);
		const checked: string[] = [];
		const refused = harness({
			results,
			pages,
			robots: (url) => {
				checked.push(url);
				return !url.includes("target.example");
			},
		});
		const out = await refused.scan();
		expect(out?.fetched).toBe(0);
		expect(checked).toEqual(
			results.flatMap((r, i) => [r, `https://target.example/job/${i}`]),
		);
		// robots.txt allows it: the destination's cap (3) holds across the aliases.
		const capped = harness({ results, pages });
		const run = await capped.scan();
		expect(run?.fetched).toBe(3);
		expect(
			run?.dropped?.find((d) => d.reason === "other")?.examples?.[0]?.title,
		).toMatch(/page limit was reached \(after a redirect\)/);
	});

	it("drops a load that redirected through a covered site, and never reads a refused page", async () => {
		const h = harness({
			results: ["https://alias.example/a", "https://alias.example/b"],
			pages: {
				"https://alias.example/a": {
					url: "https://target.example/job",
					html: ld(posting()),
				},
				"https://alias.example/b": { html: ld(posting({ title: "Kept?" })) },
			},
		});
		// The tab reports the hops; one of them went through LinkedIn.
		const open = h.provider as unknown as {
			openPages: () => Promise<unknown>;
		};
		const base = open.openPages;
		open.openPages = async () => {
			const reader = (await base()) as {
				open: (u: string) => Promise<Record<string, unknown>>;
				close: () => Promise<void>;
			};
			return {
				close: reader.close,
				open: async (u: string) => {
					const page = await reader.open(u);
					return u.endsWith("/a")
						? { ...page, redirects: ["https://www.linkedin.com/jobs/view/1"] }
						: {
								...page,
								html: ld(posting({ title: "Kept?" })),
								refused: "a private network address",
							};
				},
			};
		};
		const run = await h.scan();
		expect(h.repo.jobs).toEqual([]);
		expect(
			run?.dropped
				?.find((d) => d.reason === "other")
				?.examples?.map((e) => e.title),
		).toEqual([
			"redirected to a site it may not read",
			"refused: a private network address",
		]);
	});
});

describe("web search authorizes each redirect before it is followed (Codex re-check)", () => {
	/** A tab that follows no redirect: alias pages come back as where they head. */
	function redirecting(
		routes: Record<string, string>,
		pages: Record<string, string>,
		robots: (url: string) => boolean = () => true,
	) {
		const h = harness({ results: Object.keys(routes), robots });
		const fetched: string[] = [];
		(h.provider as unknown as { openPages: () => Promise<unknown> }).openPages =
			async () => ({
				close: async () => {},
				open: async (url: string) => {
					fetched.push(url);
					const target = routes[url];
					if (target) return { url, status: 302, html: "", redirect: target };
					return { url, status: 200, html: pages[url] ?? "" };
				},
			});
		return { h, fetched };
	}

	it("five aliases to one destination: the destination is fetched three times, its page limit", async () => {
		const routes = Object.fromEntries(
			Array.from({ length: 5 }, (_, i) => [
				`https://alias${i}.example/job`,
				`https://target.example/job/${i}`,
			]),
		);
		const pages = Object.fromEntries(
			Object.values(routes).map((t, i) => [
				t,
				ld(posting({ title: `Engineer ${i}` })),
			]),
		);
		const { h, fetched } = redirecting(routes, pages);
		const run = await h.scan();
		expect(
			fetched.filter((u) => u.startsWith("https://target.example")),
		).toEqual([
			"https://target.example/job/0",
			"https://target.example/job/1",
			"https://target.example/job/2",
		]);
		expect(run?.fetched).toBe(3);
		expect(run?.dropped?.find((d) => d.reason === "other")?.count).toBe(2);
	});

	it("a destination robots.txt refuses is never fetched", async () => {
		const { h, fetched } = redirecting(
			{ "https://alias.example/job": "https://denied.example/job" },
			{ "https://denied.example/job": ld(posting()) },
			(url) => !url.startsWith("https://denied.example"),
		);
		const run = await h.scan();
		expect(fetched).toEqual(["https://alias.example/job"]);
		expect(h.repo.jobs).toEqual([]);
		expect(run?.dropped?.[0]?.examples?.[0]?.title).toBe(
			"robots.txt refuses where it redirected",
		);
	});

	it("never follows to a covered site or a private address, nor past five redirects", async () => {
		const chain = Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [
				`https://hop${i}.example/x`,
				`https://hop${i + 1}.example/x`,
			]),
		);
		const { h, fetched } = redirecting(
			{
				"https://a.example/job": "https://www.linkedin.com/jobs/view/1",
				"https://b.example/job": "http://10.0.0.8/admin",
				"https://hop0.example/x": chain["https://hop0.example/x"] as string,
			},
			{},
		);
		// The chain's later hops are answered as redirects too.
		const open = (
			h.provider as unknown as {
				openPages: () => Promise<{ open: (u: string) => Promise<unknown> }>;
			}
		).openPages;
		(h.provider as unknown as { openPages: () => Promise<unknown> }).openPages =
			async () => {
				const r = await open();
				return {
					close: async () => {},
					open: async (u: string) => {
						const next = chain[u];
						if (!next) return r.open(u);
						fetched.push(u);
						return { url: u, status: 302, html: "", redirect: next };
					},
				};
			};
		const run = await h.scan();
		expect(fetched).not.toContain("https://www.linkedin.com/jobs/view/1");
		expect(fetched).not.toContain("http://10.0.0.8/admin");
		expect(fetched.filter((u) => u.startsWith("https://hop"))).toHaveLength(6);
		expect(
			run?.dropped
				?.find((d) => d.reason === "other")
				?.examples?.map((e) => e.title),
		).toEqual([
			"redirected to a site it may not read",
			"redirected to a site it may not read",
			"too many redirects",
		]);
	});
});

describe("web search never loops on a redirect to itself (Codex re-check 2)", () => {
	it("a page redirecting to its own URL (any host case) is set aside after one fetch", async () => {
		const h = harness({
			results: ["https://self.example/same", "https://case.example/x"],
		});
		const fetched: string[] = [];
		(h.provider as unknown as { openPages: () => Promise<unknown> }).openPages =
			async () => ({
				close: async () => {},
				open: async (url: string) => {
					fetched.push(url);
					const redirect = url.includes("self.example")
						? "https://self.example/same"
						: "https://CASE.example/x";
					return { url, status: 302, html: "", redirect };
				},
			});
		const run = await h.scan();
		expect(fetched).toEqual([
			"https://self.example/same",
			"https://case.example/x",
		]);
		expect(
			run?.dropped
				?.find((d) => d.reason === "other")
				?.examples?.map((e) => e.title),
		).toEqual(["it redirects to itself", "it redirects to itself"]);
	});
});
