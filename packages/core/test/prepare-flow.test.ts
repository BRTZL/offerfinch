import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareApproval, hashDocuments } from "../src/domain/approval";
import type { NormalizedJob } from "../src/domain/types";
import type { FilterSettings } from "../src/filter/settings";
import { NoopNotifier } from "../src/notify/ntfy";
import { runApplicationFlow } from "../src/pipeline/application-flow";
import { LocalStep, LocalWorkflowStarter } from "../src/pipeline/local";
import type { PipelineDeps } from "../src/pipeline/ports";
import { runScanFlow } from "../src/pipeline/scan-flow";
import { loadProfileFromDir } from "../src/profile/load-node";
import { FakeLlmProvider, heuristicFitResponder } from "../src/scoring/fake";
import type { GenerateObjectRequest } from "../src/scoring/llm";
import { fakeClaimsResponder, fakeTailorResponder } from "../src/tailor/fake";
import type { TailorOutput } from "../src/tailor/tailor";
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
		"Requirements\n- TypeScript and React with Next.js\n- Node.js and PostgreSQL\n- Go is a plus\nPlease tell us your notice period.",
};

async function setup(
	llm = new FakeLlmProvider(),
	settings: Partial<FilterSettings> = {},
	claimsLlm = new FakeLlmProvider(),
	profile = PROFILE,
	onDemand = false,
) {
	const repo = new MemoryRepo(structuredClone(profile));
	repo.onDemand = onDemand;
	repo.settings = { ...repo.settings, ...settings };
	repo.addCompany({
		name: "Acme Robotics",
		source: "greenhouse",
		sourceKey: "acme",
	});
	const exported: string[] = [];
	const workflows = new LocalWorkflowStarter();
	const deps: PipelineDeps = {
		repo,
		sources: {
			greenhouse: { kind: "greenhouse", listJobs: async () => [POSTING] },
		},
		llm,
		claimsLlm,
		exporter: fakeExporter(exported),
		now: () => new Date("2026-10-30T12:00:00Z"),
		notifier: new NoopNotifier(),
		workflows,
	};
	workflows.bind(deps);
	await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
	const app = repo.apps[0];
	if (!app) throw new Error("no application");
	// Locally, delivering an event means running the same flow again; Postgres decides.
	const wake = () =>
		runApplicationFlow(new LocalStep(), deps, {
			userId: "u1",
			jobId: app.jobId,
		});
	return { repo, deps, app, wake, exported };
}

function answer(repo: MemoryRepo, appId: string, text: string) {
	for (const q of repo.questions) {
		q.status = "answered";
		q.answer = text;
	}
	repo.profile?.files.push({
		path: "answers.md",
		content: `# Answers\n\n## Answer to a question from tailoring\n\n- Question asked (the pipeline's wording, not evidence): ${repo.questions[0]?.question}\n- Answer: ${text}\n- Source: dashboard question inbox, 2026-10-30\n`,
	});
	return repo.transition("u1", appId, {
		from: ["needs_answers"],
		to: "preparing",
		reason: "answered",
	});
}

const latest = (repo: MemoryRepo, kind: string) =>
	repo.documents.filter((d) => d.kind === kind).at(-1);

describe("review retries", () => {
	it("resumes a review whose export failed, without a second claims check or a stuck approval", async () => {
		const claimsLlm = new FakeLlmProvider();
		const exported: string[] = [];
		let failures = 1;
		const flaky = fakeExporter(exported);
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
				greenhouse: {
					kind: "greenhouse",
					listJobs: async () => [
						{
							...POSTING,
							descriptionText: POSTING.descriptionText.replace(
								"Please tell us your notice period.",
								"",
							),
						},
					],
				},
			},
			llm: new FakeLlmProvider(),
			claimsLlm,
			exporter: async (input) => {
				if (failures-- > 0) throw new Error("Browser Run: session closed");
				return flaky(input);
			},
			now: () => new Date("2026-10-30T12:00:00Z"),
			notifier: new NoopNotifier(),
			workflows,
		};
		workflows.bind(deps);
		await runScanFlow(new LocalStep(), deps, { userId: "u1", trigger: "cli" });
		const app = repo.apps[0];
		expect(app?.state).toBe("ready_for_review");
		expect(repo.reviews).toHaveLength(1);
		expect(repo.reviews[0]).toMatchObject({ passed: true, atsChecked: true });
		expect(exported).toEqual(["cv-v1", "cover_letter-v1"]);
		expect(
			claimsLlm.calls.filter((c) => c.task === "claims-check"),
		).toHaveLength(1);
	});
});

