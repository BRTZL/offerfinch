import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { submissionModeForSource } from "../src/apply/modes";
import { FEEDS } from "../src/feeds/feeds";
import {
	hackerNewsFeed,
	hiringThread,
	parseHiringLine,
	parseHiringThread,
} from "../src/feeds/hackernews";
import { FeedReadError, feedFetcher, fixMojibake } from "../src/feeds/http";
import {
	FEED_NEW_CAP,
	FEED_PACE,
	type Feed,
	type FeedPosting,
	FeedProvider,
	type FeedStore,
	nextFeedRead,
	plausible,
} from "../src/feeds/provider";
import { parseRemoteOk, remoteOkFeed } from "../src/feeds/remoteok";
import {
	parseRemotive,
	REMOTIVE_URL,
	remotiveFeed,
} from "../src/feeds/remotive";
import {
	parseWeWorkRemotely,
	weWorkRemotelyFeed,
} from "../src/feeds/weworkremotely";
import { parseFilterSettings } from "../src/filter/settings";
import { NoopNotifier } from "../src/notify/ntfy";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { FakeLlmProvider } from "../src/scoring/fake";
import { feedKeywordsMatch, feedWhereMatch } from "../src/search/adapt";
import type { PlannedSearch, PlanResult, PlanSearch } from "../src/search/plan";
import { DropLog } from "../src/sites/report";
import type { SiteStopRecord } from "../src/sites/stops";
import { USER_AGENT } from "../src/sources/types";
import { fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

/** Fabricated fixtures in each feed's published shape (no real people, companies made up). */
const fixture = (name: string) =>
	fs.readFileSync(path.join(__dirname, "fixtures/feeds", name), "utf8");
const NOW = new Date("2026-11-03T10:00:00Z");

const SETTINGS = parseFilterSettings({
	livesIn: "Turkey",
	rightToWork: ["Turkey"],
	keepOnsiteIn: ["Turkey"],
});
const SEARCHES: PlannedSearch[] = [
	{ keywords: "Frontend Engineer", where: "remote-worldwide", by: "ai" },
	{
		keywords: "Backend Developer",
		where: "remote-in-country",
		place: "Turkey",
		by: "ai",
	},
];
const PLAN: PlanResult = {
	searches: SEARCHES,
	generatedAt: NOW.toISOString(),
	basis: "ai",
};

describe("feed parsers, on fabricated fixtures in each feed's shape", () => {
	it("Remotive: every listing with its Remotive URL, company, place and plain-text description", () => {
		const postings = parseRemotive(fixture("remotive.json"));
		expect(postings.map((p) => p.externalId)).toEqual([
			"1001",
			"1002",
			"1003",
			"1004",
		]);
		const [first] = postings;
		expect(first).toMatchObject({
			url: "https://remotive.com/remote-jobs/software-development/senior-frontend-engineer-1001",
			title: "Senior Frontend Engineer",
			company: "Nimbus Cloud",
			locations: ["Remote (Worldwide)"],
			workplaceType: "remote",
			employmentType: "full time",
			tags: ["react", "typescript", "frontend"],
		});
		// Written without a zone: UTC.
		expect(first?.publishedAt?.toISOString()).toBe("2026-11-01T09:30:00.000Z");
		expect(first?.descriptionText).toContain(
			"- Requirements: React & TypeScript",
		);
		expect(first?.descriptionText).not.toContain("<");
		expect(postings[1]?.locations).toEqual(["Remote (USA Only)"]);
	});

	it("Remote OK: skips its legal notice, repairs its UTF-8 read as Latin-1, links to remoteok.com", () => {
		const postings = parseRemoteOk(fixture("remoteok.json"));
		expect(postings.map((p) => p.externalId)).toEqual(["2001", "2002", "2003"]);
		const [first, second, third] = postings;
		expect(first).toMatchObject({
			url: "https://remoteok.com/remote-jobs/remote-front-end-engineer-kestrel-works-2001",
			title: "Front End Engineer",
			company: "Kestrel Works",
			locations: ["Remote"],
			workplaceType: "remote",
		});
		expect(first?.descriptionText).toContain("Remote · Full time · €70k–€90k");
		expect(second?.company).toBe("Lumen & Co");
		expect(third).toMatchObject({
			locations: ["Palo Alto, CA"],
			workplaceType: "remote",
		});
		expect(fixMojibake("plain – text · ok")).toBe("plain – text · ok");
	});

	it("We Work Remotely: company and title from the item title, the region as the place, never the headquarters", () => {
		const postings = parseWeWorkRemotely(fixture("weworkremotely-rss.txt"));
		expect(postings.map((p) => `${p.company} | ${p.title}`)).toEqual([
			"Fernhill Analytics | Senior Front-End Engineer",
			"Brightwater Health | Frontend Engineer",
			"Juniper Atlas | Frontend Engineer",
		]);
		const [first] = postings;
		expect(first).toMatchObject({
			externalId: "/remote-jobs/fernhill-analytics-senior-front-end-engineer",
			url: "https://weworkremotely.com/remote-jobs/fernhill-analytics-senior-front-end-engineer",
			locations: ["Remote (Anywhere in the World)"],
			workplaceType: "remote",
			employmentType: "Full-Time",
		});
		expect(first?.tags).toEqual(
			expect.arrayContaining(["Front-End Programming", "React", "TypeScript"]),
		);
		expect(first?.descriptionText).toContain("for & with small clinics");
		expect(first?.publishedAt?.toISOString()).toBe("2026-11-02T17:00:19.000Z");
		expect(postings[2]?.expiresAt?.toISOString()).toBe(
			"2026-11-01T12:00:00.000Z",
		);
	});

	it("HN: picks the newest Who is hiring thread, never Who wants to be hired, nor last month's", () => {
		expect(hiringThread(fixture("hn-search.json"), NOW)).toBe("9001");
		// Forty days on, no new thread yet: none.
		expect(
			hiringThread(fixture("hn-search.json"), new Date("2026-12-20T00:00:00Z")),
		).toBeNull();
	});

	it("HN: reads each top-level comment's first line; replies, deleted and free-form comments are no postings", () => {
		const postings = parseHiringThread(fixture("hn-thread.json"));
		expect(postings.map((p) => p.externalId)).toEqual(["9101", "9102", "9106"]);
		const [nimbus, tessera, harbor] = postings;
		expect(nimbus).toMatchObject({
			url: "https://news.ycombinator.com/item?id=9101",
			company: "Nimbus Cloud",
			title: "Senior Frontend Engineer",
			locations: ["REMOTE (worldwide)"],
			workplaceType: "remote",
			employmentType: "Full-time",
			applyUrl: "https://nimbus.example/jobs/42",
		});
		expect(nimbus?.descriptionText).toContain("React & TypeScript");
		expect(tessera).toMatchObject({
			company: "Tessera Labs",
			title: "Backend Developer",
			locations: ["Berlin, Germany", "ONSITE"],
			workplaceType: "onsite",
		});
		expect(harbor).toMatchObject({
			title: "Frontend Engineer, Backend Engineer",
			locations: ["REMOTE (Turkey, EU)"],
		});
		// The commenter is never kept.
		expect(JSON.stringify(postings)).not.toContain("author");
	});

	it("HN: the first line, as posters write it", () => {
		expect(
			parseHiringLine(
				"Synthwave Labs | Austin, TX | REMOTE (US) | Full-time | Staff Software Engineer",
			),
		).toMatchObject({
			company: "Synthwave Labs",
			title: "Staff Software Engineer",
			locations: ["Austin, TX", "REMOTE (US)"],
			workplaceType: "remote",
		});
		expect(
			parseHiringLine(
				"Oakmoss | Hybrid (2 days) | Lisbon, Portugal | Data Engineer",
			),
		).toMatchObject({ workplaceType: "hybrid", title: "Data Engineer" });
		expect(parseHiringLine("We are hiring! Email us.")).toBeNull();
		expect(parseHiringLine("Only a company | REMOTE")).toBeNull();
	});

	it("every feed's jobs are handed off, and say where they were found", () => {
		for (const feed of FEEDS) {
			const mode = submissionModeForSource(feed.source, null, null);
			expect(mode.mode).toBe("handoff");
			expect(mode.reason).toMatch(/Found (on|in)/);
		}
	});
});

describe("the shared plan, applied to a feed", () => {
	const search = (keywords: string): PlanSearch => ({
		keywords,
		where: "remote-worldwide",
	});

	it("keywords: every telling word in the title (or tags), spellings folded, seniority left out", () => {
		const yes: [string, string, string[]?][] = [
			["Frontend Engineer", "Senior Front-End Developer"],
			["Frontend Engineer", "Engineer, Frontend Platform"],
			["Senior Frontend Engineer", "Frontend Engineer"],
			["React Developer", "React.js Engineer"],
			["Software Engineers", "Software Engineer"],
			["Frontend Engineer", "Software Engineer", ["frontend"]],
			["Design Systems Engineer", "Design System Engineer"],
		];
		for (const [keywords, title, tags] of yes)
			expect(
				feedKeywordsMatch({ title, tags }, search(keywords)),
				`${keywords} ~ ${title}`,
			).toBe(true);
		const no: [string, string][] = [
			["Frontend Engineer", "Marketing Manager"],
			["Frontend Engineer", "Frontend Lead"],
			["Backend Developer", "Frontend Developer"],
			["Senior", "Senior Accountant"],
		];
		for (const [keywords, title] of no)
			expect(
				feedKeywordsMatch({ title }, search(keywords)),
				`${keywords} !~ ${title}`,
			).toBe(false);
	});

	it("where: the filter's place verdict against where the search looks", () => {
		const remote = search("x");
		const home: PlanSearch = { keywords: "x", where: "remote-in-country" };
		const office: PlanSearch = { keywords: "x", where: "onsite" };
		const r = { workplaceType: "remote" as const };
		const o = { workplaceType: "onsite" as const };
		expect(feedWhereMatch(r, "remote_global", remote)).toBe(true);
		expect(feedWhereMatch(r, "unclear", remote)).toBe(true);
		expect(feedWhereMatch(r, "remote_home", remote)).toBe(false);
		expect(feedWhereMatch(r, "remote_home", home)).toBe(true);
		expect(feedWhereMatch(r, "remote_global", home)).toBe(true);
		expect(feedWhereMatch(o, "home", office)).toBe(true);
		expect(feedWhereMatch(r, "remote_global", office)).toBe(false);
		// An office job in a place the filter can't judge is no remote job.
		expect(feedWhereMatch(o, "unclear", remote)).toBe(false);
		expect(feedWhereMatch(o, "unclear", home)).toBe(false);
	});

	it("keeps only plausible matches, newest first, and says why the others were set aside", () => {
		const postings = [
			...parseRemotive(fixture("remotive.json")),
			...parseWeWorkRemotely(fixture("weworkremotely-rss.txt")),
		];
		const drops = new DropLog();
		const kept = plausible(postings, SETTINGS, SEARCHES, NOW, drops);
		expect(kept.map((p) => p.company)).toEqual([
			"Fernhill Analytics",
			"Quarry",
			"Nimbus Cloud",
		]);
		expect(drops.report()).toEqual([
			expect.objectContaining({ reason: "off_search", count: 3 }),
			expect.objectContaining({ reason: "expired", count: 1 }),
		]);
		const off = drops.report()?.find((d) => d.reason === "off_search");
		// US-only (the filter), a role no search names, and US-only again.
		expect(off?.examples?.map((e) => e.company)).toEqual([
			"Tessera Labs",
			"Harbor Mills",
			"Brightwater Health",
		]);
	});
});

describe("the pace", () => {
	const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

	it("every 6 hours, 4 reads a day, and never longer than the pace after a clock set back", () => {
		expect(nextFeedRead([], NOW)).toEqual(NOW);
		expect(nextFeedRead([hours(-1)], NOW)).toEqual(hours(5));
		expect(nextFeedRead([hours(-7)], NOW)).toEqual(NOW);
		// Four reads in the last day (as close as 6 h allows, the oldest 18 h ago): a day after it.
		expect(
			nextFeedRead([hours(-18), hours(-12), hours(-7), hours(-6.5)], NOW),
		).toEqual(hours(6));
		// A read "in the future" (the clock went back): at most one pace away.
		expect(nextFeedRead([hours(30)], NOW)).toEqual(hours(FEED_PACE.everyHours));
	});
});

/** An in-memory feed store: dedupe like the database's, reads and stops kept across "restarts". */
function memoryStore(repo: MemoryRepo, state = new FeedState()): FeedStore {
	return {
		hasPosting: async (_u, source, id) =>
			repo.jobs.some((j) => j.job.source === source && j.job.externalId === id),
		companyFor: async (userId, c) =>
			(
				repo.companies.find((x) => x.sourceKey === c.sourceKey) ??
				repo.addCompany(c, userId)
			).id,
		isDuplicate: async (_u, job) =>
			repo.jobs.some(
				(j) =>
					job.urls.includes(j.job.url) ||
					(j.job.applyUrl !== undefined && job.urls.includes(j.job.applyUrl)) ||
					(j.job.companyName === job.company && j.job.title === job.title),
			),
		stopped: async (_u, s) => state.stops.get(s) ?? null,
		stop: async (_u, s, r) => {
			state.stops.set(s, r);
		},
		clearStop: async (_u, s) => {
			state.stops.delete(s);
		},
		reads: async (_u, f) => state.reads.get(f) ?? [],
		markRead: async (_u, f, at) => {
			state.reads.set(f, [...(state.reads.get(f) ?? []), at]);
		},
	};
}
class FeedState {
	stops = new Map<string, SiteStopRecord>();
	reads = new Map<string, Date[]>();
}

/** A fetch serving the fixtures by URL, counting requests; `fail` answers with that status. */
function fixtureFetch(fail?: number) {
	const requests: { url: string; ua: string | null }[] = [];
	const fetchImpl = async (url: string, init?: RequestInit) => {
		requests.push({
			url,
			ua: new Headers(init?.headers).get("user-agent"),
		});
		if (fail) return new Response("no", { status: fail });
		const name = url.startsWith(REMOTIVE_URL)
			? "remotive.json"
			: url.includes("remoteok.com")
				? "remoteok.json"
				: url.includes("weworkremotely.com")
					? "weworkremotely-rss.txt"
					: url.includes("search_by_date")
						? "hn-search.json"
						: "hn-thread.json";
		return new Response(fixture(name), { status: 200 });
	};
	return { fetchImpl, requests };
}

function harness(
	input: {
		feeds?: Feed[];
		fail?: number;
		cap?: number;
		now?: () => Date;
		state?: FeedState;
		repo?: MemoryRepo;
	} = {},
) {
	const repo = input.repo ?? new MemoryRepo();
	repo.onDemand = true;
	repo.settings = SETTINGS;
	const state = input.state ?? new FeedState();
	const net = fixtureFetch(input.fail);
	const providers = (input.feeds ?? [remotiveFeed]).map(
		(feed) =>
			new FeedProvider(feed, memoryStore(repo, state), net.fetchImpl, {
				now: input.now ?? (() => NOW),
				...(input.cap ? { cap: input.cap } : {}),
			}),
	);
	const llm = new FakeLlmProvider();
	const workflows = new LocalWorkflowStarter();
	const deps: PipelineDeps = {
		repo,
		sources: {},
		providers: async () => providers,
		searchPlan: async () => PLAN,
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
			.providers ?? [];
	return { repo, state, net, scan, providers, deps };
}

describe("a feed provider in a scan", () => {
	it("reads once, keeps plausible matches with a link back, and records the read before the request", async () => {
		const h = harness();
		const [run] = await h.scan();
		expect(h.net.requests).toEqual([{ url: REMOTIVE_URL, ua: USER_AGENT }]);
		expect(run).toMatchObject({
			provider: "remotive",
			results: 4,
			fetched: 4,
			found: 2,
			duplicates: 0,
			pagesRead: 1,
		});
		expect(run?.newJobIds).toHaveLength(2);
		expect(run?.searches).toEqual([
			"Frontend Engineer · remote, worldwide",
			"Backend Developer · remote, Turkey",
		]);
		expect(h.repo.jobs.map((j) => [j.job.source, j.job.url])).toEqual([
			[
				"remotive",
				"https://remotive.com/remote-jobs/software-development/backend-engineer-1004",
			],
			[
				"remotive",
				"https://remotive.com/remote-jobs/software-development/senior-frontend-engineer-1001",
			],
		]);
		expect(h.state.reads.get("remotive")).toEqual([NOW]);
	});

	it("waits out its pace across restarts: a new provider over the same store makes no request", async () => {
		const state = new FeedState();
		await harness({ state }).scan();
		let clock = new Date(NOW.getTime() + 2 * 3_600_000);
		const later = harness({ state, now: () => clock });
		const [waiting] = await later.scan();
		expect(later.net.requests).toEqual([]);
		expect(waiting).toMatchObject({
			status: "waiting",
			retryAt: "2026-11-03T16:00:00.000Z",
			problem: "Next Remotive read in ~4 h.",
		});
		clock = new Date(NOW.getTime() + 6 * 3_600_000);
		await later.scan();
		expect(later.net.requests).toHaveLength(1);
	});

	it("a refusal is a stop that backs off, never thrown (so no step retry asks again)", async () => {
		const h = harness({ fail: 429 });
		const [run] = await h.scan();
		expect(h.net.requests).toHaveLength(1);
		expect(run?.problem).toMatch(
			/^Paused after: remotive\.com refused the request \(HTTP 429\)\. Tries again/,
		);
		expect(h.state.stops.get("remotive")).toMatchObject({
			kind: "blocked",
			failures: 1,
		});
		// The read counted: the next scan neither asks again nor clears the stop.
		const [again] = await h.scan();
		expect(h.net.requests).toHaveLength(1);
		expect(again?.problem).toMatch(/^Paused after/);
	});

	it("a server error or a web page where the feed should be is a problem, the read still counted", async () => {
		const h = harness({ fail: 503 });
		const [run] = await h.scan();
		expect(run?.problem).toBe(
			"Could not read the feed: remotive.com answered HTTP 503.",
		);
		expect(h.state.stops.size).toBe(0);
		expect(h.state.reads.get("remotive")).toHaveLength(1);
		const page = feedFetcher(
			async () => new Response("<!DOCTYPE html><title>Just a moment</title>"),
		);
		await expect(page("https://remoteok.com/api", "json")).rejects.toThrow(
			FeedReadError,
		);
	});

	it("stores at most the cap a read, the newest first, and says so; the rest come with the next read", async () => {
		const many: Feed = {
			id: "remotive",
			label: "Remotive",
			source: "remotive",
			read: async () => ({
				requests: 1,
				postings: Array.from(
					{ length: 30 },
					(_, i): FeedPosting => ({
						externalId: String(i),
						url: `https://remotive.com/remote-jobs/x-${i}`,
						title: "Frontend Engineer",
						company: `Company ${i}`,
						locations: ["Remote (Worldwide)"],
						workplaceType: "remote",
						descriptionText: "Build the web app in React.",
						publishedAt: new Date(NOW.getTime() - i * 60_000),
					}),
				),
			}),
		};
		const state = new FeedState();
		let clock = NOW;
		const h = harness({ feeds: [many], state, now: () => clock });
		const [run] = await h.scan();
		expect(run?.newJobIds).toHaveLength(FEED_NEW_CAP);
		expect(run?.found).toBe(30);
		expect(run?.status).toBe("ok");
		expect(run?.problem).toBe(
			"Cap of 25 new postings a read reached; 5 more wait for the next read",
		);
		expect(h.repo.jobs.map((j) => j.job.externalId)).toContain("0");
		expect(h.repo.jobs.map((j) => j.job.externalId)).not.toContain("29");
		clock = new Date(NOW.getTime() + 6 * 3_600_000);
		const [next] = await h.scan();
		expect(next?.newJobIds).toHaveLength(5);
		expect(next?.duplicates).toBe(25);
		expect(next?.problem).toBeUndefined();
	});

	it("dedupes against what the app has: its own posting, another source's apply link, company and title", async () => {
		const repo = new MemoryRepo();
		const board = repo.addCompany(
			{ name: "Nimbus Cloud", source: "greenhouse", sourceKey: "nimbus" },
			"u1",
		);
		// Job-board search stored the employer's posting that HN's comment links to.
		await repo.upsertJob("u1", board.id, {
			source: "greenhouse",
			externalId: "42",
			url: "https://nimbus.example/jobs/42",
			title: "Staff Frontend Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "React.",
			companyName: "Nimbus Cloud",
		});
		const h = harness({
			repo,
			feeds: [remotiveFeed, remoteOkFeed, weWorkRemotelyFeed, hackerNewsFeed],
		});
		const runs = await h.scan();
		const by = Object.fromEntries(runs.map((r) => [r.provider, r]));
		// Remotive's Nimbus Cloud job is new; HN's same company and title is not, nor its link.
		expect(by.remotive?.newJobIds).toHaveLength(2);
		expect(by["hn-hiring"]).toMatchObject({ duplicates: 1, pagesRead: 2 });
		expect(by["hn-hiring"]?.newJobIds).toHaveLength(1);
		expect(by.remoteok?.newJobIds).toHaveLength(2);
		expect(by.weworkremotely?.newJobIds).toHaveLength(1);
		const hn = h.repo.jobs.find((j) => j.job.source === "hackernews");
		expect(hn?.job).toMatchObject({
			title: "Frontend Engineer, Backend Engineer",
			companyName: "Harbor Mills",
			url: "https://news.ycombinator.com/item?id=9106",
		});
		// Each feed read once, two requests for HN.
		expect(h.net.requests).toHaveLength(5);
	});
});
