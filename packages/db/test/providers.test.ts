import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type Database,
	DrizzlePipelineRepository,
	listProviders,
	providerCursor,
	recordProviderRun,
	retireSearchBackends,
	SqliteSiteStore,
	SqliteWebStore,
	updateProvider,
} from "../src/index";
import { testDb } from "./setup";

let db: Database;

beforeAll(async () => {
	db = await testDb();
});

afterAll(async () => {
	db.$close();
});

describe("source settings", () => {
	it("drops the Brave Search and SearXNG choice of earlier versions, keeping on or off", async () => {
		await updateProvider(db, "u1", "job-board-search", {
			enabled: false,
			config: { backend: "searxng", searxngUrl: "http://localhost:8888" },
		});
		expect(await retireSearchBackends(db)).toBe(1);
		const state = (await listProviders(db, "u1")).find(
			(p) => p.provider === "job-board-search",
		);
		expect(state).toMatchObject({ enabled: false, config: {} });
		// Once only.
		expect(await retireSearchBackends(db)).toBe(0);
	});

	it("keeps a site's stop record as the run made it, and lifts it when a run reads the site again", async () => {
		const store = new SqliteSiteStore(db);
		const record = {
			kind: "selectors" as const,
			reason: "x",
			selector: "cardTitle" as const,
			at: "2026-11-02T10:00:00.000Z",
			failures: 2,
			retryAt: "2026-11-02T11:59:00.000Z",
		};
		await store.stop("u1", "indeed", record);
		expect(await store.stopped("u1", "indeed")).toEqual(record);
		await store.clearStop("u1", "indeed");
		expect(await store.stopped("u1", "indeed")).toBeNull();
	});
});

describe("a source's cursor in its searches", () => {
	it("starts where the last run that got through searches ended, and stays after one that got through none", async () => {
		const run = {
			provider: "indeed",
			queries: 1,
			found: 0,
			fetched: 0,
			newJobIds: [],
		};
		expect(await providerCursor(db, "u1", "indeed")).toBe(0);
		await recordProviderRun(db, "u1", { ...run, cursor: 2 });
		expect(await providerCursor(db, "u1", "indeed")).toBe(2);
		await recordProviderRun(db, "u1", { ...run, cursor: 3 });
		expect(await providerCursor(db, "u1", "indeed")).toBe(3);
		// Held before its first search: no cursor, the next run starts at the same place.
		await recordProviderRun(db, "u1", { ...run, problem: "Stopped: x" });
		expect(await providerCursor(db, "u1", "indeed")).toBe(3);
		// Each source has its own.
		expect(await providerCursor(db, "u1", "glassdoor")).toBe(0);
	});
});

describe("web search's store", () => {
	it("is off until the user turns it on", async () => {
		const state = (await listProviders(db, "u1")).find(
			(p) => p.provider === "web-search",
		);
		expect(state?.enabled).toBe(false);
	});

	it("knows a job stored from any source: by URL, apply link, or company and title; and a removed company", async () => {
		const store = new SqliteWebStore(db);
		const repo = new DrizzlePipelineRepository(db);
		const companyId = await store.companyFor("u1", {
			name: "Harbor Mills",
			source: "greenhouse",
			sourceKey: "harbormills",
		});
		await repo.upsertJob("u1", companyId, {
			source: "greenhouse",
			externalId: "42",
			url: "https://boards.greenhouse.io/harbormills/jobs/42",
			applyUrl: "https://careers.harbormills.example/apply/42",
			title: "Senior Frontend Engineer",
			locations: [],
			workplaceType: "remote",
			descriptionText: "x",
		});
		const dup = (urls: string[], company: string, title: string) =>
			store.isDuplicate("u1", { urls, company, title });
		expect(
			await dup(
				["https://www.boards.greenhouse.io/harbormills/jobs/42/?utm_source=x"],
				"Other",
				"Other",
			),
		).toBe(true);
		expect(
			await dup(
				["https://careers.harbormills.example/apply/42"],
				"Other",
				"Other",
			),
		).toBe(true);
		expect(
			await dup(
				["https://elsewhere.example/1"],
				"Harbor Mills Inc.",
				"Senior Frontend Engineer",
			),
		).toBe(true);
		expect(
			await dup(
				["https://elsewhere.example/1"],
				"Harbor Mills",
				"Backend Engineer",
			),
		).toBe(false);
		await store.companyFor("u1", {
			name: "Gone Co",
			source: "web",
			sourceKey: "web:goneco",
		});
		db.$client
			.prepare("update companies set status = 'removed' where name = 'Gone Co'")
			.run();
		expect(await dup(["https://gone.example/1"], "Gone Co", "Anything")).toBe(
			true,
		);
	});
});
