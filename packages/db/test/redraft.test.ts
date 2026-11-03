import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportInput } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import { LocalWorkflowStarter } from "@offerfinch/core/pipeline/local";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { loadProfileFromDir } from "@offerfinch/core/profile/load-node";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import {
	DrizzlePipelineRepository,
	ensureUser,
	importProfile,
	seedCompanies,
} from "@offerfinch/db";
import {
	applications,
	applicationTransitions,
	companies,
	profileFacts,
	questions,
} from "@offerfinch/db/schema/pipeline";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./support/api";
import { redraftApplication } from "./support/redraft";

/** `application:redraft`: restart one application's preparation, keeping its answers. */

const FIXTURES = join(import.meta.dirname, "../../core/test/fixtures");
let t: TestApp;
let repo: DrizzlePipelineRepository;
let workflows: LocalWorkflowStarter;
let llm: FakeLlmProvider;

beforeAll(async () => {
	t = await startTestApp("redraft");
	repo = new DrizzlePipelineRepository(t.db);
	workflows = new LocalWorkflowStarter();
	llm = new FakeLlmProvider();
	const deps: PipelineDeps = {
		repo,
		sources: {},
		llm,
		claimsLlm: new FakeLlmProvider(),
		notifier: new NoopNotifier(),
		workflows,
		exporter: async (input: ExportInput) => ({
			records: input.documents.map((d) => ({
				kind: d.kind,
				format: "pdf" as const,
				sourceVersion: d.version,
				storageKey: `${input.applicationId}/${d.kind}-v${d.version}.pdf`,
				meta: {},
			})),
			atsIssues: [],
		}),
	};
	workflows.bind(deps);
});

afterAll(async () => {
	await t.close();
});

async function applicationWaitingForAnswers(userId: string) {
	await ensureUser(t.db, {
		id: userId,
		name: userId,
		email: `${userId}@example.test`,
	});
	await importProfile(
		t.db,
		userId,
		await loadProfileFromDir(join(FIXTURES, "desktop-profile")),
		"fixtures/profile",
	);
	await seedCompanies(t.db, userId, [
		{
			name: "Acme Robotics",
			source: "greenhouse",
			sourceKey: `acme-${userId}`,
			discoveredFrom: "test",
		},
	]);
	const [company] = await t.db
		.select({ id: companies.id })
		.from(companies)
		.where(eq(companies.sourceKey, `acme-${userId}`));
	const companyId = company?.id;
	if (!companyId) throw new Error("no company");
	const { jobId } = await repo.upsertJob(userId, companyId, {
		source: "greenhouse",
		externalId: `acme-${userId}`,
		url: `https://example.invalid/acme/${userId}`,
		title: "Senior Full-Stack Engineer",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		descriptionText: readFileSync(
			join(FIXTURES, "acme-senior-fullstack.txt"),
			"utf8",
		),
	});
	await workflows.startBatch([{ userId, jobId }]);
	const listed = await repo.getApplicationByJob(userId, jobId);
	if (!listed) throw new Error("no application");
	await t.db
		.update(applications)
		.set({ prepareRequestedAt: new Date() })
		.where(eq(applications.id, listed.applicationId));
	await workflows.restart({ userId, jobId });
	const app = await repo.getApplicationByJob(userId, jobId);
	if (!app) throw new Error("no application");
	expect(app.state).toBe("needs_answers");
	return app;
}

