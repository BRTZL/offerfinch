import { FlowPaused } from "@offerfinch/core/pipeline/ports";
import type { Database } from "@offerfinch/db";
import { flowEvents, flowRuns, flowSteps } from "@offerfinch/db/schema/jobs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { type FlowHandler, FlowRunner } from "../src/runner";
import { decode, encode } from "../src/serialize";
import { DurableStep, durationMs, WaitTimeoutError } from "../src/step";
import {
	DurableWorkflowStarter,
	ensureHourlyScan,
	hourlyScanId,
	startManualScan,
} from "../src/workflows";
import { openTestDb, until } from "./helpers";

const runners: FlowRunner[] = [];
afterEach(async () => {
	for (const r of runners.splice(0)) await r.stop(200);
});

async function stepRow(db: Database, runId: string, key: string) {
	const rows = await db
		.select()
		.from(flowSteps)
		.where(eq(flowSteps.runId, runId));
	return rows.find((r) => r.key === key);
}

async function queue(db: Database, id: string, kind: string, priority = 5) {
	await db.insert(flowRuns).values({
		id,
		userId: "u1",
		kind,
		params: {},
		status: "queued",
		priority,
		runAfter: new Date(0),
	});
}

async function runOf(db: Database, id: string) {
	const [run] = await db.select().from(flowRuns).where(eq(flowRuns.id, id));
	return run;
}

function startRunner(
	db: Database,
	handlers: Record<string, FlowHandler>,
	extra: Partial<ConstructorParameters<typeof FlowRunner>[0]> = {},
) {
	const runner = new FlowRunner({
		db,
		handlers,
		backoffMs: () => 5,
		...extra,
	});
	runners.push(runner);
	return runner;
}

describe("serialize", () => {
	it("keeps Dates and undefined through a replay", () => {
		const at = new Date("2026-11-01T10:00:00.123Z");
		const value = decode<{ at: Date; list: { d: Date }[] }>(
			encode({ at, list: [{ d: at }] }),
		);
		expect(value.at).toBeInstanceOf(Date);
		expect(value.at.getTime()).toBe(at.getTime());
		expect(value.list[0]?.d).toBeInstanceOf(Date);
		expect(decode(encode(undefined))).toBeUndefined();
	});

	it("parses wait timeouts", () => {
		expect(durationMs("14 days")).toBe(14 * 86_400_000);
		expect(durationMs("30 seconds")).toBe(30_000);
	});
});

