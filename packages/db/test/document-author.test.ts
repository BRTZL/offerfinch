import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	seedCompanies,
} from "../src/index";
import { applications } from "../src/schema/pipeline";
import { execute, testDb } from "./setup";

/**
 * Each document version records the model that wrote it, so the claims check is never run by
 * the company that wrote a saved draft (docs/decisions.md, 2026-11-04).
 */

let db: Database;
let repo: DashboardRepository;

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
});
afterAll(() => db.$close());

const job: NormalizedJob = {
	source: "greenhouse",
	externalId: "11",
	url: "https://boards.greenhouse.io/acme/jobs/11",
	title: "Platform Engineer",
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "TypeScript",
};

const author = async (applicationId: string) =>
	Object.fromEntries(
		(await repo.latestDocuments("u1", applicationId)).map((d) => [
			d.kind,
			d.authorProvider,
		]),
	);

describe("document authors", () => {
	it("saves the drafting model, keeps it through a user's edit, and takes a redraft's", async () => {
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
		const appId =
			(await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
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

		await repo.saveDraft(
			"u1",
			appId,
			{
				notes: "n",
				cv: "# CV",
				coverLetter: "Dear team",
				formAnswers: [],
				provider: "claude-subscription:opus",
			},
			"workflow",
		);
		expect(await author(appId)).toEqual({
			notes: "claude-subscription:opus",
			cv: "claude-subscription:opus",
			cover_letter: "claude-subscription:opus",
			form_answers: "claude-subscription:opus",
		});

		await repo.transition("u1", appId, {
			from: ["preparing"],
			to: "ready_for_review",
			reason: "t",
			actor: "workflow",
		});
		await repo.editDocument({
			userId: "u1",
			applicationId: appId,
			kind: "cv",
			content: "# CV\n\nEdited by hand.",
			baseVersion: 1,
		});
		const cv = (await repo.latestDocuments("u1", appId)).find(
			(d) => d.kind === "cv",
		);
		expect(cv).toMatchObject({
			version: 2,
			createdBy: "user",
			authorProvider: "claude-subscription:opus",
		});

		// A redraft request as `requestRedraft` stores it once the check finished.
		const requestId = "redraft-1";
		await db
			.update(applications)
			.set({
				redraft: {
					id: requestId,
					scope: "cover_letter",
					instruction: null,
					rewriteOwnAnswers: false,
					baseVersions: { cover_letter: 1 },
					requestedAt: "2026-11-04T12:00:00Z",
				},
			})
			.where(eq(applications.id, appId));
		expect(
			await repo.saveRedraft(
				"u1",
				appId,
				requestId,
				[{ kind: "cover_letter", content: "Hello team" }],
				"codex-subscription:default",
			),
		).toBe("saved");
		expect(await author(appId)).toMatchObject({
			cv: "claude-subscription:opus",
			cover_letter: "codex-subscription:default",
		});
	});

	it("reads a version saved before authors were recorded as null", async () => {
		const [row] = await execute<{ application_id: string }>(
			db,
			sql`select application_id from documents limit 1`,
		);
		const appId = row?.application_id ?? "";
		await execute(
			db,
			sql`update documents set author_provider = null where application_id = ${appId}`,
		);
		expect((await author(appId)).cv).toBeNull();
	});
});
