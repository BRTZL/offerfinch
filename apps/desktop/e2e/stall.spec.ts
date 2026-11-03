import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { launchApp, workerPid } from "./launch";

/**
 * A step attempt that ignores its stop and never settles holds a runner slot for good. The
 * worker then ends itself; main starts a new one and crash recovery runs the step again. A step
 * that keeps stalling is failed after three stalls instead of restarting the worker forever.
 * The stalling step is a test-only flow (OFFERFINCH_TEST_STALL, src/worker/stalls.ts).
 */

test.describe.configure({ mode: "serial" });

function read<T>(userData: string, sql: string): T[] {
	const db = new Database(path.join(userData, DB_FILE), { readonly: true });
	try {
		return db.prepare(sql).all() as T[];
	} finally {
		db.close();
	}
}
const run = (userData: string) =>
	read<{ status: string; error: string | null }>(
		userData,
		"select status, error from flow_runs where id = 'test-stall'",
	)[0];
const attempts = (userData: string) => {
	const file = path.join(userData, "stall-probe.log");
	return fs.existsSync(file)
		? fs.readFileSync(file, "utf8").trim().split("\n")
		: [];
};

test("a stalled step ends the worker; the new worker runs the step again", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-stall-"));
	const { app } = await launchApp({
		userData,
		env: { OFFERFINCH_TEST_STALL: "1" },
	});
	try {
		const first = (await workerPid(app)) as number;
		await expect.poll(() => attempts(userData).length).toBe(1);
		// The next attempt may finish: it only starts in a new worker.
		fs.writeFileSync(path.join(userData, "stall-release"), "");
		await expect
			.poll(() => workerPid(app), { timeout: 30_000 })
			.not.toBe(first);
		await expect
			.poll(() => run(userData)?.status, { timeout: 30_000 })
			.toBe("complete");
		const lines = attempts(userData);
		expect(lines).toHaveLength(2);
		// Each attempt in its own process: none ran beside the stalled one.
		expect(lines[0]).toBe(`start ${first}`);
		expect(lines[1]).not.toBe(lines[0]);
		const log = fs.readFileSync(
			path.join(userData, "logs", "main.log"),
			"utf8",
		);
		expect(log).toContain("step stalled");
		expect(log).toContain("stall 1 of 3");
	} finally {
		await app.close();
	}
});

test("a step that keeps stalling is failed after three stalls, not restarted forever", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-stall-"));
	const { app } = await launchApp({
		userData,
		env: { OFFERFINCH_TEST_STALL: "1" },
	});
	try {
		// The window can be ready before the worker has created the run tables.
		await expect.poll(() => attempts(userData).length).toBeGreaterThan(0);
		await expect
			.poll(() => run(userData)?.status, { timeout: 90_000 })
			.toBe("errored");
		expect(run(userData)?.error).toMatch(/Stopped after 3 stalls/);
		const lines = attempts(userData);
		expect(lines).toHaveLength(3);
		expect(new Set(lines).size).toBe(3);
		// No more restarts: the worker that ended the run stays up.
		const settled = await workerPid(app);
		await new Promise((r) => setTimeout(r, 4_000));
		expect(await workerPid(app)).toBe(settled);
		expect(attempts(userData)).toHaveLength(3);
		const [step] = read<{ status: string }>(
			userData,
			"select status from flow_steps where run_id = 'test-stall'",
		);
		expect(step?.status).toBe("failed");
	} finally {
		await app.close();
	}
});
