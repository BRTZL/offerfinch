import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "../src/domain/types";
import { NoopNotifier } from "../src/notify/ntfy";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { reviewStep } from "../src/pipeline/prepare";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { loadProfileFromDir } from "../src/profile/load-node";
import { FakeLlmProvider } from "../src/scoring/fake";
import type { GenerateObjectRequest, LlmProvider } from "../src/scoring/llm";
import { FIXTURES, fakeExporter } from "./helpers";
import { MemoryRepo } from "./memory-repo";

const PROFILE = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));

const POSTING: NormalizedJob = {
	source: "greenhouse",
	externalId: "42",
	url: "https://boards.greenhouse.io/acme/jobs/42",
	title: "Senior Full-Stack Engineer",
	locations: ["Ankara, Turkey"],
	workplaceType: "hybrid",
	descriptionText:
		"Requirements\n- TypeScript and React with Next.js\n- Node.js and PostgreSQL\n- Go is a plus",
};

/** The test model under a real company's name, as a Claude or Codex plan or an API key. */
class Named implements LlmProvider {
	readonly calls: string[] = [];
	private readonly fake = new FakeLlmProvider();
	constructor(
		readonly name: string,
		readonly vendor?: string,
	) {}
	generateObject<T>(request: GenerateObjectRequest<T>): Promise<T> {
		this.calls.push(request.task);
		return this.fake.generateObject(request);
	}
}

const claudePlan = () => new Named("claude-subscription:test", "anthropic");
const anthropicKey = () => new Named("anthropic:claude-test");
const openaiKey = () => new Named("openai:gpt-test", "openai");

/** Scans one posting, drafts it with `tailorLlm` and reviews it with `claimsLlm`. */
async function drafted(tailorLlm: LlmProvider, claimsLlm: LlmProvider) {
	const repo = new MemoryRepo(structuredClone(PROFILE));
	repo.addCompany({
		name: "Acme Robotics",
		source: "greenhouse",
		sourceKey: "acme",
	});
	const workflows = new LocalWorkflowStarter();
	const deps: PipelineDeps = {
		repo,
		sources: {
			greenhouse: { kind: "greenhouse", listJobs: async () => [POSTING] },
		},
		llm: new FakeLlmProvider(),
		tailorLlm,
		claimsLlm,
		exporter: fakeExporter([]),
		now: () => new Date("2026-11-04T12:00:00Z"),
		notifier: new NoopNotifier(),
		workflows,
	};
	workflows.bind(deps);
	await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
	const app = repo.apps[0];
	if (!app) throw new Error("no application");
	return { repo, deps, app };
}

describe("any model may check any draft, its own company's included", () => {
	it("records the drafting model as the author and lets OpenAI check Claude's draft", async () => {
		const checker = openaiKey();
		const { repo, app } = await drafted(claudePlan(), checker);
		expect(app.state).toBe("ready_for_review");
		expect(checker.calls).toContain("claims-check");
		const cv = repo.documents.filter((d) => d.kind === "cv").at(-1);
		expect(cv?.authorProvider).toBe("claude-subscription:test");
	});

	it("lets Claude check Claude's draft (the same model for every step)", async () => {
		const checker = claudePlan();
		const { repo, app } = await drafted(claudePlan(), checker);
		expect(app.state).toBe("ready_for_review");
		expect(checker.calls).toContain("claims-check");
		expect(repo.reviews).toHaveLength(1);
	});

	it("checks an edited draft and one saved before authors were recorded on its own company", async () => {
		const { repo, deps, app } = await drafted(claudePlan(), openaiKey());
		for (const d of repo.documents) d.authorProvider = null;
		const cv = repo.documents.filter((d) => d.kind === "cv").at(-1);
		repo.addVersion("u1", app.id, "cv", `${cv?.content}\nEdited.`);
		const claude = anthropicKey();
		const outcome = await reviewStep(
			{ ...deps, claimsLlm: claude },
			"u1",
			app.jobId,
		);
		expect(outcome.outcome).toBe("reviewed");
		expect(claude.calls).toContain("claims-check");
	});

	it("lets Codex check a Codex draft", async () => {
		const checker = new Named("codex-subscription:check", "openai");
		const { app } = await drafted(
			new Named("codex-subscription:test", "openai"),
			checker,
		);
		expect(app.state).toBe("ready_for_review");
		expect(checker.calls).toContain("claims-check");
	});
});
