import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import {
	DashboardRepository,
	ensureUser,
	openSqlite,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { applications, companies } from "@offerfinch/db/schema/pipeline";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { firstSearchLine } from "../src/renderer/components/desktop/setup/first-search-line";
import {
	type FoundJob,
	firstSearchRow,
	firstSearchView,
	jobsFoundBy,
} from "../src/worker/first-search";

const found = (over: Partial<FoundJob> = {}): FoundJob => ({
	jobId: "j1",
	applicationId: "a1",
	company: "Northwind Logistics",
	title: "Senior Full-Stack Engineer",
	source: "greenhouse",
	state: "found",
	filterResult: null,
	endedReason: null,
	score: null,
	...over,
});

const reject = {
	decision: "reject" as const,
	summary: "Needs German",
	flags: [],
	reasons: [
		{
			rule: "language" as const,
			outcome: "reject" as const,
			message: "Needs German",
		},
	],
};

describe("first search rows (desktop.scanJobs)", () => {
	it("a job with no application yet, or not checked yet, is found", () => {
		expect(
			firstSearchRow(found({ state: null, applicationId: null }), 50),
		).toMatchObject({
			state: "found",
			reason: null,
			score: null,
			match: false,
		});
		expect(firstSearchRow(found(), 50).state).toBe("found");
	});

	it("a found job with a passing filter result fits the rules", () => {
		const row = firstSearchRow(
			found({
				filterResult: { decision: "keep", summary: "", flags: [], reasons: [] },
			}),
			50,
		);
		expect(row.state).toBe("fits");
	});

	it("a set-aside job carries the first rejecting rule's message, else the summary", () => {
		expect(
			firstSearchRow(
				found({ state: "rejected_by_filter", filterResult: reject }),
				50,
			),
		).toMatchObject({ state: "rejected_by_filter", reason: "Needs German" });
		expect(
			firstSearchRow(
				found({
					state: "rejected_by_filter",
					filterResult: { ...reject, reasons: [], summary: "Internship" },
				}),
				50,
			).reason,
		).toBe("Internship");
	});

	it("scored jobs carry the fit; a match is at or above the minimum; later states count as scored", () => {
		expect(
			firstSearchRow(found({ state: "scored", score: 70 }), 70),
		).toMatchObject({
			state: "scored",
			score: 70,
			match: true,
		});
		expect(
			firstSearchRow(
				found({
					state: "scored",
					score: 64,
					endedReason: "Fit score 64 is below the minimum of 70.",
				}),
				70,
			),
		).toMatchObject({ state: "scored", score: 64, match: false });
		expect(
			firstSearchRow(found({ state: "preparing", score: 91 }), 70),
		).toMatchObject({ state: "scored", match: true });
	});

	it("totals count every job", () => {
		const view = firstSearchView(
			[
				found({ jobId: "1", state: "scored", score: 91 }),
				found({ jobId: "2", state: "scored", score: 40 }),
				found({
					jobId: "3",
					state: "rejected_by_filter",
					filterResult: reject,
				}),
				found({ jobId: "4" }),
			],
			50,
		);
		expect(view.counts).toEqual({
			read: 4,
			found: 1,
			fits: 0,
			setAside: 1,
			scored: 2,
			matches: 1,
		});
		expect(view.rows.map((r) => r.jobId)).toEqual(["1", "2", "3", "4"]);
	});
});

const job = (id: string, title: string): NormalizedJob => ({
	source: "greenhouse",
	externalId: id,
	url: `https://boards.greenhouse.io/acme/jobs/${id}`,
	title,
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "Build things.",
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("the jobs a scan run found", () => {
	it("are the user's jobs created while the run was open, oldest first, with their state", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-first-"));
		const db = openSqlite(path.join(dir, "test.sqlite"));
		await migrate(db);
		await ensureUser(db, { id: "u1", name: "Test", email: "u1@example.test" });
		await seedCompanies(db, "u1", [
			{
				name: "Acme",
				source: "greenhouse",
				sourceKey: "acme",
				discoveredFrom: "t",
			},
		]);
		const [company] = await db
			.select({ id: companies.id })
			.from(companies)
			.where(eq(companies.userId, "u1"));
		const repo = new DashboardRepository(db);
		const add = (id: string, title: string) =>
			repo.upsertJob("u1", company?.id ?? "", job(id, title));
		await add("0", "Seen before");
		await tick();
		const createdAt = new Date();
		await tick();
		const first = await add("1", "Frontend Engineer");
		await tick();
		const second = await add("2", "Platform Engineer");
		await tick();
		const third = await add("3", "Data Engineer");
		const appOf = async (jobId: string) =>
			(await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
		const secondApp = await appOf(second.jobId);
		await repo.saveFilterResult("u1", secondApp, reject);
		await repo.transition("u1", secondApp, {
			from: ["found"],
			to: "rejected_by_filter",
			reason: "Needs German",
			actor: "workflow",
		});
		await db
			.update(applications)
			.set({ state: "scored", score: 82 })
			.where(eq(applications.id, await appOf(third.jobId)));

		const live = firstSearchView(
			await jobsFoundBy(db, { userId: "u1", createdAt, endedAt: null }),
			50,
		);
		expect(live.rows.map((r) => [r.title, r.state, r.reason, r.score])).toEqual(
			[
				["Frontend Engineer", "found", null, null],
				["Platform Engineer", "rejected_by_filter", "Needs German", null],
				["Data Engineer", "scored", null, 82],
			],
		);
		expect(live.counts.matches).toBe(1);
		expect(live.rows[0]?.jobId).toBe(first.jobId);

		// A run that ended keeps only what came in before its end.
		await tick();
		const endedAt = new Date();
		await tick();
		await add("4", "Added later");
		const ended = await jobsFoundBy(db, { userId: "u1", createdAt, endedAt });
		expect(ended.map((j) => j.title)).toEqual([
			"Frontend Engineer",
			"Platform Engineer",
			"Data Engineer",
		]);
		db.$close();
	});
});

describe("the first search's status line", () => {
	const counts = { read: 8, setAside: 3, matches: 3 };
	const progress = {
		status: "running",
		total: 3,
		done: 1,
		unit: "sources" as const,
		source: "Lever",
	};
	const phase = { checking: false, settled: false, fitRules: 5 };

	it("names the source being read while the scan runs", () => {
		expect(firstSearchLine(progress, counts, phase)).toBe(
			"Reading Lever · 2 of 3 sources",
		);
		expect(firstSearchLine(undefined, counts, phase)).toBe("Starting…");
	});

	it("checks, then scores, then sums it up", () => {
		const complete = { ...progress, status: "complete", done: 3 };
		expect(
			firstSearchLine(complete, counts, { ...phase, checking: true }),
		).toBe("8 jobs read. Checking them against your rules…");
		expect(firstSearchLine(complete, counts, phase)).toBe(
			"5 fit your rules. Scoring them…",
		);
		expect(firstSearchLine(complete, counts, { ...phase, settled: true })).toBe(
			"Done: 8 jobs read, 3 set aside, 3 matches. They are waiting in your Inbox.",
		);
		expect(
			firstSearchLine(
				complete,
				{ ...counts, matches: 0 },
				{ ...phase, settled: true },
			),
		).toBe(
			"Done: 8 jobs read, 3 set aside. No matches this time. OfferFinch keeps looking every hour, and new ones show up in the Inbox.",
		);
	});

	it("before the first read of what a finished scan found, says it is checking", () => {
		const complete = { ...progress, status: "complete", done: 3 };
		expect(firstSearchLine(complete, { ...counts, read: 0 }, phase)).toBe(
			"Search done. Checking what it found…",
		);
	});

	it("says why the search stopped", () => {
		expect(
			firstSearchLine(
				{ ...progress, status: "errored", error: "No network" },
				counts,
				phase,
			),
		).toBe("The search stopped: No network");
	});
});
