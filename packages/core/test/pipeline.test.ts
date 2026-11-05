import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "../src/domain/types";
import { NoopNotifier } from "../src/notify/ntfy";
import { runApplicationFlow } from "../src/pipeline/application-flow";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import {
	FlowPaused,
	type FlowStep,
	type PipelineDeps,
} from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { loadProfileFromDir } from "../src/profile/load-node";
import { FakeLlmProvider } from "../src/scoring/fake";
import type { JobSource } from "../src/sources/types";
import { SourceBlockedError } from "../src/sources/types";
import { applicationInstanceId } from "../src/workflow/types";
import { FIXTURES, fakeExporter, fixture } from "./helpers";
import { MemoryRepo } from "./memory-repo";

const PROFILE = await loadProfileFromDir(join(FIXTURES, "tailor-profile"));

function posting(overrides: Partial<NormalizedJob>): NormalizedJob {
	return {
		source: "greenhouse",
		externalId: "1",
		url: "https://boards.greenhouse.io/acme/jobs/1",
		title: "Senior Software Engineer",
		locations: ["Ankara, Turkey"],
		workplaceType: "hybrid",
		descriptionText:
			"Requirements\n- TypeScript and React\n- Node.js and PostgreSQL\n- Go is a plus",
		...overrides,
	};
}

const NORTHBEAM = posting({
	externalId: "2",
	url: "https://boards.greenhouse.io/acme/jobs/2",
	title: "Senior Full Stack Engineer",
	locations: ["Fully remote (Europe)"],
	workplaceType: "remote",
	descriptionText: fixture("northbeam-posting.txt"),
});

function staticSource(jobs: NormalizedJob[]): JobSource {
	return { kind: "greenhouse", listJobs: async () => jobs };
}

function setup(jobs: NormalizedJob[]) {
	const repo = new MemoryRepo(PROFILE);
	repo.addCompany({ name: "Acme", source: "greenhouse", sourceKey: "acme" });
	const notifier = new NoopNotifier();
	const workflows = new LocalWorkflowStarter();
	const deps: PipelineDeps = {
		repo,
		sources: { greenhouse: staticSource(jobs) },
		llm: new FakeLlmProvider(),
		claimsLlm: new FakeLlmProvider(),
		exporter: fakeExporter(),
		now: () => new Date("2026-10-30T12:00:00Z"),
		notifier,
		workflows,
	};
	workflows.bind(deps);
	return { repo, notifier, workflows, deps };
}

