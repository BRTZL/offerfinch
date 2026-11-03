import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { FEED_IDS } from "@offerfinch/core/feeds/feeds";
import { nextFeedRead } from "@offerfinch/core/feeds/provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	clearProviderStop,
	DashboardRepository,
	type Database,
	listProviders,
	openSqlite,
	recordProviderRun,
	SqliteFeedStore,
	updateProvider,
} from "../src/index";
import { testDb } from "./setup";

let db: Database;

beforeAll(async () => {
	db = await testDb();
});
afterAll(() => db.$close());

describe("the remote feeds' store", () => {
	it("the feeds are sources of their own, off until the user turns one on", async () => {
		const states = await listProviders(db, "u1");
		for (const id of FEED_IDS)
			expect(states.find((p) => p.provider === id)).toMatchObject({
				enabled: false,
			});
		// Before web search, which stays last.
		expect(states.map((p) => p.provider).slice(-5)).toEqual([
			...FEED_IDS,
			"web-search",
		]);
	});

	it("keeps a feed's reads across restarts, beside its stop, and through Retry now", async () => {
		await updateProvider(db, "u1", "remotive", { enabled: true });
		const at = new Date("2026-11-03T08:00:00Z");
		await new SqliteFeedStore(db).markRead("u1", "remotive", at);
		const store = new SqliteFeedStore(db);
		await store.stop("u1", "remotive", {
			kind: "blocked",
			reason: "refused",
			at: at.toISOString(),
			failures: 1,
			retryAt: "2026-11-03T09:00:00Z",
		});
		// The app started again: a new store, over the same file.
		const path = (db.$client as { name: string }).name;
		const reopened = openSqlite(path);
		try {
			const again = new SqliteFeedStore(reopened);
			expect(await again.reads("u1", "remotive")).toEqual([at]);
			expect(await again.stopped("u1", "remotive")).toMatchObject({
				kind: "blocked",
			});
			// Retry now lifts the stop, never the pace.
			await clearProviderStop(reopened, "u1", "remotive");
			expect(await again.stopped("u1", "remotive")).toBeNull();
			const reads = await again.reads("u1", "remotive");
			expect(reads).toEqual([at]);
			expect(
				nextFeedRead(reads, new Date("2026-11-03T09:00:00Z")).toISOString(),
			).toBe("2026-11-03T14:00:00.000Z");
			// Still on, and reads older than two days are dropped as new ones come.
			await again.markRead("u1", "remotive", new Date("2026-11-06T08:00:00Z"));
			expect(await again.reads("u1", "remotive")).toEqual([
				new Date("2026-11-06T08:00:00Z"),
			]);
			expect(
				(await listProviders(reopened, "u1")).find(
					(p) => p.provider === "remotive",
				)?.enabled,
			).toBe(true);
		} finally {
			reopened.$close();
		}
	});

	it("finds a job another source stored: its URL, its apply link, or the company and title", async () => {
		const repo = new DashboardRepository(db);
		const store = new SqliteFeedStore(db);
		const companyId = await store.companyFor("u1", {
			name: "Nimbus Cloud",
			source: "greenhouse",
			sourceKey: "nimbus",
		});
		await repo.upsertJob("u1", companyId, {
			source: "greenhouse",
			externalId: "42",
			url: "https://job-boards.greenhouse.io/nimbus/jobs/42",
			title: "Senior Frontend Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "React.",
		});
		const dup = (urls: string[], company: string, title: string) =>
			store.isDuplicate("u1", { urls, company, title });
		expect(
			await dup(
				[
					"https://news.ycombinator.com/item?id=1",
					"https://job-boards.greenhouse.io/nimbus/jobs/42",
				],
				"Someone Else",
				"Other",
			),
		).toBe(true);
		expect(
			await dup(
				["https://remotive.com/remote-jobs/x-1"],
				"Nimbus Cloud",
				"Senior Frontend Engineer",
			),
		).toBe(true);
		expect(
			await dup(
				["https://remotive.com/remote-jobs/x-2"],
				"Nimbus Cloud",
				"Backend Engineer",
			),
		).toBe(false);
		// A feed's own posting, by its id.
		const feedCompany = await store.companyFor("u1", {
			name: "Quarry",
			source: "remotive",
			sourceKey: "remotive:quarry",
		});
		await repo.upsertJob("u1", feedCompany, {
			source: "remotive",
			externalId: "1004",
			url: "https://remotive.com/remote-jobs/software-development/backend-engineer-1004",
			title: "Backend Engineer",
			locations: ["Remote (Europe, Turkey)"],
			workplaceType: "remote",
			descriptionText: "Node.",
		});
		expect(await store.hasPosting("u1", "remotive", "1004")).toBe(true);
		expect(await store.hasPosting("u1", "remoteok", "1004")).toBe(false);
	});

	it("in the other order too: a board posting an HN post linked to, found later, is the same job", async () => {
		const repo = new DashboardRepository(db);
		const store = new SqliteFeedStore(db);
		const hnCompany = await store.companyFor("u1", {
			name: "Harbor Mills",
			source: "hackernews",
			sourceKey: "hackernews:harbormills",
		});
		const hn = await repo.upsertJob("u1", hnCompany, {
			source: "hackernews",
			externalId: "9106",
			url: "https://news.ycombinator.com/item?id=9106",
			applyUrl:
				"https://jobs.lever.co/harbormills/4c1f2a7e-0000-4000-8000-000000000001",
			title: "Frontend Engineer",
			locations: ["REMOTE (Turkey, EU)"],
			workplaceType: "remote",
			descriptionText: "Logistics software.",
		});
		const board = await store.companyFor("u1", {
			name: "Harbor Mills",
			source: "lever",
			sourceKey: "harbormills",
		});
		const found = await repo.upsertJob("u1", board, {
			source: "lever",
			externalId: "4c1f2a7e-0000-4000-8000-000000000001",
			url: "https://jobs.lever.co/harbormills/4c1f2a7e-0000-4000-8000-000000000001",
			title: "Frontend Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "Logistics software.",
		});
		expect(found).toEqual({ jobId: hn.jobId, inserted: false });
	});

	it("drops a read recorded in the future when it records the next (review #4)", async () => {
		const store = new SqliteFeedStore(db);
		await updateProvider(db, "u1", "remoteok", { enabled: true });
		const now = new Date("2026-11-03T08:00:00Z");
		await store.markRead("u1", "remoteok", new Date("2026-11-04T14:00:00Z"));
		await store.markRead("u1", "remoteok", now);
		expect(await store.reads("u1", "remoteok")).toEqual([now]);
	});

	it("Retry now on a feed keeps its last run, so a waiting scan doesn't read as never run (review #5)", async () => {
		await updateProvider(db, "u1", "weworkremotely", { enabled: true });
		await recordProviderRun(db, "u1", {
			provider: "weworkremotely",
			queries: 2,
			found: 1,
			fetched: 100,
			newJobIds: ["j1"],
		});
		await new SqliteFeedStore(db).stop("u1", "weworkremotely", {
			kind: "blocked",
			reason: "refused",
			at: new Date().toISOString(),
		});
		await clearProviderStop(db, "u1", "weworkremotely", { keepLastRun: true });
		const state = (await listProviders(db, "u1")).find(
			(p) => p.provider === "weworkremotely",
		);
		expect(state?.config.stop).toBeUndefined();
		expect(state?.lastRun).toMatchObject({ fetched: 100, newJobs: 1 });
		expect(state?.lastRunAt).not.toBeNull();
	});
});

