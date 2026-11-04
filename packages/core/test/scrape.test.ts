import { describe, expect, it } from "vitest";
import { NoopNotifier } from "../src/notify/ntfy";
import { LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { scanCompany } from "../src/pipeline/scan-flow";
import { FakeLlmProvider } from "../src/scoring/fake";
import type { LlmProvider } from "../src/scoring/llm";
import type { SpendStore } from "../src/scoring/metered";
import type { BrowserPage, BrowserProvider } from "../src/scrape/browser";
import { detectChallenge } from "../src/scrape/challenge";
import {
	jobLinks,
	jsonLdItemList,
	jsonLdJobPostings,
	parseListing,
} from "../src/scrape/parsers";
import { HostRateLimiter } from "../src/scrape/rate-limit";
import { parseRobots, RobotsCache } from "../src/scrape/robots";
import { ScrapeSource } from "../src/scrape/source";
import {
	RobotsDisallowedError,
	SourceBlockedError,
} from "../src/sources/types";
import { fakeFetch, fixture } from "./helpers";
import { MemoryRepo } from "./memory-repo";

const LISTING = "https://tessera.example/careers/";

describe("robots.txt", () => {
	const robots = parseRobots(
		"User-agent: *\nDisallow: /private\nAllow: /private/jobs\nCrawl-delay: 3\n\nUser-agent: OfferFinchBot\nDisallow: /careers/secret$\n",
		"OfferFinchBot/0.1",
	);
	it("uses the group for our agent, longest rule wins", () => {
		expect(robots.isAllowed("https://x.com/careers/secret")).toBe(false);
		expect(robots.isAllowed("https://x.com/careers/secret/more")).toBe(true);
		expect(robots.isAllowed("https://x.com/private")).toBe(true);
	});
	it("falls back to the * group", () => {
		const star = parseRobots(
			"User-agent: *\nDisallow: /private\nAllow: /private/jobs\nCrawl-delay: 3",
			"OfferFinchBot/0.1",
		);
		expect(star.isAllowed("https://x.com/private/x")).toBe(false);
		expect(star.isAllowed("https://x.com/private/jobs/1")).toBe(true);
		expect(star.crawlDelaySeconds).toBe(3);
	});
	it("disallows when robots.txt is unreachable and allows on 404", async () => {
		const cache = new RobotsCache(
			"OfferFinchBot/0.1",
			fakeFetch({ "down.example/robots.txt": { status: 503, body: "" } }),
		);
		expect(await cache.isAllowed("https://down.example/careers")).toBe(false);
		expect(await cache.isAllowed("https://missing.example/careers")).toBe(true);
	});
});

describe("rate limiter", () => {
	it("waits between requests to one host, not across hosts", async () => {
		let now = 0;
		const sleeps: number[] = [];
		const limiter = new HostRateLimiter(
			5_000,
			() => now,
			async (ms) => {
				sleeps.push(ms);
				now += ms;
			},
		);
		await limiter.wait("https://a.com/1");
		now += 1_000;
		await limiter.wait("https://a.com/2");
		await limiter.wait("https://b.com/1");
		await limiter.wait("https://a.com/3", 10);
		expect(sleeps).toEqual([4_000, 10_000]);
	});
});

describe("challenge detection", () => {
	it("flags block statuses and challenge pages", () => {
		expect(detectChallenge(403, "<html></html>")).toBe("HTTP 403");
		expect(detectChallenge(200, "<title>Just a moment...</title>")).toMatch(
			/Cloudflare/,
		);
		expect(
			detectChallenge(200, "<div>Please verify you are human</div>"),
		).toMatch(/human/);
	});
	it("does not flag vendor names in cookie banners", () => {
		expect(
			detectChallenge(200, "<p>Partners: Google, DataDome, PerimeterX</p>"),
		).toBeNull();
		expect(
			detectChallenge(
				200,
				'<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>',
			),
		).toMatch(/DataDome/);
	});

	it("does not flag a normal careers page", () => {
		expect(detectChallenge(200, fixture("tessera-careers.html"))).toBeNull();
	});
});

describe("parsers (recorded tessera.example pages)", () => {
	it("reads the ItemList on the listing page", () => {
		const jobs = jsonLdItemList(fixture("tessera-careers.html"), LISTING);
		expect(jobs.map((j) => j.title)).toEqual([
			"Senior Full-Stack Developer",
			"Customer Success Specialist",
			"Sales Development Representative",
		]);
	});
	it("reads the JobPosting on a detail page", () => {
		const [posting] = jsonLdJobPostings(
			fixture("tessera-senior-fullstack.html"),
			"https://www.tessera.example/careers/senior-fullstack-developer/",
		);
		expect(posting?.title).toBe("Senior Full-Stack Developer");
		expect(posting?.descriptionText).toMatch(/TypeScript\/React/);
		expect(posting?.descriptionText).not.toMatch(/<li>/);
	});
	it("falls back to job-looking links", () => {
		const jobs = jobLinks(
			'<a href="/careers/backend-engineer">Backend Engineer</a><a href="/about">About</a>',
			"https://x.com/careers",
		);
		expect(jobs).toEqual([
			{
				url: "https://x.com/careers/backend-engineer",
				title: "Backend Engineer",
			},
		]);
		expect(parseListing("<p>nothing</p>", "https://x.com/careers")).toEqual([]);
	});
});

/** Serves recorded HTML by URL, records every navigation. */
function fakeBrowser(
	pages: Record<string, { status?: number; html: string; redirect?: string }>,
): BrowserProvider & { visits: string[] } {
	const visits: string[] = [];
	let current = "";
	const page: BrowserPage = {
		goto: async (url, options) => {
			visits.push(url);
			current = url;
			// Like the Playwright page: each redirect hop is offered to beforeRedirect first.
			for (
				let next = pages[current]?.redirect;
				next;
				next = pages[current]?.redirect
			) {
				await options?.beforeRedirect?.(next);
				visits.push(next);
				current = next;
			}
			return {
				status: pages[current]?.status ?? (pages[current] ? 200 : 404),
				url: current,
			};
		},
		content: async () => pages[current]?.html ?? "",
		title: async () => "",
		url: () => current,
		waitForSelector: async () => {},
		click: async () => {},
		fill: async () => {},
		selectOption: async () => {},
		check: async () => {},
		uncheck: async () => {},
		setInputFiles: async () => {},
		screenshot: async () => new Uint8Array(),
		setContent: async () => {},
		pdf: async () => new Uint8Array(),
		evaluate: async <T>() => undefined as T,
		type: async () => {},
		press: async () => {},
		waitForTimeout: async () => {},
		waitForNetworkIdle: async () => {},
		restrictNetwork: () => {},
		networkLog: () => [],
		close: async () => {},
	};
	return {
		name: "fake",
		visits,
		openSession: async () => ({
			newPage: async () => page,
			close: async () => {},
		}),
	};
}

const noWait = new HostRateLimiter(0);
const allowAll = new RobotsCache("OfferFinchBot/0.1", fakeFetch({}));

describe("ScrapeSource", () => {
	it("lists jobs and fills descriptions from detail pages", async () => {
		const browser = fakeBrowser({
			[LISTING]: { html: fixture("tessera-careers.html") },
			"https://www.tessera.example/careers/senior-fullstack-developer/": {
				html: fixture("tessera-senior-fullstack.html"),
			},
		});
		const source = new ScrapeSource({
			browser,
			robots: allowAll,
			rateLimiter: noWait,
			maxDetailPages: 1,
		});
		const jobs = await source.listJobs({
			sourceKey: LISTING,
			parser: "tesseraapp",
		});
		expect(jobs).toHaveLength(3);
		expect(jobs[0]).toMatchObject({
			source: "scrape",
			title: "Senior Full-Stack Developer",
		});
		expect(jobs[0]?.descriptionText).toMatch(/TypeScript/);
		expect(jobs[0]?.externalId).toBe(
			"https://tessera.example/careers/senior-fullstack-developer",
		);
		expect(browser.visits).toHaveLength(2);
	});

	it("stops with SourceBlockedError on a challenge, without retrying", async () => {
		const browser = fakeBrowser({
			[LISTING]: { status: 403, html: "<title>Just a moment...</title>" },
		});
		const source = new ScrapeSource({
			browser,
			robots: allowAll,
			rateLimiter: noWait,
		});
		await expect(
			source.listJobs({ sourceKey: LISTING }),
		).rejects.toBeInstanceOf(SourceBlockedError);
		expect(browser.visits).toEqual([LISTING]);
	});

	it("never loads a page robots.txt disallows", async () => {
		const browser = fakeBrowser({ [LISTING]: { html: "" } });
		const robots = new RobotsCache(
			"OfferFinchBot/0.1",
			fakeFetch({
				"tessera.example/robots.txt": {
					body: "User-agent: *\nDisallow: /careers",
				},
			}),
		);
		const source = new ScrapeSource({ browser, robots, rateLimiter: noWait });
		await expect(
			source.listJobs({ sourceKey: LISTING }),
		).rejects.toBeInstanceOf(RobotsDisallowedError);
		expect(browser.visits).toEqual([]);
	});

	it("keeps same-identifier jobs from two companies apart, and stores each once", async () => {
		const posting = (title: string) =>
			`<script type="application/ld+json">${JSON.stringify({
				"@type": "JobPosting",
				identifier: { value: "1" },
				title,
				description: "Build things with TypeScript.",
			})}</script>`;
		const browser = fakeBrowser({
			"https://a.example/careers": { html: posting("Engineer at A") },
			"https://b.example/jobs": { html: posting("Engineer at B") },
		});
		const source = new ScrapeSource({
			browser,
			robots: allowAll,
			rateLimiter: noWait,
		});
		const repo = new MemoryRepo();
		const a = repo.addCompany({
			name: "A",
			source: "scrape",
			sourceKey: "https://a.example/careers",
		});
		const b = repo.addCompany({
			name: "B",
			source: "scrape",
			sourceKey: "https://b.example/jobs",
		});
		const scan = async () => {
			const inserted: boolean[] = [];
			for (const company of [a, b])
				for (const job of await source.listJobs({
					sourceKey: company.sourceKey,
				}))
					inserted.push((await repo.upsertJob("u1", company.id, job)).inserted);
			return inserted;
		};
		expect(await scan()).toEqual([true, true]);
		expect(repo.jobs.map((j) => j.job.title)).toEqual([
			"Engineer at A",
			"Engineer at B",
		]);
		expect(repo.jobs.map((j) => j.job.externalId)).toEqual([
			"https://a.example/careers#1",
			"https://b.example/jobs#1",
		]);
		// A second scan of the same pages inserts nothing.
		expect(await scan()).toEqual([false, false]);
		expect(repo.jobs).toHaveLength(2);
	});

	it("checks robots.txt and the host gap for every redirect hop before fetching it", async () => {
		const browser = fakeBrowser({
			[LISTING]: { redirect: "https://jobs.other.example/careers", html: "" },
			"https://jobs.other.example/careers": {
				redirect: "https://jobs.other.example/private/careers",
				html: "",
			},
			"https://jobs.other.example/private/careers": { html: "<p>secret</p>" },
		});
		const waited: string[] = [];
		class RecordingLimiter extends HostRateLimiter {
			override async wait(url: string) {
				waited.push(url);
			}
		}
		const robots = new RobotsCache(
			"OfferFinchBot/0.1",
			fakeFetch({
				"jobs.other.example/robots.txt": {
					body: "User-agent: *\nDisallow: /private",
				},
			}),
		);
		const source = new ScrapeSource({
			browser,
			robots,
			rateLimiter: new RecordingLimiter(0),
		});
		await expect(
			source.listJobs({ sourceKey: LISTING }),
		).rejects.toBeInstanceOf(RobotsDisallowedError);
		// The disallowed destination was never fetched; the allowed hop was throttled first.
		expect(browser.visits).toEqual([
			LISTING,
			"https://jobs.other.example/careers",
		]);
		expect(waited).toEqual([LISTING, "https://jobs.other.example/careers"]);
	});

	it("uses the LLM fallback only with links that exist on the page", async () => {
		const html =
			'<p>Open roles</p><a href="/open/frontend-dev">Frontend Developer (Izmir)</a>';
		const browser = fakeBrowser({
			"https://x.com/careers": { html },
			"https://x.com/open/frontend-dev": { html: "<p>details</p>" },
		});
		const llm = new FakeLlmProvider({
			"extract-jobs": () => ({
				jobs: [
					{
						title: "Frontend Developer",
						url: "https://x.com/open/frontend-dev",
						location: "Izmir",
					},
					{
						title: "Invented Role",
						url: "https://x.com/open/invented",
						location: "",
					},
				],
			}),
		});
		const source = new ScrapeSource({
			browser,
			llm,
			robots: allowAll,
			rateLimiter: noWait,
		});
		const jobs = await source.listJobs({ sourceKey: "https://x.com/careers" });
		expect(jobs.map((j) => j.title)).toEqual(["Frontend Developer"]);
		expect(jobs[0]?.locations).toEqual(["Izmir"]);
	});
});

/**
 * Codex re-check of 647487f, finding 5: the scrape source got the raw model, so careers-page
 * extraction could spend with a zero or exhausted cap and left no usage row. A scan now passes
 * its user's metered model, with no application.
 */
describe("careers-page extraction is metered for the scan's user", () => {
	const page = {
		"https://x.com/careers": {
			html: '<main><a href="https://x.com/open/frontend-dev">Frontend Developer</a></main>',
		},
	};
	const priced = (calls: string[]): LlmProvider => {
		const fake = new FakeLlmProvider({
			"extract-jobs": () => ({
				jobs: [
					{
						title: "Frontend Developer",
						url: "https://x.com/open/frontend-dev",
						location: "",
					},
				],
			}),
		});
		return {
			name: "anthropic:claude-opus-5-5",
			async generateObject(request) {
				calls.push(request.task);
				const out = await fake.generateObject({
					...request,
					onUsage: undefined,
				});
				request.onUsage?.({
					model: "claude-opus-5-5",
					inputTokens: 1_000,
					outputTokens: 100,
					cachedInputTokens: 0,
					cacheWriteTokens: 0,
				});
				return out;
			},
		};
	};
	const spendStore = (capMicros: number) => {
		const rows: {
			applicationId: string | null;
			task: string;
			status: string;
			userId: string;
		}[] = [];
		const store: SpendStore = {
			async reserveSpend(input) {
				if (input.estimateMicros > capMicros)
					return { ok: false, reason: "cap", spentMicros: 0, capMicros };
				rows.push({ ...input, status: "reserved" });
				return { ok: true, id: String(rows.length - 1) };
			},
			async settleSpend(id) {
				const row = rows[Number(id)];
				if (row) row.status = "settled";
			},
			async holdSpend() {},
			async recordRefusal() {},
			async subscriptionBudget() {
				return { budget: 40, used: 0, resetsAt: null };
			},
			async recordPaidStop() {},
			async listCapPausedJobIds() {
				return [];
			},
			async spendingStatus() {
				return { enabled: true, capMicros, spentMicros: 0, reservedMicros: 0 };
			},
		};
		return { rows, store };
	};
	const deps = (llm: LlmProvider, spend: SpendStore) => {
		const repo = new MemoryRepo();
		const company = repo.addCompany({
			name: "X",
			source: "scrape",
			sourceKey: "https://x.com/careers",
		});
		const pipeline: PipelineDeps = {
			repo,
			sources: {
				// As createPipelineDeps builds it: no model of its own.
				scrape: new ScrapeSource({
					browser: fakeBrowser(page),
					robots: allowAll,
					rateLimiter: noWait,
					maxDetailPages: 0,
				}),
			},
			llm,
			notifier: new NoopNotifier(),
			workflows: new LocalWorkflowStarter(),
			spend,
		};
		return { pipeline, company };
	};

	it("records the call against the user, with no application", async () => {
		const calls: string[] = [];
		const { rows, store } = spendStore(100_000_000);
		const { pipeline, company } = deps(priced(calls), store);
		const result = await scanCompany(pipeline, "u1", company);
		expect(result.fetched).toBe(1);
		expect(rows).toEqual([
			expect.objectContaining({
				userId: "u1",
				applicationId: null,
				task: "extract-jobs",
				status: "settled",
			}),
		]);
	});

	it("is stopped by an exhausted cap before the model is called", async () => {
		const calls: string[] = [];
		const { rows, store } = spendStore(0);
		const { pipeline, company } = deps(priced(calls), store);
		const result = await scanCompany(pipeline, "u1", company);
		expect(calls).toEqual([]);
		expect(rows).toEqual([]);
		expect(result.problem).toMatch(/Spending cap reached/);
		// Not the source's fault: its health is left alone.
		expect(
			(pipeline.repo as MemoryRepo).companies.find((c) => c.id === company.id)
				?.health ?? "ok",
		).toBe("ok");
	});
});