describe("phase 2 application flow", () => {
	it("asks, resumes, reviews, blocks a planted claim, approves and stops at the apply stub", async () => {
		const { repo, app, wake, exported } = await setup();

		// A fact the profile lacks pauses the application with a question.
		expect(app.state).toBe("needs_answers");
		expect(repo.questions.map((q) => q.question)).toEqual([
			"What is your notice period?",
		]);

		// The answer goes to the profile and tailoring resumes.
		await answer(repo, app.id, "Four weeks from signing the offer.");
		expect(await wake()).toMatchObject({
			outcome: "paused",
			state: "ready_for_review",
		});
		expect(app.state).toBe("ready_for_review");
		expect(
			JSON.parse(latest(repo, "form_answers")?.content ?? "[]"),
		).toContainEqual({
			question: "What is your notice period?",
			answer: "Four weeks from signing the offer.",
		});
		expect((await repo.latestReview("u1", app.id))?.passed).toBe(true);
		expect(exported).toEqual(["cv-v2", "cover_letter-v2"]);

		// A duplicate event changes nothing: no new draft, no new review.
		const counts = () => [repo.documents.length, repo.reviews.length];
		const before = counts();
		await wake();
		expect(counts()).toEqual(before);

		// The user plants an invented claim in the CV: the re-review blocks it.
		const cv = latest(repo, "cv")?.content ?? "";
		repo.addVersion(
			"u1",
			app.id,
			"cv",
			cv.replace(
				"## Skills",
				"- Led a team of 40 engineers building Kubernetes operators at Google.\n\n## Skills",
			),
		);
		await wake();
		const blocked = await repo.latestReview("u1", app.id);
		expect(blocked?.passed).toBe(false);
		expect(blocked?.issues).toContainEqual(
			expect.objectContaining({
				rule: "unsupported_claim",
				excerpt:
					"Led a team of 40 engineers building Kubernetes operators at Google.",
			}),
		);
		expect(app.state).toBe("ready_for_review");

		// Removing it passes review again; the user approves those exact documents.
		repo.addVersion("u1", app.id, "cv", cv);
		await wake();
		expect((await repo.latestReview("u1", app.id))?.passed).toBe(true);
		await repo.approve("u1", app.id);

		// Without submission configured (no `apply` deps), approved just waits.
		expect(await wake()).toMatchObject({
			outcome: "paused",
			state: "approved",
		});
		expect(repo.transitions.map((t) => t.to)).not.toContain("applying");

		// An edit after approval sends it back to review and revokes the approval.
		repo.addVersion(
			"u1",
			app.id,
			"cover_letter",
			`${latest(repo, "cover_letter")?.content}\n`,
		);
		await repo.transition("u1", app.id, {
			from: ["approved"],
			to: "ready_for_review",
			reason: "cover letter edited after approval",
		});
		expect(repo.approvals.every((a) => a.revoked)).toBe(true);
		expect((await repo.checkApproval("u1", app.id)).ok).toBe(false);
		await wake();
		expect(app.state).toBe("ready_for_review");
	});

	it("re-drafts a failing draft once, then hands it to review with its flags instead of asking or failing", async () => {
		const inventing = new FakeLlmProvider({
			"fit-score": heuristicFitResponder,
			tailor: (request: GenerateObjectRequest<unknown>) => {
				const draft = fakeTailorResponder(request) as TailorOutput;
				return {
					...draft,
					missingFacts: [],
					cv: draft.cv.replace(
						"## Skills",
						"- Ran Kubernetes clusters for 300 services at Google.\n\n## Skills",
					),
				};
			},
		});
		const claimsLlm = new FakeLlmProvider();
		const { repo, app } = await setup(inventing, {}, claimsLlm);
		expect(app.state).toBe("ready_for_review");
		expect(app.prepareAttempts).toBe(2);
		// Two drafts; the second was identical, so its review was reused, not paid for twice.
		expect(inventing.calls.filter((c) => c.task === "tailor")).toHaveLength(2);
		expect(
			claimsLlm.calls.filter((c) => c.task === "claims-check"),
		).toHaveLength(1);
		expect(repo.reviews).toHaveLength(1);
		const review = repo.reviews[0];
		expect(review).toMatchObject({ passed: false, status: "claims_flagged" });
		expect(review?.flags).toContainEqual(
			expect.objectContaining({
				document: "cv",
				text: "Ran Kubernetes clusters for 300 services at Google.",
				state: "open",
				confirmable: true,
			}),
		);
		expect(repo.questions).toEqual([]);
		expect(repo.transitions.map((t) => t.to)).not.toContain("failed");
		expect(repo.transitions.at(-1)?.reason).toMatch(
			/^The claims check still flags \d+ line\(s\) after 2 drafts/,
		);
	});
});

