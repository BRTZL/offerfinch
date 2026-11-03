import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { filterStep } from "@offerfinch/core/pipeline/application-flow";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	DismissalStore,
	ensureLocationDefaults,
	importProfile,
	refilterApplications,
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

async function row(id: string) {
	const [r] = await execute<{
		state: string;
		rank: number | null;
		rank_penalties: string | null;
		filter_result: string | null;
	}>(
		db,
		sql`select state, rank, rank_penalties, filter_result from applications where id = ${id}`,
	);
	return r;
}

describe("location defaults from the profile", () => {
	it("fills I live in, citizenship and right to work from the About location once, keeping the rest", async () => {
		const first = await ensureLocationDefaults(db, "u1");
		expect(first.changed).toBe(true);
		expect(first.settings).toMatchObject({
			livesIn: "Turkey",
			citizenship: ["Turkey"],
			rightToWork: ["Turkey"],
			locationPrefilled: true,
			minScore: 55,
		});
		const again = await ensureLocationDefaults(db, "u1");
		expect(again.changed).toBe(false);
	});
});

describe("re-filter after the job search changes", () => {
	const ids: Record<string, string> = {};

	beforeAll(async () => {
		ids.lockheed = await add({
			company: "lockheed",
			locations: ["Owego, NY"],
			text: LOCKHEED_TEXT,
		});
		ids.seattle = await add({
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
		ids.emea = await add({
			company: "nimbus",
			locations: ["Remote (EMEA)"],
			workplaceType: "remote",
			score: 85,
		});
		// Never touched, though each fails the filter now:
		ids.prepareAsked = await add({
			company: "lockheed",
			locations: ["Fort Worth, TX"],
			extra: { prepare_requested_at: Date.now() },
		});
		ids.inReview = await add({
			company: "lockheed",
			locations: ["Fort Worth, TX"],
			state: "ready_for_review",
		});
		ids.applied = await add({
			company: "lockheed",
			locations: ["Arlington, VA"],
			state: "applied",
		});
		ids.dismissed = await add({
			company: "lockheed",
			locations: ["Arlington, VA"],
			state: "dismissed",
		});
		ids.lowScore = await add({
			company: "lockheed",
			locations: ["Arlington, VA"],
			extra: { ended_reason: "Fit score 20 is below the minimum of 55." },
		});
		ids.chosen = await add({
			company: "lockheed",
			locations: ["Arlington, VA"],
			extra: { chosen_anyway_at: Date.now() },
		});
		ids.manual = await add({
			company: "manual:lumen",
			locations: ["Arlington, VA"],
			source: "manual",
		});
	});

	it("moves found jobs and open matches that now fail to rejected_by_filter, with the reason and an event", async () => {
		const result = await refilterApplications(db, "u1");
		expect(result.checked).toBe(4);
		expect(result.rejected).toBe(2);
		expect(result.events).toHaveLength(2);
		expect((await row(ids.lockheed ?? ""))?.state).toBe("rejected_by_filter");
		expect((await row(ids.seattle ?? ""))?.state).toBe("rejected_by_filter");
		const lockheed = result.decisions.find(
			(d) => d.applicationId === ids.lockheed,
		);
		expect(lockheed?.rejectedBy).toEqual(["citizenship", "location"]);
		expect(lockheed?.summary).toMatch(/Requires United States citizenship/);
		const [transition] = await execute<{
			from_state: string;
			reason: string;
			actor: string;
		}>(
			db,
			sql`select from_state, reason, actor from application_transitions where application_id = ${ids.lockheed} order by created_at desc limit 1`,
		);
		expect(transition).toMatchObject({ from_state: "scored", actor: "system" });
		expect(transition?.reason).toMatch(/your citizenship is Turkey/);
		// Listed among the rejected with the reason (Scans and All › Closed).
		const rejected = await repo.listApplications("u1", {
			states: ["rejected_by_filter"],
		});
		expect(rejected.map((r) => r.id)).toContain(ids.lockheed);
		expect(rejected.find((r) => r.id === ids.lockheed)?.filterSummary).toMatch(
			/citizenship/,
		);
	});

	it("never touches anything past an open match, nor jobs the user added or chose", async () => {
		for (const [key, state] of [
			["prepareAsked", "scored"],
			["inReview", "ready_for_review"],
			["applied", "applied"],
			["dismissed", "dismissed"],
			["lowScore", "scored"],
			["chosen", "scored"],
			["manual", "scored"],
		] as const)
			expect((await row(ids[key] ?? ""))?.state, key).toBe(state);
	});

	it("ranks the matches it keeps: an unclear place below a clear one", async () => {
		const turkey = await row(ids.turkey ?? "");
		const emea = await row(ids.emea ?? "");
		expect(turkey).toMatchObject({ state: "scored", rank: 75 });
		expect(emea?.state).toBe("scored");
		expect(emea?.rank).toBeLessThan(75);
		expect(JSON.parse(emea?.rank_penalties ?? "[]")[0]?.reason).toBe(
			"location unclear",
		);
		const matches = await repo.listApplications("u1", {
			states: ["scored"],
			sort: "fit",
		});
		const order = matches.map((m) => m.id);
		expect(order.indexOf(ids.turkey ?? "")).toBeLessThan(
			order.indexOf(ids.emea ?? ""),
		);
		expect(matches.find((m) => m.id === ids.emea)?.rankReason).toBe(
			"location unclear",
		);
		const detail = await repo.getApplication("u1", ids.emea ?? "");
		expect(detail?.rankPenalties[0]?.reason).toBe("location unclear");
	});

	it("does nothing the second time", async () => {
		const again = await refilterApplications(db, "u1");
		expect(again.rejected).toBe(0);
		expect(again.reranked).toBe(0);
		expect(again.events).toEqual([]);
	});

	it("reads the user's dismissals as ranking signals", async () => {
		const store = new DismissalStore(db);
		await store.dismiss({
			userId: "u1",
			applicationIds: [ids.turkey ?? ""],
			reasons: ["seniority"],
		});
		const signals = await repo.dismissalSignals("u1");
		expect(signals).toEqual([
			{
				companyId: companyIds.nimbus,
				reasons: ["seniority"],
				title: "Software Engineer",
				locationVerdict: "remote_home",
			},
		]);
		// The same company's other open match ranks lower now.
		const result = await refilterApplications(db, "u1");
		expect(result.reranked).toBe(1);
		const emea = await row(ids.emea ?? "");
		expect(JSON.parse(emea?.rank_penalties ?? "[]")[0]?.kind).toBe(
			"dismissed_company",
		);
	});
});

describe("re-filter races (review, 2026-11-03)", () => {
	/** The database, with `before` run once just before the pass's first write transaction. */
	function interleaved(before: () => Promise<void>): Database {
		let fired = false;
		return new Proxy(db, {
			get(target, key) {
				if (key === "transaction")
					return async (fn: Parameters<Database["transaction"]>[0]) => {
						if (!fired) {
							fired = true;
							await before();
						}
						return target.transaction(fn);
					};
				return Reflect.get(target, key);
			},
		});
	}

	beforeAll(async () => {
		await saveFilterSettings(db, "u1", {
			livesIn: "Turkey",
			locationPrefilled: true,
		});
	});

	it("leaves a match the user pressed Prepare on after the pass selected it", async () => {
		const id = await add({ company: "nimbus", locations: ["Berlin"] });
		const result = await refilterApplications(
			interleaved(() =>
				repo.requestPrepare({ userId: "u1", applicationId: id }).then(() => {}),
			),
			"u1",
		);
		expect((await row(id))?.state).toBe("scored");
		expect(result.rejected).toBe(0);
	});

	it("leaves a job the user showed in Matches (chosen) after the pass selected it", async () => {
		const id = await add({ company: "nimbus", locations: ["Berlin"] });
		await refilterApplications(
			interleaved(async () => {
				await db.run(
					sql`update applications set chosen_anyway_at = ${Date.now()} where id = ${id}`,
				);
			}),
			"u1",
		);
		expect((await row(id))?.state).toBe("scored");
	});

	it("lets the newest settings win when a save overlaps a pass", async () => {
		const id = await add({ company: "nimbus", locations: ["Berlin"] });
		let newer: Awaited<ReturnType<typeof refilterApplications>> | undefined;
		const older = await refilterApplications(
			interleaved(async () => {
				// Save B allows office jobs in Germany; its own pass runs to the end.
				await saveFilterSettings(db, "u1", {
					livesIn: "Turkey",
					locationPrefilled: true,
					keepOnsiteIn: ["Germany"],
				});
				newer = await refilterApplications(db, "u1");
			}),
			"u1",
		);
		expect(older.superseded).toBe(true);
		expect(older.rejected).toBe(0);
		expect(newer?.superseded).toBe(false);
		expect((await row(id))?.state).toBe("scored");
	});
});

describe("set aside with older settings, brought back by newer ones (re-check, 2026-11-03)", () => {
	const TURKEY = { livesIn: "Turkey", locationPrefilled: true };
	const GERMANY_TOO = { ...TURKEY, keepOnsiteIn: ["Germany"] };

	beforeEach(async () => {
		// Earlier tests' jobs stay out of each test's counts.
		await db.run(
			sql`update applications set chosen_anyway_at = ${Date.now()} where chosen_anyway_at is null`,
		);
	});

	async function flowRow(id: string) {
		const [r] = await execute<{
			state: string;
			refiltered_with: string | null;
			events: number;
		}>(
			db,
			sql`select state, json_extract(filter_result, '$.refilteredWith') refiltered_with, (select count(*) from workflow_events e where e.application_id = a.id) events from applications a where id = ${id}`,
		);
		return r;
	}

	it("restores a job an overlapping older pass set aside before it was superseded", async () => {
		await saveFilterSettings(db, "u1", TURKEY);
		const first = await add({ company: "nimbus", locations: ["Berlin"] });
		const second = await add({ company: "nimbus", locations: ["Berlin"] });
		let writes = 0;
		const wrapped = new Proxy(db, {
			get(target, key) {
				if (key === "transaction")
					return async (fn: Parameters<Database["transaction"]>[0]) => {
						// After pass A set aside the first job: save B, and B's own pass runs.
						if (++writes === 2) {
							await saveFilterSettings(db, "u1", GERMANY_TOO);
							await refilterApplications(db, "u1");
						}
						return target.transaction(fn);
					};
				return Reflect.get(target, key);
			},
		});
		const older = await refilterApplications(wrapped, "u1");
		expect(older.superseded).toBe(true);
		expect((await row(first))?.state).toBe("scored");
		expect((await row(second))?.state).toBe("scored");
	});

	it("brings a set-aside match back to Matches with an event that starts its run again", async () => {
		await saveFilterSettings(db, "u1", TURKEY);
		const id = await add({ company: "nimbus", locations: ["Berlin"] });
		const first = await refilterApplications(db, "u1");
		expect(first.rejected).toBe(1);
		const stamped = await flowRow(id);
		expect(stamped?.state).toBe("rejected_by_filter");
		expect(stamped?.refiltered_with).toMatch(/^[0-9a-f]{16}$/);

		await saveFilterSettings(db, "u1", GERMANY_TOO);
		const second = await refilterApplications(db, "u1");
		expect(second.restored).toBe(1);
		expect(second.events).toHaveLength(1);
		const restored = await flowRow(id);
		expect(restored).toMatchObject({ state: "scored", refiltered_with: null });
		expect(restored?.events).toBe(2);
		expect((await row(id))?.rank).not.toBeNull();
		const [transition] = await execute<{ to_state: string; reason: string }>(
			db,
			sql`select to_state, reason from application_transitions where application_id = ${id} order by created_at desc limit 1`,
		);
		expect(transition).toMatchObject({
			to_state: "scored",
			reason: "Fits your job search again",
		});
		// Nothing more the next time.
		const third = await refilterApplications(db, "u1");
		expect(third.restored + third.rejected).toBe(0);
	});

	it("brings a job never scored back to found, and its run's filter step goes on to scoring", async () => {
		await saveFilterSettings(db, "u1", TURKEY);
		const id = await add({
			company: "nimbus",
			locations: ["Berlin"],
			state: "found",
		});
		await refilterApplications(db, "u1");
		expect((await row(id))?.state).toBe("rejected_by_filter");
		await saveFilterSettings(db, "u1", GERMANY_TOO);
		const restored = await refilterApplications(db, "u1");
		expect(restored.restored).toBe(1);
		expect((await row(id))?.state).toBe("found");
		// The restarted run: its filter step passes now, so the run scores it next.
		const [job] = await execute<{ job_id: string }>(
			db,
			sql`select job_id from applications where id = ${id}`,
		);
		const step = await filterStep(
			{ repo } as unknown as PipelineDeps,
			"u1",
			job?.job_id ?? "",
		);
		expect(step).toMatchObject({ ended: false });
		expect(step?.result.decision).toBe("keep");
	});

	it("keeps a job set aside when the newer settings still rule it out, stamped with them", async () => {
		await saveFilterSettings(db, "u1", TURKEY);
		const id = await add({ company: "nimbus", locations: ["Seattle, WA"] });
		await refilterApplications(db, "u1");
		const before = await flowRow(id);
		await saveFilterSettings(db, "u1", GERMANY_TOO);
		const result = await refilterApplications(db, "u1");
		expect(result.restored).toBe(0);
		const after = await flowRow(id);
		expect(after?.state).toBe("rejected_by_filter");
		expect(after?.refiltered_with).not.toBe(before?.refiltered_with);
	});

	it("never brings back a job set aside at its first check, or one the user showed in Matches", async () => {
		await saveFilterSettings(db, "u1", TURKEY);
		const firstCheck = await add({
			company: "nimbus",
			locations: ["Berlin"],
			state: "rejected_by_filter",
		});
		const shown = await add({ company: "nimbus", locations: ["Berlin"] });
		await refilterApplications(db, "u1");
		await db.run(
			sql`update applications set chosen_anyway_at = ${Date.now()} where id = ${shown}`,
		);
		await saveFilterSettings(db, "u1", GERMANY_TOO);
		await refilterApplications(db, "u1");
		expect((await row(firstCheck))?.state).toBe("rejected_by_filter");
		expect((await row(shown))?.state).toBe("rejected_by_filter");
	});
});
