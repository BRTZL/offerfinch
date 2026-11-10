import type { ApplicationRun } from "@offerfinch/core/apply/applier";
import type { FormRead, FormSchema } from "@offerfinch/core/apply/form-schema";
import { type ApplyDeps, submitStep } from "@offerfinch/core/apply/submit";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import type { PipelineDeps } from "@offerfinch/core/pipeline/ports";
import { parseFormAnswers } from "@offerfinch/core/tailor/tailor";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	importProfile,
	seedCompanies,
} from "../src/index";
import { execute, testDb } from "./setup";

/** The form read before review: stored per application, only while it is preparing. */

let db: Database;
let repo: DashboardRepository;
let companyId = "";
let n = 0;

const SCHEMA: FormSchema = {
	board: "greenhouse",
	url: "http://127.0.0.1:9/greenhouse/acme/jobs/1",
	submit: "Submit application",
	fields: [
		{
			ref: "1",
			key: "text:email",
			kind: "text",
			label: "Email",
			required: true,
			name: "email",
			options: [],
			visible: true,
			page: 1,
			section: "",
		},
		{
			ref: "2",
			key: "combobox:gender",
			kind: "combobox",
			label: "Gender",
			required: false,
			name: "gender",
			options: ["Male", "Female", "Decline To Self Identify"],
			visible: true,
			page: 1,
			section: "Voluntary self-identification",
		},
	],
};

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	await importProfile(
		db,
		"u1",
		{
			files: [
				{
					path: "personal.md",
					content:
						"- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Location:** Izmir, Turkey",
				},
			],
		},
		"test",
	);
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acme",
			discoveredFrom: "t",
		},
	]);
	const [company] = await execute<{ id: string }>(
		db,
		sql`select id from companies where user_id = 'u1'`,
	);
	companyId = company?.id ?? "";
});

afterAll(async () => {
	db.$close();
});

