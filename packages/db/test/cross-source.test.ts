import type { NormalizedJob } from "@offerfinch/core/domain/types";
import type { LinkedInListing } from "@offerfinch/core/linkedin/parse";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	DrizzleLinkedInStore,
	SqliteSearchStore,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;
let search: SqliteSearchStore;
let linkedin: DrizzleLinkedInStore;

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	search = new SqliteSearchStore(db);
	linkedin = new DrizzleLinkedInStore(db);
});
afterAll(() => db.$close());

const posting = (company: string, id: string): NormalizedJob => ({
	source: "greenhouse",
	externalId: id,
	url: `https://boards.greenhouse.io/${company}/jobs/${id}`,
	title: "Frontend Engineer",
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "React.",
});

const listing = (
	jobId: string,
	company: string,
	apply: string,
): LinkedInListing => ({
	jobId,
	title: "Frontend Engineer",
	company,
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "React.",
	easyApply: false,
	externalApplyUrl: apply,
});

const jobsOf = async (like: string) =>
	(
		await execute<{ n: number }>(
			db,
			sql`select count(*) as n from jobs where user_id = 'u1' and (url like ${`%${like}%`} or apply_url like ${`%${like}%`})`,
		)
	)[0]?.n;

/** The same posting found through job-board search and through a LinkedIn listing is one job. */
describe("one job across sources", () => {
	it("search first, then the LinkedIn listing that links to it", async () => {
		const companyId = await search.companyFor("u1", {
			name: "Harbor Mills",
			source: "greenhouse",
			sourceKey: "harbormills",
		});
		expect(
			(await repo.upsertJob("u1", companyId, posting("harbormills", "55")))
				.inserted,
		).toBe(true);
		expect(
			await linkedin.saveListing(
				"u1",
				listing(
					"li-1",
					"Harbor Mills",
					"https://boards.greenhouse.io/harbormills/jobs/55?gh_src=li",
				),
				"https://www.linkedin.com/jobs/view/li-1",
			),
		).toEqual({ outcome: "duplicate", jobId: null });
		expect(await jobsOf("harbormills/jobs/55")).toBe(1);
	});

	it("the LinkedIn listing first, then search finds the board posting it links to", async () => {
		expect(
			await linkedin.saveListing(
				"u1",
				listing(
					"li-2",
					"Lumen Labs",
					"https://boards.greenhouse.io/lumen/jobs/66?gh_src=li",
				),
				"https://www.linkedin.com/jobs/view/li-2",
			),
		).toMatchObject({ outcome: "inserted" });
		const companyId = await search.companyFor("u1", {
			name: "Lumen",
			source: "greenhouse",
			sourceKey: "lumen",
		});
		expect(
			(await repo.upsertJob("u1", companyId, posting("lumen", "66"))).inserted,
		).toBe(false);
		expect(await jobsOf("lumen/jobs/66")).toBe(1);
		// And search will not read the board for it again.
		expect(await search.hasPosting("u1", "greenhouse", "55")).toBe(true);
	});
});
