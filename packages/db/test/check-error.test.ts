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
import type { GenerateObjectRequest } from "@offerfinch/core/scoring/llm";
import {
	fakeClaimsResponder,
	fakeTailorResponder,
} from "@offerfinch/core/tailor/fake";
import type { TailorOutput } from "@offerfinch/core/tailor/tailor";
import {
	DrizzlePipelineRepository,
	importProfile,
	seedCompanies,
} from "@offerfinch/db";
import {
	applications,
	approvals,
	companies,
} from "@offerfinch/db/schema/pipeline";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestApp, type TestApp, type TestUser } from "./support/api";

/**
 * Codex review, 2026-10-31: when the focused check of an edit kept failing after its retries,
 * the dashboard said "Checking…" forever. The error is now kept for that version and shown with
 * a retry that checks the same version again, without a redraft; approval stays refused.
 */

const FIXTURES = join(import.meta.dirname, "../../core/test/fixtures");
let t: TestApp;
let a: TestUser;
let repo: DrizzlePipelineRepository;
let workflows: LocalWorkflowStarter;
let tailor: FakeLlmProvider;
let failing = false;
let jobId = "";
let appId = "";

const deliver = () => workflows.restart({ userId: a.id, jobId });
const view = () => a.rpc.application.get({ id: appId });

beforeAll(async () => {
	t = await startTestApp("checkerror");
	a = await t.user("check-a");
	repo = new DrizzlePipelineRepository(t.db);
	workflows = new LocalWorkflowStarter();
	tailor = new FakeLlmProvider({
		"fit-score": heuristicFitResponder,
		tailor: (request: GenerateObjectRequest<unknown>) => ({
			...(fakeTailorResponder(request) as TailorOutput),
			missingFacts: [],
		}),
	});
	const deps: PipelineDeps = {
		repo,
		sources: {},
		llm: tailor,
		claimsLlm: new FakeLlmProvider({
			"claims-check": (request: GenerateObjectRequest<unknown>) => {
				if (failing) throw new Error("claims provider HTTP 503");
				return fakeClaimsResponder(request);
			},
		}),
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
			sourceKey: "acme-check-error",
			discoveredFrom: "test",
		},
	]);
	const [company] = await t.db
		.select({ id: companies.id })
		.from(companies)
		.where(eq(companies.userId, a.id));
	({ jobId } = await repo.upsertJob(a.id, company?.id ?? "", {
		source: "greenhouse",
		externalId: "acme-check-error",
		url: "https://example.invalid/acme/check-error",
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
	await workflows.restart({ userId: a.id, jobId });
	appId = (await repo.getApplicationByJob(a.id, jobId))?.applicationId ?? "";
});

afterAll(async () => {
	await t.close();
});

describe("a check that keeps failing in review", () => {
	it("shows the error for that version, refuses approval, and a retry checks it again without a redraft", async () => {
		const ready = await view();
		expect(ready.state).toBe("ready_for_review");
		expect(ready.approvable).toBe(true);
		const tailored = tailor.calls.filter((c) => c.task === "tailor").length;
		const letter = ready.documents.find((d) => d.kind === "cover_letter");
		if (!letter) throw new Error("no letter");
		// Split a paragraph in two: the same true sentences in new paragraphs, checked again.
		const paragraph =
			letter.content
				.split("\n\n")
				.find((p) => !p.startsWith("Dear") && /\. [A-Z]/.test(p)) ?? "";
		expect(paragraph).not.toBe("");

		failing = true;
		await a.rpc.application.editDocument({
			id: appId,
			kind: "cover_letter",
			content: letter.content.replace(
				paragraph,
				paragraph.replace(/\. ([A-Z])/, ".\n\n$1"),
			),
			baseVersion: letter.version,
		});
		await deliver();
		const stuck = await view();
		expect(stuck.reviewCurrent).toBe(false);
		expect(stuck.checkError?.message).toContain("HTTP 503");
		expect(stuck.approvable).toBe(false);

		const response = await a.request("/rpc/application/approve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				json: {
					id: appId,
					hashes: stuck.currentHashes,
					idempotencyKey: "approve-while-check-failed",
				},
			}),
		});
		expect(response.status).toBe(409);
		expect(await t.db.select().from(approvals)).toEqual([]);

		failing = false;
		await a.rpc.application.retryCheck({ id: appId });
		// A second click finds no error to retry.
		await expect(a.rpc.application.retryCheck({ id: appId })).rejects.toThrow(
			/no check error/,
		);
		await deliver();
		const checked = await view();
		expect(checked.checkError).toBeNull();
		expect(checked.reviewCurrent).toBe(true);
		expect(checked.approvable).toBe(true);
		expect(tailor.calls.filter((c) => c.task === "tailor")).toHaveLength(
			tailored,
		);
	});
});
