import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { submissionModeForSource } from "../src/apply/modes";
import { decodeEntities } from "../src/domain/text";
import { FEEDS } from "../src/feeds/feeds";
import {
	hackerNewsFeed,
	hiringThread,
	parseHiringLine,
	parseHiringThread,
} from "../src/feeds/hackernews";
import {
	FeedReadError,
	feedFetcher,
	feedLine,
	fixMojibake,
} from "../src/feeds/http";
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
import { parseRemotive, remotiveFeed } from "../src/feeds/remotive";
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
const REMOTIVE_URL = "https://remotive.com/api/remote-jobs";
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
		const postings = parseRemotive(fixture("remotive.json")).postings;
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
		const postings = parseRemoteOk(fixture("remoteok.json")).postings;
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
		const postings = parseWeWorkRemotely(
			fixture("weworkremotely-rss.txt"),
		).postings;
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
		const postings = parseHiringThread(fixture("hn-thread.json")).postings;
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
		// No break after the header: the prose run into the last part is no place.
		expect(
			parseHiringLine(
				"Pinecrest Data | Software Engineers | 100% Remote (Global) | Full-Time Pinecrest processes petabytes of data every month for hundreds of customers in Germany and Japan.",
			),
		).toMatchObject({
			title: "Software Engineers",
			locations: ["100% Remote (Global)"],
		});
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
			// Lead is a role word (review #2): any role word stands for the others.
			["Frontend Engineer", "Frontend Lead"],
		];
		for (const [keywords, title, tags] of yes)
			expect(
				feedKeywordsMatch({ title, tags }, search(keywords)),
				`${keywords} ~ ${title}`,
			).toBe(true);
		const no: [string, string][] = [
			["Frontend Engineer", "Marketing Manager"],
			["Backend Developer", "Frontend Developer"],
			["Senior", "Senior Accountant"],
		];
		for (const [keywords, title] of no)
			expect(
				feedKeywordsMatch({ title }, search(keywords)),
				`${keywords} !~ ${title}`,
			).toBe(false);
	});

	it("where: the kind of work against where the search looks, never the place", () => {
		const remote = search("x");
		const home: PlanSearch = { keywords: "x", where: "remote-in-country" };
		const office: PlanSearch = { keywords: "x", where: "onsite" };
		const r = { workplaceType: "remote" as const };
		const o = { workplaceType: "onsite" as const };
		const u = { workplaceType: "unknown" as const };
		expect(feedWhereMatch(r, remote)).toBe(true);
		expect(feedWhereMatch(r, home)).toBe(true);
		expect(feedWhereMatch(u, remote)).toBe(true);
		expect(feedWhereMatch(o, office)).toBe(true);
		expect(feedWhereMatch(u, office)).toBe(true);
		expect(feedWhereMatch(r, office)).toBe(false);
		// An office job is no remote job.
		expect(feedWhereMatch(o, remote)).toBe(false);
		expect(feedWhereMatch(o, home)).toBe(false);
	});

	it("keeps the postings a search finds, newest first, and says why the others were set aside", () => {
		const postings = [
			...parseRemotive(fixture("remotive.json")).postings,
			...parseWeWorkRemotely(fixture("weworkremotely-rss.txt")).postings,
		];
		const drops = new DropLog();
		const kept = plausible(postings, SEARCHES, NOW, drops);
		// US-only roles are kept: the fit score judges where a job hires, not the feed.
		expect(kept.map((p) => p.company)).toEqual([
			"Fernhill Analytics",
			"Brightwater Health",
			"Quarry",
			"Nimbus Cloud",
			"Tessera Labs",
		]);
		expect(drops.report()).toEqual([
			expect.objectContaining({ reason: "off_search", count: 1 }),
			expect.objectContaining({ reason: "expired", count: 1 }),
		]);
		const off = drops.report()?.find((d) => d.reason === "off_search");
		// A role no search names.
		expect(off?.examples?.map((e) => e.company)).toEqual(["Harbor Mills"]);
	});
});

