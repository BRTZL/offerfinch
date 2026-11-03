import type {
	InstanceStatus,
	StartBatchResult,
	WorkflowStarter,
} from "@offerfinch/core/pipeline/ports";
import {
	APPLICATION_UPDATED_EVENT,
	type ApplicationWorkflowParams,
	applicationInstanceId,
	type ScanWorkflowParams,
} from "@offerfinch/core/workflow/types";
import type { Database, PendingEvent } from "@offerfinch/db";
import { DrizzlePipelineRepository } from "@offerfinch/db";
import { flowEvents, flowRuns, flowSteps } from "@offerfinch/db/schema/jobs";
import { applications } from "@offerfinch/db/schema/pipeline";
import { and, desc, eq, inArray, isNotNull, like } from "drizzle-orm";

import type { FlowRunner } from "./runner";

export const SCAN_KIND = "scan";
export const APPLICATION_KIND = "application";

/** Priorities: lower first. User actions, then scans, then background scoring. */
export const PRIORITY = { event: 1, scan: 3, application: 5 } as const;

/** States in which an application's flow still has something to do or wait for. */
const ACTIVE_STATES = [
	"found",
	"scored",
	"preparing",
	"needs_answers",
	"ready_for_review",
	"approved",
	"applying",
	"needs_human",
] as const;

/**
 * The WorkflowStarter the core flows use, backed by flow runs in SQLite. Instance ids are the
 * Cloudflare ones (`job-<jobId>`), inserted with ON CONFLICT DO NOTHING, so a retried scan can
 * never start a second run for a job.
 */
export class DurableWorkflowStarter implements WorkflowStarter {
	readonly runtime = "local" as const;

	constructor(
		private readonly db: Database,
		private readonly runner: Pick<FlowRunner, "poke" | "wake"> | null,
		private readonly now: () => Date = () => new Date(),
	) {}