describe("application:redraft", () => {
	it("dismisses open questions, keeps answers, drafts again without a new round, and records why", async () => {
		const app = await applicationWaitingForAnswers("redraft-a");
		// An earlier answer in the profile store; it must survive.
		await t.db.insert(profileFacts).values({
			userId: "redraft-a",
			question: "What is your English level?",
			answer: "Professional working proficiency.",
			source: "dashboard question inbox",
		});

		const dry = await redraftApplication(t.db, workflows, {
			userId: "redraft-a",
			applicationId: app.applicationId,
			from: "preparing",
			dryRun: true,
		});
		expect(dry).toMatchObject({ from: "needs_answers", dismissed: 1 });
		expect(await repo.getState("redraft-a", app.applicationId)).toBe(
			"needs_answers",
		);

		const tailorCalls = () => llm.calls.filter((c) => c.task === "tailor");
		const before = tailorCalls().length;
		const result = await redraftApplication(t.db, workflows, {
			userId: "redraft-a",
			applicationId: app.applicationId,
			from: "preparing",
		});
		expect(result).toMatchObject({
			from: "needs_answers",
			to: "preparing",
			dismissed: 1,
			state: "ready_for_review",
		});
		expect(tailorCalls()).toHaveLength(before + 1);
		// The question round was spent before the restart: the draft asked nothing new.
		expect(tailorCalls().at(-1)?.prompt).toContain(
			"<questions_allowed>0</questions_allowed>",
		);
		const asked = await t.db
			.select({ status: questions.status })
			.from(questions)
			.where(eq(questions.applicationId, app.applicationId));
		expect(asked).toEqual([{ status: "dismissed" }]);
		const facts = await t.db
			.select({ answer: profileFacts.answer })
			.from(profileFacts)
			.where(eq(profileFacts.userId, "redraft-a"));
		expect(facts).toEqual([{ answer: "Professional working proficiency." }]);
		const [restart] = await t.db
			.select()
			.from(applicationTransitions)
			.where(eq(applicationTransitions.applicationId, app.applicationId))
			.orderBy(desc(applicationTransitions.createdAt))
			.offset(1)
			.limit(1);
		expect(restart).toMatchObject({
			fromState: "needs_answers",
			toState: "preparing",
			actor: "user",
			reason:
				"Restarted from needs_answers by application:redraft; answers kept",
		});
	});

	it("restarts a failed application, which the state machine never leaves", async () => {
		const app = await applicationWaitingForAnswers("redraft-b");
		await t.db
			.update(applications)
			.set({ state: "failed", prepareAttempts: 3 })
			.where(eq(applications.id, app.applicationId));
		const result = await redraftApplication(t.db, workflows, {
			userId: "redraft-b",
			applicationId: app.applicationId,
			from: "preparing",
		});
		expect(result).toMatchObject({ from: "failed", state: "ready_for_review" });
	});

	it("refuses approved and submitted applications, and another user's", async () => {
		const app = await applicationWaitingForAnswers("redraft-c");
		await expect(
			redraftApplication(t.db, workflows, {
				userId: "redraft-a",
				applicationId: app.applicationId,
				from: "preparing",
			}),
		).rejects.toThrow(
			/not owned by user "redraft-a".*belongs to redraft-c@example\.test: run again with --email redraft-c@example\.test or --user redraft-c/,
		);
		for (const state of ["approved", "applied"] as const) {
			await t.db
				.update(applications)
				.set({ state })
				.where(eq(applications.id, app.applicationId));
			await expect(
				redraftApplication(t.db, workflows, {
					userId: "redraft-c",
					applicationId: app.applicationId,
					from: "preparing",
				}),
			).rejects.toThrow(new RegExp(`Refused: the application is ${state}`));
		}
		expect(await repo.getState("redraft-c", app.applicationId)).toBe("applied");
	});

	it("says so when the default user does not own it, and when no application has the id", async () => {
		const app = await applicationWaitingForAnswers("redraft-d");
		await expect(
			redraftApplication(t.db, workflows, {
				userId: "owner",
				applicationId: app.applicationId,
				from: "preparing",
				userGiven: false,
			}),
		).rejects.toThrow(
			/not owned by the default user "owner" \(PIPELINE_USER_ID; no --user or --email was given\)\. It belongs to redraft-d@example\.test/,
		);
		await expect(
			redraftApplication(t.db, workflows, {
				userId: "owner",
				applicationId: "00000000-0000-4000-8000-000000000000",
				from: "preparing",
				userGiven: false,
			}),
		).rejects.toThrow(
			/No application 00000000-0000-4000-8000-000000000000 in this database/,
		);
		await expect(
			redraftApplication(t.db, workflows, {
				userId: "owner",
				applicationId: "not-an-id",
				from: "preparing",
			}),
		).rejects.toThrow(/"not-an-id" is not an application id/);
		expect(await repo.getState("redraft-d", app.applicationId)).toBe(
			"needs_answers",
		);
	});
});
