import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FormSchema,
	type SchemaField,
	schemaKey,
} from "@offerfinch/core/apply/form-schema";
import type { FormField } from "@offerfinch/core/apply/forms";
import type { ExportInput } from "@offerfinch/core/export/export";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import { NoopNotifier } from "@offerfinch/core/notify/ntfy";
import { runApplicationFlow } from "@offerfinch/core/pipeline/application-flow";
import {
	LocalStep,
	LocalWorkflowStarter,
} from "@offerfinch/core/pipeline/local";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { loadProfileFromDir } from "@offerfinch/core/profile/load-node";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import { parseFormAnswers } from "@offerfinch/core/tailor/tailor";
import {
	DashboardRepository,
	importProfile,
	seedCompanies,
} from "@offerfinch/db";
import {
	applications,
	approvals,
	companies,
	profiles,
} from "@offerfinch/db/schema/pipeline";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestApp, type TestApp, type TestUser } from "./support/api";

/**
 * Steps 2 and 3 of docs/auto-apply-plan.md through the real workflow and repository: the form is
 * read before the draft, a required field the profile cannot answer becomes a question (never a
 * guess), its answer joins the form answers, and review lists every field with its exact value.
 */

const FIXTURES = join(import.meta.dirname, "../../core/test/fixtures");
const WHY = "Why do you want to work at Acme Robotics?";
const CLEARANCE = "Do you hold an active security clearance?";

const field = (
	ref: string,
	kind: FormField["kind"],
	name: string,
	label: string,
	extra: { required?: boolean; options?: string[]; section?: string } = {},
): SchemaField => {
	const f: FormField = {
		ref,
		kind,
		name,
		label,
		required: extra.required ?? false,
		options: extra.options ?? [],
		visible: true,
		current: [],
	};
	return { ...f, key: schemaKey(f), page: 1, section: extra.section ?? "" };
};

let t: TestApp;
let a: TestUser;
let repo: DashboardRepository;
let workflows: LocalWorkflowStarter;
let jobId = "";
let appId = "";
let reads = 0;
let deps: PipelineDeps;
let companyId = "";

beforeAll(async () => {
	t = await startTestApp("form-flow");
	a = await t.user("form-a");
	repo = new DashboardRepository(t.db);
	workflows = new LocalWorkflowStarter();
	const llm = new FakeLlmProvider();
	deps = {
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
				storageKey: `users/${input.userId}/applications/${input.applicationId}/${d.kind}-v${d.version}.pdf`,
				meta: {},
			})),
			atsIssues: [],
		}),
		apply: {
			store: repo,
			browser: {
				name: "unused",
				openSession: async () => {
					throw new Error("no browser in this test");
				},
			},
			blobs: new MemoryBlobStore(),
			boardBases: { greenhouse: "http://127.0.0.1:9/greenhouse" },
			fixtures: true,
			readForm: async ({ board, url }) => {
				reads++;
				const schema: FormSchema = {
					board,
					url,
					submit: "Submit application",
					fields: [
						field("1", "text", "first_name", "First Name", { required: true }),
						field("2", "text", "last_name", "Last Name", { required: true }),
						field("3", "text", "email", "Email", { required: true }),
						field("8", "text", "phone", "Phone", { required: true }),
						field("4", "file", "resume", "Resume/CV", { required: true }),
						field("5", "text", "question_1", WHY, { required: true }),
						// Planted: the profile cannot answer it.
						field("6", "combobox", "question_2", CLEARANCE, {
							required: true,
							options: ["Yes", "No"],
						}),
						field("7", "combobox", "gender", "Gender", {
							options: ["Male", "Female", "Decline To Self Identify"],
							section: "Voluntary self-identification",
						}),
					],
				};
				return { ok: true, schema };
			},
		},
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
			sourceKey: "acme-form",
			discoveredFrom: "test",
		},
	]);
	const [company] = await t.db
		.select({ id: companies.id })
		.from(companies)
		.where(eq(companies.userId, a.id));
	companyId = company?.id ?? "";
	({ jobId } = await repo.upsertJob(a.id, companyId, {
		source: "greenhouse",
		externalId: "4001",
		url: "https://example.invalid/acme/4001",
		title: "Senior Full-Stack Engineer",
		locations: ["Remote - Worldwide"],
		workplaceType: "remote",
		// Without the notice-period line, so the only question is the form's.
		descriptionText: readFileSync(
			join(FIXTURES, "acme-senior-fullstack.txt"),
			"utf8",
		).replace(/^.*notice period.*$/im, ""),
	}));
	await workflows.startBatch([{ userId: a.id, jobId }]);
	appId = (await repo.getApplicationByJob(a.id, jobId))?.applicationId ?? "";
	await t.db
		.update(applications)
		.set({ prepareRequestedAt: new Date() })
		.where(eq(applications.id, appId));
	await workflows.restart({ userId: a.id, jobId });
});

