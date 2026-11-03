import { FlowPaused, type FlowStep } from "@offerfinch/core/pipeline/ports";
import type { Database } from "@offerfinch/db";
import { flowEvents, flowSteps } from "@offerfinch/db/schema/jobs";
import { and, asc, eq, isNull } from "drizzle-orm";

import { decode, encode } from "./serialize";

/** The process is stopping: the run is left to be picked up again, nothing is marked failed. */
class RunInterrupted extends FlowPaused {
	constructor() {
		super("the app to start again");
		this.name = "RunInterrupted";
	}
}

/** A wait whose timeout passed with no event: the flow turns it into `expired`. */
export class WaitTimeoutError extends Error {
	constructor(name: string) {
		super(`Wait ${name} timed out`);
		this.name = "WaitTimeoutError";
	}
}

class StepTimeoutError extends Error {
	constructor(name: string, seconds: number) {
		super(`Step ${name} did not finish within ${seconds} seconds`);
		this.name = "StepTimeoutError";
	}
}

export interface StepOptions {
	now?: () => Date;
	/** Delay before retry `attempt` (1-based); default 10 s doubling, at most 2 minutes. */
	backoffMs?: (attempt: number) => number;
	signal?: AbortSignal;
	log?: (message: string, data?: Record<string, unknown>) => void;
	/**
	 * After a timeout, how long the attempt is expected to take to stop (default 90 s: a page
	 * load in progress finishes first). Past it the step logs and keeps waiting: an attempt is
	 * never retried while it may still be running.
	 */
	stopGraceMs?: number;
	/**
	 * Reports an attempt still running past its timeout and the grace period (it ignored its
	 * signal), once per attempt. Only a report: the step keeps the slot and keeps waiting. The
	 * app decides what to do, e.g. end the process so crash recovery takes over.
	 */
	onStalled?: (stall: StalledAttempt) => void;
}

export interface StalledAttempt {
	runId: string;
	/** The step's key (name and occurrence), as in flow_steps. */
	step: string;
	attempt: number;
}

/** How an attempt ended: its value, or its error. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * The outcome, or "grace" once `ms` passed without one (no limit when `ms` is null). Rejects
 * with RunInterrupted as soon as the runner stops: the process is going down, and the step must
 * stay recoverable.
 */
function outcomeWithin<T>(
	outcome: Promise<Outcome<T>>,
	ms: number | null,
	signal?: AbortSignal,
): Promise<Outcome<T> | "grace"> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new RunInterrupted());
		const timer = ms === null ? null : setTimeout(() => done("grace"), ms);
		const onAbort = () => {
			if (timer) clearTimeout(timer);
			reject(new RunInterrupted());
		};
		const done = (value: Outcome<T> | "grace") => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		void outcome.then(done);
	});
}

const DEFAULT_BACKOFF = (attempt: number) =>
	Math.min(10_000 * 2 ** (attempt - 1), 120_000);

/** "14 days", "30 seconds", "2 hours" -> milliseconds. */
export function durationMs(text: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?$/i.exec(
		text.trim(),
	);
	if (!match) throw new Error(`Unknown duration: ${text}`);
	const unit = {
		second: 1_000,
		minute: 60_000,
		hour: 3_600_000,
		day: 86_400_000,
		week: 604_800_000,
	}[match[2]?.toLowerCase() as "second"];
	return Number(match[1]) * unit;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new RunInterrupted());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new RunInterrupted());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function withTimeout<T>(
	promise: Promise<T>,
	name: string,
	seconds: number,
	signal?: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new StepTimeoutError(name, seconds)),
			seconds * 1_000,
		);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new RunInterrupted());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export interface PendingWait {
	key: string;
	type: string;
	until: Date;
}