describe("one question round per application (Tessera, 2026-10-31)", () => {
	const answered = (request: GenerateObjectRequest<unknown>) =>
		JSON.stringify(request.context).includes("Four weeks");

	it("drafts after the answers without asking new questions, and names them as gaps", async () => {
		const llm = new FakeLlmProvider({
			"fit-score": heuristicFitResponder,
			tailor: (request: GenerateObjectRequest<unknown>) => {
				const draft = fakeTailorResponder(request) as TailorOutput;
				if (!answered(request)) return draft;
				return {
					...draft,
					missingFacts: [
						{
							question:
								"Have you built any invoicing or multi-currency features?",
							why: "The posting asks for invoicing.",
							requirement: "must_have" as const,
						},
					],
				};
			},
		});
		const { repo, app, wake } = await setup(llm);
		expect(app.state).toBe("needs_answers");
		await answer(repo, app.id, "Four weeks from signing the offer.");
		await wake();

		expect(app.state).toBe("ready_for_review");
		expect(repo.questions.map((q) => q.question)).toEqual([
			"What is your notice period?",
		]);
		expect(latest(repo, "notes")?.content).toContain(
			"## Not asked\n\n- Have you built any invoicing or multi-currency features? (no question round left; left out and named as a gap)",
		);
		// The second draft was told what was asked, and that it may ask nothing.
		const prompts = llm.calls.filter((c) => c.task === "tailor");
		expect(prompts.at(-1)?.prompt).toContain(
			"<questions_allowed>0</questions_allowed>",
		);
		expect(prompts.at(-1)?.prompt).toContain(
			"- What is your notice period? — answered: Four weeks from signing the offer.",
		);
	});

	it("after the answer round: two checked drafts at most, then the flagged review", async () => {
		let drafts = 0;
		const llm = new FakeLlmProvider({
			"fit-score": heuristicFitResponder,
			tailor: (request: GenerateObjectRequest<unknown>) => {
				const draft = fakeTailorResponder(request) as TailorOutput;
				if (!answered(request)) return draft;
				return {
					...draft,
					cv: draft.cv.replace(
						"## Skills",
						`- Ran Kubernetes clusters for ${300 + ++drafts} services at Google.\n\n## Skills`,
					),
				};
			},
		});
		const claimsLlm = new FakeLlmProvider();
		const { repo, app, wake } = await setup(llm, {}, claimsLlm);
		await answer(repo, app.id, "Four weeks from signing the offer.");
		await wake();

		expect(app.state).toBe("ready_for_review");
		expect(repo.questions).toHaveLength(1);
		// The draft that asked, then two checked drafts (different each time, so two checks).
		expect(llm.calls.filter((c) => c.task === "tailor")).toHaveLength(3);
		expect(
			claimsLlm.calls.filter((c) => c.task === "claims-check"),
		).toHaveLength(2);
		expect((await repo.latestReview("u1", app.id))?.status).toBe(
			"claims_flagged",
		);
	});
});

