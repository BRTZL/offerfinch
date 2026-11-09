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

describe("submission.setBoardOpen", () => {
	it("lists every real job site closed, with its hosts, and opens and closes one idempotently", async () => {
		const { db } = await setup();
		const sent: PendingEvent[] = [];
		const context = {
			session: { user: { id: "u1", email: "u1@example.test", name: "U" } },
			db,
			sendEvent: async (event: PendingEvent) => {
				sent.push(event);
			},
		} as never;
		const { settings, setBoardOpen } = pipelineRouter.submission;
		const boards = async () =>
			(await call(settings, undefined, { context })).boards;
		const open = (board: "greenhouse" | "web", value: boolean) =>
			call(setBoardOpen, { board, open: value }, { context });

		const listed = await boards();
		expect(listed.map((b) => b.name)).toEqual([
			"Ashby",
			"Greenhouse",
			"Lever",
			"Workable",
			"Recruitee",
			"Teamtailor",
			"Personio",
			"Employers' own forms",
		]);
		expect(listed.every((b) => !b.open)).toBe(true);
		expect(listed.find((b) => b.board === "greenhouse")?.hosts).toContain(
			"job-boards.greenhouse.io",
		);
		expect(listed.find((b) => b.board === "recruitee")?.hosts).toEqual([
			"<company>.recruitee.com",
		]);
		expect(listed.find((b) => b.board === "web")?.hosts).toEqual([
			"the form's own site only",
		]);

		expect(await open("greenhouse", true)).toEqual({
			board: "greenhouse",
			open: true,
		});
		await open("greenhouse", true);
		expect((await boards()).filter((b) => b.open).map((b) => b.board)).toEqual([
			"greenhouse",
		]);
		await open("greenhouse", false);
		await open("greenhouse", false);
		expect((await boards()).some((b) => b.open)).toBe(false);
		// Opening a site wakes nothing: a stopped run is retried by the user.
		expect(sent).toEqual([]);
	});

	it("refuses a board it does not know", async () => {
		const { db } = await setup();
		const context = {
			session: { user: { id: "u1", email: "u1@example.test", name: "U" } },
			db,
			sendEvent: async () => {},
		} as never;
		await expect(
			call(
				pipelineRouter.submission.setBoardOpen,
				{ board: "smartrecruiters" as never, open: true },
				{ context },
			),
		).rejects.toThrow();
	});
});
