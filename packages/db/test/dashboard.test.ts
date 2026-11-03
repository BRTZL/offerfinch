import { hashDocuments } from "@offerfinch/core/domain/approval";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appliedDate,
	DashboardRepository,
	type Database,
	EditConflictError,
	ensureUser,
	importProfile,
	seedCompanies,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;
let appId = "";

const job: NormalizedJob = {
	source: "greenhouse",
	externalId: "77",
	url: "https://boards.greenhouse.io/acme/jobs/77",
	title: "Senior Engineer",
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "Requirements\n- TypeScript",
};

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	await ensureUser(db, { id: "u2", name: "Other", email: "u2@example.test" });
	await importProfile(
		db,
		"u1",
		{
			files: [
				{ path: "skills.md", content: "- TypeScript" },
				{ path: "sources/old.md", content: "- Python expert" },
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
	const { jobId } = await repo.upsertJob("u1", company?.id ?? "", job);
	const app = await repo.getApplicationByJob("u1", jobId);
	appId = app?.applicationId ?? "";
	for (const [from, to] of [
		["found", "scored"],
		["scored", "preparing"],
	] as const)
		await repo.transition("u1", appId, {
			from: [from],
			to,
			reason: "t",
			actor: "workflow",
		});
});

afterAll(async () => {
	db.$close();
});

describe("question inbox", () => {
	it("saves an answer to the profile with date and source, then resumes preparing once", async () => {
		const asked = await repo.askQuestions("u1", appId, [
			{ question: "What is your notice period?", why: "Form asks" },
			{ question: "What is your notice period? ", why: "asked again" },
		]);
		expect(asked.open).toBe(1);
		await repo.transition("u1", appId, {
			from: ["preparing"],
			to: "needs_answers",
			reason: "questions",
			actor: "workflow",
		});
		const [question] = await repo.listQuestions("u1", "open");
		if (!question) throw new Error("no question");
		// Another user cannot answer it.
		await expect(
			repo.answerQuestion({
				userId: "u2",
				questionId: question.id,
				answer: "x",
			}),
		).rejects.toThrow(/not found/);

		const first = await repo.answerQuestion({
			userId: "u1",
			questionId: question.id,
			answer: "Four weeks.",
		});
		expect(first.event?.instanceId).toMatch(/^job-/);
		expect(await repo.getState("u1", appId)).toBe("preparing");
		const again = await repo.answerQuestion({
			userId: "u1",
			questionId: question.id,
			answer: "Four weeks.",
		});
		expect(again.event).toBeNull();

		// The question round and its answer, as the next draft sees them; another user sees none.
		expect(await repo.questionHistory("u1", appId)).toEqual({
			rounds: 1,
			asked: [
				{
					question: "What is your notice period?",
					answer: "Four weeks.",
					status: "answered",
				},
			],
		});
		expect(await repo.questionHistory("u2", appId)).toEqual({
			rounds: 0,
			asked: [],
		});

		const profile = await repo.getProfile("u1");
		const answers = profile?.files.find((f) => f.path === "answers.md");
		expect(answers?.content).toMatch(
			/- Question asked \(the pipeline's wording, not evidence\): What is your notice period\?\n- Answer: Four weeks\.\n- Source: dashboard question inbox, \d{4}-\d{2}-\d{2}/,
		);
		expect(profile?.files.some((f) => f.path.startsWith("sources/"))).toBe(
			false,
		);
		expect(await repo.listFacts("u2")).toEqual([]);
	});
});

describe("review, edits and approval", () => {
	it("approves only reviewed hashes, and an edit after approval revokes it", async () => {
		await repo.saveDraft(
			"u1",
			appId,
			{
				notes: "# Notes",
				cv: "# CV v1",
				coverLetter: "Letter v1",
				formAnswers: [{ question: "Why?", answer: "Because." }],
			},
			"workflow",
		);
		await repo.transition("u1", appId, {
			from: ["preparing"],
			to: "ready_for_review",
			reason: "prepared",
			actor: "workflow",
		});
		const detail = await repo.getApplication("u1", appId);
		expect(detail?.documents.map((d) => d.kind).sort()).toEqual([
			"cover_letter",
			"cv",
			"form_answers",
			"notes",
		]);
		expect(await repo.getApplication("u2", appId)).toBeNull();
		const hashes = detail?.currentHashes ?? {};
		// Each submitted document, and the posting they answer.
		expect(Object.keys(hashes).sort()).toEqual([
			"cover_letter",
			"cv",
			"form_answers",
			"posting",
		]);

		await expect(
			repo.approve({
				userId: "u1",
				applicationId: appId,
				approvedHashes: hashes,
				idempotencyKey: "a1",
			}),
		).rejects.toThrow(/not been reviewed/);
		const review = await repo.recordReview("u1", appId, {
			documentHashes: hashes,
			provider: "test",
			passed: true,
			issues: [],
			claims: [],
		});
		await repo.completeReview("u1", review, []);
		expect((await repo.latestReview("u1", appId))?.issues).toEqual([]);
		const approved = await repo.approve({
			userId: "u1",
			applicationId: appId,
			approvedHashes: hashes,
			idempotencyKey: "a2",
		});
		// A double click is the same event.
		expect(
			await repo.approve({
				userId: "u1",
				applicationId: appId,
				approvedHashes: hashes,
				idempotencyKey: "a2",
			}),
		).toEqual(approved);
		expect(await repo.getState("u1", appId)).toBe("approved");
		const [approval] = await execute<{ document_hashes: unknown }>(
			db,
			sql`select document_hashes from approvals where application_id = ${appId} and revoked_at is null`,
		);
		expect(JSON.parse(String(approval?.document_hashes))).toEqual(hashes);

		const cv = detail?.documents.find((d) => d.kind === "cv");
		await expect(
			repo.editDocument({
				userId: "u1",
				applicationId: appId,
				kind: "cv",
				content: "# CV stale",
				baseVersion: 0,
			}),
		).rejects.toBeInstanceOf(EditConflictError);
		const edit = await repo.editDocument({
			userId: "u1",
			applicationId: appId,
			kind: "cv",
			content: "# CV v2",
			baseVersion: cv?.version ?? 0,
		});
		expect(edit).toMatchObject({ version: 2, revoked: true });
		expect(await repo.getState("u1", appId)).toBe("ready_for_review");
		const after = await repo.getApplication("u1", appId);
		expect(after?.activeApproval).toBeNull();
		expect(after?.approvals[0]?.revokedReason).toMatch(
			/cv edited after approval/,
		);
		expect(after?.currentHashes.cv).toBe(
			(await hashDocuments([{ kind: "cv", content: "# CV v2" }])).cv,
		);
		await expect(repo.checkApproval("u1", appId)).resolves.toMatchObject({
			ok: false,
		});
	});
});

describe("review records", () => {
	it("appends ATS findings as issue objects and fails the review", async () => {
		const id = await repo.recordReview("u1", appId, {
			documentHashes: { cv: "x" },
			provider: "test",
			passed: true,
			issues: [],
			claims: [],
		});
		const ats = {
			rule: "ats" as const,
			document: "cv" as const,
			message: "The PDF has 3 pages; the limit is 2.",
		};
		expect(await repo.completeReview("u1", id, [ats])).toBe(false);
		const review = await repo.latestReview("u1", appId);
		expect(review).toMatchObject({
			passed: false,
			atsChecked: true,
			issues: [ats],
		});
		expect(await repo.completeReview("u2", id, [])).toBe(false);
	});
});

describe("edit events", () => {
	it("gives each application's edit its own event, even at the same version", async () => {
		const [company] = await execute<{ id: string }>(
			db,
			sql`select id from companies where user_id = 'u1' limit 1`,
		);
		const apps: string[] = [];
		for (const n of [501, 502]) {
			const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
				...job,
				externalId: String(n),
				url: `https://boards.greenhouse.io/acme/jobs/${n}`,
			});
			const app = await repo.getApplicationByJob("u1", jobId);
			const id = app?.applicationId ?? "";
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
				{ notes: "n", cv: "# CV", coverLetter: "L", formAnswers: [] },
				"workflow",
			);
			await repo.transition("u1", id, {
				from: ["preparing"],
				to: "ready_for_review",
				reason: "t",
				actor: "workflow",
			});
			apps.push(id);
		}
		const edits = [];
		for (const id of apps)
			edits.push(
				await repo.editDocument({
					userId: "u1",
					applicationId: id,
					kind: "cv",
					content: "# CV edited",
					baseVersion: 1,
				}),
			);
		expect(edits.map((e) => e.version)).toEqual([2, 2]);
		expect(edits[0]?.event.eventId).not.toBe(edits[1]?.event.eventId);
		for (const [i, id] of apps.entries())
			expect(
				await repo.consumeEvent("u1", id, edits[i]?.event.eventId ?? ""),
			).toBe(true);
	});
});

describe("the day the user submitted it", () => {
	const now = new Date("2026-10-30T22:30:00Z");
	it("takes today in the user's time zone, even when it is tomorrow in UTC", () => {
		expect(appliedDate("2026-10-31", now).toISOString()).toBe(
			"2026-10-31T12:00:00.000Z",
		);
		expect(appliedDate(undefined, now)).toBe(now);
	});
	it("refuses a later day, an invalid date and another format", () => {
		expect(() => appliedDate("2026-11-02", now)).toThrow(/future/);
		expect(() => appliedDate("2026-02-30", now)).toThrow(/valid/);
		expect(() => appliedDate("30.10.2026", now)).toThrow(/YYYY-MM-DD/);
	});
});

describe("watchlist", () => {
	it("counts each company's jobs", async () => {
		const rows = await repo.listCompanies("u1");
		const acme = rows.find((c) => c.name === "Acme");
		const [stored] = await execute<{ n: number }>(
			db,
			sql`select count(*) as n from jobs where company_id = ${acme?.id ?? ""}`,
		);
		expect(stored?.n).toBeGreaterThan(0);
		expect(acme?.jobs).toBe(stored?.n);
	});
});
