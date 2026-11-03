import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

/**
 * Durable flow runs: the desktop replacement for Cloudflare Workflows and Cron. One row per
 * instance; the id is derived from what it runs (`job-<jobId>`, `scan-<user>-<YYYYMMDDHH>`), so a
 * repeated start is a no-op. The flow bodies are the same core functions (`runScanFlow`,
 * `runApplicationFlow`), driven through the FlowStep port by `@offerfinch/runner`.
 */
export const flowRuns = sqliteTable(
	"flow_runs",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").notNull(),
		/** Which flow body runs it: "scan", "application" (or a test flow). */
		kind: text("kind").notNull(),
		params: text("params", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull(),
		/**
		 * queued: ready once `run_after` passes. running: leased by `lease_owner` until
		 * `lease_until`. waiting: paused on an event (or its timeout at `wait_until`).
		 * complete / errored: ended.
		 */
		status: text("status", {
			enum: ["queued", "running", "waiting", "complete", "errored"],
		}).notNull(),
		/** Lower runs first: user actions (events) come before background scoring. */
		priority: integer("priority").notNull().default(5),
		runAfter: integer("run_after", { mode: "timestamp_ms" }).notNull(),
		leaseOwner: text("lease_owner"),
		leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
		/** How many times an execution started (crash recoveries and wake-ups included). */
		executions: integer("executions").notNull().default(0),
		waitStep: text("wait_step"),
		waitEventType: text("wait_event_type"),
		waitUntil: integer("wait_until", { mode: "timestamp_ms" }),
		result: text("result"),
		error: text("error"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		endedAt: integer("ended_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		index("flow_runs_ready_idx").on(t.status, t.priority, t.runAfter),
		index("flow_runs_user_kind_idx").on(t.userId, t.kind, t.createdAt),
	],
);

/**
 * One step of a run, keyed by its name and the occurrence of that name in the run (as
 * Cloudflare does), so a repeated name never returns another call's result. A completed step's
 * result is replayed; `attempts` survives a crash, so retries keep counting.
 */
export const flowSteps = sqliteTable(
	"flow_steps",
	{
		runId: text("run_id")
			.notNull()
			.references(() => flowRuns.id, { onDelete: "cascade" }),
		/** `<name>#<occurrence>` */
		key: text("key").notNull(),
		/** running, complete, failed, waiting (an event wait), timed_out. */
		status: text("status", {
			enum: ["running", "complete", "failed", "waiting", "timed_out"],
		}).notNull(),
		attempts: integer("attempts").notNull().default(0),
		/** JSON with Dates tagged, see runner/serialize. */
		result: text("result"),
		error: text("error"),
		/** For a wait: when it started and when it times out. */
		waitStartedAt: integer("wait_started_at", { mode: "timestamp_ms" }),
		waitUntil: integer("wait_until", { mode: "timestamp_ms" }),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [primaryKey({ columns: [t.runId, t.key] })],
);

/** Events sent to a run (`sendEvent`), delivered to its next matching wait, oldest first. */
export const flowEvents = sqliteTable(
	"flow_events",
	{
		id: text("id").primaryKey(),
		runId: text("run_id").notNull(),
		type: text("type").notNull(),
		payload: text("payload", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull(),
		/** The step key it was delivered to; null while undelivered. */
		deliveredTo: text("delivered_to"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [index("flow_events_run_idx").on(t.runId, t.deliveredTo)],
);

/**
 * Desktop settings that are not pipeline settings: model roles, notification toggles, onboarding
 * progress, scan pause, and the like. One JSON value per key. Never holds a secret: API keys are
 * stored encrypted by the main process (safeStorage), outside the database.
 */
export const appSettings = sqliteTable("app_settings", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" }).$type<unknown>().notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.$defaultFn(() => new Date())
		.notNull(),
});
