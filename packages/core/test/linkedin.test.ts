import { describe, expect, it } from "vitest";

import { detectLinkedInStop } from "../src/linkedin/detect";
import {
	employerApplyUrl,
	LinkedInSelectorError,
	parseJobView,
	parseSearchResults,
} from "../src/linkedin/parse";
import {
	type LinkedInBrowser,
	LinkedInRunBlockedError,
	type LinkedInStore,
	runLinkedIn,
} from "../src/linkedin/runner";

const ORIGIN = "https://www.linkedin.com";
const HOST = "www.linkedin.com";

const card = (id: string, title: string, company: string) =>
	`<li data-occludable-job-id="${id}"><a class="job-card-container__link" href="/jobs/view/${id}/">${title}</a><div class="artdeco-entity-lockup__subtitle">${company}</div><div class="artdeco-entity-lockup__caption">Remote</div></li>`;
const results = (...cards: string[]) =>
	`<html><body><div class="scaffold-layout__list"><ul>${cards.join("")}</ul></div></body></html>`;
const view = (
	title: string,
	company: string,
	apply: string,
	description = "<p>Build things.</p>",
) =>
	`<html><body><h1 class="job-details-jobs-unified-top-card__job-title">${title}</h1><div class="job-details-jobs-unified-top-card__company-name">${company}</div><div class="job-details-jobs-unified-top-card__tertiary-description-container">Ankara, Türkiye · 2 days ago</div><div class="job-details-fit-level-preferences">Hybrid Full-time</div>${apply}<div id="job-details">${description}</div></body></html>`;
const EXTERNAL =
	'<a class="jobs-apply-button" href="/jobs/view/externalApply/1?url=https%3A%2F%2Fjobs.lever.co%2Facme%2F1%2Fapply"><span>Apply</span></a>';
const EASY =
	'<button class="jobs-apply-button"><span>Easy Apply</span></button>';

describe("LinkedIn stop detection", () => {
	const page = (url: string, html = "<html></html>", status = 200) => ({
		url,
		html,
		status,
	});

	it("stops at a security check, the sign-in wall and a CAPTCHA", () => {
		expect(
			detectLinkedInStop(page(`${ORIGIN}/checkpoint/challenge/x`), HOST)?.kind,
		).toBe("security_check");
		expect(detectLinkedInStop(page(`${ORIGIN}/authwall?x`), HOST)?.kind).toBe(
			"login_wall",
		);
		expect(detectLinkedInStop(page(`${ORIGIN}/login`), HOST)?.kind).toBe(
			"login_wall",
		);
		expect(
			detectLinkedInStop(
				page(
					`${ORIGIN}/jobs/search/`,
					'<iframe src="https://client-api.arkoselabs.com/x"></iframe>',
				),
				HOST,
			)?.kind,
		).toBe("captcha");
		expect(
			detectLinkedInStop(page(`${ORIGIN}/jobs/search/`, "", 999), HOST)?.kind,
		).toBe("security_check");
	});

	it("stops at an account warning and at a page on another host", () => {
		expect(
			detectLinkedInStop(
				page(
					`${ORIGIN}/jobs/search/`,
					"<div>Your account has been temporarily restricted</div>",
				),
				HOST,
			)?.kind,
		).toBe("warning");
		expect(
			detectLinkedInStop(page("https://evil.example/jobs/search/"), HOST)?.kind,
		).toBe("unusual_page");
	});

	it("does not stop for words in the employer's own posting text", () => {
		const html = view(
			"Fraud Engineer",
			"Acme",
			EXTERNAL,
			"<p>Detect unusual activity and automated tools abuse.</p>",
		);
		expect(detectLinkedInStop(page(`${ORIGIN}/jobs/view/1/`, html), HOST)).toBe(
			null,
		);
	});
});

