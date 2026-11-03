import { FEED_IDS } from "@offerfinch/core/feeds/feeds";
import { nextFeedRead } from "@offerfinch/core/feeds/provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	clearProviderStop,
	DashboardRepository,
	type Database,
	listProviders,
	openSqlite,
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
});
