import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NoopNotifier } from "../src/notify/ntfy";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { sweepStuckApplications } from "../src/pipeline/sweep";
import { loadProfileFromDir } from "../src/profile/load-node";
import { FakeLlmProvider } from "../src/scoring/fake";
import { FIXTURES, fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

describe("sweep for stuck applications", () => {
	it("restarts a finished workflow that left its job in found, and leaves active ones alone", async () => {
		// No profile yet: the workflow completes early and the job stays found.
		const repo = new MemoryRepo(null);
		repo.addCompany({ name: "Acme", source: "greenhouse", sourceKey: "acme" });
		const workflows = new LocalWorkflowStarter();
		const deps: PipelineDeps = {
			repo,
			sources: {
				greenhouse: {
					kind: "greenhouse",
					listJobs: async () => [
						{
							source: "greenhouse",
							externalId: "1",
							url: "https://boards.greenhouse.io/acme/jobs/1",
							title: "Senior Software Engineer",
							locations: ["Ankara, Turkey"],
							workplaceType: "hybrid",
							descriptionText:
								"Requirements\n- TypeScript and React\n- Node.js and PostgreSQL",
						},
					],
				},
			},
			llm: new FakeLlmProvider(),
			claimsLlm: new FakeLlmProvider(),
			exporter: fakeExporter(),
			notifier: new NoopNotifier(),
			workflows,
		};
		workflows.bind(deps);
		const scan = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		const app = repo.apps[0];
		expect(app?.state).toBe("found");
		expect(scan.sweep?.restarted).toEqual([]); // it was not stuck long enough yet
		expect(await workflows.status(app?.jobId ?? "")).toBe("complete");

		repo.profile = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));
		const swept = await sweepStuckApplications(deps, "u1", {
			olderThanMinutes: 0,
		});
		expect(swept).toMatchObject({
			checked: 1,
			restarted: [app?.jobId],
			failed: [],
		});
		expect(app?.state).toBe("ready_for_review");

		// Nothing is stuck now.
		expect(
			(await sweepStuckApplications(deps, "u1", { olderThanMinutes: 0 }))
				.checked,
		).toBe(0);
	});

	it("does not restart an instance that is still waiting", async () => {
		const repo = new MemoryRepo(null);
		repo.apps.push({
			id: "a",
			userId: "u1",
			jobId: "j",
			state: "found",
			filter: null,
			fit: null,
			endedReason: null,
			alertedAt: null,
			workflowStarted: true,
		});
		const restarted: string[] = [];
		const deps = {
			repo,
			sources: {},
			llm: new FakeLlmProvider(),
			notifier: new NoopNotifier(),
			workflows: {
				runtime: "cloudflare" as const,
				startBatch: async () => ({ created: [], existing: [], failed: [] }),
				status: async () => "waiting" as const,
				restart: async (p: { jobId: string }) => {
					restarted.push(p.jobId);
				},
			},
		} satisfies PipelineDeps;
		const result = await sweepStuckApplications(deps, "u1", {
			olderThanMinutes: 0,
		});
		expect(result.active).toEqual(["j"]);
		expect(restarted).toEqual([]);
	});
});