describe("LinkedIn parsing", () => {
	it("reads the cards of a search page", () => {
		expect(parseSearchResults(results(card("11", "Engineer", "Acme")))).toEqual(
			[{ jobId: "11", title: "Engineer", company: "Acme", location: "Remote" }],
		);
	});

	it("stops, rather than guesses, when a required selector finds nothing", () => {
		expect(() => parseSearchResults("<main>new layout</main>")).toThrow(
			LinkedInSelectorError,
		);
		expect(() =>
			parseSearchResults(
				'<div class="scaffold-layout__list"><li data-occludable-job-id="1"><span>t</span></li></div>',
			),
		).toThrow(/cardTitle/);
		expect(() =>
			parseJobView("<h1>Title</h1>", `${ORIGIN}/jobs/view/1/`, "1"),
		).toThrow(/jobTitle/);
	});

	it("reads a job and the employer's apply link without following it", () => {
		const listing = parseJobView(
			view("Senior Engineer", "Acme", EXTERNAL),
			`${ORIGIN}/jobs/view/1/`,
			"1",
		);
		expect(listing).toMatchObject({
			title: "Senior Engineer",
			company: "Acme",
			locations: ["Ankara, Türkiye"],
			workplaceType: "hybrid",
			employmentType: "Full-time",
			easyApply: false,
			externalApplyUrl: "https://jobs.lever.co/acme/1/apply",
		});
		expect(listing.descriptionText).toMatch(/Build things/);
	});

	it("marks Easy Apply and keeps no apply link for it", () => {
		const listing = parseJobView(
			view("Engineer", "Acme", EASY),
			`${ORIGIN}/jobs/view/2/`,
			"2",
		);
		expect(listing.easyApply).toBe(true);
		expect(listing.externalApplyUrl).toBe(null);
	});

	it("keeps only http(s) employer links outside LinkedIn", () => {
		expect(
			employerApplyUrl(
				"/jobs/view/externalApply/1?url=javascript%3Aalert(1)",
				ORIGIN,
			),
		).toBe(null);
		expect(
			employerApplyUrl(
				"/jobs/view/externalApply/1?url=https%3A%2F%2Fwww.linkedin.com%2Fx",
				ORIGIN,
			),
		).toBe(null);
	});
});

/* --------------------------------------------------------------- runner */

const SEARCH_A = `${ORIGIN}/jobs/search/?keywords=a`;
const opts = (extra: Partial<Parameters<typeof runLinkedIn>[1]> = {}) => ({
	userId: "u1",
	trigger: "t",
	lists: [{ kind: "search" as const, label: "a", url: SEARCH_A }],
	perList: 3,
	maxPages: 50,
	...extra,
});

class MemoryStore implements LinkedInStore {
	dailyPageCap = 15;
	block_: { at: Date; kind: string; reason: string } | null = null;
	known = new Set<string>();
	saved: string[] = [];
	runs: { pagesUsed: number; outcome?: string; startedAt: Date }[] = [];
	pages: Date[] = [];
	async blocked() {
		return this.block_;
	}
	async pagesUsedSince(_u: string, since: Date) {
		return this.pages.filter((at) => at >= since).length;
	}
	async reservePage() {
		if (this.block_)
			return {
				ok: false as const,
				reason: "blocked" as const,
				block: this.block_,
			};
		const now = new Date();
		const since = new Date(now.getTime() - 24 * 3600 * 1000);
		if ((await this.pagesUsedSince("", since)) >= this.dailyPageCap)
			return {
				ok: false as const,
				reason: "cap" as const,
				cap: this.dailyPageCap,
			};
		this.pages.push(now);
		return { ok: true as const };
	}
	async startRun() {
		this.runs.push({ pagesUsed: 0, startedAt: new Date() });
		return String(this.runs.length - 1);
	}
	async updateRun(id: string, p: { pagesUsed: number }) {
		const run = this.runs[Number(id)];
		if (run) run.pagesUsed = p.pagesUsed;
	}
	async finishRun(id: string, r: { pagesUsed: number; outcome: string }) {
		const run = this.runs[Number(id)];
		if (run) Object.assign(run, r);
	}
	async block(_u: string, stop: { kind: string; reason: string }) {
		this.block_ = { at: new Date(), ...stop };
	}
	async isKnown(_u: string, id: string) {
		return this.known.has(id);
	}
	async saveListing(_u: string, listing: { jobId: string }) {
		this.known.add(listing.jobId);
		this.saved.push(listing.jobId);
		return { outcome: "inserted" as const, jobId: `job-${listing.jobId}` };
	}
}

