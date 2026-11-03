import type { NormalizedJob } from "@offerfinch/core/domain/types";
import {
	type SourceReport,
	sourceReport,
} from "@offerfinch/core/pipeline/scan-report";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	beginScanRun,
	DashboardRepository,
	type Database,
	listScanRuns,
	recordIdleSources,
	recordScanSource,
	SCAN_HISTORY_KEEP,
	scanJobs,
	seedCompanies,
	setScanProgress,
} from "../src/index";
import { flowRuns } from "../src/schema/jobs";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acme",
			discoveredFrom: "t",
		},
	]);
});
afterAll(() => db.$close());

const job = (id: string, title: string): NormalizedJob => ({
	source: "greenhouse",
	externalId: id,
	url: `https://boards.greenhouse.io/acme/jobs/${id}`,
	title,
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "Build things.",
});

async function flowRun(id: string, status: "running" | "complete" | "errored") {
	await db.insert(flowRuns).values({
		id,
		userId: "u1",
		kind: "scan",
		params: { userId: "u1", trigger: "cron" },
		status,
		runAfter: new Date(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...(status === "running" ? {} : { endedAt: new Date() }),
		...(status === "errored" ? { error: "boom" } : {}),
	} as never);
}

const off = (id: string, label: string): SourceReport => ({
	...sourceReport(
		{ provider: id, queries: 0, fetched: 0, newJobIds: [] },
		label,
		null,
	),
	status: "off",
});

describe("scan history", () => {
	it("records a run as it goes: trigger once, idle sources, each source, progress, totals", async () => {
		await flowRun("scan-u1-manual-1", "running");
		await beginScanRun(db, {
			userId: "u1",
			flowRunId: "scan-u1-manual-1",
			trigger: "manual",
		});
		// The flow's own start hook comes later and keeps the first trigger.
		await beginScanRun(db, {
			userId: "u1",
			flowRunId: "scan-u1-manual-1",
			trigger: "timer",
		});
		await recordIdleSources(db, "scan-u1-manual-1", [
			off("glassdoor", "Glassdoor"),
		]);
		await setScanProgress(db, "scan-u1-manual-1", {
			source: "indeed",
			label: "Indeed",
			query: "frontend engineer",
		});
		let [row] = await listScanRuns(db, "u1");
		expect(row).toMatchObject({
			trigger: "manual",
			status: "running",
			progress: { source: "indeed", query: "frontend engineer" },
			finishedAt: null,
		});
		const company = await execute<{ id: string }>(
			db,
			sql`select id from companies where user_id = 'u1'`,
		);
		const saved = await repo.upsertJob(
			"u1",
			company[0]?.id ?? "",
			job("1", "Frontend Engineer"),
		);
		const indeed = sourceReport(
			{
				provider: "indeed",
				queries: 1,
				fetched: 3,
				newJobIds: [saved.jobId],
				searches: ["frontend engineer"],
				duplicates: 2,
			},
			"Indeed",
			null,
		);
		await recordScanSource(db, "scan-u1-manual-1", indeed);
		// A resumed scan replays the same report: replaced, not added twice.
		await recordScanSource(db, "scan-u1-manual-1", indeed);
		await setScanProgress(db, "scan-u1-manual-1", null);
		[row] = await listScanRuns(db, "u1");
		// Kept in arrival order; the history view puts sources that ran first.
		expect(row?.sources.map((s) => s.id)).toEqual(["glassdoor", "indeed"]);
		expect(row?.progress).toBeNull();
		expect(row?.finishedAt).toBeInstanceOf(Date);
		const [stats] = await execute<{ stats: string }>(
			db,
			sql`select stats from scan_runs where flow_run_id = 'scan-u1-manual-1'`,
		);
		expect(JSON.parse(String(stats?.stats))).toEqual({
			searches: 1,
			read: 3,
			newJobs: 1,
			duplicates: 2,
			dropped: 0,
		});
		const found = await scanJobs(db, "u1", [saved.jobId]);
		expect(found).toEqual([
			expect.objectContaining({
				jobId: saved.jobId,
				title: "Frontend Engineer",
				company: "Acme",
				state: "found",
			}),
		]);
		expect(found[0]?.applicationId).toBeTruthy();
	});

	it("takes the run's status from the runner, so a run that died still reads as errored", async () => {
		await flowRun("scan-u1-2026110213", "errored");
		await beginScanRun(db, {
			userId: "u1",
			flowRunId: "scan-u1-2026110213",
			trigger: "timer",
			startedAt: new Date(Date.now() + 1000),
		});
		const [row] = await listScanRuns(db, "u1");
		expect(row).toMatchObject({
			trigger: "timer",
			status: "errored",
			error: "boom",
		});
	});

	it("keeps the newest 100 runs per user", async () => {
		const base = Date.now() + 10_000;
		for (let i = 0; i < SCAN_HISTORY_KEEP + 5; i++)
			await beginScanRun(db, {
				userId: "u1",
				flowRunId: `scan-u1-bulk-${i}`,
				trigger: "timer",
				startedAt: new Date(base + i),
			});
		const rows = await listScanRuns(db, "u1", 500);
		expect(rows).toHaveLength(SCAN_HISTORY_KEEP);
		expect(rows[0]?.flowRunId).toBe(`scan-u1-bulk-${SCAN_HISTORY_KEEP + 4}`);
		expect(rows.some((r) => r.flowRunId === "scan-u1-bulk-0")).toBe(false);
	});
});