async function preparingApp(): Promise<string> {
	n++;
	const job: NormalizedJob = {
		source: "greenhouse",
		externalId: `form-${n}`,
		url: `https://boards.greenhouse.io/acme/jobs/form-${n}`,
		title: "Engineer",
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "TypeScript",
	};
	const { jobId } = await repo.upsertJob("u1", companyId, job);
	const id = (await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
	for (const [from, to] of [
		["found", "scored"],
		["scored", "preparing"],
	] as const)
		await repo.transition("u1", id, {
			from: [from],
			to,
			reason: "t",
			actor: "workflow",
		});
	await repo.saveDraft(
		"u1",
		id,
		{
			notes: "n",
			cv: "# CV",
			coverLetter: "Letter",
			formAnswers: [{ question: "Why us?", answer: "Because." }],
		},
		"workflow",
	);
	return id;
}

const read = (schema = SCHEMA): FormRead => ({
	status: "read",
	schema,
	readAt: "2026-11-09T10:00:00.000Z",
});

describe("application form schema", () => {
	it("stores the read schema per application and returns it unchanged", async () => {
		const id = await preparingApp();
		expect(await repo.formRead("u1", id)).toBeNull();
		expect(await repo.saveFormRead("u1", id, read())).toBe(true);
		expect(await repo.formRead("u1", id)).toEqual(read());
		// A second read replaces the first: still one row.
		const fewer = { ...SCHEMA, fields: SCHEMA.fields.slice(0, 1) };
		expect(await repo.saveFormRead("u1", id, read(fewer))).toBe(true);
		expect(await repo.formRead("u1", id)).toEqual(read(fewer));
		const rows = await execute<{ n: number }>(
			db,
			sql`select count(*) n from application_forms where application_id = ${id}`,
		);
		expect(rows[0]?.n).toBe(1);
		// Another user's id reads as missing.
		expect(await repo.formRead("u2", id)).toBeNull();
	});

	it("records a failed read with its note, for review to show", async () => {
		const id = await preparingApp();
		const failed: FormRead = {
			status: "failed",
			board: "greenhouse",
			url: SCHEMA.url,
			note: "The form could not be read before review: reCAPTCHA challenge shown instead of the form.",
			readAt: "2026-11-09T10:00:00.000Z",
		};
		expect(await repo.saveFormRead("u1", id, failed)).toBe(true);
		expect(await repo.formRead("u1", id)).toEqual(failed);
	});

	it("never changes the schema once the application left preparing", async () => {
		const id = await preparingApp();
		await repo.saveFormRead("u1", id, read());
		await repo.transition("u1", id, {
			from: ["preparing"],
			to: "ready_for_review",
			reason: "t",
			actor: "workflow",
		});
		const other = { ...SCHEMA, fields: [] };
		expect(await repo.saveFormRead("u1", id, read(other))).toBe(false);
		expect(await repo.formRead("u1", id)).toEqual(read());
		expect(
			await repo.addFormAnswers("u1", id, [
				{ question: "Gender", answer: "Female" },
			]),
		).toBe(0);
	});

	it("adds saved answers to the form answers as a new version, once", async () => {
		const id = await preparingApp();
		const added = [
			{ question: "What is your notice period?", answer: "Four weeks." },
		];
		expect(await repo.addFormAnswers("u1", id, added)).toBe(1);
		expect(await repo.addFormAnswers("u1", id, added)).toBe(0);
		const docs = await repo.latestDocuments("u1", id);
		const answers = docs.find((d) => d.kind === "form_answers");
		expect(answers?.version).toBe(2);
		expect(parseFormAnswers(answers?.content ?? "[]")).toEqual([
			{ question: "Why us?", answer: "Because." },
			...added,
		]);
	});

	it("asks a form question before review, and its answer resumes preparation", async () => {
		const id = await preparingApp();
		const { open } = await repo.askQuestions(
			"u1",
			id,
			[
				{
					question: "Will you require visa sponsorship?",
					why: "Asked by the greenhouse application form (required).",
					formField: {
						label: "Will you require visa sponsorship?",
						options: ["Yes", "No"],
						kind: "select",
						board: "greenhouse",
					},
				},
			],
			"{open} question(s) on the application form need your answer before review",
		);
		expect(open).toBe(1);
		expect(await repo.getState("u1", id)).toBe("needs_answers");
		const [question] = (await repo.listQuestions("u1", "open")).filter(
			(q) => q.applicationId === id,
		);
		expect(question?.question).toBe(
			"Will you require visa sponsorship? (one of: Yes / No)",
		);
		const answered = await repo.answerQuestion({
			userId: "u1",
			questionId: question?.id ?? "",
			answer: "No",
		});
		expect(answered.next).toBe("preparing");
		expect(answered.event).not.toBeNull();
		expect(await repo.getState("u1", id)).toBe("preparing");
		// The saved answer carries its record id, the source the field list cites.
		const saved = await repo.savedAnswers("u1");
		const fact = saved.find((s) => s.answer === "No");
		expect(fact?.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(fact?.question).toBe(
			"Will you require visa sponsorship? (one of: Yes / No)",
		);
	});

	it("hands the saved schema to the submission run", async () => {
		const id = await preparingApp();
		await repo.saveFormRead("u1", id, read());
		await repo.transition("u1", id, {
			from: ["preparing"],
			to: "ready_for_review",
			reason: "t",
			actor: "workflow",
		});
		// Straight to applying for the test: the run is replaced, nothing opens.
		await db.run(
			sql`update applications set state = 'applying' where id = ${id}`,
		);
		await repo.setSubmissionsPaused("u1", false);
		const blobs = new MemoryBlobStore();
		const key = `users/u1/applications/${id}/cv.pdf`;
		await blobs.put(
			key,
			new TextEncoder().encode("%PDF-1.4"),
			"application/pdf",
		);
		await repo.saveExport("u1", id, {
			kind: "cv",
			format: "pdf",
			sourceVersion: 1,
			storageKey: key,
			meta: {},
		});
		const runs: ApplicationRun[] = [];
		const apply: ApplyDeps = {
			store: repo,
			browser: {
				name: "unused",
				openSession: async () => {
					throw new Error("no browser in tests");
				},
			},
			blobs,
			boardBases: { greenhouse: "http://127.0.0.1:9/greenhouse" },
			fixtures: true,
			run: async (run) => {
				runs.push(run);
				return {
					outcome: "stopped",
					stop: { kind: "form_changed", message: 'The form now asks "Visa".' },
					screenshot: null,
					filled: [],
				};
			},
		};
		const outcome = await submitStep(
			{ repo, apply } as unknown as PipelineDeps,
			"u1",
			id,
		);
		expect(runs[0]?.schema).toEqual(SCHEMA.fields);
		expect(outcome).toEqual({
			outcome: "needs_human",
			reason: 'The form now asks "Visa".',
		});
		expect(await repo.getState("u1", id)).toBe("needs_human");
		await repo.setSubmissionsPaused("u1", true);
	});
});
