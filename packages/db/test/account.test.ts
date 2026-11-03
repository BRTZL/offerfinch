import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	countUserRows,
	DashboardRepository,
	type Database,
	DismissalStore,
	deleteUserData,
	exportUserData,
	seedCompanies,
	USER_TABLES,
} from "../src/index";
import * as schema from "../src/schema/index";
import { testDb } from "./setup";

let db: Database;
beforeAll(async () => {
	db = await testDb();
});
afterAll(() => db.$close());

const blobs = {
	get: async () => null,
	put: async () => {},
	deletePrefix: async () => 0,
} as unknown as Parameters<typeof exportUserData>[1];

describe("your data", () => {
	it("covers every table with a user's rows, except the runner's flow runs", () => {
		const withUser = (Object.values(schema) as unknown[])
			.filter(
				(value): value is SQLiteTable =>
					is(value, SQLiteTable) && "userId" in getTableColumns(value),
			)
			.map(getTableName);
		const covered = new Set(USER_TABLES.map(getTableName));
		expect(withUser.filter((name) => !covered.has(name))).toEqual([
			"flow_runs",
		]);
		expect(covered.has("dismissals")).toBe(true);
		expect(covered.has("hidden_companies")).toBe(true);
	});

	it("exports the user's dismissals and hidden companies, and erasing removes them", async () => {
		const repo = new DashboardRepository(db);
		await seedCompanies(db, "u1", [
			{
				name: "Acme",
				source: "greenhouse",
				sourceKey: "acme",
				discoveredFrom: "t",
			},
		]);
		const [company] = await db.all<{ id: string }>(
			sql`select id from companies where source_key = 'acme'`,
		);
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
			source: "greenhouse",
			externalId: "1",
			url: "https://jobs.example/acme/1",
			title: "Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "React",
		});
		const app = await repo.getApplicationByJob("u1", jobId);
		await repo.transition("u1", app?.applicationId ?? "", {
			from: ["found"],
			to: "scored",
			reason: "t",
			actor: "workflow",
		});
		await new DismissalStore(db).dismiss({
			userId: "u1",
			applicationIds: [app?.applicationId ?? ""],
			reasons: ["salary"],
			note: "Too low",
			hideCompanyId: company?.id,
		});

		const exported = await exportUserData(db, blobs, "u1");
		expect(exported.tables.dismissals).toEqual([
			expect.objectContaining({
				applicationId: app?.applicationId,
				companyId: company?.id,
				reasons: ["salary"],
				note: "Too low",
			}),
		]);
		expect(exported.tables.hidden_companies).toEqual([
			expect.objectContaining({ companyId: company?.id }),
		]);

		await deleteUserData(
			db,
			blobs,
			{ id: "u1", email: "u1@example.test" },
			{ deleteUserRow: true },
		);
		const left = await countUserRows(db, "u1");
		expect(left.dismissals).toBe(0);
		expect(left.hidden_companies).toBe(0);
		expect(Object.values(left).every((n) => n === 0)).toBe(true);
	});
});
