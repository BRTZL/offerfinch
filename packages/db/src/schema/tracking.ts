import { TRACKING_STAGES } from "@offerfinch/core/domain/tracking";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth";
import { applications } from "./pipeline";

/**
 * What happened after Applied, one row per stage the application entered (see
 * `core/domain/tracking.ts`). The row with the highest `seq` is its current stage; an applied
 * application with none is at Applied, dated its `applied_at`. The application's own state stays
 * `applied`.
 */
export const applicationStages = sqliteTable(
	"application_stages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		/**
		 * The entry's place in the application's history, 1, 2, 3…: the order of record. Never
		 * the clock, which can be set back between two moves.
		 */
		seq: integer("seq").notNull(),
		stage: text("stage", { enum: TRACKING_STAGES }).notNull(),
		/**
		 * The calendar day it happened (YYYY-MM-DD), as the user picked it: a day, not an instant,
		 * so it reads the same in every time zone.
		 */
		occurredOn: text("occurred_on").notNull(),
		/** Interviewing: which round this is. */
		interviewRound: integer("interview_round"),
		/** Interviewing: when the interview is, an instant (shown in the user's time zone). */
		interviewAt: integer("interview_at", { mode: "timestamp_ms" }),
		/** Set by the app (Ghosted after days without a change), not by the user. */
		automatic: integer("automatic", { mode: "boolean" })
			.notNull()
			.default(false),
		/** When the follow-up reminder for this stage entry was sent; one per entry. */
		remindedAt: integer("reminded_at", { mode: "timestamp_ms" }),
		/**
		 * When macOS last did not show that reminder (blocked, failed, no answer): it is tried
		 * again, at most once a day, until it is shown.
		 */
		reminderTriedAt: integer("reminder_tried_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [
		uniqueIndex("application_stages_app_seq").on(t.applicationId, t.seq),
		index("application_stages_user_idx").on(t.userId),
	],
);

/**
 * The user's private notes on a job ("recruiter: Dana", "referred by Lee"), dated. A note made
 * while the application is past Applied belongs to its stage entry then. Never given to a model.
 */
export const jobNotes = sqliteTable(
	"job_notes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		stageId: text("stage_id").references(() => applicationStages.id, {
			onDelete: "set null",
		}),
		body: text("body").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [index("job_notes_app_idx").on(t.applicationId, t.createdAt)],
);