describe("durable steps", () => {
	it("replays completed steps and keys repeated names by occurrence", async () => {
		const db = await openTestDb();
		await queue(db, "r1", "t");
		let calls = 0;
		const body = async (step: DurableStep) => {
			const a = await step.do("same", async () => ++calls);
			const b = await step.do("same", async () => ++calls);
			return [a, b];
		};
		const first = new DurableStep(db, "r1");
		expect(await body(first)).toEqual([1, 2]);
		const replay = new DurableStep(db, "r1");
		expect(await body(replay)).toEqual([1, 2]);
		expect(calls).toBe(2);
		expect(replay.executed).toEqual([]);
	});

	it("retries with backoff, then fails for good and replays the failure", async () => {
		const db = await openTestDb();
		await queue(db, "r2", "t");
		const delays: number[] = [];
		let calls = 0;
		const step = new DurableStep(db, "r2", {
			backoffMs: (n) => {
				delays.push(n);
				return 1;
			},
		});
		await expect(
			step.do(
				"flaky",
				async () => {
					calls++;
					throw new Error("down");
				},
				{ retries: 2 },
			),
		).rejects.toThrow("down");
		expect(calls).toBe(3);
		expect(delays).toEqual([1, 2]);
		const replay = new DurableStep(db, "r2");
		await expect(replay.do("flaky", async () => 1)).rejects.toThrow("down");
		expect(calls).toBe(3);
	});

	it("times a slow step out", async () => {
		const db = await openTestDb();
		await queue(db, "r3", "t");
		const step = new DurableStep(db, "r3", {
			backoffMs: () => 1,
			stopGraceMs: 10,
		});
		// Slow, and stops when told to (with the timeout as its reason).
		await expect(
			step.do(
				"slow",
				(signal) =>
					new Promise((_, reject) =>
						signal?.addEventListener("abort", () => reject(signal.reason)),
					),
				{ retries: 0, timeoutSeconds: 0.05 },
			),
		).rejects.toThrow(/did not finish/);
		expect((await stepRow(db, "r3", "slow#1"))?.status).toBe("failed");
	});

	it("keeps a success that lands while a timed-out attempt cleans up: it is not run twice", async () => {
		const db = await openTestDb();
		await queue(db, "r3c", "t");
		const step = new DurableStep(db, "r3c", {
			backoffMs: () => 1,
			stopGraceMs: 5_000,
		});
		const events: string[] = [];
		let attempts = 0;
		const value = await step.do(
			"commit",
			(signal) => {
				const n = ++attempts;
				events.push(`start ${n}`);
				// Its side effect finishes during cleanup, after the timeout told it to stop.
				return new Promise<string>((resolve) =>
					signal?.addEventListener("abort", () =>
						setTimeout(() => {
							events.push(`committed ${n}`);
							resolve(`result ${n}`);
						}, 30),
					),
				);
			},
			{ retries: 2, timeoutSeconds: 0.05 },
		);
		expect(value).toBe("result 1");
		expect(events).toEqual(["start 1", "committed 1"]);
		expect(await stepRow(db, "r3c", "commit#1")).toMatchObject({
			status: "complete",
			attempts: 1,
		});
		// A replay returns the kept result without running it again.
		const replay = new DurableStep(db, "r3c");
		expect(await replay.do("commit", async () => "again")).toBe("result 1");
		expect(events).toEqual(["start 1", "committed 1"]);
	});

	it("never retries beside an attempt still running past the grace period", async () => {
		const db = await openTestDb();
		await queue(db, "r3d", "t");
		const logs: string[] = [];
		const step = new DurableStep(db, "r3d", {
			backoffMs: () => 1,
			stopGraceMs: 10,
			log: (message) => logs.push(message),
		});
		const events: string[] = [];
		let attempts = 0;
		const value = await step.do(
			"stubborn",
			(signal) => {
				const n = ++attempts;
				events.push(`start ${n}`);
				if (n > 1) return Promise.resolve(`result ${n}`);
				// Ignores the stop for a long while (well past the 10 ms grace), then fails.
				return new Promise<string>((_, reject) =>
					signal?.addEventListener("abort", () =>
						setTimeout(() => {
							events.push(`ended ${n}`);
							reject(new Error("gave up"));
						}, 150),
					),
				);
			},
			{ retries: 1, timeoutSeconds: 0.05 },
		);
		// The retry started only after the first attempt had ended.
		expect(events).toEqual(["start 1", "ended 1", "start 2"]);
		expect(value).toBe("result 2");
		expect(logs).toContain("step attempt still running after its timeout");
	});

	it("a stop during the grace period leaves the step recoverable, never failed", async () => {
		const db = await openTestDb();
		await queue(db, "r3e", "t");
		const stop = new AbortController();
		const step = new DurableStep(db, "r3e", {
			backoffMs: () => 1,
			stopGraceMs: 5_000,
			signal: stop.signal,
		});
		let attempts = 0;
		const done = step.do(
			"last",
			(signal) => {
				attempts++;
				// The final attempt times out; the app quits during its cleanup; cleanup finishes.
				return new Promise((_, reject) =>
					signal?.addEventListener("abort", () => {
						setTimeout(() => stop.abort(), 10);
						setTimeout(() => reject(new Error("cleaned up")), 40);
					}),
				);
			},
			{ retries: 0, timeoutSeconds: 0.05 },
		);
		await expect(done).rejects.toBeInstanceOf(FlowPaused);
		await new Promise((r) => setTimeout(r, 60));
		expect((await stepRow(db, "r3e", "last#1"))?.status).toBe("running");
		// The next start runs it again (it was not recorded as failed).
		const next = new DurableStep(db, "r3e");
		expect(await next.do("last", async () => "second time")).toBe(
			"second time",
		);
		expect(attempts).toBe(1);
	});

	it("a stop while an attempt runs past its grace period is an interruption too", async () => {
		const db = await openTestDb();
		await queue(db, "r3f", "t");
		const stop = new AbortController();
		const step = new DurableStep(db, "r3f", {
			stopGraceMs: 10,
			signal: stop.signal,
		});
		const done = step.do("hung", () => new Promise(() => {}), {
			retries: 2,
			timeoutSeconds: 0.05,
		});
		setTimeout(() => stop.abort(), 150);
		await expect(done).rejects.toBeInstanceOf(FlowPaused);
		expect(await stepRow(db, "r3f", "hung#1")).toMatchObject({
			status: "running",
			attempts: 1,
		});
	});

	it("tells a timed-out attempt to stop and waits for it to let go before the retry", async () => {
		const db = await openTestDb();
		await queue(db, "r3b", "t");
		const step = new DurableStep(db, "r3b", {
			backoffMs: () => 1,
			stopGraceMs: 5_000,
		});
		const events: string[] = [];
		let attempts = 0;
		const value = await step.do(
			"held",
			(signal) => {
				const n = ++attempts;
				events.push(`start ${n}`);
				if (n === 2) return Promise.resolve("done");
				// Holds something (a site tab) until told to stop, then lets go a moment later.
				return new Promise((_, reject) =>
					signal?.addEventListener("abort", () =>
						setTimeout(() => {
							events.push(`released ${n}`);
							reject(new Error("stopped"));
						}, 30),
					),
				);
			},
			{ retries: 1, timeoutSeconds: 0.05 },
		);
		expect(value).toBe("done");
		expect(events).toEqual(["start 1", "released 1", "start 2"]);
	});

	it("pauses on a wait, takes an event sent before or after, and times out", async () => {
		const db = await openTestDb();
		await queue(db, "r4", "t");
		let now = new Date("2026-11-01T10:00:00Z");
		const wait = (step: DurableStep) =>
			step.waitForEvent<{ eventId: string }>("wait", {
				type: "application_updated",
				timeout: "1 day",
			});
		const first = new DurableStep(db, "r4", { now: () => now });
		await expect(wait(first)).rejects.toBeInstanceOf(FlowPaused);
		expect(first.pendingWait?.until.toISOString()).toBe(
			"2026-11-02T10:00:00.000Z",
		);
		await db.insert(flowEvents).values({
			id: "e1",
			runId: "r4",
			type: "application_updated",
			payload: { eventId: "e1" },
		});
		const second = new DurableStep(db, "r4", { now: () => now });
		expect((await wait(second)).payload).toEqual({ eventId: "e1" });
		// Delivered once: the replay returns it from the step, the event is taken.
		const third = new DurableStep(db, "r4", { now: () => now });
		expect((await wait(third)).payload).toEqual({ eventId: "e1" });
		const [event] = await db
			.select()
			.from(flowEvents)
			.where(eq(flowEvents.id, "e1"));
		expect(event?.deliveredTo).toBe("wait#1");

		await queue(db, "r5", "t");
		const timed = (n: Date) =>
			new DurableStep(db, "r5", { now: () => n }).waitForEvent("w", {
				type: "x",
				timeout: "1 day",
			});
		await expect(timed(now)).rejects.toBeInstanceOf(FlowPaused);
		now = new Date("2026-11-02T10:00:01Z");
		await expect(timed(now)).rejects.toBeInstanceOf(WaitTimeoutError);
		// A timed-out wait stays timed out, even if an event comes later.
		await db.insert(flowEvents).values({
			id: "late",
			runId: "r5",
			type: "x",
			payload: {},
		});
		await expect(timed(now)).rejects.toBeInstanceOf(WaitTimeoutError);
	});
});

