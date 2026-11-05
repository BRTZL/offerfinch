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
	it("ranks from the fit score alone, and sends work rights and preferences, never a filter verdict", async () => {
		const repo = new MemoryRepo(PROFILE);
		repo.onDemand = true;
		repo.settings = {
			...repo.settings,
			seniority: ["Senior"],
			preferredIndustries: ["Developer tools"],
		};
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
							locations: ["Remote"],
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

		const [turkey, remote] = ["1", "2"].map((id) =>
			repo.apps.find(
				(a) => repo.jobs.find((j) => j.id === a.jobId)?.job.externalId === id,
			),
		);
		expect(turkey?.state).toBe("scored");
		expect(remote?.state).toBe("scored");
		// Same score, same rank: an unstated place is the fit score's to weigh, not a penalty.
		expect(turkey?.fit?.score).toBe(remote?.fit?.score);
		expect(turkey?.rank?.rank).toBe(turkey?.fit?.score);
		expect(remote?.rank?.rank).toBe(remote?.fit?.score);
		expect(remote?.rank?.penalties).toEqual([]);

		const prompts = llm.calls.filter((c) => c.task === "fit-score");
		expect(prompts[0]?.prompt).toMatch(
			/<work_rights>\nLives in: Türkiye\nCitizenship: Türkiye\nRight to work in: Türkiye\n<\/work_rights>/,
		);
		expect(prompts[0]?.prompt).toMatch(/Target levels: Senior\n/);
		expect(prompts[0]?.prompt).toMatch(
			/Preferred industries: Developer tools\n/,
		);
		expect(prompts.map((p) => p.prompt).join("\n")).not.toMatch(
			/Location check/,
		);
	});
});

describe("the strong-match notification follows the rank", () => {
	it("is not sent for a job ranked below the bar, whatever its raw score", async () => {
		const run = async (alertMinScore: number) => {
			const repo = new MemoryRepo(PROFILE);
			repo.onDemand = true;
			repo.settings = { ...repo.settings, alertMinScore };
			const passedOn = repo.addCompany({
				name: "Passed On Labs",
				source: "greenhouse",
				sourceKey: "acme",
			});
			// The user passed on a job at this company before: its new jobs rank 25 lower.
			repo.dismissals = [
				{
					companyId: passedOn.id,
					reasons: ["company"],
					title: "Backend Engineer",
				},
			];
			const notified: string[] = [];
			const workflows = new LocalWorkflowStarter();
			const deps: PipelineDeps = {
				repo,
				sources: {
					greenhouse: {
						kind: "greenhouse",
						listJobs: async () => [posting("1", {})],
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
			const app = repo.apps[0];
			return { notified, score: app?.fit?.score ?? 0, rank: app?.rank?.rank };
		};
		const { score, rank } = await run(101);
		expect(score).toBeGreaterThan(25);
		expect(rank).toBe(score - 25);
		// Above the rank, below the score: no alert.
		expect((await run(score - 10)).notified).toEqual([]);
		expect((await run(score - 30)).notified).toEqual([
			"Senior Software Engineer",
		]);
	});
});
