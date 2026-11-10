import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportInput } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import { LocalWorkflowStarter } from "@offerfinch/core/pipeline/local";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { loadProfileFromDir } from "@offerfinch/core/profile/load-node";
import {
	FakeLlmProvider,
	heuristicFitResponder,
} from "@offerfinch/core/scoring/fake";
import {
	type GenerateObjectRequest,
	LlmPausedError,
} from "@offerfinch/core/scoring/llm";
import {
	fakeClaimsResponder,
	fakeTailorResponder,
} from "@offerfinch/core/tailor/fake";
import type { TailorOutput } from "@offerfinch/core/tailor/tailor";
import {
	DashboardRepository,
	DrizzlePipelineRepository,
	importProfile,
	seedCompanies,
} from "@offerfinch/db";
import {
	applications,
	approvals,
	companies,
	jobs,
} from "@offerfinch/db/schema/pipeline";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestApp, type TestApp, type TestUser } from "./support/api";

/**
 * Redraft (docs/decisions.md, 2026-11-03): a new version of only the chosen documents, the
 * instruction in the tailoring prompt as the user's preference, the check run on the new version,
 * approval withdrawn, and refusals while drafting or checking, once submitted and when closed.
 */

const FIXTURES = join(import.meta.dirname, "../../core/test/fixtures");
let t: TestApp;
let a: TestUser;
let repo: DrizzlePipelineRepository;
let workflows: LocalWorkflowStarter;
let tailor: FakeLlmProvider;
let claims: FakeLlmProvider;
let paused = false;
let jobId = "";
let appId = "";

const deliver = () => workflows.restart({ userId: a.id, jobId });
const view = () => a.rpc.application.get({ id: appId });
const docs = async () =>
	Object.fromEntries((await view()).documents.map((d) => [d.kind, d]));
const tailorCalls = () => tailor.calls.filter((c) => c.task === "tailor");
const claimsCalls = () => claims.calls.filter((c) => c.task === "claims-check");

beforeAll(async () => {
	t = await startTestApp("redraft");
	a = await t.user("redraft-a");
	repo = new DrizzlePipelineRepository(t.db);
	workflows = new LocalWorkflowStarter();
	tailor = new FakeLlmProvider({
		"fit-score": heuristicFitResponder,
		tailor: (request: GenerateObjectRequest<unknown>) => {
			if (paused) throw new LlmPausedError("Claude plan usage limit reached");
			return {
				...(fakeTailorResponder(request) as TailorOutput),
				missingFacts: [],
			};
		},
	});
	claims = new FakeLlmProvider({ "claims-check": fakeClaimsResponder });
	const deps: PipelineDeps = {
		repo,
		sources: {},
		llm: tailor,
		claimsLlm: claims,
		notifier: new NoopNotifier(),
		workflows,
		exporter: async (input: ExportInput) => ({
			records: input.documents.map((d) => ({
				kind: d.kind,
				format: "pdf" as const,
				sourceVersion: d.version,
				storageKey: `users/${input.userId}/applications/${input.applicationId}/${d.kind}-v${d.version}.pdf`,
				meta: {},
			})),
			atsIssues: [],
		}),
	};
	workflows.bind(deps);
	await importProfile(
		t.db,
		a.id,
		await loadProfileFromDir(join(FIXTURES, "desktop-profile")),
		"fixtures/profile",
	);
	await seedCompanies(t.db, a.id, [
		{
			name: "Acme Robotics",
			source: "greenhouse",
			sourceKey: "acme-redraft",
			discoveredFrom: "test",
		},
	]);
	const [company] = await t.db
		.select({ id: companies.id })
		.from(companies)
		.where(eq(companies.userId, a.id));
	({ jobId } = await repo.upsertJob(a.id, company?.id ?? "", {
		source: "greenhouse",
		externalId: "acme-redraft",
		url: "https://example.invalid/acme/redraft",
		title: "Senior Full-Stack Engineer",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		descriptionText: readFileSync(
			join(FIXTURES, "acme-senior-fullstack.txt"),
			"utf8",
		),
	}));
	await workflows.startBatch([{ userId: a.id, jobId }]);
	const listed = await repo.getApplicationByJob(a.id, jobId);
	if (!listed) throw new Error("no application");
	await t.db
		.update(applications)
		.set({ prepareRequestedAt: new Date() })
		.where(eq(applications.id, listed.applicationId));
	await deliver();
	appId = (await repo.getApplicationByJob(a.id, jobId))?.applicationId ?? "";
});