describe("the runner", () => {
	it("runs at most `concurrency` runs at once, in priority order", async () => {
		const db = await openTestDb();
		let active = 0;
		let peak = 0;
		const order: string[] = [];
		const handler: FlowHandler = async (step, _p, run) => {
			order.push(run.id);
			active++;
			peak = Math.max(peak, active);
			await step.do("work", () => new Promise((r) => setTimeout(r, 30)));
			active--;
		};
		for (const id of ["a", "b", "c", "d", "e"]) await queue(db, id, "t", 5);
		await queue(db, "urgent", "t", 1);
		const runner = startRunner(db, { t: handler }, { concurrency: 2 });
		await runner.start();
		await until(
			async () => (await runner.pendingCount()) === 0 && runner.busy === 0,
		);
		expect(peak).toBe(2);
		expect(order[0]).toBe("urgent");
		expect(order).toHaveLength(6);
		for (const id of ["a", "urgent"])
			expect((await runOf(db, id))?.status).toBe("complete");
	});

	it("parks a waiting run, wakes it on an event, and expires it when the wait times out", async () => {
		const db = await openTestDb();
		let now = new Date("2026-11-01T10:00:00Z");
		const outcomes: string[] = [];
		const handler: FlowHandler = async (step) => {
			try {
				const event = await step.waitForEvent<{ eventId: string }>("wait 0", {
					type: "application_updated",
					timeout: "1 day",
				});
				outcomes.push(`event ${event.payload.eventId}`);
				return "woke";
			} catch (error) {
				if (error instanceof FlowPaused) throw error;
				outcomes.push("expired");
				return "expired";
			}
		};
		const runner = startRunner(db, { t: handler }, { now: () => now });
		const starter = new DurableWorkflowStarter(db, runner, () => now);
		await queue(db, "job-a", "t");
		await queue(db, "job-b", "t");
		await runner.start();
		await until(async () => (await runOf(db, "job-b"))?.status === "waiting");
		await until(async () => (await runOf(db, "job-a"))?.status === "waiting");
		// The dashboard committed a change and sends its event.
		await starter.sendEvent({
			userId: "u1",
			eventId: "ev-1",
			instanceId: "job-a",
		});
		await until(async () => (await runOf(db, "job-a"))?.status === "complete");
		expect(outcomes).toEqual(["event ev-1"]);
		// A day later job-b's wait times out; the flow moves it on (expired), never forward.
		now = new Date("2026-11-02T10:00:01Z");
		runner.poke();
		await until(async () => (await runOf(db, "job-b"))?.status === "complete");
		expect(outcomes).toEqual(["event ev-1", "expired"]);
	});

	it("restarts an ended run when an event arrives for it, and adopts runless applications", async () => {
		const db = await openTestDb();
		const runs: string[] = [];
		const runner = startRunner(db, {
			application: async (_step, params) => {
				runs.push(String(params.jobId));
			},
		});
		const starter = new DurableWorkflowStarter(db, runner);
		await runner.start();
		// No run exists (an imported application): the event starts one.
		await starter.sendEvent({
			userId: "u1",
			eventId: "ev-x",
			instanceId: "job-77",
		});
		await until(async () => (await runOf(db, "job-77"))?.status === "complete");
		expect(runs).toEqual(["77"]);
		// Starting the same job again is a no-op: one run per job id.
		const again = await starter.startBatch([{ userId: "u1", jobId: "77" }]);
		expect(again).toEqual({ created: [], existing: ["77"], failed: [] });
		expect(await starter.status("77")).toBe("complete");
		expect(await starter.status("never")).toBe("complete");
	});

	it("errors a run whose step keeps failing, and queues an interrupted one again on stop", async () => {
		const db = await openTestDb();
		await queue(db, "bad", "t");
		let release: () => void = () => {};
		const runner = startRunner(db, {
			t: async (step, _p, run) => {
				if (run.id === "bad")
					await step.do(
						"boom",
						async () => {
							throw new Error("always");
						},
						{ retries: 1 },
					);
				await step.do(
					"long",
					() =>
						new Promise<void>((r) => {
							release = r;
						}),
					{ timeoutSeconds: 60 },
				);
			},
		});
		await runner.start();
		await until(async () => (await runOf(db, "bad"))?.status === "errored");
		expect((await runOf(db, "bad"))?.error).toBe("always");
		await queue(db, "long", "t");
		runner.poke();
		await until(async () => (await runOf(db, "long"))?.status === "running");
		await runner.stop(500);
		release();
		const run = await runOf(db, "long");
		expect(run?.status).toBe("queued");
		const steps = await db
			.select()
			.from(flowSteps)
			.where(eq(flowSteps.runId, "long"));
		expect(steps.map((s) => s.status)).toEqual(["running"]);
	});
});

