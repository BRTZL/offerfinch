import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { applicationInstanceId } from "@offerfinch/core/workflow/types";
import {
	DashboardRepository,
	ensureUser,
	openSqlite,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { flowRuns } from "@offerfinch/db/schema/jobs";
import {
	applications,
	companies,
	scanRuns,
} from "@offerfinch/db/schema/pipeline";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type FoundRow,
	newRowBeats,
	shownRowsAt,
} from "../src/renderer/components/desktop/setup/first-search-beats";
import {
	firstSearchLine,
	firstSearchSettle,
	PAUSED_POLL_MS,
	POLL_MS,
} from "../src/renderer/components/desktop/setup/first-search-line";
import {
	FIRST_SEARCH_MAX_ROWS,
	type FoundJob,
	firstSearchRow,
	firstSearchView,
	jobsFoundBy,
} from "../src/worker/first-search";
import { scanRunRepo } from "../src/worker/scan-history";

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
			paused: 0,
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

async function setupDb() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-first-"));
	const db = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	for (const id of ["u1", "u2"])
		await ensureUser(db, { id, name: "Test", email: `${id}@example.test` });
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
	const run = { id: "scan-u1-manual-1", userId: "u1" };
	// The repository the scan run uses: each job it inserts is recorded as the run's.
	const scanRepo = scanRunRepo(repo, db, run);
	const add = (
		id: string,
		title: string,
		via: Pick<typeof repo, "upsertJob"> = scanRepo,
	) => via.upsertJob("u1", company?.id ?? "", job(id, title));
	const appOf = async (jobId: string) =>
		(await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
	return { db, repo, run, add, appOf };
}

describe("the jobs a scan run found", () => {
	it("are the jobs the scan inserted, oldest first, with their state; not a job added by link meanwhile", async () => {
		const { db, repo, run, add, appOf } = await setupDb();
		await add("0", "Seen before", repo);
		await add("0", "Seen before");
		await tick();
		const first = await add("1", "Frontend Engineer");
		await tick();
		const second = await add("2", "Platform Engineer");
		await tick();
		// Added by link while the scan runs: through another repository, not the scan's.
		await add("9", "Added by link", repo);
		await tick();
		const third = await add("3", "Data Engineer");
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

		const live = firstSearchView(await jobsFoundBy(db, run), 50);
		expect(live.rows.map((r) => [r.title, r.state, r.reason, r.score])).toEqual(
			[
				["Frontend Engineer", "found", null, null],
				["Platform Engineer", "rejected_by_filter", "Needs German", null],
				["Data Engineer", "scored", null, 82],
			],
		);
		expect(live.counts.matches).toBe(1);
		expect(live.rows[0]?.jobId).toBe(first.jobId);
		// Another user's lookup of the same run finds nothing.
		expect(await jobsFoundBy(db, { ...run, userId: "u2" })).toEqual([]);
		db.$close();
	});

	it("a run from before the table reads its sources' new jobs", async () => {
		const { db, repo, add } = await setupDb();
		const a = await add("1", "Frontend Engineer", repo);
		await tick();
		const b = await add("2", "Platform Engineer", repo);
		await db.insert(scanRuns).values({
			userId: "u1",
			trigger: "manual",
			flowRunId: "scan-old",
			sources: [
				{ newJobIds: [a.jobId] },
				{ newJobIds: [b.jobId, a.jobId] },
			] as unknown as (typeof scanRuns.$inferInsert)["sources"],
		});
		const old = await jobsFoundBy(db, { id: "scan-old", userId: "u1" });
		expect(old.map((j) => j.title)).toEqual([
			"Frontend Engineer",
			"Platform Engineer",
		]);
		db.$close();
	});

	it("reads only this user's application of a job (another user's on the same job is ignored)", async () => {
		const { db, run, add, appOf } = await setupDb();
		const one = await add("1", "Frontend Engineer");
		await db
			.update(applications)
			.set({ state: "scored", score: 40 })
			.where(eq(applications.id, await appOf(one.jobId)));
		// A schema-valid application of another user on the same job.
		await db
			.insert(applications)
			.values({ userId: "u2", jobId: one.jobId, state: "scored", score: 99 });
		const mine = await jobsFoundBy(db, run);
		expect(mine).toHaveLength(1);
		expect(mine[0]?.score).toBe(40);
		expect(firstSearchView(mine, 50).counts.matches).toBe(0);
		db.$close();
	});

	it("a job whose scoring paused is paused, with the pause's reason, until its run is queued again", async () => {
		const { db, repo, run, add, appOf } = await setupDb();
		const one = await add("1", "Frontend Engineer");
		await repo.saveFilterResult("u1", await appOf(one.jobId), {
			decision: "keep",
			summary: "",
			flags: [],
			reasons: [],
		});
		const message =
			"Subscription paused (usage_limit, fake-subscription): the fake plan's usage limit is reached.";
		await db.insert(flowRuns).values({
			id: applicationInstanceId(one.jobId),
			userId: "u1",
			kind: "application",
			params: { userId: "u1", jobId: one.jobId },
			status: "complete",
			runAfter: new Date(),
			result: JSON.stringify({
				outcome: "paused",
				state: "found",
				waitingFor: message,
			}),
		});
		const view = firstSearchView(await jobsFoundBy(db, run), 50);
		expect(view.rows[0]).toMatchObject({ state: "fits", paused: true });
		expect(view.counts.paused).toBe(1);
		// Without the prefix, as a sentence of its own.
		expect(view.pausedFor).toBe("The fake plan's usage limit is reached.");
		// Resumed: its run is queued again.
		await db
			.update(flowRuns)
			.set({ status: "queued" })
			.where(eq(flowRuns.id, applicationInstanceId(one.jobId)));
		const resumed = firstSearchView(await jobsFoundBy(db, run), 50);
		expect(resumed.counts.paused).toBe(0);
		expect(resumed.pausedFor).toBeNull();
		db.$close();
	});
});