describe("scan flow + application flow (local runner)", () => {
	it("saves new jobs, starts one application flow each, and repeats nothing on a second scan", async () => {
		const { repo, notifier, workflows, deps } = setup([posting({}), NORTHBEAM]);
		const first = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(first.jobsInserted).toBe(2);
		expect(first.workflows.created).toHaveLength(2);
		// No rule sets a job aside: the Spanish-speaking role is scored, and its language
		// requirement caps the score below the minimum with the blocker as the reason.
		expect(repo.apps.map((a) => a.state).sort()).toEqual([
			"ready_for_review",
			"scored",
		]);
		expect(notifier.sent).toHaveLength(1);

		const low = repo.apps.find((a) => a.state === "scored");
		expect(low?.filter).toBeNull();
		expect(low?.endedReason).toMatch(
			/Requires Spanish.*Fit score \d+ is below the minimum/,
		);
		expect(workflows.outcomes.get(low?.jobId ?? "")).toMatchObject({
			outcome: "low_score",
		});
		const kept = repo.apps.find((a) => a.state === "ready_for_review");
		expect(workflows.outcomes.get(kept?.jobId ?? "")).toMatchObject({
			outcome: "paused",
			state: "ready_for_review",
		});

		const second = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(second.jobsInserted).toBe(0);
		expect(second.workflows.created).toHaveLength(0);
		expect(repo.jobs).toHaveLength(2);
		expect(repo.apps).toHaveLength(2);
		expect(notifier.sent).toHaveLength(1);
	});

	it("dedupes the same posting seen under a tracking URL", async () => {
		const { repo, deps } = setup([
			posting({}),
			posting({
				externalId: "1-dup",
				url: "https://boards.greenhouse.io/acme/jobs/1?gh_src=li",
			}),
		]);
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		expect(repo.jobs).toHaveLength(1);
	});

	it("ends with the reason saved when the score is below the minimum", async () => {
		const { repo, deps } = setup([
			posting({
				descriptionText: "Requirements\n- Rust and Scala\n- Kubernetes",
			}),
		]);
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		expect(repo.apps[0]?.state).toBe("scored");
		expect(repo.apps[0]?.endedReason).toMatch(/below the minimum/);
	});

	it("releases the alert claim when ntfy fails, so a retry sends it", async () => {
		const { repo, deps } = setup([posting({})]);
		repo.settings = { ...repo.settings, alertMinScore: 0 };
		let calls = 0;
		deps.notifier = {
			notifyStrongMatch: async () => {
				calls += 1;
				if (calls === 1) throw new Error("ntfy 429");
			},
		};
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		expect(calls).toBe(2);
		expect(repo.apps[0]?.alertedAt).not.toBeNull();
	});

	it("marks a blocked source needs_human and keeps scanning", async () => {
		const { repo, deps } = setup([]);
		repo.addCompany({
			name: "Blocked",
			source: "scrape",
			sourceKey: "https://blocked.example/careers",
		});
		deps.sources.scrape = {
			kind: "scrape",
			listJobs: async () => {
				throw new SourceBlockedError(
					"https://blocked.example/careers",
					"Cloudflare challenge",
				);
			},
		};
		const result = await runScanFlow(new LocalStep(), deps, {
			userId: "u1",
			trigger: "cli",
		});
		expect(result.companies.find((c) => c.name === "Blocked")?.problem).toMatch(
			/blocked/i,
		);
		expect(repo.companies.find((c) => c.name === "Blocked")?.health).toBe(
			"needs_human",
		);
	});

	it("starts workflows in batches of at most 100", async () => {
		const jobs = Array.from({ length: 230 }, (_, i) =>
			posting({
				externalId: `j${i}`,
				url: `https://boards.greenhouse.io/acme/jobs/j${i}`,
				title: "Account Executive",
			}),
		);
		const { deps } = setup(jobs);
		const sizes: number[] = [];
		const inner = deps.workflows;
		deps.workflows = {
			runtime: "local",
			status: (jobId) => inner.status(jobId),
			restart: (params) => inner.restart(params),
			startBatch: async (params) => {
				sizes.push(params.length);
				return inner.startBatch(params);
			},
		};
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		expect(sizes).toEqual([100, 100, 30]);
		// Every job is scored now (no rule rejects one first): 230 fake scorings.
	}, 30_000);

	it("derives instance ids from job ids within Cloudflare's 100-character limit", () => {
		const id = applicationInstanceId("0b7d0d2c-5a6e-4f7a-9a39-0c2f8f1b2c3d");
		expect(id).toBe("job-0b7d0d2c-5a6e-4f7a-9a39-0c2f8f1b2c3d");
		expect(id.length).toBeLessThanOrEqual(100);
		expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});

/** A FlowStep whose waits time out, like Cloudflare's waitForEvent after its timeout. */
class TimeoutStep extends LocalStep implements FlowStep {
	override async waitForEvent<T>(): Promise<{ payload: T }> {
		throw new Error("WorkflowTimeoutError: waitForEvent timed out");
	}
}

describe("application flow waits", () => {
	it("moves to expired on timeout and never to approved", async () => {
		const { repo, deps } = setup([posting({})]);
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		const app = repo.apps[0];
		expect(app?.state).toBe("ready_for_review");
		const outcome = await runApplicationFlow(new TimeoutStep(), deps, {
			userId: "u1",
			jobId: app?.jobId ?? "",
		});
		expect(outcome).toEqual({ outcome: "finished", state: "expired" });
		expect(repo.transitions.map((t) => t.to)).not.toContain("approved");
		expect(repo.transitions.at(-1)).toMatchObject({
			from: "ready_for_review",
			to: "expired",
		});
	});

	it("does not expire an application the user moved on while the wait timed out", async () => {
		const { repo, deps } = setup([posting({})]);
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		const found = repo.apps[0];
		if (!found) throw new Error("no app");
		const app = found;
		let raced = false;
		class RacingStep extends LocalStep {
			override async waitForEvent<T>(name: string): Promise<{ payload: T }> {
				if (raced) throw new FlowPaused(name);
				raced = true;
				// The user rejects it just as the review wait times out.
				app.state = "rejected";
				throw new Error("timeout");
			}
		}
		const outcome = await runApplicationFlow(new RacingStep(), deps, {
			userId: "u1",
			jobId: app.jobId,
		});
		expect(app.state).toBe("rejected");
		expect(outcome).toEqual({ outcome: "finished", state: "rejected" });
	});

	it("ignores a duplicate event delivery", async () => {
		const repo = new MemoryRepo();
		repo.addEvent("e1", "u1", "a1");
		expect(await repo.consumeEvent("u1", "a1", "e1")).toBe(true);
		expect(await repo.consumeEvent("u1", "a1", "e1")).toBe(false);
	});

	it("needs an approval matching the current documents to enter applying", async () => {
		const repo = new MemoryRepo();
		repo.apps.push({
			id: "a",
			userId: "u1",
			jobId: "j",
			state: "ready_for_review",
			filter: null,
			fit: null,
			endedReason: null,
			alertedAt: null,
			workflowStarted: true,
		});
		const doc = { userId: "u1", applicationId: "a", kind: "cv" };
		repo.documents.push({ ...doc, version: 1, content: "# CV v1" });
		expect(await repo.approve("u1", "a")).toBe(true);
		// An edit after approval: the state still says approved, but the hashes no longer match.
		repo.documents.push({ ...doc, version: 2, content: "# CV v2" });
		expect(await repo.checkApproval("u1", "a")).toMatchObject({
			ok: false,
			reason: "cv changed after approval",
		});
		await expect(
			repo.transition("u1", "a", {
				from: ["approved"],
				to: "applying",
				reason: "x",
			}),
		).rejects.toThrow(/no approval matching/);
		expect(await repo.getState("u1", "a")).toBe("approved");
		// Approving the edited version lets the transition through.
		await repo.transition("u1", "a", {
			from: ["approved"],
			to: "ready_for_review",
			reason: "edited",
		});
		expect(repo.approvals.every((x) => x.revoked)).toBe(true);
		await repo.approve("u1", "a");
		expect(
			await repo.transition("u1", "a", {
				from: ["approved"],
				to: "applying",
				reason: "x",
			}),
		).toBe(true);
	});
});

describe("owner scoping", () => {
	it("fails a workflow given user A with user B's job and leaves B's rows untouched", async () => {
		const { repo, deps } = setup([]);
		const other = repo.addCompany(
			{ name: "Other", source: "greenhouse", sourceKey: "other" },
			"u2",
		);
		const { jobId } = await repo.upsertJob("u2", other.id, posting({}));
		const before = structuredClone(repo.apps);
		await expect(
			runApplicationFlow(new LocalStep(), deps, { userId: "u1", jobId }),
		).rejects.toThrow(/owned by user u1/);
		expect(repo.apps).toEqual(before);
		expect(repo.transitions).toHaveLength(0);
	});

	it("ignores another user's ids on every write", async () => {
		const { repo } = setup([]);
		const other = repo.addCompany(
			{ name: "Other", source: "greenhouse", sourceKey: "other" },
			"u2",
		);
		const { jobId } = await repo.upsertJob("u2", other.id, posting({}));
		const app = repo.apps.find((a) => a.jobId === jobId);
		if (!app) throw new Error("no app");
		repo.addEvent("e2", "u2", app.id);
		expect(await repo.getState("u1", app.id)).toBeNull();
		expect(await repo.claimAlert("u1", app.id)).toBe(false);
		expect(
			await repo.transition("u1", app.id, {
				from: ["found"],
				to: "scored",
				reason: "x",
			}),
		).toBe(false);
		expect(await repo.consumeEvent("u1", app.id, "e2")).toBe(false);
		await expect(repo.upsertJob("u1", other.id, posting({}))).rejects.toThrow(
			/not owned/,
		);
		expect(app.state).toBe("found");
	});
});
