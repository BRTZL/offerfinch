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

describe("the same role from a feed and from a board is one job, in either order (review #7)", () => {
	const job = (
		source: "remotive" | "greenhouse" | "lever",
		id: string,
		over: Partial<NormalizedJob> = {},
	): NormalizedJob => ({
		source,
		externalId: id,
		url: `https://${source}.example/jobs/${id}`,
		title: "Platform Engineer",
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "Run the platform.",
		...over,
	});
	const company = (
		name: string,
		source: "remotive" | "greenhouse" | "lever",
		key: string,
	) =>
		new SqliteFeedStore(db).companyFor("u1", { name, source, sourceKey: key });

	it("feed first, then the board", async () => {
		const repo = new DashboardRepository(db);
		const feed = await repo.upsertJob(
			"u1",
			await company("Orchid Grid", "remotive", "remotive:orchidgrid"),
			job("remotive", "r-1"),
		);
		const board = await repo.upsertJob(
			"u1",
			await company("Orchid Grid", "greenhouse", "orchidgrid"),
			job("greenhouse", "g-1", { title: "Platform engineer" }),
		);
		expect(board).toEqual({ jobId: feed.jobId, inserted: false });
	});

	it("board first, then the feed", async () => {
		const repo = new DashboardRepository(db);
		const board = await repo.upsertJob(
			"u1",
			await company("Saffron Loop", "lever", "saffronloop"),
			job("lever", "l-1"),
		);
		const feed = await repo.upsertJob(
			"u1",
			await company("Saffron Loop", "remotive", "remotive:saffronloop"),
			job("remotive", "r-2"),
		);
		expect(feed).toEqual({ jobId: board.jobId, inserted: false });
	});

	it("conservative: an office posting, or two board postings, with that title stay apart", async () => {
		const repo = new DashboardRepository(db);
		const office = await repo.upsertJob(
			"u1",
			await company("Juniper Mesa", "greenhouse", "junipermesa"),
			job("greenhouse", "g-10", {
				locations: ["Berlin, Germany"],
				workplaceType: "onsite",
			}),
		);
		const feed = await repo.upsertJob(
			"u1",
			await company("Juniper Mesa", "remotive", "remotive:junipermesa"),
			job("remotive", "r-10"),
		);
		expect(feed.inserted).toBe(true);
		expect(feed.jobId).not.toBe(office.jobId);
		const second = await repo.upsertJob(
			"u1",
			await company("Juniper Mesa", "lever", "junipermesa"),
			job("lever", "l-10", {
				locations: ["Munich, Germany"],
				workplaceType: "onsite",
			}),
		);
		// Neither from a feed: two boards' postings are not merged by their title.
		expect(second.inserted).toBe(true);
	});
});
