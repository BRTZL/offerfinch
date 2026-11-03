import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "../src/domain/types";
import { NoopNotifier } from "../src/notify/ntfy";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { loadProfileFromDir } from "../src/profile/load-node";
import { FakeLlmProvider } from "../src/scoring/fake";
import { FIXTURES, fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

const PROFILE = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));

function posting(id: string, overrides: Partial<NormalizedJob>): NormalizedJob {
	return {
		source: "greenhouse",
		externalId: id,
		url: `https://boards.greenhouse.io/acme/jobs/${id}`,
		title: "Senior Software Engineer",
		locations: ["Ankara, Turkey"],
		workplaceType: "hybrid",
		descriptionText:
			"Requirements\n- TypeScript and React\n- Node.js and PostgreSQL\n- Go is a plus",
		...overrides,
	};
}

describe("scoring stores a rank and tells the scorer where the user may work", () => {
	it("ranks a match with an unclear place below the same job in Turkey", async () => {
		const repo = new MemoryRepo(PROFILE);
		repo.onDemand = true;
		repo.addCompany({ name: "Acme", source: "greenhouse", sourceKey: "acme" });
		const llm = new FakeLlmProvider();
		const workflows = new LocalWorkflowStarter();
		const deps: PipelineDeps = {
			repo,
			sources: {
				greenhouse: {
					kind: "greenhouse",
					listJobs: async () => [
						posting("1", {}),
						posting("2", {
							locations: ["Remote (EMEA)"],
							workplaceType: "remote",
						}),
					],
				},
			},
			llm,
			claimsLlm: new FakeLlmProvider(),
			exporter: fakeExporter(),
			now: () => new Date("2026-10-30T12:00:00Z"),
			notifier: new NoopNotifier(),
			workflows,
		};
		workflows.bind(deps);
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });

		const [turkey, emea] = ["1", "2"].map((id) =>
			repo.apps.find(
				(a) => repo.jobs.find((j) => j.id === a.jobId)?.job.externalId === id,
			),
		);
		expect(turkey?.state).toBe("scored");
		expect(emea?.state).toBe("scored");
		expect(turkey?.fit?.score).toBe(emea?.fit?.score);
		expect(turkey?.rank?.rank).toBe(turkey?.fit?.score);
		expect(emea?.rank?.rank).toBeLessThan(turkey?.rank?.rank ?? 0);
		expect(emea?.rank?.penalties[0]?.reason).toBe("location unclear");

		const prompts = llm.calls.filter((c) => c.task === "fit-score");
		expect(prompts[0]?.prompt).toMatch(
			/<work_rights>\nLives in: Turkey\nCitizenship: Turkey\nRight to work in: Turkey\n<\/work_rights>/,
		);
		expect(prompts.map((p) => p.prompt).join("\n")).toMatch(
			/Location check: unclear/,
		);
	});
});

describe("the strong-match notification follows the rank", () => {
	it("is not sent for a job ranked below the bar, whatever its raw score", async () => {
		const run = async (alertMinScore: number) => {
			const repo = new MemoryRepo(PROFILE);
			repo.onDemand = true;
			repo.settings = { ...repo.settings, alertMinScore };
			repo.addCompany({
				name: "Acme",
				source: "greenhouse",
				sourceKey: "acme",
			});
			const notified: string[] = [];
			const workflows = new LocalWorkflowStarter();
			const deps: PipelineDeps = {
				repo,
				sources: {
					greenhouse: {
						kind: "greenhouse",
						listJobs: async () => [
							posting("1", { title: "Senior Software Engineer, Ankara" }),
							posting("2", {
								title: "Senior Software Engineer, EMEA",
								locations: ["Remote (EMEA)"],
								workplaceType: "remote",
							}),
						],
					},
				},
				llm: new FakeLlmProvider(),
				claimsLlm: new FakeLlmProvider(),
				exporter: fakeExporter(),
				now: () => new Date("2026-10-30T12:00:00Z"),
				notifier: {
					notifyStrongMatch: async (match) => {
						notified.push(match.title);
					},
				},
				workflows,
			};
			workflows.bind(deps);
			await runScanFlow(new LocalStep(), deps, {
				userId: "u1",
				trigger: "cli",
			});
			const score = repo.apps[0]?.fit?.score ?? 0;
			return { notified, score };
		};
		// Nothing alerts with the bar above every score; this run only tells us the fake's score.
		const { score } = await run(101);
		expect(score).toBeGreaterThan(15);
		// Both jobs score the same; the EMEA one is ranked 15 lower for its unclear place.
		const { notified } = await run(score - 10);
		expect(notified).toEqual(["Senior Software Engineer, Ankara"]);
	});
});
