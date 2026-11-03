import fs from "node:fs";
import path from "node:path";
import type { Database } from "@offerfinch/db";
import { flowRuns, flowSteps } from "@offerfinch/db/schema/jobs";
import type { FlowHandler, StalledAttempt } from "@offerfinch/runner";
import { and, eq } from "drizzle-orm";

import type { SettingsStore } from "./settings";

/**
 * A step attempt that ran past its timeout and grace period without stopping (it ignores its
 * signal) holds one of the runner's two slots for good, and nothing in this process can stop it.
 * The worker ends itself instead: main starts a new one (WorkerHost), main lets the dead
 * process's site tabs go (its generation), and crash recovery runs the step again once the old
 * process is gone. The same step stalling again and again is stopped: after STALL_LIMIT stalls
 * it is marked failed with the reason, and its run ends as the flow decides (a scan records the
 * provider's problem; other runs end errored), instead of restarting the worker forever.
 */
export const STALL_LIMIT = 3;

export interface StallOutcome {
	stalls: number;
	failed: boolean;
}

/** Counts the stall (kept across restarts); at the limit, marks the step failed with why. */
export async function recordStall(
	db: Database,
	settings: SettingsStore,
	stall: StalledAttempt,
): Promise<StallOutcome> {
	const key = `${stall.runId} ${stall.step}`;
	const counts = await settings.get("stalls");
	const stalls = (counts[key] ?? 0) + 1;
	await settings.set("stalls", { ...counts, [key]: stalls });
	if (stalls < STALL_LIMIT) return { stalls, failed: false };
	await db
		.update(flowSteps)
		.set({
			status: "failed",
			error: `Stopped after ${stalls} stalls: the step kept running past its time limit and did not stop when asked`,
			updatedAt: new Date(),
		})
		.where(
			and(eq(flowSteps.runId, stall.runId), eq(flowSteps.key, stall.step)),
		);
	return { stalls, failed: true };
}

/* ------------------------------------------------------------ test runs */

export const TEST_STALL_KIND = "test-stall";
const TEST_STALL_RUN = "test-stall";

/**
 * Test runs only (OFFERFINCH_TEST_STALL=1): a flow whose one step ignores its signal and never
 * settles, unless `stall-release` exists in the data folder. Each attempt is written to
 * `stall-probe.log` with the worker's pid.
 */
export function testStallHandler(userData: string): FlowHandler {
	return (step) =>
		step.do(
			"hang",
			() => {
				fs.appendFileSync(
					path.join(userData, "stall-probe.log"),
					`start ${process.pid}\n`,
				);
				if (fs.existsSync(path.join(userData, "stall-release")))
					return Promise.resolve("released");
				return new Promise<string>(() => {});
			},
			{ retries: 0, timeoutSeconds: 0.3 },
		);
}

export async function queueTestStall(db: Database, userId: string) {
	const now = new Date();
	await db
		.insert(flowRuns)
		.values({
			id: TEST_STALL_RUN,
			userId,
			kind: TEST_STALL_KIND,
			params: {},
			status: "queued",
			priority: 1,
			runAfter: now,
			createdAt: now,
		})
		.onConflictDoNothing();
}