describe("a feed posting is a duplicate by company and title only when it is surely the same job (re-check C)", () => {
	const board = async (
		name: string,
		id: string,
		over: Partial<NormalizedJob> = {},
	) => {
		const store = new SqliteFeedStore(db);
		const companyId = await store.companyFor("u1", {
			name,
			source: "greenhouse",
			sourceKey: name.toLowerCase().replace(/\W+/g, ""),
		});
		return new DashboardRepository(db).upsertJob("u1", companyId, {
			source: "greenhouse",
			externalId: id,
			url: `https://job-boards.greenhouse.io/x/jobs/${id}`,
			title: "Platform Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "Run the platform.",
			...over,
		});
	};
	const feedPosting = (
		company: string,
		over: Record<string, unknown> = {},
	) => ({
		urls: [`https://remotive.com/remote-jobs/${company}`],
		company,
		title: "Platform Engineer",
		workplaceType: "remote" as const,
		locations: ["Remote (Worldwide)"],
		...over,
	});
	const dup = (p: ReturnType<typeof feedPosting>) =>
		new SqliteFeedStore(db).sameJobStored("u1", p);

	it("an office job in Berlin and a remote feed job with that company and title are both kept", async () => {
		await board("Orchid Grid", "501", {
			locations: ["Berlin, Germany"],
			workplaceType: "onsite",
		});
		expect(await dup(feedPosting("Orchid Grid"))).toBe(false);
	});

	it("two remote postings with the same company and title are both kept: only a shared URL or apply link is one vacancy", async () => {
		await board("Saffron Loop", "502", {
			locations: ["Remote - US"],
			workplaceType: "remote",
		});
		expect(
			await dup(
				feedPosting("Saffron Loop", { locations: ["Remote (Turkey)"] }),
			),
		).toBe(false);
		expect(
			await dup(
				feedPosting("Saffron Loop", {
					workplaceType: "unknown",
					locations: [],
				}),
			),
		).toBe(false);
		// The same vacancy: the feed links the board's own posting.
		expect(
			await dup(
				feedPosting("Saffron Loop", {
					urls: [
						"https://remotive.com/remote-jobs/saffron-loop",
						"https://job-boards.greenhouse.io/x/jobs/502",
					],
				}),
			),
		).toBe(true);
	});

	it("the URL and apply-link checks are unchanged", async () => {
		await board("Lantern Bay", "505", {
			locations: ["Berlin, Germany"],
			workplaceType: "onsite",
		});
		expect(
			await dup(
				feedPosting("Someone Else", {
					urls: [
						"https://news.ycombinator.com/item?id=5",
						"https://job-boards.greenhouse.io/x/jobs/505",
					],
				}),
			),
		).toBe(true);
	});
});

describe("Retry now after a refused read (re-check D)", () => {
	it("keeps the last run but not the refusal it reported", async () => {
		await updateProvider(db, "u1", "remotive", { enabled: true });
		await recordProviderRun(db, "u1", {
			provider: "remotive",
			queries: 0,
			found: 0,
			fetched: 0,
			newJobIds: [],
			pagesRead: 1,
			problem:
				"Paused after: remotive.com refused the request (HTTP 429). Tries again with the first scan after 3 Nov, 16:00.",
		});
		await new SqliteFeedStore(db).stop("u1", "remotive", {
			kind: "blocked",
			reason: "remotive.com refused the request (HTTP 429)",
			at: new Date().toISOString(),
			failures: 1,
			retryAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
		});
		await clearProviderStop(db, "u1", "remotive", { keepLastRun: true });
		const state = (await listProviders(db, "u1")).find(
			(p) => p.provider === "remotive",
		);
		expect(state?.config.stop).toBeUndefined();
		expect(state?.lastRunAt).not.toBeNull();
		expect(state?.lastRun?.problem).toBeUndefined();
		expect(state?.lastRun?.status).toBeUndefined();
		expect(state?.lastRun).toMatchObject({ pagesRead: 1 });
	});
});