afterAll(async () => {
	await t.close();
});

describe("Redraft", () => {
	it("redrafts the letter only, with the instruction in the prompt, and checks the new version", async () => {
		const ready = await view();
		expect(ready.state).toBe("ready_for_review");
		expect(ready.approvable).toBe(true);
		const before = await docs();
		const drafts = tailorCalls().length;
		const checks = claimsCalls().length;

		await a.rpc.application.redraft({
			id: appId,
			scope: "cover_letter",
			instruction: "  Shorter, and mention my Go work  ",
		});
		const pending = await view();
		expect(pending.redraft?.scope).toBe("cover_letter");
		expect(pending.redraft?.instruction).toBe(
			"Shorter, and mention my Go work",
		);
		// Approval waits for the redraft: the old version is no longer what the user wants.
		expect(pending.approvable).toBe(false);

		await deliver();
		const after = await docs();
		expect(after.cover_letter?.version).toBe(
			(before.cover_letter?.version ?? 0) + 1,
		);
		expect(after.cover_letter?.content).not.toBe(before.cover_letter?.content);
		for (const kind of ["cv", "form_answers", "notes"]) {
			expect(after[kind]?.version).toBe(before[kind]?.version);
			expect(after[kind]?.content).toBe(before[kind]?.content);
		}

		// One tailoring call, scoped to the letter, with the instruction as a preference.
		const calls = tailorCalls().slice(drafts);
		expect(calls).toHaveLength(1);
		const prompt = calls[0]?.prompt ?? "";
		expect(prompt).toContain(
			"<candidate_preference>\nShorter, and mention my Go work\n</candidate_preference>",
		);
		expect(prompt).toMatch(/a preference, never evidence/);
		expect(prompt).toContain("Write only the cover letter for this posting");
		expect(prompt).toContain('<current_version document="cover_letter">');
		expect(prompt).not.toContain('<current_version document="cv">');
		// The grounding rules are unchanged: the same system prompt as Prepare.
		expect(calls[0]?.system).toBe(tailorCalls()[0]?.system);

		// The independent check ran on the new version, which is back in review.
		expect(claimsCalls().length).toBeGreaterThan(checks);
		const checked = await view();
		expect(checked.state).toBe("ready_for_review");
		expect(checked.redraft).toBeNull();
		expect(checked.reviewCurrent).toBe(true);
		expect(checked.approvable).toBe(true);

		// Both letter versions stay readable; the new one says it was a redraft.
		const letters = checked.versions.filter((v) => v.kind === "cover_letter");
		expect(letters.map((v) => v.version)).toEqual([1, 2]);
		expect(letters[1]?.redraft).toEqual({
			scope: "cover_letter",
			instruction: "Shorter, and mention my Go work",
		});
		const first = await a.rpc.application.documentVersion({
			id: appId,
			kind: "cover_letter",
			version: 1,
		});
		expect(first.content).toBe(before.cover_letter?.content);
		expect(first.html).toContain("Dear Hiring Team");
	});

	it("redrafts the CV only; the letter and answers stay byte-identical", async () => {
		const before = await docs();
		await a.rpc.application.redraft({ id: appId, scope: "cv" });
		await deliver();
		const after = await docs();
		expect(after.cv?.version).toBe((before.cv?.version ?? 0) + 1);
		expect(after.cover_letter?.content).toBe(before.cover_letter?.content);
		expect(after.cover_letter?.version).toBe(before.cover_letter?.version);
		expect(after.form_answers?.content).toBe(before.form_answers?.content);
		expect(tailorCalls().at(-1)?.prompt).not.toContain(
			"<candidate_preference>",
		);
		expect((await view()).reviewCurrent).toBe(true);
	});

	it("keeps answers the user wrote unless asked to rewrite them too", async () => {
		const answers = (await docs()).form_answers;
		if (!answers) throw new Error("no answers");
		const parsed = JSON.parse(answers.content) as {
			question: string;
			answer: string;
		}[];
		const own = "Written by me, word for word.";
		await a.rpc.application.editDocument({
			id: appId,
			kind: "form_answers",
			content: JSON.stringify(
				parsed.map((x, i) => (i === 0 ? { ...x, answer: own } : x)),
				null,
				2,
			),
			baseVersion: answers.version,
		});
		await deliver();
		const edited = await view();
		expect(edited.ownAnswers).toEqual([parsed[0]?.question]);

		const cv = (await docs()).cv;
		await a.rpc.application.redraft({ id: appId, scope: "form_answers" });
		await deliver();
		const kept = await docs();
		expect(kept.form_answers?.version).toBe(answers.version + 2);
		expect(kept.form_answers?.content).toContain(own);
		expect(kept.cv?.content).toBe(cv?.content);

		await a.rpc.application.redraft({
			id: appId,
			scope: "form_answers",
			rewriteOwnAnswers: true,
		});
		await deliver();
		const rewritten = await docs();
		expect(rewritten.form_answers?.version).toBe(answers.version + 3);
		expect(rewritten.form_answers?.content).not.toContain(own);
		expect((await view()).ownAnswers).toEqual([]);
	});

	it("withdraws the approval of an approved application and returns it to review", async () => {
		const ready = await view();
		expect(ready.approvable).toBe(true);
		await a.rpc.application.approve({
			id: appId,
			hashes: ready.currentHashes,
			idempotencyKey: "approve-before-redraft",
		});
		expect((await view()).state).toBe("approved");
		const before = await docs();

		const result = await a.rpc.application.redraft({ id: appId, scope: "all" });
		expect(result.revoked).toBe(true);
		const moved = await view();
		expect(moved.state).toBe("ready_for_review");
		expect(moved.activeApproval).toBeNull();
		const [revoked] = await t.db
			.select()
			.from(approvals)
			.where(eq(approvals.applicationId, appId));
		expect(revoked?.revokedReason).toMatch(
			/Redraft of the CV, letter and answers requested; approval withdrawn/,
		);
		// The old version cannot be approved while the redraft is pending.
		await expect(
			a.rpc.application.approve({
				id: appId,
				hashes: moved.currentHashes,
				idempotencyKey: "approve-while-redrafting",
			}),
		).rejects.toThrow(/redraft is pending/);

		await deliver();
		const after = await docs();
		for (const kind of ["cv", "cover_letter", "form_answers"])
			expect(after[kind]?.version).toBe((before[kind]?.version ?? 0) + 1);
		expect(after.notes?.content).toBe(before.notes?.content);
		expect((await view()).approvable).toBe(true);
	});

	it("refuses while checking, while another redraft runs, and while drafting", async () => {
		const letter = (await docs()).cover_letter;
		if (!letter) throw new Error("no letter");
		await a.rpc.application.editDocument({
			id: appId,
			kind: "cover_letter",
			content: `${letter.content}\n`,
			baseVersion: letter.version,
		});
		await expect(
			a.rpc.application.redraft({ id: appId, scope: "cv" }),
		).rejects.toThrow(/still running/);
		await deliver();

		await a.rpc.application.redraft({ id: appId, scope: "cv" });
		await expect(
			a.rpc.application.redraft({ id: appId, scope: "cv" }),
		).rejects.toThrow(/already running/);
		expect(await a.rpc.application.cancelRedraft({ id: appId })).toEqual({
			cancelled: true,
		});
		const calls = tailorCalls().length;
		const cv = (await docs()).cv;
		await deliver();
		// Cancelled: no model call, no new version.
		expect(tailorCalls()).toHaveLength(calls);
		expect((await docs()).cv?.version).toBe(cv?.version);

		await t.db
			.update(applications)
			.set({ state: "preparing" })
			.where(eq(applications.id, appId));
		await expect(
			a.rpc.application.redraft({ id: appId, scope: "cv" }),
		).rejects.toThrow(/drafting is still running/);
		await t.db
			.update(applications)
			.set({ state: "ready_for_review" })
			.where(eq(applications.id, appId));
	});

	it("waits on a paused model with the documents unchanged, then runs on Try again", async () => {
		const before = await docs();
		paused = true;
		await a.rpc.application.redraft({ id: appId, scope: "cover_letter" });
		await deliver();
		const waiting = await view();
		expect(waiting.redraft?.problem).toMatchObject({
			kind: "paused",
			message: expect.stringMatching(/usage limit/),
		});
		expect((await docs()).cover_letter?.content).toBe(
			before.cover_letter?.content,
		);
		expect(waiting.approvable).toBe(false);

		paused = false;
		await a.rpc.application.retryRedraft({ id: appId });
		await expect(a.rpc.application.retryRedraft({ id: appId })).rejects.toThrow(
			/no stopped redraft/,
		);
		await deliver();
		expect((await docs()).cover_letter?.version).toBe(
			(before.cover_letter?.version ?? 0) + 1,
		);
		expect((await view()).redraft).toBeNull();
	});

	it("a redraft paused by a subscription waits for Try again, also when the spending limit changes", async () => {
		paused = true;
		await a.rpc.application.redraft({ id: appId, scope: "cv" });
		await deliver();
		expect((await view()).redraft?.problem?.kind).toBe("paused");
		paused = false;
		await new DashboardRepository(t.db).setSpendingCap(a.id, {
			enabled: true,
			monthlyCapMicros: 50_000_000,
		});
		await deliver();
		expect((await view()).redraft?.problem?.kind).toBe("paused");
		// Try again runs it.
		const before = (await docs()).cv?.version ?? 0;
		await a.rpc.application.retryRedraft({ id: appId });
		await deliver();
		expect((await docs()).cv?.version).toBe(before + 1);
		expect((await view()).redraft).toBeNull();
	});

	it("a redraft paused by the spending limit runs again when the limit changes", async () => {
		await a.rpc.application.redraft({ id: appId, scope: "cv" });
		const request = await repo.pendingRedraft(a.id, appId);
		if (!request) throw new Error("no request");
		await repo.setRedraftProblem(a.id, appId, request.id, {
			kind: "paused",
			message: "Monthly spending limit reached",
			at: new Date().toISOString(),
			spendingCap: true,
		});
		await new DashboardRepository(t.db).setSpendingCap(a.id, {
			enabled: true,
			monthlyCapMicros: 60_000_000,
		});
		expect((await view()).redraft?.problem).toBeUndefined();
		const before = (await docs()).cv?.version ?? 0;
		await deliver();
		expect((await docs()).cv?.version).toBe(before + 1);
		expect((await view()).redraft).toBeNull();
	});

	it("records a conflict instead of overwriting an edit made after the request", async () => {
		await a.rpc.application.redraft({ id: appId, scope: "cover_letter" });
		const letter = (await docs()).cover_letter;
		if (!letter) throw new Error("no letter");
		const mine = `${letter.content}\n`;
		await a.rpc.application.editDocument({
			id: appId,
			kind: "cover_letter",
			content: mine,
			baseVersion: letter.version,
		});
		await deliver();
		const after = await view();
		expect(after.redraft?.problem?.kind).toBe("conflict");
		expect((await docs()).cover_letter?.content).toBe(mine);
		await expect(a.rpc.application.retryRedraft({ id: appId })).rejects.toThrow(
			/cancel it and redraft again/,
		);
		await a.rpc.application.cancelRedraft({ id: appId });
		expect((await view()).redraft).toBeNull();
	});

	it("refuses for a closed posting and once the user marked it submitted", async () => {
		await t.db
			.update(jobs)
			.set({
				closedAt: new Date(),
				closedReason: "Greenhouse no longer lists it",
			})
			.where(eq(jobs.id, jobId));
		await expect(
			a.rpc.application.redraft({ id: appId, scope: "cv" }),
		).rejects.toThrow(/posting looks closed/);
		await t.db
			.update(jobs)
			.set({ closedAt: null, closedReason: null })
			.where(eq(jobs.id, jobId));

		const ready = await view();
		await a.rpc.application.approve({
			id: appId,
			hashes: ready.currentHashes,
			idempotencyKey: "approve-before-submitted",
		});
		await a.rpc.submission.markSubmitted({
			id: appId,
			attemptId: null,
			idempotencyKey: "submitted-by-hand",
		});
		expect((await view()).state).toBe("applied");
		await expect(
			a.rpc.application.redraft({ id: appId, scope: "cv" }),
		).rejects.toThrow(/marked this application submitted/);
	});
});