afterAll(async () => {
	await t.close();
});

const formAnswers = async () =>
	parseFormAnswers(
		(await repo.latestDocuments(a.id, appId)).find(
			(d) => d.kind === "form_answers",
		)?.content ?? "[]",
	);

describe("the form read before review", () => {
	it("asks the field the profile cannot answer, and guesses nothing", async () => {
		expect(reads).toBe(1);
		expect(await repo.getState(a.id, appId)).toBe("needs_answers");
		const open = (await repo.listQuestions(a.id, "open")).filter(
			(q) => q.applicationId === appId,
		);
		expect(open.map((q) => q.question)).toEqual([
			`${CLEARANCE} (one of: Yes / No)`,
		]);
		// The drafting model answered the form's motivation question in the form's words.
		const answers = await formAnswers();
		expect(answers.map((x) => x.question)).toContain(WHY);
		expect(answers.some((x) => /clearance/i.test(x.question))).toBe(false);
	});

	it("adds the user's answer to the form answers and lists every field for review", async () => {
		const [question] = (await repo.listQuestions(a.id, "open")).filter(
			(q) => q.applicationId === appId,
		);
		const answered = await repo.answerQuestion({
			userId: a.id,
			questionId: question?.id ?? "",
			answer: "No",
		});
		expect(answered.next).toBe("preparing");
		await workflows.restart({ userId: a.id, jobId });
		expect(await repo.getState(a.id, appId)).toBe("ready_for_review");
		// Read once: the schema is kept across the answer round.
		expect(reads).toBe(1);
		expect(await formAnswers()).toContainEqual({
			question: CLEARANCE,
			answer: "No",
		});

		const app = await a.rpc.application.get({ id: appId });
		expect(app.form?.status).toBe("read");
		if (app.form?.status !== "read") return;
		const lines = Object.fromEntries(app.form.fields.map((f) => [f.label, f]));
		expect(lines["First Name"]).toMatchObject({
			value: "Sam",
			source: { kind: "contact" },
		});
		expect(lines["Resume/CV"]).toMatchObject({
			value: "CV.pdf",
			source: { kind: "file" },
		});
		expect(lines[WHY]?.source).toEqual({ kind: "form_answer" });
		expect(lines[CLEARANCE]).toMatchObject({
			value: "No",
			source: {
				kind: "profile_fact",
				id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			},
		});
		expect(lines.Gender).toMatchObject({
			value: "Decline To Self Identify",
			source: { kind: "decline" },
			section: "Voluntary self-identification",
		});
		expect(app.form.submit).toBe("Submit application");
	});

	it("goes on to the draft when the read step itself times out", async () => {
		/** A runner whose read step times out, as a hung board page would. */
		class SlowRead extends LocalStep {
			override do<T>(
				name: string,
				fn: (signal?: AbortSignal) => Promise<T>,
				options?: { retries?: number; timeoutSeconds?: number },
			): Promise<T> {
				if (name.startsWith("read form"))
					return Promise.reject(new Error(`Step "${name}" timed out`));
				return super.do(name, fn, options);
			}
		}
		const { jobId: slowJob } = await repo.upsertJob(a.id, companyId, {
			source: "greenhouse",
			externalId: "4009",
			url: "https://example.invalid/acme/4009",
			title: "Senior Full-Stack Engineer",
			locations: ["Remote - Worldwide"],
			workplaceType: "remote",
			descriptionText: readFileSync(
				join(FIXTURES, "acme-senior-fullstack.txt"),
				"utf8",
			).replace(/^.*notice period.*$/im, ""),
		});
		const slowApp =
			(await repo.getApplicationByJob(a.id, slowJob))?.applicationId ?? "";
		await t.db
			.update(applications)
			.set({ prepareRequestedAt: new Date() })
			.where(eq(applications.id, slowApp));
		const before = reads;
		await runApplicationFlow(new SlowRead(), deps, {
			userId: a.id,
			jobId: slowJob,
		});
		// No form read, so no field list and no form question: drafted and reviewed as before.
		expect(reads).toBe(before);
		expect(await repo.getState(a.id, slowApp)).toBe("ready_for_review");
		expect(await repo.formRead(a.id, slowApp)).toBeNull();
	});
});