/**
 * FlowStep backed by SQLite. Each step is keyed by its name and its occurrence in the run; a
 * completed step returns its stored result on replay, a finally failed one throws its error
 * again, so a replay follows the path the first run took. Attempts are stored before each try:
 * after a crash a step continues its count (the interrupted attempt is not counted as failed,
 * since it may not have finished). Waits record their deadline and pause the run (FlowPaused);
 * an event or the deadline starts it again and the replay reaches the wait.
 */
export class DurableStep implements FlowStep {
	private readonly seen = new Map<string, number>();
	/** Set when the run paused on a wait; the runner parks the run until an event or timeout. */
	pendingWait: PendingWait | null = null;
	/** Steps actually executed (not replayed) in this execution, in order. */
	readonly executed: string[] = [];

	constructor(
		private readonly db: Database,
		readonly runId: string,
		private readonly options: StepOptions = {},
	) {}

	private now() {
		return this.options.now?.() ?? new Date();
	}

	private keyOf(name: string): string {
		const n = (this.seen.get(name) ?? 0) + 1;
		this.seen.set(name, n);
		return `${name}#${n}`;
	}

	private async row(key: string) {
		const [row] = await this.db
			.select()
			.from(flowSteps)
			.where(and(eq(flowSteps.runId, this.runId), eq(flowSteps.key, key)));
		return row;
	}

	private async save(
		key: string,
		values: Partial<typeof flowSteps.$inferInsert> & {
			status: (typeof flowSteps.$inferInsert)["status"];
		},
	) {
		const row = { ...values, updatedAt: this.now() };
		await this.db
			.insert(flowSteps)
			.values({ runId: this.runId, key, ...row })
			.onConflictDoUpdate({
				target: [flowSteps.runId, flowSteps.key],
				set: row,
			});
	}

	/**
	 * What a timed-out attempt finally did. It was told to stop; the step waits for it to settle
	 * and takes its outcome as the attempt's: a success that landed during cleanup is kept (not
	 * run again), an error is the attempt's failure. Past the grace period the step goes on
	 * waiting instead of retrying beside it, as after a crash, where a step left running is run
	 * again only once its process is gone. If the runner stops meanwhile: RunInterrupted, and
	 * nothing is recorded, so the next start runs the step again.
	 */
	private async lateOutcome<T>(
		running: Promise<T>,
		key: string,
		attempt: number,
	): Promise<Outcome<T>> {
		const outcome: Promise<Outcome<T>> = running.then(
			(value) => ({ ok: true, value }),
			(error) => ({ ok: false, error }),
		);
		const first = await outcomeWithin(
			outcome,
			this.options.stopGraceMs ?? 90_000,
			this.options.signal,
		);
		if (first !== "grace") return first;
		this.options.log?.("step attempt still running after its timeout", {
			runId: this.runId,
			key,
		});
		this.options.onStalled?.({ runId: this.runId, step: key, attempt });
		const late = await outcomeWithin(outcome, null, this.options.signal);
		return late as Outcome<T>;
	}