describe("scheduling", () => {
	it("starts one scan per user per hour, however often it is asked, and one manual scan at a time", async () => {
		const db = await openTestDb();
		const at = new Date("2026-11-01T10:15:00Z");
		expect(await ensureHourlyScan(db, null, "u1", at)).toBe(
			"scan-u1-2026110110",
		);
		expect(
			await ensureHourlyScan(db, null, "u1", new Date("2026-11-01T10:59:00Z")),
		).toBeNull();
		// Woken from sleep hours later: only the current hour is started, once.
		const woke = new Date("2026-11-01T15:02:00Z");
		expect(await ensureHourlyScan(db, null, "u1", woke)).toBe(
			hourlyScanId("u1", woke),
		);
		const manual = await startManualScan(db, null, "u1", woke);
		// Two scans are queued already: a manual one is not added on top.
		expect(manual.started).toBe(false);
	});
});

describe("attempts that ignore their stop (stalled)", () => {
	/** A flow whose step never settles and ignores its signal; a quick flow beside it. */
	const handlers: Record<string, FlowHandler> = {
		hang: (step) =>
			step.do("hang", () => new Promise(() => {}), {
				retries: 0,
				timeoutSeconds: 0.05,
			}),
		quick: (step) => step.do("quick", async () => "done"),
	};

	it("reports each stalled attempt once; the slots stay held (nothing runs beside them)", async () => {
		const db = await openTestDb();
		await queue(db, "h1", "hang");
		await queue(db, "h2", "hang");
		const stalls: { runId: string; step: string; attempt: number }[] = [];
		const runner = startRunner(db, handlers, {
			stopGraceMs: 20,
			onStalled: (s) => stalls.push(s),
		});
		await runner.start();
		await until(() => stalls.length === 2);
		await queue(db, "q1", "quick");
		runner.poke();
		await new Promise((r) => setTimeout(r, 300));
		expect(stalls.sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
			{ runId: "h1", step: "hang#1", attempt: 1 },
			{ runId: "h2", step: "hang#1", attempt: 1 },
		]);
		// Both slots are held by the stalled attempts: the quick run waits, and no step was
		// retried beside a stalled attempt or marked failed.
		expect((await runOf(db, "q1"))?.status).toBe("queued");
		expect((await runOf(db, "h1"))?.status).toBe("running");
		expect(stalls).toHaveLength(2);
	});

	it("without a hook, a stalled attempt is waited for as before", async () => {
		const db = await openTestDb();
		await queue(db, "h3", "hang");
		const logs: string[] = [];
		const runner = startRunner(db, handlers, {
			stopGraceMs: 20,
			concurrency: 1,
			log: (m) => logs.push(m),
		});
		await runner.start();
		await until(() =>
			logs.includes("step attempt still running after its timeout"),
		);
		await queue(db, "q2", "quick");
		runner.poke();
		await new Promise((r) => setTimeout(r, 300));
		expect((await runOf(db, "q2"))?.status).toBe("queued");
		expect((await runOf(db, "h3"))?.status).toBe("running");
	});

	it("stopTaking: a process about to end starts nothing new", async () => {
		const db = await openTestDb();
		const runner = startRunner(db, handlers);
		await runner.start();
		runner.stopTaking();
		await queue(db, "q3", "quick");
		runner.poke();
		await new Promise((r) => setTimeout(r, 200));
		expect((await runOf(db, "q3"))?.status).toBe("queued");
	});

	it("stopTaking during a claim: the claimed run is handed back, never started", async () => {
		const db = await openTestDb();
		let started = 0;
		const runner = startRunner(db, {
			counted: (step) =>
				step.do("counted", async () => {
					started++;
					return "done";
				}),
		});
		// The claim is in flight (as behind a SQLite lock) when the process stops taking work.
		const internal = runner as unknown as {
			claim: (id: string) => Promise<unknown>;
		};
		const claim = internal.claim.bind(runner);
		internal.claim = async (id) => {
			runner.stopTaking();
			return claim(id);
		};
		await queue(db, "c1", "counted");
		await runner.start();
		await new Promise((r) => setTimeout(r, 200));
		expect(started).toBe(0);
		const run = await runOf(db, "c1");
		expect(run?.status).toBe("queued");
		expect(run?.leaseOwner).toBeNull();
		expect(run?.executions).toBe(0);
	});
});
