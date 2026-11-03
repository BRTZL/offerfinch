import type { ExportInput, ExportResult } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import { runApplicationFlow } from "@offerfinch/core/pipeline/application-flow";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { loadProfileFromDir } from "@offerfinch/core/profile/load-node";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import type { ApplicationWorkflowParams } from "@offerfinch/core/workflow/types";
import {
	DashboardRepository,
	DrizzlePipelineRepository,
	importProfile,
	saveFilterSettings,
	seedCompanies,
} from "@offerfinch/db";
import { flowRuns, flowSteps } from "@offerfinch/db/schema/jobs";
import { applications, companies } from "@offerfinch/db/schema/pipeline";
import { eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { FlowRunner } from "../src/runner";
import { APPLICATION_KIND, DurableWorkflowStarter } from "../src/workflows";
import { openTestDb, until } from "./helpers";

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

describe("Redraft on the durable runner", () => {
	it("redrafts once in a run whose earlier wakes predate the redraft step", async () => {
		const db = await openTestDb();
		await saveFilterSettings(db, "u1", {
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
		const tailor = new FakeLlmProvider();
		const deps: PipelineDeps = {
			repo,
			sources: {},
			llm: tailor,
			claimsLlm: new FakeLlmProvider(),
			exporter: noopExporter,
			notifier: new NoopNotifier(),
			workflows: new DurableWorkflowStarter(db, null),
		};
		runner = new FlowRunner({
			db,
			concurrency: 1,
			backoffMs: () => 5,
			handlers: {
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

		const [company] = await db.select({ id: companies.id }).from(companies);
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
			source: "greenhouse",
			externalId: "1",
			url: "https://boards.greenhouse.io/acme/jobs/1",
			title: "Senior Software Engineer",
			locations: ["Ankara, Turkey"],
			workplaceType: "hybrid",
			descriptionText: "Requirements\n- TypeScript and React\n- PostgreSQL",
		});
		await live.startBatch([{ userId: "u1", jobId }]);
		const runId = `job-${jobId}`;
		const stateOf = async () =>
			(
				await db
					.select({ state: applications.state, id: applications.id })
					.from(applications)
			)[0];
		await until(async () => (await stateOf())?.state === "scored");
		const dashboard = new DashboardRepository(db);
		const appId = (await stateOf())?.id ?? "";
		await live.sendEvent(
			await dashboard.requestPrepare({ userId: "u1", applicationId: appId }),
		);
		const waiting = async (executions: number) => {
			const [run] = await db
				.select()
				.from(flowRuns)
				.where(eq(flowRuns.id, runId));
			return run?.status === "waiting" && run.executions >= executions;
		};
		await until(async () => (await stateOf())?.state === "ready_for_review");
		await until(() => waiting(1));
		const detail = await dashboard.getApplication("u1", appId);
		await live.sendEvent(
			await dashboard.approve({
				userId: "u1",
				applicationId: appId,
				approvedHashes: detail?.currentHashes ?? {},
				idempotencyKey: "approve-redraft-flow",
			}),
		);
		await until(async () => (await stateOf())?.state === "approved");
		await until(() => waiting(2));

		// As if the run's history were written by a build without the redraft step.
		const removed = await db
			.delete(flowSteps)
			.where(like(flowSteps.key, "redraft %"))
			.returning({ key: flowSteps.key });
		expect(removed.length).toBeGreaterThan(0);
		const before = Object.fromEntries(
			(await repo.latestDocuments("u1", appId)).map((d) => [d.kind, d]),
		);
		const drafts = tailor.calls.filter((c) => c.task === "tailor").length;

		const requested = await dashboard.requestRedraft({
			userId: "u1",
			applicationId: appId,
			scope: "cover_letter",
			instruction: "Shorter",
		});
		expect(requested.revoked).toBe(true);
		await live.sendEvent(requested.event);
		// Delivered twice (a double click or a replay): still one redraft.
		await live.sendEvent(requested.event);
		await until(async () => {
			const app = await dashboard.getApplication("u1", appId);
			return (
				app?.redraft === null &&
				app.review !== null &&
				app.documents.find((d) => d.kind === "cover_letter")?.version ===
					(before.cover_letter?.version ?? 0) + 1
			);
		});
		await until(async () => {
			const verdict = await dashboard.getApplication("u1", appId);
			const review = verdict?.review;
			return Boolean(
				review &&
					JSON.stringify(review.documentHashes) ===
						JSON.stringify(verdict.currentHashes) &&
					review.atsChecked,
			);
		});
		expect(tailor.calls.filter((c) => c.task === "tailor")).toHaveLength(
			drafts + 1,
		);
		const after = Object.fromEntries(
			(await repo.latestDocuments("u1", appId)).map((d) => [d.kind, d]),
		);
		expect(after.cv).toEqual(before.cv);
		expect(after.form_answers).toEqual(before.form_answers);
		expect(after.cover_letter?.content).not.toBe(before.cover_letter?.content);
		expect((await stateOf())?.state).toBe("ready_for_review");
		db.$close();
	});
});