describe("the row cap", () => {
	const aside = (i: number) =>
		found({
			jobId: `r${i}`,
			state: "rejected_by_filter",
			filterResult: reject,
		});

	it("keeps a match found after 300 set-aside jobs, and counts no active job as hidden", () => {
		const view = firstSearchView(
			[
				...Array.from({ length: FIRST_SEARCH_MAX_ROWS }, (_, i) => aside(i)),
				found({ jobId: "m", state: "scored", score: 90 }),
			],
			50,
		);
		expect(view.rows).toHaveLength(FIRST_SEARCH_MAX_ROWS);
		expect(view.rows.at(-1)).toMatchObject({ jobId: "m", match: true });
		// The latest set-aside jobs fill the rest, in found order.
		expect(view.rows[0]?.jobId).toBe("r1");
		expect(view.hidden).toBe(0);
		expect(view.counts).toMatchObject({ matches: 1, setAside: 300, read: 301 });
	});

	it("prefers active jobs over set-aside ones once the cap binds, and counts the active ones left out", () => {
		const view = firstSearchView(
			[
				aside(0),
				...Array.from({ length: FIRST_SEARCH_MAX_ROWS + 5 }, (_, i) =>
					found({ jobId: `a${i}` }),
				),
			],
			50,
		);
		expect(view.rows.every((r) => r.state !== "rejected_by_filter")).toBe(true);
		expect(view.rows).toHaveLength(FIRST_SEARCH_MAX_ROWS);
		expect(view.hidden).toBe(5);
	});
});

describe("when the first search is settled", () => {
	const base = {
		status: "complete",
		pending: 0,
		paused: 0,
		jobsAt: 2,
		scoringAt: 1,
	};

	it("settles once the scan is done, nothing is pending or paused, and the jobs were read after", () => {
		expect(firstSearchSettle(base)).toEqual({
			settled: true,
			paused: false,
			pollMs: false,
		});
		expect(firstSearchSettle({ ...base, jobsAt: 1, scoringAt: 2 })).toEqual({
			settled: false,
			paused: false,
			pollMs: POLL_MS,
		});
		expect(firstSearchSettle({ ...base, pending: 2 }).settled).toBe(false);
		expect(firstSearchSettle({ ...base, status: "running" }).settled).toBe(
			false,
		);
		expect(firstSearchSettle({ ...base, status: "errored" }).settled).toBe(
			true,
		);
	});

	it("never settles while scoring is paused with jobs unscored; it reads slower", () => {
		expect(firstSearchSettle({ ...base, paused: 2 })).toEqual({
			settled: false,
			paused: true,
			pollMs: PAUSED_POLL_MS,
		});
		// Queued again once resumed: pending, back to the fast read.
		expect(firstSearchSettle({ ...base, paused: 2, pending: 1 })).toEqual({
			settled: false,
			paused: false,
			pollMs: POLL_MS,
		});
	});
});

describe("set-aside rows leaving the list", () => {
	const row = (jobId: string, state: FoundRow["state"]): FoundRow => ({
		jobId,
		company: "Acme",
		title: "Engineer",
		state,
		reason: state === "rejected_by_filter" ? "Needs German" : null,
		score: null,
		match: false,
		paused: false,
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a row that left stays gone when a new arrival starts a check before the 3 s limit", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const beats = newRowBeats();
		const a = row("a", "rejected_by_filter");
		const at = () => shownRowsAt([a], beats).shown.find((r) => r.jobId === "a");
		// Seen at 0: held as found, then its reason.
		expect(at()?.shown).toBe("found");
		vi.advanceTimersByTime(800);
		expect(at()).toMatchObject({ shown: "rejected_by_filter", gone: false });
		// 1.2 s after it was set aside and nothing is being checked: it leaves.
		vi.advanceTimersByTime(1_300);
		expect(at()?.gone).toBe(true);
		// A new row arrives at 2.4 s (between 1.2 s and 3 s): a check is running again.
		vi.advanceTimersByTime(300);
		const b = row("b", "found");
		const withB = shownRowsAt([a, b], beats);
		expect(withB.shown.find((r) => r.jobId === "b")?.shown).toBe("found");
		expect(withB.shown.find((r) => r.jobId === "a")?.gone).toBe(true);
		vi.advanceTimersByTime(200);
		expect(shownRowsAt([a, b], beats).shown[0]?.gone).toBe(true);
		// Its job leaves the set-aside state: the latch clears.
		vi.advanceTimersByTime(1_000);
		expect(shownRowsAt([row("a", "fits"), b], beats).shown[0]).toMatchObject({
			shown: "fits",
			gone: false,
		});
		expect(beats.gone.has("a")).toBe(false);
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

	it("while scoring is paused, says so with the pause's reason", () => {
		const complete = { ...progress, status: "complete", done: 3 };
		expect(
			firstSearchLine(complete, counts, {
				...phase,
				paused: { count: 2, reason: "Spending cap reached: $5.00 of $5.00." },
			}),
		).toBe(
			"Scoring is paused: 2 jobs wait for a fit score. Spending cap reached: $5.00 of $5.00.",
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
