import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GreenhouseSource } from "@offerfinch/core/sources/greenhouse";
import type { FetchLike } from "@offerfinch/core/sources/types";
import {
	DashboardRepository,
	DrizzleClosedPostingStore,
	ensureUser,
	openSqlite,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { WorkerApp } from "../src/worker/app";
import { checkBeforeAction } from "../src/worker/closed-postings";
import { LOCAL_USER_ID } from "../src/worker/settings";

/**
 * The checks on the user's actions in the worker (worker/closed-postings.ts), on a real
 * database with a stand-in board: what an earlier, discarded answer must not do.
 */
async function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-closed-worker-"));
	const db = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, {
		id: LOCAL_USER_ID,
		name: "Test",
		email: "local@example.test",
	});
	await seedCompanies(db, LOCAL_USER_ID, [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acmerobotics",
			discoveredFrom: "t",
		},
	]);
	const repo = new DashboardRepository(db);
	const [company] = db.$client.prepare("select id from companies").all() as {
		id: string;
	}[];
	const { jobId } = await repo.upsertJob(LOCAL_USER_ID, company?.id ?? "", {
		source: "greenhouse",
		externalId: "4001",
		url: "https://boards.greenhouse.io/acmerobotics/jobs/4001",
		title: "Engineer",
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "React",
	});
	const appId =
		(await repo.getApplicationByJob(LOCAL_USER_ID, jobId))?.applicationId ?? "";
	await repo.transition(LOCAL_USER_ID, appId, {
		from: ["found"],
		to: "scored",
		reason: "t",
		actor: "workflow",
	});
	// The board took 4001 down: its page answers 404, the board lists another posting.
	const asked: string[] = [];
	const board: FetchLike = async (url) => {
		asked.push(url);
		return url.endsWith("/jobs/4001")
			? new Response("{}", { status: 404 })
			: new Response(JSON.stringify({ jobs: [{ id: 4002 }] }), {
					status: 200,
				});
	};
	const app = {
		db,
		deps: { sources: { greenhouse: new GreenhouseSource(board) } },
		init: {},
		log: () => {},
	} as unknown as WorkerApp;
	return { db, jobId, appId, asked, app };
}

describe("checks on the user's actions", () => {
	it("a sweep's answer discarded by a later approval does not stop the hand-off from checking", async () => {
		const { db, jobId, appId, asked, app } = await setup();
		// The sweep starts on the listed match; meanwhile the user prepares and approves it.
		await db.run(
			sql`update applications set state = 'approved', prepare_requested_at = ${Date.now()} where id = ${appId}`,
		);
		// The sweep's "gone" arrives late: not about the approved application, so discarded.
		expect(
			await new DrizzleClosedPostingStore(db).recordCheck(
				LOCAL_USER_ID,
				jobId,
				{
					at: new Date(),
					origin: "sweep",
					gone: { reason: "Greenhouse no longer lists it" },
				},
			),
		).toBe(false);
		// The user opens the hand-off: it checks now, and finds the posting closed.
		const check = await checkBeforeAction(app, appId, "handoff");
		expect(asked).toEqual([
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/4001",
			"https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs",
		]);
		expect(check).toMatchObject({
			closed: true,
			reason:
				"Greenhouse no longer lists it (checked when the hand-off opened)",
		});
		db.$close();
	});

	it("an unclear answer moments ago does not stop the next action's check either", async () => {
		const { db, jobId, appId, asked, app } = await setup();
		await new DrizzleClosedPostingStore(db).recordCheck(LOCAL_USER_ID, jobId, {
			at: new Date(),
			origin: "sweep",
		});
		const check = await checkBeforeAction(app, appId, "prepare");
		expect(asked).toHaveLength(2);
		expect(check.closed).toBe(true);
		db.$close();
	});
});
