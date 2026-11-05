import { describe, expect, it } from "vitest";

import { parseFilterSettings } from "../src/filter/settings";
import {
	inAbout,
	LinkedInScanProvider,
	type LinkedInScanStore,
	nextLinkedInRead,
} from "../src/linkedin/provider";
import { LINKEDIN_PACE } from "../src/linkedin/runner";
import type { PipelineDeps } from "../src/pipeline/ports";
import { FakeLlmProvider } from "../src/scoring/fake";
import { LlmPausedError } from "../src/scoring/llm";
import {
	boardQueries,
	linkedinSearch,
	searchFromLinkedInUrl,
	siteSearch,
	webQueries,
} from "../src/search/adapt";
import {
	EMPTY_PLAN,
	type PlanResult,
	type PlanSearch,
	plannedSearches,
	refreshSearchPlan,
	rotate,
	rulesPlan,
	type SearchPlanStore,
	type StoredPlan,
} from "../src/search/plan";

const settings = parseFilterSettings({
	livesIn: "Poland",
	rightToWork: ["Poland", "Germany"],
	keepRemoteFromHome: true,
	keepGlobalRemote: true,
	keepOnsiteIn: ["Germany"],
	searchTitles: ["Frontend Engineer", "Design Engineer"],
});

function memoryPlans(initial: Partial<StoredPlan> = {}) {
	let stored: StoredPlan = { ...EMPTY_PLAN, ...initial };
	const store: SearchPlanStore = {
		plan: async () => stored,
		saveGenerated: async (_u, p) => {
			stored = { ...stored, ...p };
		},
	};
	return { store, stored: () => stored };
}

const NOW = new Date("2026-11-03T10:00:00Z");
const MINE: PlanSearch = {
	keywords: "Platform Engineer",
	where: "onsite",
	place: "Kraków",
};

