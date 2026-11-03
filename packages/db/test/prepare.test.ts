import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DashboardRepository,
	type Database,
	seedCompanies,
} from "../src/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
});
afterAll(() => db.$close());

const job: NormalizedJob = {
	source: "greenhouse",
	externalId: "7",
	url: "https://boards.greenhouse.io/acme/jobs/7",
	title: "Frontend Engineer",
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "React",
};

describe("Prepare on demand", () => {
	it("records the request once, only for a listed match", async () => {
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

		await expect(
			repo.requestPrepare({ userId: "u1", applicationId: appId }),
		).rejects.toThrow(/only a listed match can be prepared \(it is found\)/);
		expect(await repo.prepareRequested("u1", appId)).toBe(false);

		await repo.transition("u1", appId, {
			from: ["found"],
			to: "scored",
			reason: "t",
			actor: "workflow",
		});
		const first = await repo.requestPrepare({
			userId: "u1",
			applicationId: appId,
		});
		expect(await repo.prepareRequested("u1", appId)).toBe(true);
		// A double click is the same event.
		expect(
			await repo.requestPrepare({ userId: "u1", applicationId: appId }),
		).toEqual(first);
		// Another user cannot prepare it.
		await expect(
			repo.requestPrepare({ userId: "u2", applicationId: appId }),
		).rejects.toThrow(/not found/);
	});
});

describe("a job you added by link", () => {
	it("stays in the Inbox: the filter is a note, and old set-aside ones are brought back on start", async () => {
		await seedCompanies(db, "u1", [
			{
				name: "Lumen",
				source: "manual",
				sourceKey: "manual:lumen",
				discoveredFrom: "t",
			},
		]);
		const [company] = await execute<{ id: string }>(
			db,
			sql`select id from companies where user_id = 'u1' and source = 'manual'`,
		);
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
			...job,
			source: "manual",
			externalId: "https://lumen.example/jobs/9",
			url: "https://lumen.example/jobs/9",
		});
		const appId =
			(await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
		// Chosen on purpose from the start: the workflow keeps it whatever the filter says.
		expect(await repo.chosenAnyway("u1", appId)).toBe(true);

		// An earlier version let the filter set it aside, next to a scanned job it set aside.
		await repo.transition("u1", appId, {
			from: ["found"],
			to: "rejected_by_filter",
			reason: "Location",
			actor: "workflow",
		});
		const [board] = await execute<{ id: string }>(
			db,
			sql`select a.id from applications a join jobs j on j.id = a.job_id where j.source = 'greenhouse' limit 1`,
		);
		const boardId = board?.id ?? "";
		await execute(
			db,
			sql`update applications set state = 'rejected_by_filter' where id = ${boardId}`,
		);
		expect(await repo.chosenAnyway("u1", boardId)).toBe(false);

		const events = await repo.migrateAddedJobs("u1");
		expect(events).toHaveLength(1);
		expect(await repo.getState("u1", appId)).toBe("found");
		// Not prepared by itself: Prepare stays the user's choice.
		expect(await repo.prepareRequested("u1", appId)).toBe(false);
		// The scanned job is not touched.
		expect(await repo.getState("u1", boardId)).toBe("rejected_by_filter");
		// Twice is a no-op.
		expect(await repo.migrateAddedJobs("u1")).toEqual([]);
		// Another user's start touches nothing of u1.
		expect(await repo.migrateAddedJobs("u2")).toEqual([]);
	});
});
