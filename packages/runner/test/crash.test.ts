import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { flowRuns, flowSteps } from "@offerfinch/db/schema/jobs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openTestDb, probeLog, tempDbPath, until } from "./helpers";

const WORKER = fileURLToPath(
	new URL("./fixtures/probe-worker.ts", import.meta.url),
);

function worker(file: string, run: string, env: Record<string, string> = {}) {
	return spawn(process.execPath, ["--import", "tsx", WORKER, file, run], {
		env: { ...process.env, ...env },
		stdio: ["ignore", "inherit", "inherit"],
	});
}

const exited = (child: ChildProcess) =>
	new Promise<number | null>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null)
			resolve(child.exitCode);
		else child.once("exit", (code) => resolve(code));
	});

describe("kill -9 mid-flow", () => {
	it("recovers on restart: finished steps are not run again, the interrupted one is, and the run completes once", async () => {
		const file = tempDbPath();
		const db = await openTestDb(file);
		await db.insert(flowRuns).values({
			id: "probe-1",
			userId: "u1",
			kind: "probe",
			params: {},
			status: "queued",
			runAfter: new Date(),
		});
		const first = worker(file, "probe-1", { PROBE_HANG: "1" });
		await until(() => probeLog(db, "probe-1").includes("B"), 20_000);
		first.kill("SIGKILL");
		await exited(first);
		// Dead mid-step: the run still looks running, step B unfinished.
		const [stuck] = await db
			.select()
			.from(flowRuns)
			.where(eq(flowRuns.id, "probe-1"));
		expect(stuck?.status).toBe("running");

		const second = worker(file, "probe-1");
		expect(await exited(second)).toBe(0);
		expect(probeLog(db, "probe-1")).toEqual([
			"execution",
			"A",
			"B",
			// After the restart: A replayed from its stored result, B tried again, then C.
			"execution",
			"B",
			"C",
		]);
		const [run] = await db
			.select()
			.from(flowRuns)
			.where(eq(flowRuns.id, "probe-1"));
		expect(run?.status).toBe("complete");
		expect(run?.executions).toBe(2);
		const steps = await db
			.select()
			.from(flowSteps)
			.where(eq(flowSteps.runId, "probe-1"));
		expect(
			Object.fromEntries(steps.map((s) => [s.key, [s.status, s.attempts]])),
		).toEqual({
			"A#1": ["complete", 1],
			"B#1": ["complete", 1],
			"C#1": ["complete", 1],
		});
		db.$close();
	}, 60_000);

	it("never runs one run in two processes at once", async () => {
		const file = tempDbPath();
		const db = await openTestDb(file);
		await db.insert(flowRuns).values({
			id: "probe-2",
			userId: "u1",
			kind: "probe",
			params: {},
			status: "queued",
			runAfter: new Date(),
		});
		// Three runner processes race for the same queued run.
		const children = [1, 2, 3].map(() => worker(file, "probe-2"));
		await Promise.all(children.map(exited));
		const log = db.$client
			.prepare("select entry, pid from probe_log where run = 'probe-2'")
			.all() as { entry: string; pid: number }[];
		expect(log.map((l) => l.entry)).toEqual(["execution", "A", "B", "C"]);
		expect(new Set(log.map((l) => l.pid)).size).toBe(1);
		db.$close();
	}, 60_000);
});