	async do<T>(
		name: string,
		fn: (signal?: AbortSignal) => Promise<T>,
		options: { retries?: number; timeoutSeconds?: number } = {},
	): Promise<T> {
		const key = this.keyOf(name);
		const stored = await this.row(key);
		if (stored?.status === "complete") return decode<T>(stored.result);
		// Stopping: start nothing new (a flow's catch-all must not record a stop as a failure).
		if (this.options.signal?.aborted) throw new RunInterrupted();
		if (stored?.status === "failed")
			throw new Error(stored.error ?? `Step ${name} failed`);
		const limit = (options.retries ?? 2) + 1;
		// A step left `running` was interrupted (the process died): that attempt is tried again.
		let attempts =
			stored?.status === "running"
				? Math.max(0, stored.attempts - 1)
				: (stored?.attempts ?? 0);
		const timeout = options.timeoutSeconds ?? 120;
		while (true) {
			attempts++;
			await this.save(key, { status: "running", attempts, error: null });
			this.executed.push(key);
			// Each attempt can be told to stop: on its timeout, or when the runner stops.
			const attempt = new AbortController();
			const stopAttempt = () => attempt.abort(new RunInterrupted());
			this.options.signal?.addEventListener("abort", stopAttempt, {
				once: true,
			});
			const running = Promise.resolve().then(() => fn(attempt.signal));
			let outcome: Outcome<T>;
			try {
				outcome = {
					ok: true,
					value: await withTimeout(running, name, timeout, this.options.signal),
				};
			} catch (error) {
				if (error instanceof StepTimeoutError) {
					// Timed out: the attempt is told to stop, and its own outcome decides. Nothing
					// is retried while it still runs (throws RunInterrupted if the runner stops).
					attempt.abort(error);
					outcome = await this.lateOutcome(running, key, attempts);
				} else outcome = { ok: false, error };
			} finally {
				this.options.signal?.removeEventListener("abort", stopAttempt);
			}
			if (outcome.ok) {
				await this.save(key, {
					status: "complete",
					attempts,
					result: encode(outcome.value),
				});
				return outcome.value;
			}
			const error = outcome.error;
			if (error instanceof FlowPaused) throw error;
			// The runner is stopping: never record a failure, the step stays recoverable.
			if (this.options.signal?.aborted) throw new RunInterrupted();
			const message = error instanceof Error ? error.message : String(error);
			if (attempts >= limit) {
				await this.save(key, {
					status: "failed",
					attempts,
					error: message.slice(0, 2_000),
				});
				throw error;
			}
			await this.save(key, {
				status: "running",
				attempts,
				error: message.slice(0, 2_000),
			});
			this.options.log?.("step retry", { runId: this.runId, key, attempts });
			await sleep(
				(this.options.backoffMs ?? DEFAULT_BACKOFF)(attempts),
				this.options.signal,
			);
		}
	}

	async waitForEvent<T>(
		name: string,
		options: { type: string; timeout: string },
	): Promise<{ payload: T }> {
		const key = this.keyOf(name);
		const stored = await this.row(key);
		if (stored?.status === "complete")
			return { payload: decode<T>(stored.result) };
		if (stored?.status === "timed_out") throw new WaitTimeoutError(name);
		const now = this.now();
		const startedAt = stored?.waitStartedAt ?? now;
		const until =
			stored?.waitUntil ??
			new Date(startedAt.getTime() + durationMs(options.timeout));
		// The oldest event of that type not yet given to a wait.
		const taken = await this.db.transaction(async (tx) => {
			const [event] = await tx
				.select()
				.from(flowEvents)
				.where(
					and(
						eq(flowEvents.runId, this.runId),
						eq(flowEvents.type, options.type),
						isNull(flowEvents.deliveredTo),
					),
				)
				.orderBy(asc(flowEvents.createdAt), asc(flowEvents.id))
				.limit(1);
			if (!event) return null;
			await tx
				.update(flowEvents)
				.set({ deliveredTo: key })
				.where(eq(flowEvents.id, event.id));
			const values = {
				status: "complete" as const,
				attempts: 1,
				result: encode(event.payload),
				waitStartedAt: startedAt,
				waitUntil: until,
				updatedAt: now,
			};
			await tx
				.insert(flowSteps)
				.values({ runId: this.runId, key, ...values })
				.onConflictDoUpdate({
					target: [flowSteps.runId, flowSteps.key],
					set: values,
				});
			return event;
		});
		if (taken) return { payload: taken.payload as T };
		if (until.getTime() <= now.getTime()) {
			await this.save(key, {
				status: "timed_out",
				waitStartedAt: startedAt,
				waitUntil: until,
			});
			throw new WaitTimeoutError(name);
		}
		await this.save(key, {
			status: "waiting",
			waitStartedAt: startedAt,
			waitUntil: until,
		});
		this.pendingWait = { key, type: options.type, until };
		throw new FlowPaused(name);
	}
}
