import type { NormalizedJob } from "@offerfinch/core/domain/types";
import type { ExportInput, ExportResult } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import { runApplicationFlow } from "@offerfinch/core/pipeline/application-flow";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { runScanFlow } from "@offerfinch/core/pipeline/scan-flow";
import { loadProfileFromDir } from "@offerfinch/core/profile/load-node";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import type {
	ApplicationWorkflowParams,
	ScanWorkflowParams,
} from "@offerfinch/core/workflow/types";
import {
	DashboardRepository,
	DrizzlePipelineRepository,
	importProfile,
	saveFilterSettings,
	seedCompanies,
} from "@offerfinch/db";
import { flowRuns } from "@offerfinch/db/schema/jobs";
import { applications } from "@offerfinch/db/schema/pipeline";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { FlowRunner } from "../src/runner";
import {
	APPLICATION_KIND,
	DurableWorkflowStarter,
	SCAN_KIND,
	startManualScan,
} from "../src/workflows";
import { openTestDb, until } from "./helpers";

const job = (n: number, overrides: Partial<NormalizedJob> = {}) =>
	({
		source: "greenhouse",
		externalId: String(n),
		url: `https://boards.greenhouse.io/acme/jobs/${n}`,
		title: "Senior Software Engineer",
		locations: ["Ankara, Turkey"],
		workplaceType: "hybrid",
		descriptionText: "Requirements\n- TypeScript and React\n- PostgreSQL",
		...overrides,
	}) satisfies NormalizedJob;

const noopExporter = async (input: ExportInput): Promise<ExportResult> => ({
	records: input.documents.map((d) => ({
		kind: d.kind,
		format: "pdf" as const,
		sourceVersion: d.version,
		storageKey: `test/${d.kind}-v${d.version}.pdf`,
		meta: { pages: 1 },
	})),
	atsIssues: [],
});

let runner: FlowRunner | null = null;
afterAll(async () => {
	await runner?.stop(200);
});

describe("the core flows on the durable runner", () => {
	it("scans, prepares to review, then follows approval and 'I submitted this' through events", async () => {
		const db = await openTestDb();
		await saveFilterSettings(db, "u1", {
			// The fabricated persona's rules; the product's defaults name no country.
			rightToWork: ["Turkey"],
			keepOnsiteIn: ["Turkey"],
			languages: ["English", "Turkish"],
		});
		await importProfile(
			db,
			"u1",
			await loadProfileFromDir(
				new URL("../../core/test/fixtures/tailor-profile", import.meta.url)
					.pathname,
			),
			"test",
		);
		await seedCompanies(db, "u1", [
			{
				name: "Acme",
				source: "greenhouse",
				sourceKey: "acme",
				discoveredFrom: "test",
			},
		]);
		const repo = new DrizzlePipelineRepository(db);
		const starter = new DurableWorkflowStarter(db, null);
		const deps: PipelineDeps = {
			repo,
			sources: {
				greenhouse: {
					kind: "greenhouse",
					listJobs: async () => [
						job(1),
						// Scored too (no rule sets a job aside): a citizenship it lacks caps it low.
						job(3, {
							title: "Account Executive",
							descriptionText:
								"Requirements\n- Must be a US Citizen\n- Closing B2B deals",
						}),
					],
				},
			},
			llm: new FakeLlmProvider(),
			claimsLlm: new FakeLlmProvider(),
			exporter: noopExporter,
			notifier: new NoopNotifier(),
			workflows: starter,
		};
		runner = new FlowRunner({
			db,
			concurrency: 2,
			backoffMs: () => 5,
			handlers: {
				[SCAN_KIND]: (step, params) =>
					runScanFlow(step, deps, params as unknown as ScanWorkflowParams),
				[APPLICATION_KIND]: (step, params) =>
					runApplicationFlow(
						step,
						deps,
						params as unknown as ApplicationWorkflowParams,
					),
			},
		});
		const live = new DurableWorkflowStarter(db, runner);
		deps.workflows = live;
		await runner.start();

		const scan = await startManualScan(db, runner, "u1");
		const stateOf = async () =>
			(
				await db
					.select({
						state: applications.state,
						id: applications.id,
						jobId: applications.jobId,
					})
					.from(applications)
			).sort((a, b) => a.state.localeCompare(b.state));
		// Tailoring is on demand: the match waits in scored until Prepare.
		await until(
			async () =>
				(await stateOf()).filter((a) => a.state === "scored").length === 2,
		);
		const ended = await db
			.select({ id: applications.id, ended: applications.endedReason })
			.from(applications);
		expect(ended.filter((a) => a.ended !== null)).toHaveLength(1);
		const listed = ended.find((a) => a.ended === null);
		await live.sendEvent(
			await new DashboardRepository(db).requestPrepare({
				userId: "u1",
				applicationId: listed?.id ?? "",
			}),
		);
		await until(async () =>
			(await stateOf()).some((a) => a.state === "ready_for_review"),
		);
		const [scanRun] = await db
			.select()
			.from(flowRuns)
			.where(eq(flowRuns.id, scan.id));
		await until(
			async () =>
				(await db.select().from(flowRuns).where(eq(flowRuns.id, scan.id)))[0]
					?.status === "complete",
		);
		expect(scanRun).toBeDefined();
		expect((await stateOf()).map((a) => a.state)).toEqual([
			"ready_for_review",
			"scored",
		]);
		const kept = (await stateOf()).find((a) => a.state === "ready_for_review");
		if (!kept) throw new Error("no application");
		const runId = `job-${kept.jobId}`;
		await until(
			async () =>
				(await db.select().from(flowRuns).where(eq(flowRuns.id, runId)))[0]
					?.status === "waiting",
		);

		// Approve in the dashboard: the change commits, then the event wakes the run.
		const dashboard = new DashboardRepository(db);
		const detail = await dashboard.getApplication("u1", kept.id);
		const event = await dashboard.approve({
			userId: "u1",
			applicationId: kept.id,
			approvedHashes: detail?.currentHashes ?? {},
			idempotencyKey: "approve-test-1",
		});
		await live.sendEvent(event);
		// A hand-off board: the flow leaves it approved and waits for the user.
		await until(async () => {
			const [run] = await db
				.select()
				.from(flowRuns)
				.where(eq(flowRuns.id, runId));
			return run?.status === "waiting" && run.executions >= 2;
		});
		expect((await repo.getState("u1", kept.id)) ?? "").toBe("approved");

		const submitted = await dashboard.markSubmittedManually({
			userId: "u1",
			applicationId: kept.id,
			idempotencyKey: "submitted-test-1",
		});
		await live.sendEvent(submitted);
		// Delivered twice (a double click): harmless.
		await live.sendEvent(submitted);
		await until(
			async () =>
				(await db.select().from(flowRuns).where(eq(flowRuns.id, runId)))[0]
					?.status === "complete",
		);
		expect(await repo.getState("u1", kept.id)).toBe("applied");
		db.$close();
	});
});
