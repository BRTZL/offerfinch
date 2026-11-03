import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureUser, openSqlite } from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { flowRuns, flowSteps } from "@offerfinch/db/schema/jobs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { SettingsStore } from "../src/worker/settings";
import { recordStall, STALL_LIMIT } from "../src/worker/stalls";

async function db() {
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-stalls-")),
		"db.sqlite",
	);
	const database = openSqlite(file);
	await migrate(database);
	await ensureUser(database, {
		id: "local",
		name: "You",
		email: "local@example.test",
	});
	const now = new Date();
	await database.insert(flowRuns).values({
		id: "r1",
		userId: "local",
		kind: "scan",
		params: {},
		status: "running",
		priority: 5,
		runAfter: now,
		createdAt: now,
	});
	await database.insert(flowSteps).values({
		runId: "r1",
		key: "provider indeed#1",
		status: "running",
		attempts: 1,
		updatedAt: now,
	});
	return database;
}

describe("a step that stalls again and again", () => {
	it("counts stalls across restarts and fails the step at the limit, with the reason", async () => {
		const database = await db();
		const settings = new SettingsStore(database);
		const stall = { runId: "r1", step: "provider indeed#1", attempt: 1 };
		expect(STALL_LIMIT).toBe(3);
		expect(await recordStall(database, settings, stall)).toEqual({
			stalls: 1,
			failed: false,
		});
		// A restarted worker reads the count back from the database.
		const again = new SettingsStore(database);
		expect(await recordStall(database, again, stall)).toEqual({
			stalls: 2,
			failed: false,
		});
		let [row] = await database
			.select()
			.from(flowSteps)
			.where(eq(flowSteps.runId, "r1"));
		expect(row?.status).toBe("running");
		expect(await recordStall(database, again, stall)).toEqual({
			stalls: 3,
			failed: true,
		});
		[row] = await database
			.select()
			.from(flowSteps)
			.where(eq(flowSteps.runId, "r1"));
		expect(row?.status).toBe("failed");
		expect(row?.error).toMatch(/Stopped after 3 stalls/);
	});

	it("keeps each step's count apart", async () => {
		const database = await db();
		const settings = new SettingsStore(database);
		await recordStall(database, settings, {
			runId: "r1",
			step: "provider indeed#1",
			attempt: 1,
		});
		expect(
			await recordStall(database, settings, {
				runId: "r1",
				step: "provider glassdoor#1",
				attempt: 1,
			}),
		).toEqual({ stalls: 1, failed: false });
	});
});
