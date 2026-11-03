import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DashboardRepository,
	DismissalStore,
	ensureUser,
	openSqlite,
	type PendingEvent,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { call } from "@orpc/server";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissalRouter, dismissFromNotice } from "../src/worker/dismissals";
import { LOCAL_USER_ID } from "../src/worker/settings";

/** A real database with two listed matches nobody acted on. */
async function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-notice-dismiss-"));
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
	const ids: string[] = [];
	for (const externalId of ["4001", "4002"]) {
		const { jobId } = await repo.upsertJob(LOCAL_USER_ID, company?.id ?? "", {
			source: "greenhouse",
			externalId,
			url: `https://boards.greenhouse.io/acmerobotics/jobs/${externalId}`,
			title: "Engineer",
			locations: ["Remote"],
			workplaceType: "remote",
			descriptionText: "React",
		});
		const id =
			(await repo.getApplicationByJob(LOCAL_USER_ID, jobId))?.applicationId ??
			"";
		await repo.transition(LOCAL_USER_ID, id, {
			from: ["found"],
			to: "scored",
			reason: "t",
			actor: "workflow",
		});
		ids.push(id);
	}
	const sent: PendingEvent[] = [];
	const sendEvent = async (event: PendingEvent) => {
		sent.push(event);
	};
	const stateOf = (id: string) =>
		(
			db.$client
				.prepare("select state from applications where id = ?")
				.get(id) as { state: string }
		).state;
	return { db, ids, sent, sendEvent, stateOf };
}

afterEach(() => vi.restoreAllMocks());

describe("Not interested from a notification", () => {
	it("goes through the same dismiss as the app's button", async () => {
		const { db, ids, sent, sendEvent, stateOf } = await setup();
		const spy = vi.spyOn(DismissalStore.prototype, "dismiss");
		const [fromNotice = "", fromApp = ""] = ids;
		expect(
			await dismissFromNotice(db, sendEvent, {
				userId: LOCAL_USER_ID,
				applicationId: fromNotice,
			}),
		).toBe("dismissed");
		await call(
			dismissalRouter(() => ({ db })).dismiss,
			{ ids: [fromApp], reasons: [] },
			{
				context: {
					session: {
						user: { id: LOCAL_USER_ID, email: "local@example.test", name: "T" },
					},
					db,
					sendEvent,
				} as never,
			},
		);
		// The same store call, with the same arguments a dismiss with no reasons sends.
		expect(spy.mock.calls.map(([input]) => input)).toEqual([
			{ userId: LOCAL_USER_ID, applicationIds: [fromNotice], reasons: [] },
			{
				userId: LOCAL_USER_ID,
				applicationIds: [fromApp],
				reasons: [],
				note: undefined,
				hideCompanyId: undefined,
			},
		]);
		expect(stateOf(fromNotice)).toBe("dismissed");
		expect(stateOf(fromApp)).toBe("dismissed");
		// Each wakes its match's waiting run, as the app's dismiss does.
		expect(sent).toHaveLength(2);
		const rows = db.$client
			.prepare("select application_id from dismissals order by application_id")
			.all() as { application_id: string }[];
		expect(rows.map((r) => r.application_id).sort()).toEqual([...ids].sort());
	});

	it("a match already dismissed, prepared or gone is left alone", async () => {
		const { db, ids, sent, sendEvent, stateOf } = await setup();
		const [done = "", preparing = ""] = ids;
		const press = (applicationId: string) =>
			dismissFromNotice(db, sendEvent, {
				userId: LOCAL_USER_ID,
				applicationId,
			});
		expect(await press(done)).toBe("dismissed");
		sent.length = 0;
		// Pressed again (a second notification, or after the app's own button).
		expect(await press(done)).toBe("stale");
		// The user asked the app to prepare it since: the notification must not undo that.
		await db.run(
			sql`update applications set prepare_requested_at = ${Date.now()} where id = ${preparing}`,
		);
		expect(await press(preparing)).toBe("stale");
		expect(stateOf(preparing)).toBe("scored");
		// Deleted, or never there.
		expect(await press("00000000-0000-4000-8000-000000000000")).toBe("stale");
		expect(sent).toEqual([]);
	});
});