	/** `priority`: a job the user just added goes ahead of scans and their scoring. */
	async startBatch(
		params: ApplicationWorkflowParams[],
		options: { priority?: number } = {},
	): Promise<StartBatchResult> {
		const result: StartBatchResult = { created: [], existing: [], failed: [] };
		for (const p of params) {
			try {
				const inserted = await this.db
					.insert(flowRuns)
					.values({
						id: applicationInstanceId(p.jobId),
						userId: p.userId,
						kind: APPLICATION_KIND,
						params: { userId: p.userId, jobId: p.jobId },
						status: "queued",
						priority: options.priority ?? PRIORITY.application,
						runAfter: this.now(),
					})
					.onConflictDoNothing()
					.returning({ id: flowRuns.id });
				(inserted.length > 0 ? result.created : result.existing).push(p.jobId);
			} catch (error) {
				result.failed.push({
					jobId: p.jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.runner?.poke();
		return result;
	}

	async status(jobId: string): Promise<InstanceStatus> {
		const [run] = await this.db
			.select({ status: flowRuns.status })
			.from(flowRuns)
			.where(eq(flowRuns.id, applicationInstanceId(jobId)));
		// No run: one the import brought, or one an earlier version ran; it has ended.
		if (!run) return "complete";
		return run.status;
	}

	/** Runs the flow again from its start: steps are cleared; the stored state decides. */
	async restart(
		params: ApplicationWorkflowParams,
		options: { priority?: number } = {},
	): Promise<void> {
		await restartRun(this.db, {
			id: applicationInstanceId(params.jobId),
			userId: params.userId,
			kind: APPLICATION_KIND,
			params: { userId: params.userId, jobId: params.jobId },
			priority: options.priority ?? PRIORITY.application,
			now: this.now(),
		});
		this.runner?.poke();
	}

	/**
	 * Delivers a committed dashboard event (the row in workflow_events) to its run. A waiting run
	 * wakes; an ended run, or an application with no run (imported), is started again from the
	 * beginning, and its replay re-reads the state. Safe twice: the event id is the key.
	 */
	async sendEvent(event: PendingEvent): Promise<void> {
		const jobId = event.instanceId.replace(/^job-/, "");
		await this.db
			.insert(flowEvents)
			.values({
				id: event.eventId,
				runId: event.instanceId,
				type: APPLICATION_UPDATED_EVENT,
				payload: { eventId: event.eventId },
				createdAt: this.now(),
			})
			.onConflictDoNothing();
		const [run] = await this.db
			.select({ status: flowRuns.status })
			.from(flowRuns)
			.where(eq(flowRuns.id, event.instanceId));
		if (!run || run.status === "complete" || run.status === "errored")
			await restartRun(this.db, {
				id: event.instanceId,
				userId: event.userId,
				kind: APPLICATION_KIND,
				params: { userId: event.userId, jobId },
				priority: PRIORITY.event,
				now: this.now(),
			});
		else if (this.runner)
			await this.runner.wake(event.instanceId, PRIORITY.event);
		await new DrizzlePipelineRepository(this.db).markEventSent(
			event.userId,
			event.eventId,
		);
		this.runner?.poke();
	}

	/**
	 * Gives every application that still has something to do a run (imported data, or a run an
	 * earlier version deleted). Returns the job ids started.
	 */
	async adoptOrphans(userId: string): Promise<string[]> {
		const rows = await this.db
			.select({ jobId: applications.jobId })
			.from(applications)
			.where(
				and(
					eq(applications.userId, userId),
					inArray(applications.state, [...ACTIVE_STATES]),
				),
			);
		const ids = rows.map((r) => applicationInstanceId(r.jobId));
		if (ids.length === 0) return [];
		const existing = new Set(
			(
				await this.db
					.select({ id: flowRuns.id })
					.from(flowRuns)
					.where(inArray(flowRuns.id, ids))
			).map((r) => r.id),
		);
		const missing = rows.filter(
			(r) => !existing.has(applicationInstanceId(r.jobId)),
		);
		await this.startBatch(missing.map((r) => ({ userId, jobId: r.jobId })));
		return missing.map((r) => r.jobId);
	}
}

async function restartRun(
	db: Database,
	input: {
		id: string;
		userId: string;
		kind: string;
		params: Record<string, unknown>;
		priority: number;
		now: Date;
	},
	// Undelivered events stay for the new run; delivered ones belonged to the old one.
): Promise<void> {
	await db.transaction(async (tx) => {
		const [run] = await tx
			.select({ status: flowRuns.status })
			.from(flowRuns)
			.where(eq(flowRuns.id, input.id));
		// A running run is never reset under its owner; the event wakes it after.
		if (run?.status === "running") return;
		await tx.delete(flowSteps).where(eq(flowSteps.runId, input.id));
		await tx
			.delete(flowEvents)
			.where(
				and(eq(flowEvents.runId, input.id), isNotNull(flowEvents.deliveredTo)),
			);
		const values = {
			userId: input.userId,
			kind: input.kind,
			params: input.params,
			status: "queued" as const,
			priority: input.priority,
			runAfter: input.now,
			leaseOwner: null,
			leaseUntil: null,
			executions: 0,
			waitStep: null,
			waitEventType: null,
			waitUntil: null,
			result: null,
			error: null,
			endedAt: null,
			updatedAt: input.now,
		};
		await tx
			.insert(flowRuns)
			.values({ id: input.id, ...values, createdAt: input.now })
			.onConflictDoUpdate({ target: flowRuns.id, set: values });
	});
}

/** `scan-<user>-<YYYYMMDDHH>` (UTC): one scheduled scan per user per hour. */
export function hourlyScanId(userId: string, at: Date): string {
	return `scan-${userId}-${at
		.toISOString()
		.slice(0, 13)
		.replace(/[^0-9]/g, "")}`;
}

/**
 * Cron's replacement. Starts this hour's scan unless it exists; called every few minutes, at
 * start, and when the Mac wakes (powerMonitor), so a scan missed while asleep runs on waking
 * (once: only the current hour's id is created). Returns the run id when it started one.
 */
export async function ensureHourlyScan(
	db: Database,
	runner: Pick<FlowRunner, "poke"> | null,
	userId: string,
	now: Date = new Date(),
): Promise<string | null> {
	// A scan still queued or running (one that ran past the hour, or waits for a site check) is
	// not joined by a second: two at once take both queue slots and read the same sites together.
	if (await busyScan(db, userId)) return null;
	const id = hourlyScanId(userId, now);
	const inserted = await db
		.insert(flowRuns)
		.values({
			id,
			userId,
			kind: SCAN_KIND,
			params: { userId, trigger: "cron" } satisfies ScanWorkflowParams,
			status: "queued",
			priority: PRIORITY.scan,
			runAfter: now,
			createdAt: now,
		})
		.onConflictDoNothing()
		.returning({ id: flowRuns.id });
	if (inserted.length > 0) runner?.poke();
	return inserted.length > 0 ? id : null;
}

/** The user's scan that is queued or running now, if any. */
async function busyScan(
	db: Database,
	userId: string,
): Promise<{ id: string } | undefined> {
	const [busy] = await db
		.select({ id: flowRuns.id })
		.from(flowRuns)
		.where(
			and(
				eq(flowRuns.kind, SCAN_KIND),
				eq(flowRuns.userId, userId),
				inArray(flowRuns.status, ["queued", "running"]),
			),
		)
		.limit(1);
	return busy;
}

/**
 * "Scan now": a scan unless one is already queued or running for the user (then that one's id).
 */
export async function startManualScan(
	db: Database,
	runner: Pick<FlowRunner, "poke"> | null,
	userId: string,
	now: Date = new Date(),
	companyIds?: string[],
): Promise<{ id: string; started: boolean }> {
	const busy = await busyScan(db, userId);
	if (busy) return { id: busy.id, started: false };
	const id = `scan-${userId}-manual-${now.getTime()}`;
	await db.insert(flowRuns).values({
		id,
		userId,
		kind: SCAN_KIND,
		params: {
			userId,
			trigger: "manual",
			...(companyIds?.length ? { companyIds } : {}),
		} satisfies ScanWorkflowParams,
		status: "queued",
		priority: PRIORITY.event,
		runAfter: now,
		createdAt: now,
	});
	runner?.poke();
	return { id, started: true };
}

/** The latest scan runs of a user, newest first. */
export async function recentScans(db: Database, userId: string, limit = 5) {
	return db
		.select()
		.from(flowRuns)
		.where(
			and(eq(flowRuns.kind, SCAN_KIND), like(flowRuns.id, `scan-${userId}-%`)),
		)
		.orderBy(desc(flowRuns.createdAt))
		.limit(limit);
}
