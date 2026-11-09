import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DashboardRepository,
	type Database,
	ensureUser,
	openSqlite,
	type PendingEvent,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { applications } from "@offerfinch/db/schema/pipeline";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pipelineRouter } from "../src/worker/routers/pipeline";

/**
 * Settings › Applying: the switch for automatic submissions goes through `submission.setPaused`.
 * Paused by default; turning it on wakes approved applications once, and the same call again
 * changes nothing (a double click, a second window).
 */

async function setup(): Promise<{ db: Database; approved: number }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-switch-"));
	const db = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, { id: "u1", name: "U", email: "u1@example.test" });
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acme",
			discoveredFrom: "t",
		},
	]);
	const repo = new DashboardRepository(db);
	const [company] = await repo.listCompanies("u1");
	for (const i of [1, 2]) {
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
			source: "greenhouse",
			url: `https://boards.greenhouse.io/acme/jobs/${i}`,
			externalId: `switch-${i}`,
			title: "Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "TypeScript",
		});
		const app = await repo.getApplicationByJob("u1", jobId);
		await db
			.update(applications)
			.set({ state: "approved" })
			.where(eq(applications.id, app?.applicationId ?? ""));
	}
	return { db, approved: 2 };
}

describe("submission.setPaused", () => {
	it("is paused by default, wakes approved applications once, and repeats as a no-op", async () => {
		const { db, approved } = await setup();
		const sent: PendingEvent[] = [];
		const context = {
			session: { user: { id: "u1", email: "u1@example.test", name: "U" } },
			db,
			sendEvent: async (event: PendingEvent) => {
				sent.push(event);
			},
		} as never;
		const { settings, setPaused } = pipelineRouter.submission;
		const paused = async () =>
			(await call(settings, undefined, { context })).paused;
		const set = (value: boolean) =>
			call(setPaused, { paused: value }, { context });

		expect(await paused()).toBe(true);
		expect(await set(false)).toEqual({ paused: false, woken: approved });
		expect(sent).toHaveLength(approved);
		expect(await paused()).toBe(false);

		// The same call again: no second wake.
		expect(await set(false)).toEqual({ paused: false, woken: 0 });
		expect(sent).toHaveLength(approved);

		// Off is immediate and wakes nothing, also twice.
		expect(await set(true)).toEqual({ paused: true, woken: 0 });
		expect(await set(true)).toEqual({ paused: true, woken: 0 });
		expect(await paused()).toBe(true);

		// On again after off wakes them again (the claim keeps a submission to one click).
		expect(await set(false)).toEqual({ paused: false, woken: approved });
		expect(sent).toHaveLength(approved * 2);
	});

	it("refuses a call with no session", async () => {
		const { db } = await setup();
		await expect(
			call(
				pipelineRouter.submission.setPaused,
				{ paused: false },
				{ context: { session: null, db, sendEvent: async () => {} } as never },
			),
		).rejects.toThrow();
	});
});
