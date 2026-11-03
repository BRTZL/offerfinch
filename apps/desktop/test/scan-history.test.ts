import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import {
	DashboardRepository,
	ensureUser,
	listScanRuns,
	openSqlite,
	seedCompanies,
	updateProvider,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { flowRuns } from "@offerfinch/db/schema/jobs";
import { companies } from "@offerfinch/db/schema/pipeline";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
	runStatus,
	scanHistoryViews,
	scanLogFor,
} from "../src/worker/scan-history";
import { SITE_DEBUG_DIR } from "../src/worker/site-debug";

const job = (id: string, title: string): NormalizedJob => ({
	source: "greenhouse",
	externalId: id,
	url: `https://boards.greenhouse.io/acme/jobs/${id}`,
	title,
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "Build things.",
});

async function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-scans-"));
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
	return { db, dir };
}

describe("scan history in the worker", () => {
	it("records each source with its status from Settings › Sources, and explains the run", async () => {
		const { db, dir } = await setup();
		await db.insert(flowRuns).values({
			id: "scan-u1-manual-1",
			userId: "u1",
			kind: "scan",
			params: { userId: "u1", trigger: "manual" },
			status: "running",
			runAfter: new Date(),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		// Indeed on, Glassdoor off; Indeed's run meets a check that holds it.
		await updateProvider(db, "u1", "indeed", { enabled: true });
		await updateProvider(db, "u1", "glassdoor", { enabled: false });
		const hooks = scanLogFor(
			{ db, init: { userData: dir } },
			{ id: "scan-u1-manual-1", userId: "u1" },
			{ userId: "u1", trigger: "manual" },
		);
		const log = hooks.scanLog;
		if (!log) throw new Error("no scan log");
		await log.start([
			{ id: "job-board-search", label: "Job-board search" },
			{ id: "indeed", label: "Indeed" },
		]);
		hooks.scanProgress?.("u1", {
			source: "job-board-search",
			query: "frontend remote",
		});
		const repo = new DashboardRepository(db);
		const [company] = await db
			.select({ id: companies.id })
			.from(companies)
			.where(eq(companies.userId, "u1"));
		const kept = await repo.upsertJob(
			"u1",
			company?.id ?? "",
			job("1", "Frontend Engineer"),
		);
		const filtered = await repo.upsertJob(
			"u1",
			company?.id ?? "",
			job("2", "Platform Engineer"),
		);
		// The job filter set one aside for its location.
		const filteredApp =
			(await repo.getApplicationByJob("u1", filtered.jobId))?.applicationId ??
			"";
		await repo.saveFilterResult("u1", filteredApp, {
			decision: "reject",
			summary: "On-site in Berlin",
			flags: [],
			reasons: [
				{
					rule: "location",
					outcome: "reject",
					message: "On-site in Berlin, Germany",
				},
			],
		});
		await repo.transition("u1", filteredApp, {
			from: ["found"],
			to: "rejected_by_filter",
			reason: "On-site in Berlin",
			actor: "workflow",
		});
		await log.source(
			{
				provider: "job-board-search",
				queries: 2,
				fetched: 5,
				newJobIds: [kept.jobId, filtered.jobId],
				searches: ["frontend remote", "react remote"],
				duplicates: 3,
			},
			"Job-board search",
		);
		await updateProvider(db, "u1", "indeed", {
			config: {
				stop: {
					kind: "captcha",
					reason: "A check",
					at: new Date().toISOString(),
				},
			},
		});
		fs.mkdirSync(path.join(dir, SITE_DEBUG_DIR), { recursive: true });
		const snapshot = `${new Date(Date.now() + 1000).toISOString().replace(/[:.]/g, "-")}-indeed-captcha.html`;
		fs.writeFileSync(path.join(dir, SITE_DEBUG_DIR, snapshot), "<html></html>");
		await log.source(
			{
				provider: "indeed",
				queries: 0,
				fetched: 0,
				newJobIds: [],
				problem: "Stopped: a check",
			},
			"Indeed",
		);
		await log.progress(null);
		const [running] = await scanHistoryViews(
			db,
			"u1",
			await listScanRuns(db, "u1"),
		);
		expect(running?.outcome).toBe("Scanning: 2 new jobs so far");
		await db
			.update(flowRuns)
			.set({ status: "complete", endedAt: new Date() })
			.where(eq(flowRuns.id, "scan-u1-manual-1"));

		const [view] = await scanHistoryViews(
			db,
			"u1",
			await listScanRuns(db, "u1"),
		);
		expect(view?.trigger).toBe("manual");
		// The sources that ran first; every other provider Settings › Sources has (whatever the
		// list holds now, LinkedIn among them) is a row of its own, off here.
		const rows = view?.sources.map((s) => [s.report.id, s.report.status]) ?? [];
		expect(rows.slice(0, 2)).toEqual([
			["job-board-search", "ok"],
			["indeed", "paused_check"],
		]);
		expect(rows).toContainEqual(["glassdoor", "off"]);
		expect(rows).toContainEqual(["linkedin", "off"]);
		expect(rows.slice(2).every(([, status]) => status === "off")).toBe(true);
		const indeed = view?.sources.find((s) => s.report.id === "indeed");
		expect(indeed?.report.debugSnapshot).toBe(
			path.join(dir, SITE_DEBUG_DIR, snapshot),
		);
		const search = view?.sources[0];
		expect(search?.found.map((f) => [f.title, f.fate.kind])).toEqual([
			["Frontend Engineer", "checking"],
			["Platform Engineer", "filtered"],
		]);
		expect(search?.drops.map((d) => [d.label, d.count])).toEqual([
			["already seen", 3],
			["filtered by location", 1],
		]);
		expect(view?.outcome).toBe("1 new job found, still being checked");
		expect(view?.totals).toMatchObject({
			searches: 2,
			read: 5,
			newJobs: 2,
			duplicates: 3,
			listed: 0,
		});
		db.$close();
	});
});

describe("rows from before the scan history (Codex review)", () => {
	it("a finished pre-migration row reads as done with its own counts; an unfinished one as interrupted", async () => {
		const { MIGRATIONS } = await import(
			"../../../packages/db/src/migrations/index"
		);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-legacy-"));
		const db = openSqlite(path.join(dir, "test.sqlite"));
		const at = MIGRATIONS.findIndex((m) => m.name.endsWith("_scan_history"));
		expect(at).toBeGreaterThan(0);
		await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
		await ensureUser(db, { id: "u1", name: "Test", email: "u1@example.test" });
		const insert = db.$client.prepare(
			"insert into scan_runs (id, user_id, trigger, stats, started_at, finished_at) values (?, ?, ?, ?, ?, ?)",
		);
		insert.run(
			"old-done",
			"u1",
			"manual",
			'{"jobsInserted":3,"jobsFetched":7}',
			2000,
			3000,
		);
		insert.run("old-orphan", "u1", "cron", null, 1000, null);
		await migrate(db);

		const views = await scanHistoryViews(
			db,
			"u1",
			await listScanRuns(db, "u1"),
		);
		const done = views.find((v) => v.id === "old-done");
		const orphan = views.find((v) => v.id === "old-orphan");
		expect(done).toMatchObject({
			status: "done",
			legacy: true,
			outcome: "3 new jobs; scanned before the history kept details",
			totals: { read: 7, newJobs: 3 },
		});
		expect(orphan).toMatchObject({
			status: "interrupted",
			outcome:
				"Interrupted before it finished; scanned before the history kept details",
		});
		expect(views.some((v) => v.status === "running")).toBe(false);
		db.$close();
	});

	it("a recorded run whose runner run is gone is done or interrupted, never running", () => {
		expect(
			runStatus({ flowRunId: "scan-x", status: null, finishedAt: new Date() }),
		).toBe("done");
		expect(
			runStatus({ flowRunId: "scan-x", status: null, finishedAt: null }),
		).toBe("interrupted");
		expect(runStatus({ flowRunId: null, status: null, finishedAt: null })).toBe(
			"interrupted",
		);
		expect(
			runStatus({ flowRunId: "scan-x", status: "running", finishedAt: null }),
		).toBe("running");
	});

	it("names the remote feeds and lists a waiting source before those that are off (review #1)", async () => {
		const { db, dir } = await setup();
		await db.insert(flowRuns).values({
			id: "scan-u1-manual-2",
			userId: "u1",
			kind: "scan",
			params: { userId: "u1", trigger: "manual" },
			status: "running",
			runAfter: new Date(),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		// Remote OK on and not due; Remotive and the other sources off.
		await updateProvider(db, "u1", "job-board-search", { enabled: false });
		await updateProvider(db, "u1", "remoteok", { enabled: true });
		const hooks = scanLogFor(
			{ db, init: { userData: dir } },
			{ id: "scan-u1-manual-2", userId: "u1" },
			{ userId: "u1", trigger: "manual" },
		);
		const log = hooks.scanLog;
		if (!log) throw new Error("no scan log");
		await log.start([{ id: "remoteok", label: "Remote OK" }]);
		await log.source(
			{
				provider: "remoteok",
				queries: 0,
				fetched: 0,
				newJobIds: [],
				status: "waiting",
				retryAt: new Date(Date.now() + 3_600_000).toISOString(),
				problem: "Next Remote OK read in ~1 h.",
			},
			"Remote OK",
		);
		await db
			.update(flowRuns)
			.set({ status: "complete", endedAt: new Date() })
			.where(eq(flowRuns.id, "scan-u1-manual-2"));
		const [view] = await scanHistoryViews(
			db,
			"u1",
			await listScanRuns(db, "u1"),
		);
		const rows = view?.sources.map((s) => [s.report.id, s.report.status]) ?? [];
		expect(rows[0]).toEqual(["remoteok", "waiting"]);
		const labels = Object.fromEntries(
			view?.sources.map((s) => [s.report.id, s.report.label]) ?? [],
		);
		expect(labels).toMatchObject({
			remotive: "Remotive",
			weworkremotely: "We Work Remotely",
			"hn-hiring": "HN Who is hiring",
		});
		expect(view?.outcome).toBe("Nothing searched: Remote OK is not due yet");
	});
});