function fakeBrowser(pages: Record<string, { url?: string; html: string }>) {
	const opened: string[] = [];
	const browser: LinkedInBrowser = {
		async open(url) {
			opened.push(url);
			const page = pages[url];
			if (!page) throw new Error(`no fixture for ${url}`);
			return { url: page.url ?? url, status: 200, html: page.html };
		},
	};
	return { browser, opened };
}

const PAGES: Record<string, { url?: string; html: string }> = {
	[`${ORIGIN}/jobs/search/?keywords=a`]: {
		html: results(card("1", "One", "Acme"), card("2", "Two", "Nimbus")),
	},
	[`${ORIGIN}/jobs/view/1/`]: { html: view("One", "Acme", EXTERNAL) },
	[`${ORIGIN}/jobs/view/2/`]: { html: view("Two", "Nimbus", EASY) },
};

describe("LinkedIn cards not drawn yet", () => {
	it("keeps the job id of an empty placeholder card (Top picks below the fold)", () => {
		const html = results(
			card("1", "One", "Acme"),
			'<li data-occludable-job-id="2" class="scaffold-layout__list-item"></li>',
		);
		expect(parseSearchResults(html)).toEqual([
			{ jobId: "1", title: "One", company: "Acme", location: "Remote" },
			{ jobId: "2", title: "", company: "", location: "" },
		]);
		// A drawn card without its title is still a changed layout.
		expect(() =>
			parseSearchResults(
				results('<li data-occludable-job-id="3"><div>Something</div></li>'),
			),
		).toThrow(LinkedInSelectorError);
	});
});

