import { FlowPaused, type FlowStep } from "@offerfinch/core/pipeline/ports";
import type { Database } from "@offerfinch/db";
import { flowEvents, flowRuns } from "@offerfinch/db/schema/jobs";
import { and, asc, eq, inArray, isNull, lte, min, ne, sql } from "drizzle-orm";

import { encode } from "./serialize";
import { DurableStep, type StepOptions } from "./step";

/** A flow body: the same functions Cloudflare Workflows ran, through the FlowStep port. */
export type FlowHandler = (
	step: FlowStep,
	params: Record<string, unknown>,
	run: { id: string; userId: string },
) => Promise<unknown>;

type RunStatus = (typeof flowRuns.$inferSelect)["status"];

export interface RunnerOptions {
	db: Database;
	handlers: Record<string, FlowHandler>;
	/** Runs executing at once, scans and applications together. */
	concurrency?: number;
	/** This process's lease name; the pid is part of it so a dead owner can be recognized. */
	owner?: string;
	leaseMs?: number;
	now?: () => Date;
	backoffMs?: StepOptions["backoffMs"];
	/** A run starting more often than this is stopped as errored (a crash loop). */
	maxExecutions?: number;
	log?: (message: string, data?: Record<string, unknown>) => void;
	/** After a step's timeout, how long its attempt may take to stop (StepOptions.stopGraceMs). */
	stopGraceMs?: number;
	/**
	 * A step attempt still runs past its timeout and grace period, holding a slot (it ignores
	 * its signal). Only reported; without a hook the step keeps waiting for it.
	 */
	onStalled?: StepOptions["onStalled"];
	/** Called after a run changes status (UI refresh, notifications). */
	onRunEnd?: (run: {
		id: string;
		kind: string;
		userId: string;
		status: RunStatus;
	}) => void;
}

const POLL_CAP_MS = 60_000;