describe("the pace", () => {
	const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

	it("every 6 hours, 4 reads a day", () => {
		expect(nextFeedRead([], NOW)).toEqual(NOW);
		expect(nextFeedRead([hours(-1)], NOW)).toEqual(hours(5));
		expect(nextFeedRead([hours(-7)], NOW)).toEqual(NOW);
		// Four reads in the last day (as close as 6 h allows, the oldest 18 h ago): a day after it.
		expect(
			nextFeedRead([hours(-18), hours(-12), hours(-7), hours(-6.5)], NOW),
		).toEqual(hours(6));
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
		// As the database's: by URL or apply link, or company and title when both are remote.
		sameJobStored: async (_u, job) =>
			repo.jobs.some(
				(j) =>
					job.urls.includes(j.job.url) ||
					(j.job.applyUrl !== undefined && job.urls.includes(j.job.applyUrl)) ||
					(j.job.companyName === job.company &&
						j.job.title === job.title &&
						j.job.workplaceType === "remote" &&
						job.workplaceType === "remote"),
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
		// A US-only role is kept too: the fit score judges where it hires.
		expect(run).toMatchObject({
			provider: "remotive",
			results: 4,
			fetched: 4,
			found: 3,
			duplicates: 0,
			pagesRead: 1,
		});
		expect(run?.newJobIds).toHaveLength(3);
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
			[
				"remotive",
				"https://remotive.com/remote-jobs/software-development/frontend-developer-1002",
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
		expect(by.remotive?.newJobIds).toHaveLength(3);
		expect(by["hn-hiring"]).toMatchObject({ duplicates: 1, pagesRead: 2 });
		expect(by["hn-hiring"]?.newJobIds).toHaveLength(1);
		expect(by.remoteok?.newJobIds).toHaveLength(3);
		expect(by.weworkremotely?.newJobIds).toHaveLength(2);
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

/* ------------------------------------------------- review fixes (2026-11-03) */

describe("review: the plan match is not over-broad (#2)", () => {
	const search = (keywords: string): PlanSearch => ({
		keywords,
		where: "remote-worldwide",
	});
	const match = (keywords: string, title: string, tags?: string[]) =>
		feedKeywordsMatch({ title, tags }, search(keywords));

	it("never matches on a role word and seniority alone", () => {
		expect(match("Staff Engineer", "QA Automation Engineer")).toBe(false);
		expect(match("Engineer", "Senior Engineer")).toBe(false);
		expect(match("Senior Developer", "Developer")).toBe(false);
	});

	it("lead is a role word, not a word to ignore", () => {
		expect(match("Frontend Lead", "Account Executive", ["frontend"])).toBe(
			false,
		);
		expect(match("Frontend Lead", "Frontend Lead")).toBe(true);
		expect(match("Frontend Lead", "Lead Frontend Engineer")).toBe(true);
	});

	it("tags supply a specialty only for a generic title, never against the title's own", () => {
		expect(match("Backend Engineer", "Frontend Engineer", ["backend"])).toBe(
			false,
		);
		expect(match("Frontend Engineer", "Software Engineer", ["frontend"])).toBe(
			true,
		);
		expect(match("Frontend Engineer", "Engineer", ["frontend"])).toBe(true);
		expect(
			match("Design Systems Engineer", "Design Engineer", ["systems"]),
		).toBe(false);
	});
});

describe("review: one bad item never costs the read (#3)", () => {
	it("an out-of-range character reference is a replacement character, not a crash", () => {
		expect(decodeEntities("a &#99999999; b")).toBe("a � b");
		expect(feedLine("a &#x110000; b &#xD800; c")).toBe("a � b � c");
	});

	it("Remotive and Remote OK skip items that are not objects, lack strings or have no web URL, and count them", () => {
		const good = {
			id: 1,
			url: "https://remotive.com/remote-jobs/x-1",
			title: "Frontend Engineer",
			company_name: "Nimbus Cloud",
			description: "<p>Build &#99999999; things.</p>",
		};
		const remotive = parseRemotive(
			JSON.stringify({
				jobs: [
					null,
					5,
					{ ...good, id: 2, url: "javascript:alert(1)" },
					{ ...good, id: 3, title: { text: "x" } },
					{ ...good, id: 4, candidate_required_location: 7 },
					good,
				],
			}),
		);
		expect(remotive.postings.map((p) => p.externalId)).toEqual(["1"]);
		expect(remotive.skipped).toBe(5);
		const remoteok = parseRemoteOk(
			JSON.stringify([
				{ legal: "notice" },
				"text",
				{ id: "9", position: "Engineer", company: "Kestrel", url: "ftp://x" },
				{
					id: "10",
					position: ["x"],
					company: "Kestrel",
					url: "https://remoteok.com/a",
				},
				{
					id: "11",
					position: "Frontend Engineer",
					company: "Kestrel Works",
					url: "https://remoteok.com/remote-jobs/11",
					tags: "frontend",
				},
			]),
		);
		expect(remoteok.postings.map((p) => p.externalId)).toEqual(["11"]);
		expect(remoteok.postings[0]?.tags).toEqual([]);
		expect(remoteok.skipped).toBe(3);
	});

	it("We Work Remotely and HN skip a broken item and keep the rest", () => {
		const wwr = parseWeWorkRemotely(
			`<rss><channel><item><title>Acme: Frontend Engineer</title><link>javascript:x</link></item>${fixture("weworkremotely-rss.txt").match(/<item>[\s\S]*?<\/item>/)?.[0]}</channel></rss>`,
		);
		expect(wwr.postings).toHaveLength(1);
		expect(wwr.skipped).toBe(1);
		const thread = JSON.parse(fixture("hn-thread.json"));
		thread.children.unshift(7, { id: 1, type: "comment", text: 42 });
		const hn = parseHiringThread(JSON.stringify(thread));
		expect(hn.postings.map((p) => p.externalId)).toEqual([
			"9101",
			"9102",
			"9106",
		]);
		expect(hn.skipped).toBe(2);
	});

	it("skipped items are a note on the run, which still stores the rest", async () => {
		const partly: Feed = {
			...remotiveFeed,
			read: async () => ({
				requests: 1,
				skipped: 2,
				postings: parseRemotive(fixture("remotive.json")).postings,
			}),
		};
		const [run] = await harness({ feeds: [partly] }).scan();
		expect(run?.newJobIds).toHaveLength(3);
		expect(run?.status).toBe("ok");
		expect(run?.problem).toBe(
			"2 items in the feed could not be read and were skipped",
		);
	});
});

describe("review: a clock set back never holds a feed (#4)", () => {
	const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
	it("a read recorded in the future is ignored, so the wait does not slide forward", () => {
		expect(nextFeedRead([hours(30)], NOW)).toEqual(NOW);
		expect(nextFeedRead([hours(30)], hours(6))).toEqual(hours(6));
		expect(nextFeedRead([hours(-1), hours(30)], NOW)).toEqual(hours(5));
	});
});

describe("review: stops, counts and the pace agree (#5)", () => {
	it("a refusal's retry time is never before the pace allows the next read", async () => {
		const h = harness({ fail: 429 });
		await h.scan();
		expect(h.state.stops.get("remotive")?.retryAt).toBe(
			new Date(NOW.getTime() + FEED_PACE.everyHours * 3_600_000).toISOString(),
		);
	});

	it("a failed read reports no searches", async () => {
		const [run] = await harness({ fail: 503 }).scan();
		expect(run?.queries).toBe(0);
		expect(run?.searches).toBeUndefined();
	});
});

describe("review: HN header parts (#6)", () => {
	it("a role with its workplace in brackets is the role, and says where", () => {
		expect(
			parseHiringLine(
				"Acme Robotics | Senior Frontend Engineer (Remote) | Full-time",
			),
		).toMatchObject({
			title: "Senior Frontend Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
		});
	});

	it("a line naming no role is no posting", () => {
		expect(
			parseHiringLine("Acme Robotics | Series B | Berlin, Germany | ONSITE"),
		).toBeNull();
	});

	it("a company's home or careers page is no apply link; a posting's page is", () => {
		const thread = (href: string) =>
			JSON.stringify({
				children: [
					{
						id: 1,
						type: "comment",
						text: `Acme | Frontend Engineer | REMOTE | <a href="${href}">link</a>`,
					},
				],
			});
		for (const href of [
			"https://acme.example",
			"https://acme.example/",
			"https://www.acme.example/careers",
			"https://acme.example/jobs/",
		])
			expect(
				parseHiringThread(thread(href)).postings[0]?.applyUrl,
				href,
			).toBeUndefined();
		expect(
			parseHiringThread(thread("https://acme.example/careers/frontend-42"))
				.postings[0]?.applyUrl,
		).toBe("https://acme.example/careers/frontend-42");
	});
});

describe("review: an address in angle brackets is text, not a tag (#8)", () => {
	it("in a JSON feed's HTML, and in an RSS feed's escaped HTML", () => {
		const remotive = parseRemotive(
			JSON.stringify({
				jobs: [
					{
						id: 1,
						url: "https://remotive.com/remote-jobs/x-1",
						title: "Frontend Engineer",
						company_name: "Nimbus Cloud",
						description: "<p>Write to &lt;jobs@nimbus.example&gt; today.</p>",
					},
				],
			}),
		);
		expect(remotive.postings[0]?.descriptionText).toBe(
			"Write to <jobs@nimbus.example> today.",
		);
		const wwr = parseWeWorkRemotely(
			"<rss><channel><item><title>Acme: Frontend Engineer</title><link>https://weworkremotely.com/remote-jobs/acme-1</link><description>&lt;p&gt;Mail &amp;lt;jobs@acme.example&amp;gt; now.&lt;/p&gt;</description></item></channel></rss>",
		);
		expect(wwr.postings[0]?.descriptionText).toBe(
			"Mail <jobs@acme.example> now.",
		);
	});
});

describe("HN: where a role segment says it is (re-check E)", () => {
	it("bracketed or trailing place text in the role goes to the locations, the title stays clean", () => {
		expect(
			parseHiringLine(
				"Acme Robotics | Senior Frontend Engineer (Remote, US only) | Full-time",
			),
		).toMatchObject({
			title: "Senior Frontend Engineer",
			locations: ["Remote, US only"],
			workplaceType: "remote",
		});
		expect(
			parseHiringLine("Acme Robotics | Backend Engineer - Berlin, Germany"),
		).toMatchObject({
			title: "Backend Engineer",
			locations: ["Berlin, Germany"],
		});
		// Brackets that say something else stay in the title.
		expect(
			parseHiringLine(
				"Acme Robotics | Platform Engineer (Kubernetes) | REMOTE",
			),
		).toMatchObject({
			title: "Platform Engineer (Kubernetes)",
			locations: ["REMOTE"],
		});
	});

	it("a US-only role is kept: the fit score judges where it hires", () => {
		const { postings } = parseHiringThread(
			JSON.stringify({
				children: [
					{
						id: 77,
						type: "comment",
						text: "Acme Robotics | Senior Frontend Engineer (Remote, US only) | Full-time<p>React.",
					},
				],
			}),
		);
		const [p] = postings;
		expect(p?.locations).toEqual(["Remote, US only"]);
		const drops = new DropLog();
		expect(
			plausible([p as FeedPosting], SEARCHES, NOW, drops).map((k) => k.title),
		).toEqual(["Senior Frontend Engineer"]);
		expect(drops.report()).toEqual([]);
	});
});
