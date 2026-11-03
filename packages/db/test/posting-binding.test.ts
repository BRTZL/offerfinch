import { compareApproval } from "@offerfinch/core/domain/approval";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { MemoryBlobStore } from "@offerfinch/core/export/export";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	importProfile,
	seedCompanies,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;
let companyId = "";
let n = 0;
const blobs = new MemoryBlobStore();

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
						"- **Name:** Ada Example\n- **Email:** ada@example.test\n- **Phone:** +90 555\n- **Location:** Izmir, Turkey",
				},
				{ path: "skills.md", content: "- TypeScript" },
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

/** An application approved for exactly its current documents, with a CV PDF stored. */
async function approvedApp(): Promise<string> {
	n++;
	const job: NormalizedJob = {
		source: "greenhouse",
		externalId: `sub-${n}`,
		url: `https://boards.greenhouse.io/acme/jobs/sub-${n}`,
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
	await repo.transition("u1", id, {
		from: ["preparing"],
		to: "ready_for_review",
		reason: "t",
		actor: "workflow",
	});
	const key = `users/u1/applications/${id}/cv-v1.pdf`;
	await blobs.put(key, new TextEncoder().encode("%PDF-1.4"), "application/pdf");
	await repo.saveExport("u1", id, {
		kind: "cv",
		format: "pdf",
		sourceVersion: 1,
		storageKey: key,
		meta: {},
	});
	await approveCurrent(id);
	return id;
}

async function approveCurrent(id: string) {
	const hashes = (await repo.getApplication("u1", id))?.currentHashes ?? {};
	const review = await repo.recordReview("u1", id, {
		documentHashes: hashes,
		provider: "t",
		passed: true,
		issues: [],
		claims: [],
	});
	await repo.completeReview("u1", review, []);
	await repo.approve({
		userId: "u1",
		applicationId: id,
		approvedHashes: hashes,
		idempotencyKey: `approve-${id}-${Date.now()}`,
	});
}

const description = async (id: string) =>
	(
		await execute<{ d: string }>(
			db,
			sql`select j.description_text as d from jobs j join applications a on a.job_id = j.id where a.id = ${id}`,
		)
	)[0]?.d;

/** As the app decides it: the latest review is of these documents for this posting. */
async function reviewCurrent(id: string) {
	const detail = await repo.getApplication("u1", id);
	return Boolean(
		detail?.review &&
			compareApproval(detail.review.documentHashes, detail.currentHashes).ok,
	);
}

describe("review and approval are bound to the posting", () => {
	it("a posting rewritten under an approval fails the submission check and the review", async () => {
		const id = await approvedApp();
		// Any write that bypasses the checks (an earlier version's re-read did this).
		await execute(
			db,
			sql`update jobs set description_text = 'A different job entirely' where id = (select job_id from applications where id = ${id})`,
		);
		await expect(
			repo.transition("u1", id, {
				from: ["approved"],
				to: "applying",
				reason: "t",
				actor: "workflow",
			}),
		).rejects.toThrow(/posting .*changed after approval/);
		expect(await reviewCurrent(id)).toBe(false);
	});

	it("a new employer or title is a different posting too", async () => {
		const id = await approvedApp();
		await execute(
			db,
			sql`update jobs set title = 'Staff Engineer' where id = (select job_id from applications where id = ${id})`,
		);
		await expect(
			repo.transition("u1", id, {
				from: ["approved"],
				to: "applying",
				reason: "t",
				actor: "workflow",
			}),
		).rejects.toThrow(/posting .*changed after approval/);
	});

	it("updatePosting sends an approved application back to review, its approval revoked, in one step", async () => {
		const id = await approvedApp();
		const { changed, event } = await repo.updatePosting({
			userId: "u1",
			applicationId: id,
			patch: { descriptionText: "TypeScript and Go" },
		});
		expect(changed).toBe(true);
		expect(event?.eventId).toBeTruthy();
		expect(await repo.getState("u1", id)).toBe("ready_for_review");
		const [approval] = await execute<{
			revoked: number | null;
			reason: string;
		}>(
			db,
			sql`select revoked_at as revoked, revoked_reason as reason from approvals where application_id = ${id}`,
		);
		expect(approval?.revoked).toBeTruthy();
		expect(await reviewCurrent(id)).toBe(false);
		// The same text again changes nothing.
		expect(
			(
				await repo.updatePosting({
					userId: "u1",
					applicationId: id,
					patch: { descriptionText: "TypeScript and Go" },
				})
			).changed,
		).toBe(false);
	});

	it("refuses to change a posting being or already submitted", async () => {
		const id = await approvedApp();
		await repo.transition("u1", id, {
			from: ["approved"],
			to: "applying",
			reason: "t",
			actor: "workflow",
		});
		await expect(
			repo.updatePosting({
				userId: "u1",
				applicationId: id,
				patch: { descriptionText: "Something else" },
			}),
		).rejects.toThrow(/can't change once it is being or has been submitted/);
		expect(await description(id)).toBe("TypeScript");
	});
});
