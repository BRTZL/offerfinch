import { parseFilterSettings } from "@offerfinch/core/filter/settings";
import { searchKey } from "@offerfinch/core/search/plan";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type Database,
	DrizzleLinkedInStore,
	listProviders,
	retirePerSourceSettings,
	SqliteSearchPlanStore,
	saveFilterSettings,
	updateProvider,
} from "../src/index";
import { linkedinSettings } from "../src/schema/pipeline";
import { testDb } from "./setup";

let db: Database;

beforeAll(async () => {
	db = await testDb();
	await saveFilterSettings(
		db,
		"u1",
		parseFilterSettings({
			livesIn: "Poland",
			searchTitles: ["Frontend Engineer"],
		}),
	);
});

afterAll(async () => {
	db.$close();
});

describe("the search plan's store", () => {
	it("keeps the model's plan and the user's own searches, and adds or removes only theirs", async () => {
		const store = new SqliteSearchPlanStore(db);
		expect(await store.plan("u1")).toEqual({
			ai: [],
			user: [],
			basis: null,
			generatedAt: null,
		});
		await store.savePlan("u1", {
			ai: [{ keywords: "React Engineer", where: "remote-worldwide" }],
			user: [],
			basis: "ai",
			generatedAt: "2026-11-03T10:00:00.000Z",
		});
		expect(
			await store.addUserSearch("u1", {
				keywords: "site:x.com Go Engineer",
				where: "remote-in-country",
			}),
		).toBe(true);
		// The same search again is not added twice; words alone are no search.
		expect(
			await store.addUserSearch("u1", {
				keywords: "Go Engineer",
				where: "remote-in-country",
			}),
		).toBe(false);
		expect(
			await store.addUserSearch("u1", { keywords: "!", where: "onsite" }),
		).toBe(false);
		const plan = await store.plan("u1");
		expect(plan.user).toEqual([
			{ keywords: "Go Engineer", where: "remote-in-country", place: "Poland" },
		]);
		expect(plan.ai).toHaveLength(1);
		expect(plan.generatedAt).toBe("2026-11-03T10:00:00.000Z");
		expect(
			await store.removeUserSearch("u1", searchKey(plan.user[0] as never)),
		).toBe(true);
		expect((await store.plan("u1")).user).toEqual([]);
		expect((await store.plan("u1")).ai).toHaveLength(1);
	});
});

describe("per-source settings of earlier versions", () => {
	it("moves LinkedIn's custom searches and web search's own into the plan, says what it can't move, and runs once", async () => {
		await db.insert(linkedinSettings).values({
			userId: "u1",
			searchUrls: [
				"https://www.linkedin.com/jobs/search/?keywords=Go%20Engineer&location=Poland&f_WT=2",
				"https://www.linkedin.com/jobs/search/?keywords=Platform%20Engineer&location=Berlin&f_WT=1%2C3",
				"https://www.linkedin.com/jobs/collections/recommended/",
			],
			dailyPageCap: 30,
		});
		await new DrizzleLinkedInStore(db).block("u1", {
			kind: "captcha",
			reason: "check",
		});
		await updateProvider(db, "u1", "web-search", {
			enabled: true,
			config: {
				stop: {
					kind: "captcha",
					reason: "DuckDuckGo's bot check",
					at: "2026-11-02T10:00:00.000Z",
				},
				queries: {
					ai: ["frontend engineer remote"],
					user: ["design engineer remote Europe", "go engineer remote"],
					removed: [],
					generatedAt: "2026-11-02T10:00:00.000Z",
				},
			},
		});
		const first = await retirePerSourceSettings(db);
		expect(first).toEqual({
			linkedinSearches: 2,
			webSearches: 2,
			notMoved: ["https://www.linkedin.com/jobs/collections/recommended/"],
			dropped: ["LinkedIn's page cap and gaps"],
		});
		const plan = await new SqliteSearchPlanStore(db).plan("u1");
		expect(plan.user).toEqual([
			{ keywords: "Go Engineer", where: "remote-in-country", place: "Poland" },
			{ keywords: "Platform Engineer", where: "onsite", place: "Berlin" },
			{ keywords: "design engineer Europe", where: "remote-worldwide" },
			{ keywords: "go engineer", where: "remote-worldwide" },
		]);
		// The stops stay (state, not settings); the old searches and queries are gone.
		const [row] = await db
			.select()
			.from(linkedinSettings)
			.where(eq(linkedinSettings.userId, "u1"));
		expect(row).toMatchObject({
			searchUrls: [],
			dailyPageCap: 15,
			blockedKind: "captcha",
		});
		const web = (await listProviders(db, "u1")).find(
			(p) => p.provider === "web-search",
		);
		expect(web).toMatchObject({
			enabled: true,
			config: { stop: { kind: "captcha" } },
		});
		expect(web?.config).not.toHaveProperty("queries");
		// Once only.
		expect(await retirePerSourceSettings(db)).toEqual({
			linkedinSearches: 0,
			webSearches: 0,
			notMoved: [],
			dropped: [],
		});
	});
});

describe("LinkedIn's pace in the database", () => {
	it("knows the last read (not a linked job) and the pages of the window, oldest first", async () => {
		const clock = { now: new Date("2026-11-03T08:00:00Z") };
		const store = new DrizzleLinkedInStore(db, () => clock.now);
		await store.clear("u1");
		const scan = await store.startRun("u1", "scan");
		await store.reservePage("u1", scan);
		clock.now = new Date("2026-11-03T09:00:00Z");
		const link = await store.startRun("u1", "link");
		await store.reservePage("u1", link);
		expect(await store.lastReadAt("u1")).toEqual(
			new Date("2026-11-03T08:00:00Z"),
		);
		expect(
			await store.pagesSince("u1", new Date("2026-11-03T00:00:00Z")),
		).toEqual([
			new Date("2026-11-03T08:00:00Z"),
			new Date("2026-11-03T09:00:00Z"),
		]);
		// The cap is core's 10 a day, whatever an earlier version stored.
		for (let i = 0; i < 8; i++)
			expect(await store.reservePage("u1", scan)).toEqual({ ok: true });
		expect(await store.reservePage("u1", scan)).toEqual({
			ok: false,
			reason: "cap",
			cap: 10,
		});
	});
});