describe("Approve waits on an empty required field (plan step 7)", () => {
	/** The profile's files as stored: the test edits them the way another window's edit would. */
	const files = async () =>
		(
			await t.db
				.select({ files: profiles.files })
				.from(profiles)
				.where(eq(profiles.userId, a.id))
		)[0]?.files ?? [];
	const saveFiles = (next: Awaited<ReturnType<typeof files>>) =>
		t.db.update(profiles).set({ files: next }).where(eq(profiles.userId, a.id));

	it("refuses the approval when the value goes after review checked it, in the approval itself", async () => {
		// The drafted lines the fake model flags are confirmed, so only the field decides.
		const flagged = await a.rpc.application.get({ id: appId });
		for (const f of flagged.flags.filter((x) => x.state === "open"))
			await a.rpc.application.confirmFlag({ id: appId, flagId: f.id });
		// This test's exporter does not finish the PDF check; the review records it as passed.
		const review = await repo.latestReview(a.id, appId);
		await repo.completeReview(a.id, review?.id ?? "", []);
		// The review page's check passes: Phone has the profile's value.
		const app = await a.rpc.application.get({ id: appId });
		expect(app.approvable).toBe(true);
		expect(app.state).toBe("ready_for_review");
		expect(app.missingRequired).toEqual([]);
		const phone =
			app.form?.status === "read"
				? app.form.fields.find((f) => f.label === "Phone")?.value
				: undefined;
		expect(phone).toBe("+1 555 010 0199");
		// Between that check and the approval, the phone leaves the profile.
		const before = await files();
		await saveFiles(
			before.map((f) =>
				f.path === "personal.md"
					? { ...f, content: f.content.replace(/^- \*\*Phone:\*\*.*$/m, "") }
					: f,
			),
		);
		await expect(
			repo.approve({
				userId: a.id,
				applicationId: appId,
				approvedHashes: app.currentHashes ?? {},
				idempotencyKey: "approve-race-direct",
			}),
		).rejects.toThrow(/required fields would be sent empty: "Phone"/);
		await expect(
			a.rpc.application.approve({
				id: appId,
				hashes: app.currentHashes ?? {},
				idempotencyKey: "approve-race-rpc",
			}),
		).rejects.toThrow(/required fields would be sent empty: "Phone"/);
		expect(await repo.getState(a.id, appId)).toBe("ready_for_review");
		expect(
			await t.db
				.select()
				.from(approvals)
				.where(eq(approvals.applicationId, appId)),
		).toEqual([]);
		// With the value back, the same approval goes through.
		await saveFiles(before);
		await repo.approve({
			userId: a.id,
			applicationId: appId,
			approvedHashes: app.currentHashes ?? {},
			idempotencyKey: "approve-race-after",
		});
		expect(await repo.getState(a.id, appId)).toBe("approved");
	});
});