describe("the shared search plan", () => {
	it("is written by the model from the profile and Job search, checked against the filter, with the user's own first", async () => {
		const llm = new FakeLlmProvider({
			"search-plan": () => ({
				searches: [
					{
						keywords: "React Engineer",
						where: "remote-worldwide",
						place: null,
						seniority: "Senior",
					},
					{
						keywords: "Frontend Engineer",
						where: "remote-in-country",
						place: null,
						seniority: null,
					},
					{
						keywords: "UI Engineer",
						where: "onsite",
						place: "Berlin",
						seniority: null,
					},
					// The filter keeps no office jobs in Spain: dropped.
					{
						keywords: "Frontend Engineer",
						where: "onsite",
						place: "Spain",
						seniority: null,
					},
					// Operators and links are not plain words.
					{
						keywords: "site:linkedin.com Vue https://x.example",
						where: "remote-worldwide",
						place: null,
						seniority: null,
					},
				],
			}),
		});
		const plans = memoryPlans({ user: [MINE] });
		const result = await refreshSearchPlan({
			llm,
			store: plans.store,
			userId: "u1",
			profile: null,
			settings,
			now: () => NOW,
		});
		expect(result.note).toBeUndefined();
		expect(result.basis).toBe("ai");
		expect(result.searches).toEqual([
			{ ...MINE, by: "you" },
			{
				keywords: "React Engineer",
				seniority: "Senior",
				where: "remote-worldwide",
				by: "ai",
			},
			{
				keywords: "Frontend Engineer",
				where: "remote-in-country",
				place: "Poland",
				by: "ai",
			},
			{ keywords: "UI Engineer", where: "onsite", place: "Berlin", by: "ai" },
			{ keywords: "Vue", where: "remote-worldwide", by: "ai" },
		]);
		// The model saw where the user lives, may work, and the titles.
		const prompt = llm.calls[0]?.prompt ?? "";
		expect(prompt).toMatch(/Lives in: Poland/);
		expect(prompt).toMatch(/Right to work in: Poland, Germany/);
		expect(prompt).toMatch(/Titles: Frontend Engineer; Design Engineer/);
		expect(plans.stored().generatedAt).toBe(NOW.toISOString());
		// Within the day the stored plan stands (no second call); Regenerate writes it again.
		await refreshSearchPlan({
			llm,
			store: plans.store,
			userId: "u1",
			profile: null,
			settings,
			now: () => NOW,
		});
		expect(llm.calls).toHaveLength(1);
		await refreshSearchPlan({
			llm,
			store: plans.store,
			userId: "u1",
			profile: null,
			settings,
			now: () => NOW,
			force: true,
		});
		expect(llm.calls).toHaveLength(2);
		// A day later it is written again.
		const later = new Date(NOW.getTime() + 25 * 3_600_000);
		await refreshSearchPlan({
			llm,
			store: plans.store,
			userId: "u1",
			profile: null,
			settings,
			now: () => later,
		});
		expect(llm.calls).toHaveLength(3);
	});

	it("without a model keeps yesterday's plan, with a note; nothing is thrown", async () => {
		const paused = new FakeLlmProvider({
			"search-plan": () => {
				throw new LlmPausedError("Spending limit reached");
			},
		});
		const yesterday: PlanSearch = {
			keywords: "React Engineer",
			where: "remote-worldwide",
		};
		const plans = memoryPlans({
			ai: [yesterday],
			user: [MINE],
			basis: "ai",
			generatedAt: "2026-11-01T09:00:00Z",
		});
		const result = await refreshSearchPlan({
			llm: paused,
			store: plans.store,
			userId: "u1",
			profile: null,
			settings,
			now: () => NOW,
		});
		expect(result.note).toMatch(/AI is paused: Spending limit reached/);
		expect(result.note).toMatch(/yesterday's are used/);
		expect(result.searches.map((s) => s.keywords)).toEqual([
			"Platform Engineer",
			"React Engineer",
		]);
		expect(plans.stored().generatedAt).toBe("2026-11-01T09:00:00Z");
	});

	it("with no plan yet and no model, searches the titles where the filter keeps jobs (the rules' plan)", async () => {
		const paused = new FakeLlmProvider({
			"search-plan": () => {
				throw new LlmPausedError("No model connected");
			},
		});
		const plans = memoryPlans({ user: [MINE] });
		const result = await refreshSearchPlan({
			llm: paused,
			store: plans.store,
			userId: "u1",
			profile: null,
			settings,
			now: () => NOW,
		});
		expect(result.basis).toBe("rules");
		expect(result.note).toMatch(/searches from your job titles and places/);
		expect(result.searches[0]).toEqual({ ...MINE, by: "you" });
		expect(result.searches.slice(1)).toEqual(
			rulesPlan(settings, null).map((s) => ({ ...s, by: "rules" })),
		);
	});

	it("the rules' plan: each title worldwide remote, remote from home, at home and in another office country", () => {
		expect(rulesPlan(settings, null)).toEqual([
			{ keywords: "Frontend Engineer", where: "remote-worldwide" },
			{
				keywords: "Frontend Engineer",
				where: "remote-in-country",
				place: "Poland",
			},
			{ keywords: "Frontend Engineer", where: "onsite", place: "Poland" },
			{ keywords: "Frontend Engineer", where: "onsite", place: "Germany" },
			{ keywords: "Design Engineer", where: "remote-worldwide" },
			{
				keywords: "Design Engineer",
				where: "remote-in-country",
				place: "Poland",
			},
			{ keywords: "Design Engineer", where: "onsite", place: "Poland" },
			{ keywords: "Design Engineer", where: "onsite", place: "Germany" },
		]);
		const officeOnly = parseFilterSettings({
			livesIn: "Poland",
			keepGlobalRemote: false,
			keepRemoteFromHome: false,
			searchTitles: ["Frontend Engineer"],
		});
		expect(rulesPlan(officeOnly, null)).toEqual([
			{ keywords: "Frontend Engineer", where: "onsite", place: "Poland" },
		]);
	});
});

describe("each source's form of the plan", () => {
	const params = (url: string) =>
		Object.fromEntries(new URL(url).searchParams.entries());

	it("LinkedIn: keywords, the place where the user lives (not their right-to-work list), workplace, newest first", () => {
		const remote = linkedinSearch(
			{
				keywords: "Frontend Engineer",
				where: "remote-in-country",
				seniority: "Senior",
			},
			"Poland",
		);
		expect(params(remote.url)).toEqual({
			keywords: "Senior Frontend Engineer",
			location: "Poland",
			f_WT: "2",
			sortBy: "DD",
		});
		expect(remote.label).toBe("Senior Frontend Engineer · remote, Poland");
		expect(
			params(
				linkedinSearch({ keywords: "A", where: "remote-worldwide" }, "Poland")
					.url,
			),
		).toMatchObject({ location: "Worldwide", f_WT: "2" });
		expect(
			params(
				linkedinSearch(
					{ keywords: "A", where: "onsite", place: "Berlin" },
					"Poland",
				).url,
			),
		).toMatchObject({ location: "Berlin", f_WT: "1,3" });
	});

	it("LinkedIn: a custom search of earlier versions reads back as a plan entry", () => {
		expect(
			searchFromLinkedInUrl(
				"https://www.linkedin.com/jobs/search/?keywords=Go%20Engineer&location=Poland&f_WT=2",
				"Poland",
			),
		).toEqual({
			keywords: "Go Engineer",
			where: "remote-in-country",
			place: undefined,
		});
		expect(
			searchFromLinkedInUrl(
				"https://www.linkedin.com/jobs/search/?keywords=Go&f_WT=2",
				"Poland",
			),
		).toEqual({ keywords: "Go", where: "remote-worldwide" });
		expect(
			searchFromLinkedInUrl(
				"https://www.linkedin.com/jobs/search/?keywords=Go&location=Berlin",
				"Poland",
			),
		).toEqual({ keywords: "Go", where: "onsite", place: "Berlin" });
		expect(
			searchFromLinkedInUrl(
				"https://www.linkedin.com/jobs/collections/recommended/",
				"Poland",
			),
		).toBeNull();
	});

	it("Indeed: a country's search runs on that country's Indeed; Glassdoor stays on its own site; a stand-in is never changed", () => {
		const home: PlanSearch = {
			keywords: "Frontend Engineer",
			where: "remote-in-country",
			place: "Türkiye",
		};
		expect(
			siteSearch("indeed", home, "Türkiye", "https://www.indeed.com", false),
		).toMatchObject({
			origin: "https://tr.indeed.com",
			query: "Frontend Engineer",
			location: "Remote",
		});
		expect(
			siteSearch(
				"indeed",
				{ keywords: "A", where: "remote-worldwide" },
				"Türkiye",
				"https://www.indeed.com",
				false,
			),
		).toMatchObject({ origin: "https://www.indeed.com", location: "Remote" });
		expect(
			siteSearch(
				"glassdoor",
				home,
				"Türkiye",
				"https://www.glassdoor.com",
				false,
			),
		).toMatchObject({
			origin: "https://www.glassdoor.com",
			location: "Remote Türkiye",
		});
		expect(
			siteSearch(
				"indeed",
				{ keywords: "A", where: "onsite", place: "Germany" },
				"Türkiye",
				"http://127.0.0.1:9",
				true,
			),
		).toMatchObject({ origin: "http://127.0.0.1:9", location: "Germany" });
	});

	it("job-board search: one board per query, a few a scan, the next scan the rest", () => {
		const plan: PlanSearch[] = [
			{ keywords: "Frontend Engineer", where: "remote-worldwide" },
			{
				keywords: "Design Engineer",
				where: "remote-in-country",
				place: "Poland",
			},
			{ keywords: "UI Engineer", where: "onsite", place: "New York" },
		];
		const first = boardQueries(plan, "Poland", 6, 0);
		expect(first).toEqual([
			'site:job-boards.greenhouse.io "Frontend Engineer" remote',
			'site:jobs.lever.co "Frontend Engineer" remote',
			'site:jobs.ashbyhq.com "Frontend Engineer" remote',
			'site:job-boards.greenhouse.io "Design Engineer" remote Poland',
			'site:jobs.lever.co "Design Engineer" remote Poland',
			'site:jobs.ashbyhq.com "Design Engineer" remote Poland',
		]);
		for (const q of first) expect(q.match(/site:/g)).toHaveLength(1);
		// The next scan starts where this one ended.
		expect(boardQueries(plan, "Poland", 6, 6)[0]).toBe(
			'site:job-boards.greenhouse.io "UI Engineer" "New York"',
		);
	});

	it("web search: plain words, at most a few a scan", () => {
		expect(
			webQueries(
				[
					{
						keywords: "Frontend Engineer",
						where: "remote-in-country",
						seniority: "Senior",
					},
					{ keywords: "UI Engineer", where: "onsite", place: "New York" },
				],
				"Poland",
				8,
				0,
			),
		).toEqual([
			"Senior Frontend Engineer jobs remote Poland",
			"UI Engineer jobs New York",
		]);
	});
});

/* ------------------------------------------------------------ LinkedIn in scans */

function linkedinStore(input: {
	lastReadAt?: Date | null;
	pages?: Date[];
	blocked?: boolean;
}) {
	const runs: string[] = [];
	const store: LinkedInScanStore = {
		blocked: async () =>
			input.blocked
				? { at: NOW, kind: "login_wall", reason: "signed out" }
				: null,
		lastReadAt: async () => input.lastReadAt ?? null,
		pagesSince: async (_u, since) =>
			(input.pages ?? []).filter((p) => p >= since),
		pagesUsedSince: async () => 0,
		reservePage: async () => ({ ok: true as const }),
		startRun: async (_u, trigger) => {
			runs.push(trigger);
			return "r1";
		},
		updateRun: async () => {},
		finishRun: async () => {},
		block: async () => {},
		isKnown: async () => false,
		saveListing: async (_u, listing) => ({
			outcome: "inserted" as const,
			jobId: `job-${listing.jobId}`,
		}),
	};
	return { store, runs };
}

const ORIGIN = "https://www.linkedin.com";
const card = (id: string) =>
	`<li data-occludable-job-id="${id}"><a class="job-card-container__link" href="/jobs/view/${id}/">Job ${id}</a><div class="artdeco-entity-lockup__subtitle">Acme</div></li>`;
const list = (...ids: string[]) =>
	`<html><body><div class="scaffold-layout__list"><ul>${ids.map(card).join("")}</ul></div></body></html>`;
const job = (id: string) =>
	`<html><body><h1 class="job-details-jobs-unified-top-card__job-title">Job ${id}</h1><div class="job-details-jobs-unified-top-card__company-name">Acme</div><div id="job-details"><p>Build things with us.</p></div></body></html>`;

function linkedinProvider(store: LinkedInScanStore, readNow = false) {
	const opened: string[] = [];
	const provider = new LinkedInScanProvider({
		store,
		openBrowser: async () => ({
			open: async (url) => {
				opened.push(url);
				const path = new URL(url).pathname;
				const html = path.startsWith("/jobs/view/")
					? job(path.split("/")[3] ?? "")
					: path.startsWith("/jobs/collections/")
						? list("7", "8", "9")
						: list("1", "2");
				return { url, status: 200, html };
			},
			close: async () => {},
		}),
		alert: async () => {},
		sleep: async () => {},
		now: () => NOW,
		takeReadNow: () => readNow,
	});
	return { provider, opened };
}

const pipeline = {
	repo: {
		getFilterSettings: async () => settings,
		getProfile: async () => null,
	},
} as unknown as PipelineDeps;
const plan: PlanResult = {
	searches: [
		{
			keywords: "Frontend Engineer",
			where: "remote-in-country",
			place: "Poland",
			by: "ai",
		},
	],
	generatedAt: null,
	basis: "ai",
};

describe("LinkedIn in scans", () => {
	it("reads at most once every few hours (LINKEDIN_PACE) and says when the next read is", async () => {
		const { store, runs } = linkedinStore({
			lastReadAt: new Date(NOW.getTime() - 1 * 3_600_000),
		});
		const { provider, opened } = linkedinProvider(store);
		const run = await provider.run(pipeline, "u1", undefined, plan);
		const wait = LINKEDIN_PACE.everyHours - 1;
		expect(run).toMatchObject({
			status: "waiting",
			retryAt: new Date(NOW.getTime() + wait * 3_600_000).toISOString(),
		});
		expect(run.problem).toBe(`Next LinkedIn read in ~${wait} h.`);
		expect(opened).toEqual([]);
		expect(runs).toEqual([]);
		// Retry now reads at once (the daily cap still holds).
		const forced = linkedinProvider(store, true);
		await forced.provider.run(pipeline, "u1", undefined, plan);
		expect(forced.opened.length).toBeGreaterThan(0);
	});

	it("waits while the last 24 hours hold the day's pages, until the oldest leaves the window", async () => {
		const pages = Array.from(
			{ length: LINKEDIN_PACE.dailyPageCap },
			(_, i) => new Date(NOW.getTime() - (20 - i) * 3_600_000),
		);
		const { store } = linkedinStore({
			lastReadAt: new Date(NOW.getTime() - 8 * 3_600_000),
			pages,
		});
		const next = await nextLinkedInRead(store, "u1", NOW);
		expect(next).toEqual({
			at: new Date(NOW.getTime() + 4 * 3_600_000),
			pagesLeft: 0,
		});
		const { provider, opened } = linkedinProvider(store, true);
		const run = await provider.run(pipeline, "u1", undefined, plan);
		expect(run.status).toBe("waiting");
		expect(run.problem).toMatch(/30 pages a day/);
		expect(opened).toEqual([]);
		expect(inAbout(35 * 60_000)).toBe("~35 min");
	});

	it("reads Top picks first, then the plan's search, within its share of pages, each reported on its own", async () => {
		// 3 pages left in the day.
		const pages = Array.from(
			{ length: LINKEDIN_PACE.dailyPageCap - 3 },
			() => new Date(NOW.getTime() - 3_600_000 * 12),
		);
		const { store, runs } = linkedinStore({
			lastReadAt: new Date(NOW.getTime() - 7 * 3_600_000),
			pages,
		});
		const { provider, opened } = linkedinProvider(store);
		const run = await provider.run(pipeline, "u1", undefined, plan);
		expect(runs).toEqual(["scan"]);
		// 3 pages left in the day: Top picks and two of its jobs; the search waits for the next read.
		expect(opened).toEqual([
			`${ORIGIN}/jobs/collections/recommended/`,
			`${ORIGIN}/jobs/view/7/`,
			`${ORIGIN}/jobs/view/8/`,
		]);
		expect(run.parts?.[0]).toMatchObject({
			provider: "linkedin-top-picks",
			label: "LinkedIn Top picks",
			searches: ["Top job picks for you"],
			pagesRead: 3,
			results: 3,
			duplicates: 0,
			newJobIds: ["job-7", "job-8"],
		});
		expect(run).toMatchObject({
			provider: "linkedin",
			pagesRead: 0,
			newJobIds: [],
		});
		// No search was opened: the next read starts at the same search.
		expect(run.cursor).toBeUndefined();

		// With the whole share: Top picks, then the search from the plan, as LinkedIn's URL.
		const fresh = linkedinStore({});
		const full = linkedinProvider(fresh.store);
		const whole = await full.provider.run(pipeline, "u1", undefined, plan, 4);
		expect(full.opened).toHaveLength(LINKEDIN_PACE.runPages);
		expect(full.opened[3]).toBe(
			`${ORIGIN}/jobs/search/?keywords=Frontend+Engineer&location=Poland&f_WT=2&sortBy=DD`,
		);
		// The search's share: its list page and its two new jobs (at most 2 opened a list).
		expect(whole).toMatchObject({
			searches: ["Frontend Engineer · remote, Poland"],
			pagesRead: 3,
			results: 2,
			newJobIds: ["job-1", "job-2"],
			// One search opened from 4: the next read starts at 5.
			cursor: 5,
		});
	});

	it("a read cut short by its pages starts the next read at the search it did not reach", async () => {
		const two: PlanResult = {
			...plan,
			searches: [
				...plan.searches,
				{ keywords: "Design Engineer", where: "remote-worldwide", by: "ai" },
			],
		};
		// The last read opened the first search only: this one starts at the second.
		const { provider, opened } = linkedinProvider(linkedinStore({}).store);
		const run = await provider.run(pipeline, "u1", undefined, two, 1);
		const searches = opened.filter((u) => u.includes("/jobs/search/"));
		expect(searches[0]).toContain("keywords=Design+Engineer");
		expect(run.cursor).toBe(1 + searches.length);
	});

	it("does not read while LinkedIn is stopped, and says how to go on", async () => {
		const { store } = linkedinStore({ blocked: true });
		const { provider, opened } = linkedinProvider(store, true);
		const run = await provider.run(pipeline, "u1", undefined, plan);
		expect(run.status).toBe("needs_sign_in");
		expect(run.problem).toMatch(/Sign in or choose Retry now/);
		expect(opened).toEqual([]);
	});

	it("hands each listing to the scan's own repository, so a scan run records its LinkedIn jobs as they are inserted", async () => {
		const { store } = linkedinStore({
			lastReadAt: new Date(NOW.getTime() - 7 * 3_600_000),
		});
		const inserters: unknown[] = [];
		store.saveListing = async (_u, listing, _url, jobs) => {
			inserters.push(jobs);
			return { outcome: "inserted" as const, jobId: `job-${listing.jobId}` };
		};
		const { provider } = linkedinProvider(store);
		await provider.run(pipeline, "u1", undefined, plan);
		expect(inserters.length).toBeGreaterThan(0);
		expect(inserters.every((jobs) => jobs === pipeline.repo)).toBe(true);
	});
});

describe("the plan keeps what the user did", () => {
	it("keeps a search the user adds or removes while the model writes the plan", async () => {
		let stored: StoredPlan = { ...EMPTY_PLAN, user: [MINE] };
		const store: SearchPlanStore = {
			plan: async () => stored,
			saveGenerated: async (_u, p) => {
				stored = { ...stored, ...p };
			},
		};
		const added: PlanSearch = {
			keywords: "Staff Engineer",
			where: "remote-worldwide",
		};
		const llm = new FakeLlmProvider({
			"search-plan": () => {
				// The user removes their search and adds another while the model writes.
				stored = { ...stored, user: [added] };
				return {
					searches: [
						{
							keywords: "React Engineer",
							where: "remote-worldwide",
							place: null,
							seniority: null,
						},
					],
				};
			},
		});
		const result = await refreshSearchPlan({
			llm,
			store,
			userId: "u1",
			profile: null,
			settings,
			now: () => NOW,
		});
		expect(stored.user).toEqual([added]);
		expect(stored.ai.map((s) => s.keywords)).toEqual(["React Engineer"]);
		expect(
			result.searches.filter((s) => s.by === "you").map((s) => s.keywords),
		).toEqual(["Staff Engineer"]);
	});

	it("keeps every search of the user's, also more than can be added now (moved from earlier versions)", () => {
		const user = Array.from({ length: 20 }, (_, i) => ({
			keywords: `Engineer ${i}`,
			where: "remote-worldwide" as const,
		}));
		const searches = plannedSearches(
			{ ...EMPTY_PLAN, user },
			rulesPlan(settings, null),
		);
		expect(searches.filter((s) => s.by === "you")).toHaveLength(20);
		expect(searches.some((s) => s.by === "rules")).toBe(true);
	});

	it("a short list also starts at the cursor, so a run cut short never starts with the same entry", () => {
		expect(rotate(["a", "b"], 0, 2)).toEqual(["a", "b"]);
		expect(rotate(["a", "b"], 1, 2)).toEqual(["b", "a"]);
		expect(rotate(["a", "b"], 3, 5)).toEqual(["b", "a"]);
		expect(rotate(["a", "b", "c"], 4, 2)).toEqual(["b", "c"]);
		expect(rotate([], 3, 2)).toEqual([]);
	});

	it("successive runs move through every query of the plan, each starting where the last ended", () => {
		const eight: PlanSearch[] = Array.from({ length: 8 }, (_, i) => ({
			keywords: `Engineer ${i}`,
			where: "remote-worldwide" as const,
		}));
		const seen = new Set<string>();
		let cursor = 0;
		for (let scan = 0; scan < 4; scan++) {
			const queries = boardQueries(eight, "Poland", 6, cursor);
			for (const q of queries) seen.add(q);
			cursor += queries.length;
		}
		expect(seen.size).toBe(24);
	});
});