describe("failed is for real errors", () => {
	it("fails the application when the claims provider keeps failing", async () => {
		const broken = new FakeLlmProvider({
			"claims-check": () => {
				throw new Error("upstream 503");
			},
		});
		const { app } = await setup(
			new FakeLlmProvider({
				"fit-score": heuristicFitResponder,
				tailor: (request: GenerateObjectRequest<unknown>) => ({
					...(fakeTailorResponder(request) as TailorOutput),
					missingFacts: [],
				}),
			}),
			{},
			broken,
		);
		expect(app.state).toBe("failed");
		// One call per try: the review step's two retries included.
		expect(broken.calls.filter((c) => c.task === "claims-check")).toHaveLength(
			3,
		);
	});
});

describe("an edit in review re-checks only the lines that changed", () => {
	it("checks the new line alone in its context, keeps the other flags, and clears a deleted line's", async () => {
		const llm = new FakeLlmProvider({
			"fit-score": heuristicFitResponder,
			tailor: (request: GenerateObjectRequest<unknown>) => {
				const draft = fakeTailorResponder(request) as TailorOutput;
				return {
					...draft,
					missingFacts: [],
					cv: draft.cv.replace(
						"## Skills",
						"- Ran Kubernetes clusters for 300 services at Google.\n- Wrote the Linux kernel's scheduler.\n\n## Skills",
					),
				};
			},
		});
		const claimsLlm = new FakeLlmProvider();
		const { repo, app, wake } = await setup(llm, {}, claimsLlm);
		expect(app.state).toBe("ready_for_review");
		const flagged = await repo.latestReview("u1", app.id);
		const open = (r: typeof flagged) =>
			(r?.flags ?? []).filter((f) => f.state === "open").map((f) => f.text);
		expect(open(flagged)).toEqual(
			expect.arrayContaining([
				"Ran Kubernetes clusters for 300 services at Google.",
				"Wrote the Linux kernel's scheduler.",
			]),
		);
		const checks = () =>
			claimsLlm.calls.filter((c) => c.task === "claims-check");
		const before = checks().length;
		const tailored = llm.calls.filter((c) => c.task === "tailor").length;

		// Edit one flagged line to something else that is still unsupported.
		const cv = latest(repo, "cv")?.content ?? "";
		repo.addVersion(
			"u1",
			app.id,
			"cv",
			cv.replace(
				"Ran Kubernetes clusters for 300 services at Google.",
				"Ran Nomad clusters at Google.",
			),
		);
		await wake();
		expect(checks()).toHaveLength(before + 1);
		// The whole documents go as context; only the changed line is listed to check.
		const sent = checks().at(-1)?.prompt ?? "";
		const listed = sent.slice(sent.indexOf("<segments>"));
		expect(listed).toMatch(
			/<segments>\n\[cv-\d+\] Ran Nomad clusters at Google\.\n<\/segments>/,
		);
		expect(sent).toContain("Wrote the Linux kernel");
		expect(sent).toContain("Dear Hiring Team");
		const edited = await repo.latestReview("u1", app.id);
		expect(edited?.status).toBe("claims_flagged");
		expect(open(edited)).toEqual(
			expect.arrayContaining([
				"Ran Nomad clusters at Google.",
				"Wrote the Linux kernel's scheduler.",
			]),
		);
		expect(open(edited)).not.toContain(
			"Ran Kubernetes clusters for 300 services at Google.",
		);

		// Deleting both lines needs no model call and passes.
		repo.addVersion(
			"u1",
			app.id,
			"cv",
			cv
				.replace("- Ran Kubernetes clusters for 300 services at Google.\n", "")
				.replace("- Wrote the Linux kernel's scheduler.\n", ""),
		);
		await wake();
		expect(checks()).toHaveLength(before + 1);
		expect(await repo.latestReview("u1", app.id)).toMatchObject({
			passed: true,
			status: "passed",
			atsChecked: true,
		});
		// No re-tailoring at any point.
		expect(llm.calls.filter((c) => c.task === "tailor")).toHaveLength(tailored);
	});
});