function ownerAlive(owner: string | null): boolean {
	const pid = Number(owner?.split(":")[1]);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the pid exists (another user's process); its lease decides.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * The durable job runner: one queue of flow runs in SQLite, a few at a time. Replaces Cloudflare
 * Workflows (instances, step memoization, waits with timeouts, retries) and Cron (see
 * scheduler.ts). A run is claimed with a lease in one UPDATE, so two processes can never run it
 * at once; a crashed owner's runs (its pid is gone, or its lease ran out) are queued again and
 * replay from their stored steps.
 */
export class FlowRunner {
	private readonly db: Database;
	private readonly concurrency: number;
	readonly owner: string;
	private readonly leaseMs: number;
	private readonly active = new Map<string, Promise<void>>();
	private abort = new AbortController();
	private timer: NodeJS.Timeout | null = null;
	private heartbeat: NodeJS.Timeout | null = null;
	private running = false;
	private ticking: Promise<void> | null = null;
	private again = false;

	constructor(private readonly options: RunnerOptions) {
		this.db = options.db;
		this.concurrency = options.concurrency ?? 2;
		this.owner =
			options.owner ??
			`runner:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
		this.leaseMs = options.leaseMs ?? 60_000;
	}

	private now() {
		return this.options.now?.() ?? new Date();
	}

	/** Queues runs whose owner died or whose lease ran out. Returns how many. */
	async recover(): Promise<number> {
		const stale = await this.db
			.select({
				id: flowRuns.id,
				leaseOwner: flowRuns.leaseOwner,
				leaseUntil: flowRuns.leaseUntil,
			})
			.from(flowRuns)
			.where(eq(flowRuns.status, "running"));
		let recovered = 0;
		for (const run of stale) {
			if (run.leaseOwner === this.owner) continue;
			const expired =
				!run.leaseUntil || run.leaseUntil.getTime() < this.now().getTime();
			if (!expired && ownerAlive(run.leaseOwner)) continue;
			const changed = await this.db
				.update(flowRuns)
				.set({
					status: "queued",
					leaseOwner: null,
					leaseUntil: null,
					runAfter: this.now(),
					updatedAt: this.now(),
				})
				.where(
					and(
						eq(flowRuns.id, run.id),
						eq(flowRuns.status, "running"),
						run.leaseOwner === null
							? isNull(flowRuns.leaseOwner)
							: eq(flowRuns.leaseOwner, run.leaseOwner),
					),
				)
				.returning({ id: flowRuns.id });
			recovered += changed.length;
			this.options.log?.("run recovered", { runId: run.id });
		}
		return recovered;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.abort = new AbortController();
		await this.recover();
		this.heartbeat = setInterval(
			() => void this.renewLeases(),
			Math.max(1_000, Math.floor(this.leaseMs / 3)),
		);
		this.heartbeat.unref?.();
		this.poke();
	}

	/**
	 * Stops taking work and interrupts running steps (their sleeps and timeouts); waits up to
	 * `graceMs` for runs to unwind. Interrupted runs are queued again for the next start.
	 */
	async stop(graceMs = 5_000): Promise<void> {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.timer = null;
		this.heartbeat = null;
		this.abort.abort();
		await Promise.race([
			Promise.allSettled([...this.active.values()]),
			new Promise((r) => setTimeout(r, graceMs)),
		]);
	}

	get busy(): number {
		return this.active.size;
	}

	/** Looks for work now (after an enqueue, an event, a wake from sleep). */
	poke(): void {
		if (!this.running) return;
		if (this.ticking !== null) {
			this.again = true;
			return;
		}
		this.ticking = this.tick()
			.catch((error) =>
				this.options.log?.("runner tick failed", {
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.finally(() => {
				this.ticking = null;
				if (this.again) {
					this.again = false;
					this.poke();
				}
			});
	}

	private async renewLeases() {
		if (this.active.size === 0) return;
		await this.db
			.update(flowRuns)
			.set({ leaseUntil: new Date(this.now().getTime() + this.leaseMs) })
			.where(
				and(
					eq(flowRuns.leaseOwner, this.owner),
					eq(flowRuns.status, "running"),
				),
			);
	}

	private async tick(): Promise<void> {
		const now = this.now();
		// Waits whose deadline passed run again; the replay reaches the wait and times it out.
		await this.db
			.update(flowRuns)
			.set({ status: "queued", runAfter: now, updatedAt: now })
			.where(and(eq(flowRuns.status, "waiting"), lte(flowRuns.waitUntil, now)));
		const free = this.concurrency - this.active.size;
		if (free > 0 && this.running) {
			const ready = await this.db
				.select({ id: flowRuns.id })
				.from(flowRuns)
				.where(
					and(
						eq(flowRuns.status, "queued"),
						lte(flowRuns.runAfter, now),
						this.active.size > 0
							? sql`${flowRuns.id} not in (${sql.join(
									[...this.active.keys()].map((id) => sql`${id}`),
									sql`, `,
								)})`
							: undefined,
					),
				)
				.orderBy(asc(flowRuns.priority), asc(flowRuns.runAfter))
				.limit(free);
			for (const { id } of ready) {
				// Stopped (or no longer taking work) while this tick ran: claim nothing more.
				if (!this.running) break;
				const claimed = await this.claim(id);
				if (!claimed) continue;
				// stop() or stopTaking() came while the claim waited (e.g. behind a SQLite lock):
				// hand the run back untouched instead of starting it in a process about to end.
				if (!this.running) {
					await this.unclaim(id);
					break;
				}
				const execution = this.execute(claimed).finally(() => {
					this.active.delete(id);
					this.poke();
				});
				this.active.set(id, execution);
			}
		}
		void this.schedule();
	}

	/** One UPDATE: only a queued run (or one whose lease ran out) can be taken. */
	private async claim(id: string) {
		const now = this.now();
		const [run] = await this.db
			.update(flowRuns)
			.set({
				status: "running",
				leaseOwner: this.owner,
				leaseUntil: new Date(now.getTime() + this.leaseMs),
				executions: sql`${flowRuns.executions} + 1`,
				updatedAt: now,
			})
			.where(and(eq(flowRuns.id, id), eq(flowRuns.status, "queued")))
			.returning();
		return run ?? null;
	}

	/** Undoes a claim that never started: back to queued, as if this runner never took it. */
	private async unclaim(id: string) {
		await this.db
			.update(flowRuns)
			.set({
				status: "queued",
				leaseOwner: null,
				leaseUntil: null,
				executions: sql`${flowRuns.executions} - 1`,
				updatedAt: this.now(),
			})
			.where(
				and(
					eq(flowRuns.id, id),
					eq(flowRuns.status, "running"),
					eq(flowRuns.leaseOwner, this.owner),
				),
			);
	}

	private async schedule() {
		if (!this.running) return;
		if (this.timer) clearTimeout(this.timer);
		const [next] = await this.db
			.select({
				queued: min(flowRuns.runAfter),
			})
			.from(flowRuns)
			.where(eq(flowRuns.status, "queued"));
		const [wait] = await this.db
			.select({ until: min(flowRuns.waitUntil) })
			.from(flowRuns)
			.where(eq(flowRuns.status, "waiting"));
		const times = [next?.queued, wait?.until]
			.filter((t): t is Date => t instanceof Date)
			.map((t) => t.getTime());
		const due =
			times.length > 0 ? Math.min(...times) : Number.POSITIVE_INFINITY;
		const delay = Math.max(
			50,
			Math.min(POLL_CAP_MS, due - this.now().getTime()),
		);
		if (!this.running) return;
		this.timer = setTimeout(() => this.poke(), delay);
		this.timer.unref?.();
	}

	private async finish(
		id: string,
		values: Partial<typeof flowRuns.$inferInsert>,
	): Promise<void> {
		await this.db
			.update(flowRuns)
			.set({
				...values,
				leaseOwner: null,
				leaseUntil: null,
				updatedAt: this.now(),
			})
			.where(and(eq(flowRuns.id, id), eq(flowRuns.leaseOwner, this.owner)));
	}

	private async execute(run: typeof flowRuns.$inferSelect): Promise<void> {
		const handler = this.options.handlers[run.kind];
		const notify = (status: RunStatus) =>
			this.options.onRunEnd?.({
				id: run.id,
				kind: run.kind,
				userId: run.userId,
				status,
			});
		if (!handler) {
			await this.finish(run.id, {
				status: "errored",
				error: `No handler for ${run.kind}`,
				endedAt: this.now(),
			});
			notify("errored");
			return;
		}
		if (run.executions > (this.options.maxExecutions ?? 50)) {
			await this.finish(run.id, {
				status: "errored",
				error: `Started ${run.executions} times without finishing; stopped`,
				endedAt: this.now(),
			});
			notify("errored");
			return;
		}
		const step = new DurableStep(this.db, run.id, {
			now: this.options.now,
			backoffMs: this.options.backoffMs,
			signal: this.abort.signal,
			log: this.options.log,
			stopGraceMs: this.options.stopGraceMs,
			onStalled: this.options.onStalled,
		});
		this.options.log?.("run started", { runId: run.id, kind: run.kind });
		const parkIfWaiting = async (): Promise<boolean> => {
			if (!step.pendingWait || this.abort.signal.aborted) return false;
			const wait = step.pendingWait;
			await this.finish(run.id, {
				status: "waiting",
				waitStep: wait.key,
				waitEventType: wait.type,
				waitUntil: wait.until,
			});
			// An event that arrived while this execution ran must wake it now.
			if (await this.hasUndelivered(run.id, wait.type))
				await this.wake(run.id, 1);
			notify("waiting");
			return true;
		};
		try {
			const result = await handler(step, run.params, {
				id: run.id,
				userId: run.userId,
			});
			if (this.abort.signal.aborted) throw new FlowPausedByStop();
			if (await parkIfWaiting()) return;
			await this.finish(run.id, {
				status: "complete",
				result: encode(result),
				error: null,
				waitStep: null,
				waitEventType: null,
				waitUntil: null,
				endedAt: this.now(),
			});
			notify("complete");
		} catch (error) {
			// A flow may let the wait's pause propagate (the scan flow) or return (application).
			if (error instanceof FlowPaused && (await parkIfWaiting())) return;
			if (error instanceof FlowPaused || this.abort.signal.aborted) {
				// Interrupted by a stop: the next start replays it.
				await this.finish(run.id, { status: "queued", runAfter: this.now() });
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			await this.finish(run.id, {
				status: "errored",
				error: message.slice(0, 2_000),
				endedAt: this.now(),
			});
			this.options.log?.("run errored", { runId: run.id, error: message });
			notify("errored");
		}
	}

	private async hasUndelivered(runId: string, type: string) {
		const [row] = await this.db
			.select({ id: flowEvents.id })
			.from(flowEvents)
			.where(
				and(
					eq(flowEvents.runId, runId),
					eq(flowEvents.type, type),
					isNull(flowEvents.deliveredTo),
				),
			)
			.limit(1);
		return Boolean(row);
	}

	/**
	 * Takes no more runs from now on (the runs in progress go on). For a process about to end
	 * itself: nothing new starts in it before it exits.
	 */
	stopTaking(): void {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** Queues a waiting (or queued) run now, ahead of background work. */
	async wake(runId: string, priority = 1): Promise<boolean> {
		const changed = await this.db
			.update(flowRuns)
			.set({
				status: "queued",
				runAfter: this.now(),
				priority,
				updatedAt: this.now(),
			})
			.where(
				and(
					eq(flowRuns.id, runId),
					inArray(flowRuns.status, ["waiting", "queued"]),
				),
			)
			.returning({ id: flowRuns.id });
		this.poke();
		return changed.length > 0;
	}

	/** Runs still to do or doing, for status displays. */
	async pendingCount(kind?: string): Promise<number> {
		const rows = await this.db
			.select({ n: sql<number>`count(*)` })
			.from(flowRuns)
			.where(
				and(
					inArray(flowRuns.status, ["queued", "running"]),
					kind ? eq(flowRuns.kind, kind) : ne(flowRuns.kind, ""),
				),
			);
		return Number(rows[0]?.n ?? 0);
	}
}

/** Thrown internally when a handler returned after a stop began. */
class FlowPausedByStop extends FlowPaused {
	constructor() {
		super("the app to start again");
	}
}