describe("LinkedIn runner", () => {
	const deps = (store: MemoryStore, pages = PAGES) => {
		const { browser, opened } = fakeBrowser(pages);
		const gaps: number[] = [];
		const alerts: { kind: string; reason: string }[] = [];
		return {
			opened,
			gaps,
			alerts,
			deps: {
				store,
				browser,
				alert: async (stop: { kind: string; reason: string }) => {
					alerts.push(stop);
				},
				sleep: async (ms: number) => {
					gaps.push(ms);
				},
			},
		};
	};

	it("reads each new job once, with a 20-60 s gap before every page but the first", async () => {
		const store = new MemoryStore();
		const run = deps(store);
		const result = await runLinkedIn(run.deps, opts());
		expect(result).toMatchObject({
			outcome: "done",
			pagesUsed: 3,
			listingsRead: 2,
			jobsInserted: 2,
		});
		expect(run.gaps).toHaveLength(2);
		for (const gap of run.gaps) {
			expect(gap).toBeGreaterThanOrEqual(20_000);
			expect(gap).toBeLessThanOrEqual(60_000);
		}
		// A second run opens only the search page: known jobs are not visited again.
		const again = deps(store);
		const second = await runLinkedIn(again.deps, opts());
		expect(second).toMatchObject({
			pagesUsed: 1,
			jobsInserted: 0,
			duplicates: 2,
		});
		expect(again.opened).toEqual([`${ORIGIN}/jobs/search/?keywords=a`]);
	});

	it("never opens more pages in 24 hours than the cap, across runs", async () => {
		const store = new MemoryStore();
		store.dailyPageCap = 2;
		const first = await runLinkedIn(deps(store).deps, opts());
		expect(first).toMatchObject({ outcome: "page_cap", pagesUsed: 2 });
		const next = deps(store);
		const second = await runLinkedIn(next.deps, opts());
		expect(second).toMatchObject({ outcome: "page_cap", pagesUsed: 0 });
		expect(next.opened).toEqual([]);
	});

	it("stops at a security check, blocks, alerts, and refuses the next run", async () => {
		const store = new MemoryStore();
		const run = deps(store, {
			...PAGES,
			[`${ORIGIN}/jobs/search/?keywords=a`]: {
				url: `${ORIGIN}/checkpoint/challenge/AgF`,
				html: "<h1>Let's do a quick security check</h1>",
			},
		});
		const result = await runLinkedIn(run.deps, opts());
		expect(result).toMatchObject({ outcome: "security_check", pagesUsed: 1 });
		expect(store.block_?.kind).toBe("security_check");
		expect(run.alerts).toHaveLength(1);
		await expect(runLinkedIn(deps(store).deps, opts())).rejects.toBeInstanceOf(
			LinkedInRunBlockedError,
		);
	});

	it("ends the run at a changed layout, names the selector, keeps the page, and does not block", async () => {
		const store = new MemoryStore();
		const run = deps(store, {
			[`${ORIGIN}/jobs/search/?keywords=a`]: { html: "<main>new</main>" },
		});
		const kept: string[] = [];
		const result = await runLinkedIn(
			{
				...run.deps,
				debug: async (page, stop) => {
					kept.push(`${stop.kind} ${page.url}`);
				},
			},
			opts(),
		);
		expect(result.outcome).toBe("selectors");
		expect(result.stopReason).toMatch(/resultsList/);
		expect(store.block_).toBe(null);
		expect(run.alerts).toEqual([]);
		expect(kept).toEqual([`selectors ${ORIGIN}/jobs/search/?keywords=a`]);
		// The next run tries again.
		const next = deps(store);
		await runLinkedIn(next.deps, opts());
		expect(next.opened[0]).toBe(`${ORIGIN}/jobs/search/?keywords=a`);
	});

	it("opens at most three new jobs per search, so one search never takes the day", async () => {
		const store = new MemoryStore();
		const ids = ["1", "2", "3", "4", "5"];
		const pages: Record<string, { html: string }> = {
			[`${ORIGIN}/jobs/search/?keywords=a`]: {
				html: results(...ids.map((id) => card(id, `Job ${id}`, "Acme"))),
			},
		};
		for (const id of ids)
			pages[`${ORIGIN}/jobs/view/${id}/`] = {
				html: view(`Job ${id}`, "Acme", EXTERNAL),
			};
		const run = deps(store, pages);
		const result = await runLinkedIn(run.deps, opts());
		expect(result).toMatchObject({ outcome: "done", jobsInserted: 3 });
		expect(run.opened).toHaveLength(4);
	});

	it("reads the lists in order, and says when there are none", async () => {
		const store = new MemoryStore();
		const generated = `${ORIGIN}/jobs/search/?keywords=b`;
		const run = deps(store, {
			...PAGES,
			[generated]: { html: results() },
		});
		// An empty results list with LinkedIn's banner is no stop.
		run.deps.browser = {
			async open(url) {
				run.opened.push(url);
				if (url === generated)
					return {
						url,
						status: 200,
						html: '<div class="scaffold-layout__list"></div><div class="jobs-search-no-results-banner">No matching jobs found</div>',
					};
				return { url, status: 200, html: PAGES[url]?.html ?? "" };
			},
		};
		await runLinkedIn(
			run.deps,
			opts({
				lists: [
					{ kind: "search", label: "b", url: generated },
					{ kind: "search", label: "a", url: SEARCH_A },
				],
			}),
		);
		expect(run.opened[0]).toBe(generated);
		expect(run.opened[1]).toBe(SEARCH_A);
		const none = await runLinkedIn(deps(store).deps, opts({ lists: [] }));
		expect(none).toMatchObject({ outcome: "no_searches" });
		expect(none.stopReason).toMatch(/Job search/);
	});

	it("stops at its share of pages, counts each list's part, and reads Top picks first", async () => {
		const store = new MemoryStore();
		const picks = `${ORIGIN}/jobs/collections/recommended/`;
		const run = deps(store, {
			...PAGES,
			[picks]: {
				html: results(card("7", "Seven", "Orbit"), card("1", "One", "Acme")),
			},
			[`${ORIGIN}/jobs/view/7/`]: { html: view("Seven", "Orbit", EXTERNAL) },
		});
		const result = await runLinkedIn(
			run.deps,
			opts({
				lists: [
					{ kind: "top-picks", label: "Top job picks for you", url: picks },
					{ kind: "search", label: "a", url: SEARCH_A },
				],
				maxPages: 4,
			}),
		);
		expect(run.opened).toEqual([
			picks,
			`${ORIGIN}/jobs/view/7/`,
			`${ORIGIN}/jobs/view/1/`,
			SEARCH_A,
		]);
		expect(result).toMatchObject({ outcome: "done", pagesUsed: 4 });
		expect(result.stopReason).toMatch(/4 pages/);
		expect(result.parts.topPicks).toMatchObject({
			searches: ["Top job picks for you"],
			pagesRead: 3,
			results: 2,
			listingsRead: 2,
			newJobIds: ["job-7", "job-1"],
		});
		// Its share used up at the search page: job 1 was known, job 2 waits for the next read.
		expect(result.parts.searches).toMatchObject({
			searches: ["a"],
			pagesRead: 1,
			results: 2,
			duplicates: 1,
		});
	});

	it("goes on to the searches when Top picks has a layout it can't read, and keeps the page", async () => {
		const store = new MemoryStore();
		const picks = `${ORIGIN}/jobs/collections/recommended/`;
		const run = deps(store, {
			...PAGES,
			[picks]: { html: "<main>new</main>" },
		});
		const kept: string[] = [];
		const result = await runLinkedIn(
			{ ...run.deps, debug: async (_p, stop) => void kept.push(stop.kind) },
			opts({
				lists: [
					{ kind: "top-picks", label: "Top job picks for you", url: picks },
					{ kind: "search", label: "a", url: SEARCH_A },
				],
			}),
		);
		expect(result.outcome).toBe("done");
		expect(result.parts.topPicks.problem).toMatch(
			/Top picks could not be read/,
		);
		expect(result.parts.searches.newJobIds).toHaveLength(2);
		expect(kept).toEqual(["selectors"]);
		expect(store.block_).toBe(null);
	});

	it("opens no page once its signal aborts", async () => {
		const store = new MemoryStore();
		const run = deps(store);
		const controller = new AbortController();
		run.deps.sleep = async () => {
			controller.abort(new Error("step timed out"));
		};
		await expect(
			runLinkedIn(run.deps, opts({ signal: controller.signal })),
		).rejects.toThrow(/step timed out/);
		expect(run.opened).toEqual([SEARCH_A]);
	});

	it("ends the run, without blocking, when a page cannot be loaded or read", async () => {
		const store = new MemoryStore();
		const run = deps(store);
		let opened = 0;
		run.deps.browser = {
			async open(url) {
				opened += 1;
				if (opened === 2)
					throw new Error(
						`page.content: Execution context was destroyed at ${url}`,
					);
				return { url, status: 200, html: PAGES[url]?.html ?? "" };
			},
		};
		const result = await runLinkedIn(run.deps, opts());
		expect(result).toMatchObject({ outcome: "unusual_page", pagesUsed: 2 });
		expect(result.stopReason).not.toMatch(/linkedin\.com|jobs\/view/);
		expect(store.block_).toBe(null);
		expect(run.alerts).toEqual([]);
	});

	it("records a run that failed for another reason, without blocking", async () => {
		const store = new MemoryStore();
		store.saveListing = async () => {
			throw new Error("database down");
		};
		await expect(runLinkedIn(deps(store).deps, opts())).rejects.toThrow(
			/database down/,
		);
		expect(store.runs[0]?.outcome).toBe("error");
		expect(store.block_).toBe(null);
	});
});