describe("tailoring on demand (PLAN A)", () => {
	/** A weak match: the fake's evidence-free "met" is downgraded, so it scores low. */
	const halfFit = () =>
		new FakeLlmProvider({
			"fit-score": () => ({
				requirements: [
					{
						requirement: "TypeScript",
						importance: "must",
						status: "met",
						evidence: [],
						note: "",
					},
					{
						requirement: "Elixir",
						importance: "must",
						status: "not_met",
						evidence: [],
						note: "",
					},
				],
				summary: "Half.",
			}),
			tailor: fakeTailorResponder,
		});

	it("lists a match without tailoring it until the user presses Prepare", async () => {
		const llm = halfFit();
		const { repo, app, wake } = await setup(
			llm,
			{ minScore: 0 },
			new FakeLlmProvider(),
			PROFILE,
			true,
		);
		expect(app.state).toBe("scored");
		expect(app.endedReason).toBeNull();
		expect(llm.calls.map((c) => c.task)).toEqual(["fit-score"]);
		expect(repo.documents).toEqual([]);
		// Woken without a Prepare (an unrelated event), it still waits and pays for nothing.
		await wake();
		expect(app.state).toBe("scored");
		expect(llm.calls.map((c) => c.task)).toEqual(["fit-score"]);

		repo.requestPrepare(app.id);
		await wake();
		expect(app.state).not.toBe("scored");
		expect(llm.calls.map((c) => c.task)).toContain("tailor");
	});

	it("ends only a match below the minimum fit, never one below an old preparing minimum", async () => {
		const llm = halfFit();
		const { app } = await setup(
			llm,
			{ minScore: 0, prepareMinScore: 100 },
			new FakeLlmProvider(),
			PROFILE,
			true,
		);
		expect(app.state).toBe("scored");
		expect(app.endedReason).toBeNull();
	});
});

describe("Prepare anyway (a job the user added and chose on purpose)", () => {
	it("scores and drafts a job the filter set aside, its filter result kept", async () => {
		const llm = new FakeLlmProvider();
		const { repo, app, wake } = await setup(
			llm,
			{
				// Living and working elsewhere only, so the job's place sets it aside.
				livesIn: "Japan",
				rightToWork: ["Japan"],
				keepOnsiteIn: [],
				keepRemoteFromHome: false,
				keepGlobalRemote: false,
			},
			new FakeLlmProvider(),
			PROFILE,
			true,
		);
		expect(app.state).toBe("rejected_by_filter");
		expect(llm.calls).toEqual([]);
		// What the app's Prepare anyway does: back to found, chosen, preparation requested.
		repo.chosen.add(app.id);
		repo.requestPrepare(app.id);
		app.state = "found";
		await wake();
		expect(app.filter?.decision).toBe("reject");
		expect(app.endedReason).toBeNull();
		expect(llm.calls.map((c) => c.task)).toEqual(
			expect.arrayContaining(["fit-score", "tailor"]),
		);
		expect(app.state).not.toBe("rejected_by_filter");
	});
});

