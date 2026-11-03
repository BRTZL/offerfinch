import type { FilterResult } from "@offerfinch/core/filter/rules";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	DismissalStore,
	seedCompanies,
} from "../src/index";
import { refilterApplications } from "../src/job-search";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;
let store: DismissalStore;
let companyId = "";
let n = 0;

const SET_ASIDE: FilterResult = {
	decision: "reject",
	summary: "Outside your job search",
	flags: [],
	reasons: [
		{ rule: "language", outcome: "pass", message: "English" },
		{
			rule: "work_permit",
			outcome: "reject",
			message: "Needs US citizenship",
		},
	],
} as FilterResult;

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	store = new DismissalStore(db);
	await seedCompanies(db, "u1", [
		{
			name: "Northwind",
			source: "greenhouse",
			sourceKey: "northwind",
			discoveredFrom: "t",
		},
	]);
	const [c] = await execute<{ id: string }>(
		db,
		sql`select id from companies where source_key = 'northwind'`,
	);
	companyId = c?.id ?? "";
});
afterAll(() => db.$close());

/** A job the filter set aside: after a score (the re-filter) or at its first check. */
async function setAside(scored: boolean): Promise<string> {
	n += 1;
	const { jobId } = await repo.upsertJob("u1", companyId, {
		source: "greenhouse",
		externalId: `na-${n}`,
		url: `https://jobs.example/northwind/${n}`,
		title: `Engineer ${n}`,
		locations: ["Remote - US"],
		workplaceType: "remote",
		descriptionText: "React",
	});
	const id = (await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
	if (scored)
		await repo.transition("u1", id, {
			from: ["found"],
			to: "scored",
			reason: "Fit score 80",
			actor: "workflow",
		});
	await execute(
		db,
		sql`update applications set state = 'rejected_by_filter', filter_decision = 'reject', filter_result = ${JSON.stringify(SET_ASIDE)}, score = ${scored ? 80 : null} where id = ${id}`,
	);
	return id;
}

const row = async (id: string) =>
	(
		await execute<{
			state: string;
			chosen_anyway_at: number | null;
			ended_reason: string | null;
		}>(
			db,
			sql`select state, chosen_anyway_at, ended_reason from applications where id = ${id}`,
		)
	)[0];

const events = async (id: string) =>
	(
		await execute<{ n: number }>(
			db,
			sql`select count(*) n from workflow_events where application_id = ${id}`,
		)
	)[0]?.n;

describe("jobs the job filter set aside, in the Inbox", () => {
	it("are listed and counted in Closed and All, with the filter's reason", async () => {
		const id = await setAside(true);
		const counts = await repo.inboxCounts("u1");
		for (const view of ["closed", "all"] as const) {
			const rows = await repo.listApplications("u1", { view, limit: 500 });
			expect(rows.length).toBe(counts[view]);
			expect(rows.find((r) => r.id === id)).toMatchObject({
				state: "rejected_by_filter",
				filterReason: "Needs US citizenship",
			});
		}
		const matches = await repo.listApplications("u1", { view: "matches" });
		expect(matches.some((r) => r.id === id)).toBe(false);
	});

	it("Show in Matches brings a set-aside match back, and the re-filter leaves it alone", async () => {
		const id = await setAside(true);
		const shown = await store.showInMatches({
			userId: "u1",
			applicationId: id,
		});
		expect(shown.state).toBe("scored");
		expect(shown.event?.instanceId).toMatch(/^job-/);
		const after = await row(id);
		expect(after?.state).toBe("scored");
		expect(after?.chosen_anyway_at).not.toBeNull();
		expect(await repo.chosenAnyway("u1", id)).toBe(true);
		const matches = await repo.listApplications("u1", { view: "matches" });
		expect(matches.some((r) => r.id === id)).toBe(true);

		// The next re-filter does not even look at it.
		const refiltered = await refilterApplications(db, "u1");
		expect(refiltered.decisions.some((d) => d.applicationId === id)).toBe(
			false,
		);
		expect((await row(id))?.state).toBe("scored");
	});

	it("a job set aside at its first check goes back to be scored, and nothing else can be shown", async () => {
		const id = await setAside(false);
		const shown = await store.showInMatches({
			userId: "u1",
			applicationId: id,
		});
		expect(shown.state).toBe("found");
		expect((await row(id))?.state).toBe("found");
		expect(await repo.chosenAnyway("u1", id)).toBe(true);
		// Another user cannot, nor on one already shown.
		await expect(
			store.showInMatches({ userId: "u2", applicationId: id }),
		).rejects.toThrow(/only a job the job filter set aside/);
		const other = await setAside(true);
		await expect(
			store.showInMatches({ userId: "u2", applicationId: other }),
		).rejects.toThrow(/only a job the job filter set aside/);
	});

	it("a repeat Show in Matches (a retry after a lost response) succeeds and changes nothing", async () => {
		const scored = await setAside(true);
		await store.showInMatches({ userId: "u1", applicationId: scored });
		const before = await events(scored);
		const again = await store.showInMatches({
			userId: "u1",
			applicationId: scored,
		});
		expect(again).toEqual({ state: "scored", event: null });
		expect(await events(scored)).toBe(before);
		expect((await row(scored))?.state).toBe("scored");

		// Never scored: back in found; scored by its run later, a repeat still succeeds.
		const fresh = await setAside(false);
		await store.showInMatches({ userId: "u1", applicationId: fresh });
		expect(
			await store.showInMatches({ userId: "u1", applicationId: fresh }),
		).toEqual({ state: "found", event: null });
		await repo.transition("u1", fresh, {
			from: ["found"],
			to: "scored",
			reason: "Fit score 70",
			actor: "workflow",
		});
		expect(
			await store.showInMatches({ userId: "u1", applicationId: fresh }),
		).toEqual({ state: "scored", event: null });

		// Unrelated states are still refused: moved on past a match, or a match never set aside
		// (even one chosen anyway some other way).
		await repo.transition("u1", scored, {
			from: ["scored"],
			to: "preparing",
			reason: "Prepare",
			actor: "workflow",
		});
		await expect(
			store.showInMatches({ userId: "u1", applicationId: scored }),
		).rejects.toThrow(/only a job the job filter set aside/);
		n += 1;
		const { jobId } = await repo.upsertJob("u1", companyId, {
			source: "greenhouse",
			externalId: `plain-${n}`,
			url: `https://jobs.example/northwind/plain-${n}`,
			title: "Plain match",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "React",
		});
		const plain =
			(await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
		await repo.transition("u1", plain, {
			from: ["found"],
			to: "scored",
			reason: "Fit score 80",
			actor: "workflow",
		});
		await execute(
			db,
			sql`update applications set chosen_anyway_at = ${Date.now()} where id = ${plain}`,
		);
		await expect(
			store.showInMatches({ userId: "u1", applicationId: plain }),
		).rejects.toThrow(/only a job the job filter set aside/);
	});
});
