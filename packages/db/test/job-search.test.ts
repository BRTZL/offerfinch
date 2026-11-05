import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	DismissalStore,
	ensureLocationDefaults,
	importProfile,
	saveFilterSettings,
	seedCompanies,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;
const companyIds: Record<string, string> = {};
let n = 0;

const LOCKHEED_TEXT =
	"Build mission software. Must be a US Citizen; this position will require a DoD government security clearance.";
const WEB_TEXT =
	"Build web products with TypeScript and React. 3+ years of experience.";

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	await seedCompanies(db, "u1", [
		{
			name: "Lockheed Martin",
			source: "greenhouse",
			sourceKey: "lockheed",
			discoveredFrom: "t",
		},
		{
			name: "Nimbus",
			source: "greenhouse",
			sourceKey: "nimbus",
			discoveredFrom: "t",
		},
		{
			name: "Lumen",
			source: "manual",
			sourceKey: "manual:lumen",
			discoveredFrom: "t",
		},
	]);
	for (const row of await execute<{ id: string; source_key: string }>(
		db,
		sql`select id, source_key from companies where user_id = 'u1'`,
	))
		companyIds[row.source_key] = row.id;
	await importProfile(
		db,
		"u1",
		{
			files: [
				{
					path: "personal.md",
					content:
						"# Personal\n\n- **Name:** Test Person\n- **Location:** Izmir, Turkey (GMT+3)\n",
				},
				{
					path: "experience/a.md",
					content:
						"# Nimbus — Engineer\n\n- **Dates:** Jan 2019 – Present\n- **Location:** Remote\n\nReact and TypeScript web apps.\n",
				},
			],
		},
		"test",
	);
	// An older install: free-text right to work, nothing about where the user lives.
	await saveFilterSettings(db, "u1", {
		rightToWork: ["Türkiye"],
		minScore: 55,
	});
});
afterAll(() => db.$close());

async function add(input: {
	company: string;
	title?: string;
	locations: string[];
	workplaceType?: NormalizedJob["workplaceType"];
	text?: string;
	state?: string;
	score?: number;
	source?: NormalizedJob["source"];
	extra?: Record<string, unknown>;
}): Promise<string> {
	n += 1;
	const { jobId } = await repo.upsertJob(
		"u1",
		companyIds[input.company] ?? "",
		{
			source: input.source ?? "greenhouse",
			externalId: `job-${n}`,
			url: `https://jobs.example/${n}`,
			title: input.title ?? "Software Engineer",
			locations: input.locations,
			workplaceType: input.workplaceType ?? "unknown",
			descriptionText: input.text ?? WEB_TEXT,
		},
	);
	const app = await repo.getApplicationByJob("u1", jobId);
	if (!app) throw new Error("no application");
	const state = input.state ?? "scored";
	await db.run(
		sql`update applications set state = ${state}, score = ${input.score ?? (state === "found" ? null : 80)} where id = ${app.applicationId}`,
	);
	for (const [column, value] of Object.entries(input.extra ?? {}))
		await db.run(
			sql`update applications set ${sql.identifier(column)} = ${value} where id = ${app.applicationId}`,
		);
	return app.applicationId;
}

describe("location defaults from the profile", () => {
	it("fills I live in, citizenship and right to work from the About location once, keeping the rest", async () => {
		const first = await ensureLocationDefaults(db, "u1");
		expect(first.changed).toBe(true);
		expect(first.settings).toMatchObject({
			livesIn: "Türkiye",
			citizenship: ["Türkiye"],
			rightToWork: ["Türkiye"],
			locationPrefilled: true,
			minScore: 55,
		});
		const again = await ensureLocationDefaults(db, "u1");
		expect(again.changed).toBe(false);
	});
});

describe("saving Job search (no re-filter, no re-score)", () => {
	const ids: Record<string, string> = {};
	const snapshot = () =>
		execute<Record<string, unknown>>(
			db,
			sql`select id, state, score, rank, rank_penalties, filter_result, ended_reason, fit, state_changed_at from applications where user_id = 'u1' order by id`,
		);

	beforeAll(async () => {
		ids.lockheed = await add({
			company: "lockheed",
			locations: ["Owego, NY"],
			text: LOCKHEED_TEXT,
		});
		ids.found = await add({
			company: "nimbus",
			locations: ["Seattle, WA"],
			state: "found",
		});
		ids.turkey = await add({
			company: "nimbus",
			locations: ["Remote – Turkey"],
			workplaceType: "remote",
			score: 75,
		});
		ids.inReview = await add({
			company: "lockheed",
			locations: ["Fort Worth, TX"],
			state: "ready_for_review",
		});
		// Set aside by the job filter in an older version: it stays, readable, with its reason.
		ids.setAside = await add({
			company: "lockheed",
			locations: ["Arlington, VA"],
			state: "rejected_by_filter",
			extra: {
				filter_decision: "reject",
				filter_result: JSON.stringify({
					decision: "reject",
					summary:
						"Requires United States citizenship; your citizenship is Türkiye.",
					reasons: [
						{
							rule: "citizenship",
							outcome: "reject",
							message:
								"Requires United States citizenship; your citizenship is Türkiye.",
						},
					],
					flags: [],
					refilteredWith: "0123456789abcdef",
				}),
			},
		});
	});

	it("touches no job already here, whatever the new settings say", async () => {
		const before = await snapshot();
		// Settings that the old filter would have used to set most of these aside, then back.
		await saveFilterSettings(db, "u1", {
			livesIn: "Japan",
			rightToWork: ["Japan"],
			keepRemoteFromHome: false,
			keepGlobalRemote: false,
			minScore: 90,
			seniority: ["Staff"],
			avoidIndustries: ["Defense"],
		});
		await saveFilterSettings(db, "u1", {
			rightToWork: ["Türkiye"],
			minScore: 55,
		});
		expect(await snapshot()).toEqual(before);
		const events = await execute<{ n: number }>(
			db,
			sql`select count(*) n from workflow_events where user_id = 'u1'`,
		);
		expect(events[0]?.n).toBe(0);
	});

	it("keeps a job the old filter set aside listed, with its reason", async () => {
		const rejected = await repo.listApplications("u1", {
			states: ["rejected_by_filter"],
		});
		expect(rejected.map((r) => r.id)).toEqual([ids.setAside]);
		expect(rejected[0]?.filterSummary).toMatch(/your citizenship is Türkiye/);
	});

	it("reads the user's dismissals as ranking signals", async () => {
		const store = new DismissalStore(db);
		await store.dismiss({
			userId: "u1",
			applicationIds: [ids.turkey ?? ""],
			reasons: ["seniority"],
		});
		expect(await repo.dismissalSignals("u1")).toEqual([
			{
				companyId: companyIds.nimbus,
				reasons: ["seniority"],
				title: "Software Engineer",
			},
		]);
	});
});