describe("an edit in review is checked in its section (Codex, 2026-10-31)", () => {
	/** The first bullet under the role whose heading ends with `company`. */
	const firstBullet = (cv: string, company: string) => {
		const lines = cv.split("\n");
		const at = lines.findIndex(
			(l) => l.startsWith("### ") && l.endsWith(company),
		);
		return lines.slice(at + 1).find((l) => l.startsWith("- ")) ?? "";
	};

	it("re-checks bullets swapped between employers and flags evidence from the other employer", async () => {
		const llm = new FakeLlmProvider({
			"fit-score": heuristicFitResponder,
			tailor: (request: GenerateObjectRequest<unknown>) => ({
				...(fakeTailorResponder(request) as TailorOutput),
				missingFacts: [],
			}),
		});
		const claimsLlm = new FakeLlmProvider();
		const { repo, app, wake } = await setup(llm, {}, claimsLlm);
		expect(app.state).toBe("ready_for_review");
		expect((await repo.latestReview("u1", app.id))?.passed).toBe(true);
		const cv = latest(repo, "cv")?.content ?? "";
		const brightloom = firstBullet(cv, "Brightloom");
		const corvid = firstBullet(cv, "Corvid AI");
		expect(brightloom).not.toBe("");
		expect(corvid).not.toBe("");
		const checks = () =>
			claimsLlm.calls.filter((c) => c.task === "claims-check").length;
		const before = checks();

		// Same lines, same documents, each under the other employer.
		const swapped = cv
			.replace(brightloom, "\u0000")
			.replace(corvid, brightloom)
			.replace("\u0000", corvid);
		repo.addVersion("u1", app.id, "cv", swapped);
		await wake();

		expect(checks()).toBe(before + 1);
		const review = await repo.latestReview("u1", app.id);
		expect(review?.passed).toBe(false);
		const open = (review?.flags ?? [])
			.filter((f) => f.state === "open")
			.map((f) => f.text);
		expect(open).toEqual(
			expect.arrayContaining([brightloom.slice(2), corvid.slice(2)]),
		);
	});
});

describe("a check that keeps failing in review (Codex, 2026-10-31)", () => {
	it("records the error for that version instead of leaving it checking, and a retry resumes the check without a redraft", async () => {
		const llm = new FakeLlmProvider({
			"fit-score": heuristicFitResponder,
			tailor: (request: GenerateObjectRequest<unknown>) => ({
				...(fakeTailorResponder(request) as TailorOutput),
				missingFacts: [],
			}),
		});
		let failing = false;
		const claimsLlm = new FakeLlmProvider({
			"claims-check": (request: GenerateObjectRequest<unknown>) => {
				if (failing) throw new Error("claims provider HTTP 503");
				return fakeClaimsResponder(request);
			},
		});
		const { repo, app, wake } = await setup(llm, {}, claimsLlm);
		expect(app.state).toBe("ready_for_review");
		const tailored = llm.calls.filter((c) => c.task === "tailor").length;
		const cv = latest(repo, "cv")?.content ?? "";
		repo.addVersion(
			"u1",
			app.id,
			"cv",
			cv.replace("## Skills", "- Wrote Go services.\n\n## Skills"),
		);

		failing = true;
		await expect(wake()).resolves.toBeDefined();
		const error = repo.checkErrors.get(app.id);
		expect(error?.message).toContain("HTTP 503");
		const docs = await repo.latestDocuments("u1", app.id);
		// The documents, and the posting they answer.
		expect(error?.hashes).toEqual({
			...(await hashDocuments(docs)),
			posting: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(app.state).toBe("ready_for_review");
		// No review passed for this version, so it cannot be approved.
		const review = await repo.latestReview("u1", app.id);
		expect(
			compareApproval(review?.documentHashes ?? {}, error?.hashes ?? {}).ok,
		).toBe(false);

		// Retry: the same version is checked again, with no new draft.
		failing = false;
		await wake();
		expect(repo.checkErrors.get(app.id)).toBeNull();
		const after = await repo.latestReview("u1", app.id);
		expect(
			compareApproval(after?.documentHashes ?? {}, error?.hashes ?? {}).ok,
		).toBe(true);
		expect(llm.calls.filter((c) => c.task === "tailor")).toHaveLength(tailored);
	});
});
