import type { ChatProposal, ChatScope } from "@offerfinch/core/chat/chat";
import type { DocumentHashes } from "@offerfinch/core/domain/approval";
import { APPLICATION_STATES } from "@offerfinch/core/domain/states";
import {
	COMPANY_STATUSES,
	JOB_SOURCES,
	SOURCE_HEALTH,
} from "@offerfinch/core/domain/types";
import type { FilterResult } from "@offerfinch/core/filter/rules";
import type { FilterSettings } from "@offerfinch/core/filter/settings";
import type { CheckError } from "@offerfinch/core/pipeline/ports";
import type {
	ScanProgress,
	SourceReport,
} from "@offerfinch/core/pipeline/scan-report";
import type { RecordKind } from "@offerfinch/core/profile/records";
import type { ProfileDocument } from "@offerfinch/core/profile/types";
import type { FitResult } from "@offerfinch/core/scoring/fit";
import type { PlanUsageJson } from "@offerfinch/core/scoring/plan-usage";
import type { RankPenalty } from "@offerfinch/core/scoring/rank";
import type {
	CheckedSegment,
	ReviewFlag,
	ReviewStatus,
} from "@offerfinch/core/tailor/flags";
import type { RuleIssue } from "@offerfinch/core/tailor/profile-rules";
import type { RedraftRequest } from "@offerfinch/core/tailor/redraft";
import type { CitedUnit } from "@offerfinch/core/tailor/stale";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth";

/** Postgres enums become text columns limited to the same values. */
function sqliteEnum<const T extends readonly [string, ...string[]]>(values: T) {
	return (name: string) => text(name, { enum: values });
}

// Every table carries user_id from day one (PLAN rule 6).
const userId = () =>
	text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

const createdAt = () =>
	integer("created_at", { mode: "timestamp_ms" })
		.$defaultFn(() => new Date())
		.notNull();
const updatedAt = () =>
	integer("updated_at", { mode: "timestamp_ms" })
		.$defaultFn(() => new Date())
		.$onUpdate(() => new Date())
		.notNull();

export const jobSource = sqliteEnum(JOB_SOURCES);
export const companyStatus = sqliteEnum(COMPANY_STATUSES);
export const sourceHealth = sqliteEnum(SOURCE_HEALTH);
export const applicationState = sqliteEnum(APPLICATION_STATES);
export const workplaceType = sqliteEnum([
	"remote",
	"hybrid",
	"onsite",
	"unknown",
]);
export const questionStatus = sqliteEnum(["open", "answered", "dismissed"]);
export const documentKind = sqliteEnum([
	"notes",
	"cv",
	"cover_letter",
	"form_answers",
]);
export const documentFormat = sqliteEnum(["markdown", "pdf", "docx", "json"]);
/**
 * started: claimed, the click may have happened. submitted: the board confirmed, or the user did.
 * needs_human: clicked, outcome unknown, not yet resolved by the user. not_sent: stopped before
 * the click, or the user confirmed it did not go through. dry_run: filled, never clicked.
 */
export const submissionStatus = sqliteEnum([
	"started",
	"submitted",
	"needs_human",
	"failed",
	"not_sent",
	"dry_run",
]);
export const actor = sqliteEnum(["system", "user", "workflow"]);

/** Snapshot of the user's profile markdown. The worker scores against this; the CLI imports it. */
export const profiles = sqliteTable(
	"profiles",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		sourcePath: text("source_path"),
		files: text("files", { mode: "json" }).$type<ProfileDocument[]>().notNull(),
		importedAt: integer("imported_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex("profiles_user_unique").on(t.userId)],
);

/**
 * The profile as structured records (PLAN C): one row per role, project, skill, education entry
 * or extra, and one About row. `data` holds the kind's fields (`@offerfinch/core/profile/records`);
 * `source` and `source_date` say where the fact came from and when. Rendered to the profile files
 * the pipeline reads; `profiles.files` is only read for a profile not yet converted.
 */
export const profileRecords = sqliteTable(
	"profile_records",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		kind: text("kind").$type<RecordKind>().notNull(),
		position: integer("position").notNull().default(0),
		data: text("data", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull(),
		source: text("source").notNull(),
		sourceDate: integer("source_date", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("profile_records_user_idx").on(t.userId, t.kind, t.position)],
);

/**
 * Where scans look for jobs (PLAN A), per user: each provider on or off, its settings (never a
 * secret: keys stay in the Keychain), and its last run for Settings › Sources.
 */
export const sourceProviders = sqliteTable(
	"source_providers",
	{
		userId: userId(),
		provider: text("provider").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		config: text("config", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.$defaultFn(() => ({})),
		lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
		lastRun: text("last_run", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex("source_providers_user_provider").on(t.userId, t.provider),
	],
);

/**
 * The shared search plan every source uses (docs/decisions.md, 2026-11-03): the model's searches,
 * written once a day (or the rules' when no model could), and the user's own, kept until removed.
 * Each search is `{ keywords, where, place?, seniority? }` (core `search/plan.ts`).
 */
export const searchPlans = sqliteTable("search_plans", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	ai: text("ai", { mode: "json" })
		.$type<unknown[]>()
		.notNull()
		.$defaultFn(() => []),
	user: text("user", { mode: "json" })
		.$type<unknown[]>()
		.notNull()
		.$defaultFn(() => []),
	/** What wrote `ai`: "ai" (the model) or "rules". */
	basis: text("basis"),
	generatedAt: integer("generated_at", { mode: "timestamp_ms" }),
	updatedAt: updatedAt(),
});

/** Company watchlist. `status` is the user's choice; `health` is the source's condition. */
export const companies = sqliteTable(
	"companies",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		name: text("name").notNull(),
		nameKey: text("name_key").notNull(),
		source: jobSource("source").notNull(),
		/** Board token (Ashby, Greenhouse, Lever) or careers page URL (scrape). Stored verbatim: tokens are case-sensitive. */
		sourceKey: text("source_key").notNull(),
		scrapeParser: text("scrape_parser"),
		status: companyStatus("status").notNull().default("active"),
		health: sourceHealth("health").notNull().default("ok"),
		healthReason: text("health_reason"),
		discoveredFrom: text("discovered_from"),
		removedAt: integer("removed_at", { mode: "timestamp_ms" }),
		lastScannedAt: integer("last_scanned_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex("companies_user_source_key_unique").on(
			t.userId,
			t.source,
			t.sourceKey,
		),
		index("companies_user_name_key_idx").on(t.userId, t.nameKey),
	],
);

export const jobs = sqliteTable(
	"jobs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		companyId: text("company_id")
			.notNull()
			.references(() => companies.id, { onDelete: "cascade" }),
		source: jobSource("source").notNull(),
		externalId: text("external_id").notNull(),
		url: text("url").notNull(),
		urlNormalized: text("url_normalized").notNull(),
		title: text("title").notNull(),
		locations: text("locations", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.$defaultFn(() => []),
		workplaceType: workplaceType("workplace_type").notNull().default("unknown"),
		department: text("department"),
		employmentType: text("employment_type"),
		descriptionText: text("description_text").notNull().default(""),
		/**
		 * The employer's own apply link, when a source shows it (LinkedIn's external apply). The
		 * hand-off opens it instead of the posting; never followed or opened by the pipeline.
		 */
		applyUrl: text("apply_url"),
		/**
		 * A job added by link while its posting is read in the background: "reading" until the
		 * application run's first step has read it, "failed" (with the cause) when it could not.
		 * Null for every other job.
		 */
		readStatus: text("read_status", { enum: ["reading", "failed"] }),
		readError: text("read_error"),
		publishedAt: integer("published_at", { mode: "timestamp_ms" }),
		/** The posting's own end date (schema.org `validThrough`), when its page gave one. */
		validThrough: integer("valid_through", { mode: "timestamp_ms" }),
		/**
		 * The posting is closed (docs/decisions.md, 2026-11-03): when a check found it gone, and in
		 * words how ("Greenhouse no longer lists it, checked before Prepare"). Only a definite answer
		 * sets it, never an error. A closed job leaves Matches and the Inbox's working views, Prepare
		 * is refused, and it stays in Closed.
		 */
		closedAt: integer("closed_at", { mode: "timestamp_ms" }),
		closedReason: text("closed_reason"),
		/** The last check, whatever it answered; the sweep re-checks the longest-unchecked first. */
		openCheckedAt: integer("open_checked_at", { mode: "timestamp_ms" }),
		/**
		 * The user said "It's still open": the check was wrong for this posting, so automatic checks
		 * never close it again.
		 */
		openConfirmedAt: integer("open_confirmed_at", { mode: "timestamp_ms" }),
		firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		// Dedupe keys: source + job id, and normalized URL.
		uniqueIndex("jobs_user_source_external_unique").on(
			t.userId,
			t.source,
			t.externalId,
		),
		uniqueIndex("jobs_user_url_unique").on(t.userId, t.urlNormalized),
		index("jobs_company_idx").on(t.companyId),
	],
);

export const applications = sqliteTable(
	"applications",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		jobId: text("job_id")
			.notNull()
			.references(() => jobs.id, { onDelete: "cascade" }),
		state: applicationState("state").notNull().default("found"),
		filterDecision: text("filter_decision"),
		filterResult: text("filter_result", { mode: "json" }).$type<FilterResult>(),
		flags: text("flags", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.$defaultFn(() => []),
		score: integer("score"),
		fit: text("fit", { mode: "json" }).$type<FitResult>(),
		/**
		 * The order of Matches: the score minus penalties for an unclear location, a seniority far
		 * from the profile's, a heavy domain the profile lacks, and similar jobs the user passed
		 * on (`core/scoring/rank.ts`). Null before scoring; Matches fall back to the score.
		 */
		rank: integer("rank"),
		/** The penalties behind `rank`, biggest first; the first is shown as "Ranked lower: …". */
		rankPenalties: text("rank_penalties", { mode: "json" }).$type<
			RankPenalty[]
		>(),
		scoredAt: integer("scored_at", { mode: "timestamp_ms" }),
		/** Why the workflow ended early (low score); filter rejections keep their reason in filter_result. */
		endedReason: text("ended_reason"),
		alertedAt: integer("alerted_at", { mode: "timestamp_ms" }),
		/** When the user pressed Prepare: tailoring is on demand, a scored match waits for it. */
		/**
		 * When the user chose a job they added themselves anyway ("Prepare anyway"): its filter
		 * result and fit score are shown but end nothing.
		 */
		chosenAnywayAt: integer("chosen_anyway_at", { mode: "timestamp_ms" }),
		/** Added by link: say so (natively, when the window is not in front) once it is ready. */
		announceReady: integer("announce_ready", { mode: "boolean" })
			.notNull()
			.default(false),
		prepareRequestedAt: integer("prepare_requested_at", {
			mode: "timestamp_ms",
		}),
		workflowInstanceId: text("workflow_instance_id"),
		workflowRuntime: text("workflow_runtime"),
		workflowStartedAt: integer("workflow_started_at", { mode: "timestamp_ms" }),
		/** Failed review rounds since the last user input; bounds automatic re-drafting. */
		prepareAttempts: integer("prepare_attempts").notNull().default(0),
		/**
		 * The check of an edited version that kept failing, or met the spending cap, with the
		 * hashes it was about. Shown with a retry while those are the current hashes; cleared by a
		 * finished review or the retry.
		 */
		checkError: text("check_error", { mode: "json" }).$type<CheckError>(),
		/**
		 * The Redraft the user asked for (scope, instruction, the versions it replaces), until its
		 * new versions are saved; with `problem` while it waits on a pause, an error or a conflict.
		 */
		redraft: text("redraft", { mode: "json" }).$type<RedraftRequest>(),
		/**
		 * Which current roles this application's documents show ("relevant", "all" or an
		 * experience file path), set when the user switches it for one application. Null: the
		 * user's setting (`filter_settings.settings.currentRole`).
		 */
		currentRole: text("current_role"),
		/** When the application was submitted, and how: "auto" (confirmed by the board) or "manual". */
		appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
		appliedVia: text("applied_via"),
		approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
		stateChangedAt: integer("state_changed_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex("applications_user_job_unique").on(t.userId, t.jobId),
		index("applications_user_state_idx").on(t.userId, t.state),
		index("applications_unstarted_idx")
			.on(t.userId)
			.where(sql`${t.workflowStartedAt} is null`),
	],
);

/** Every state change, with who made it and why. */
export const applicationTransitions = sqliteTable(
	"application_transitions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		fromState: applicationState("from_state"),
		toState: applicationState("to_state").notNull(),
		reason: text("reason").notNull(),
		actor: actor("actor").notNull(),
		createdAt: createdAt(),
	},
	(t) => [index("application_transitions_app_idx").on(t.applicationId)],
);

/**
 * Events sent to ApplicationWorkflow instances. The dashboard writes the row (with the state
 * change) before sending; the unique key makes a repeated click or retry a no-op, and
 * `consumed_at` makes a duplicate delivery a no-op.
 */
export const workflowEvents = sqliteTable(
	"workflow_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		type: text("type").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		payload: text("payload", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.$defaultFn(() => ({})),
		sentAt: integer("sent_at", { mode: "timestamp_ms" }),
		consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("workflow_events_idempotency_unique").on(
			t.userId,
			t.idempotencyKey,
		),
	],
);

export const filterSettings = sqliteTable("filter_settings", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	settings: text("settings", { mode: "json" })
		.$type<Partial<FilterSettings>>()
		.notNull()
		.$defaultFn(() => ({})),
	updatedAt: updatedAt(),
});

/** Missing facts become questions, never guesses (PLAN rule 2). Answers are written back to the profile. */
export const questions = sqliteTable(
	"questions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		applicationId: text("application_id").references(() => applications.id, {
			onDelete: "set null",
		}),
		/** Normalized question text; a re-draft asking the same thing does not add a row. */
		key: text("key").notNull(),
		question: text("question").notNull(),
		context: text("context"),
		answer: text("answer"),
		status: questionStatus("status").notNull().default("open"),
		profilePath: text("profile_path"),
		/** Set for a question an application form asked: its label, options and board. */
		formField: text("form_field", { mode: "json" }).$type<{
			label: string;
			options: string[];
			kind: string;
			board: string;
		}>(),
		answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
		createdAt: createdAt(),
	},
	(t) => [
		index("questions_user_status_idx").on(t.userId, t.status),
		uniqueIndex("questions_app_key_unique").on(t.applicationId, t.key),
	],
);

/**
 * The user's answers, kept as part of their profile. They are merged into the profile snapshot as
 * `answers.md`, so tailoring and the claims check can cite them; a profile re-import keeps them.
 */
export const profileFacts = sqliteTable(
	"profile_facts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		questionId: text("question_id").references(() => questions.id, {
			onDelete: "set null",
		}),
		applicationId: text("application_id").references(() => applications.id, {
			onDelete: "set null",
		}),
		question: text("question").notNull(),
		answer: text("answer").notNull(),
		/** Where the answer came from, e.g. "dashboard question inbox". */
		source: text("source").notNull(),
		/**
		 * Who wrote the question: "pipeline" (tailoring asked for a missing fact) or "board" (an
		 * application form's label, third-party text). A board's label is never evidence about the
		 * candidate; only the answer is.
		 */
		questionSource: text("question_source").notNull().default("pipeline"),
		/** The board whose form asked it, for a "board" question. */
		board: text("board"),
		answeredAt: integer("answered_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [index("profile_facts_user_idx").on(t.userId)],
);

/**
 * One review of an application's documents: the independent claims check, the deterministic
 * rules and the ATS check of the exported PDF, for one set of document hashes. Approval requires
 * a passed review for the current hashes.
 */
export const reviewChecks = sqliteTable(
	"review_checks",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		documentHashes: text("document_hashes", { mode: "json" })
			.$type<DocumentHashes>()
			.notNull(),
		provider: text("provider").notNull(),
		passed: integer("passed", { mode: "boolean" }).notNull(),
		claims: text("claims", { mode: "json" })
			.$type<unknown[]>()
			.notNull()
			.$defaultFn(() => []),
		issues: text("issues", { mode: "json" })
			.$type<RuleIssue[]>()
			.notNull()
			.$defaultFn(() => []),
		/** Set once the exported PDF passed (or failed) the ATS text check. */
		atsCheckedAt: integer("ats_checked_at", { mode: "timestamp_ms" }),
		/**
		 * passed, failed (a draft during preparation) or claims_flagged (handed to the user with its
		 * flags; approval waits until none is open). Null on reviews made before flags existed.
		 */
		status: text("status").$type<ReviewStatus>(),
		/** One per flagged line: reasons, whether it can be confirmed, open or confirmed. */
		flags: text("flags", { mode: "json" })
			.$type<ReviewFlag[]>()
			.notNull()
			.$defaultFn(() => []),
		/** What the claims cited, bound to each record's text at check time (core/tailor/stale.ts). */
		cited: text("cited", { mode: "json" })
			.$type<CitedUnit[]>()
			.notNull()
			.default([]),
		/** Every segment checked, so an edit re-checks only lines that changed. */
		segments: text("segments", { mode: "json" })
			.$type<CheckedSegment[]>()
			.notNull()
			.$defaultFn(() => []),
		createdAt: createdAt(),
	},
	(t) => [index("review_checks_app_idx").on(t.applicationId, t.createdAt)],
);

export const documents = sqliteTable(
	"documents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		kind: documentKind("kind").notNull(),
		format: documentFormat("format").notNull(),
		version: integer("version").notNull().default(1),
		content: text("content"),
		createdBy: actor("created_by").notNull().default("workflow"),
		/**
		 * The model that wrote this version's text (`anthropic:…`, `claude-subscription:…`,
		 * `codex-subscription:…`). A user's edit keeps the version it edits' author, so the claims
		 * check never goes to the company that wrote the words. Null: written before authors were
		 * recorded (2026-11-04), when only Anthropic could draft.
		 */
		authorProvider: text("author_provider"),
		/** For exports: the markdown version they were rendered from. */
		sourceVersion: integer("source_version"),
		/** For exports: page count, byte size, ATS findings. */
		meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
		/** R2 object key for exported files. */
		storageKey: text("storage_key"),
		claimsCheck: text("claims_check", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		claimsPassed: integer("claims_passed", { mode: "boolean" }),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("documents_app_kind_format_version_unique").on(
			t.applicationId,
			t.kind,
			t.format,
			t.version,
		),
	],
);

/**
 * The user's approval of one exact application: the hash of every submitted document at the time
 * of approval. Entering `applying` requires the unrevoked row to match the current documents; an
 * edit after approval revokes it. At most one unrevoked approval per application.
 */
export const approvals = sqliteTable(
	"approvals",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		documentHashes: text("document_hashes", { mode: "json" })
			.$type<DocumentHashes>()
			.notNull(),
		approvedAt: integer("approved_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
		revokedReason: text("revoked_reason"),
	},
	(t) => [
		index("approvals_app_idx").on(t.applicationId),
		uniqueIndex("approvals_one_active_unique")
			.on(t.applicationId)
			.where(sql`${t.revokedAt} is null`),
	],
);

/**
 * One automatic (or dry-run, or manual) submission. A row in `started` is written in a locked
 * transaction before the submit click; at most one per application, and none while an earlier
 * attempt is unresolved, so a retry, a duplicate event or a double click cannot submit twice.
 */
export const submissionAttempts = sqliteTable(
	"submission_attempts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.id, { onDelete: "cascade" }),
		attempt: integer("attempt").notNull(),
		status: submissionStatus("status").notNull().default("started"),
		/** "auto", "dry_run" or "manual". */
		mode: text("mode").notNull().default("auto"),
		board: text("board"),
		url: text("url"),
		screenshotBeforeKey: text("screenshot_before_key"),
		screenshotAfterKey: text("screenshot_after_key"),
		proof: text("proof", { mode: "json" }).$type<Record<string, unknown>>(),
		error: text("error"),
		/** How the user resolved an unknown outcome. */
		resolution: text("resolution"),
		startedAt: integer("started_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		uniqueIndex("submission_attempts_app_attempt_unique").on(
			t.applicationId,
			t.attempt,
		),
		uniqueIndex("submission_attempts_one_started")
			.on(t.applicationId)
			.where(sql`${t.status} = 'started'`),
	],
);

/** Per-user submission switch. No row means paused: nothing is submitted until the user turns it on. */
export const submissionSettings = sqliteTable("submission_settings", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	paused: integer("paused", { mode: "boolean" }).notNull().default(true),
	updatedAt: updatedAt(),
});

/**
 * Scan history: one row per scan run (`flow_run_id`, the runner's run), with what each source
 * searched, read, saved and set aside (`sources`), and what runs now (`progress`). The run's
 * status stays on `flow_runs`; the newest 100 rows per user are kept.
 */
export const scanRuns = sqliteTable(
	"scan_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		/** timer, start or manual. */
		trigger: text("trigger").notNull(),
		/** Totals over the sources (`ScanTotals`). */
		stats: text("stats", { mode: "json" }).$type<Record<string, unknown>>(),
		startedAt: integer("started_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
		flowRunId: text("flow_run_id"),
		sources: text("sources", { mode: "json" })
			.$type<SourceReport[]>()
			.notNull()
			.default([]),
		progress: text("progress", { mode: "json" }).$type<ScanProgress | null>(),
	},
	(t) => [
		uniqueIndex("scan_runs_flow_run_unique").on(t.flowRunId),
		index("scan_runs_user_started_idx").on(t.userId, t.startedAt),
	],
);

/**
 * One LLM call made for a user: who it was for, the model that answered, the tokens it used and
 * its estimated cost (core/scoring/pricing.ts; an estimate, not the invoice). A row starts as
 * `reserved` with a worst-case estimate, written under a per-user lock that enforces the spending
 * cap, and becomes `settled` with the reported usage once the call returns.
 */
export const llmUsage = sqliteTable(
	"llm_usage",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		applicationId: text("application_id").references(() => applications.id, {
			onDelete: "set null",
		}),
		task: text("task").notNull(),
		provider: text("provider").notNull(),
		/** The model that answered, as the provider reported it. */
		model: text("model"),
		status: text("status").$type<"reserved" | "settled">().notNull(),
		estimateMicros: integer("estimate_micros").notNull(),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
		cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
		/** Estimated cost in micro-dollars (1e-6 USD). */
		costMicros: integer("cost_micros").notNull().default(0),
		/**
		 * Model calls (prompts sent) a subscription call made, counted by the daily call budget.
		 * Reserved at 1, settled to the real number (0 when nothing was sent); 0 for API calls.
		 */
		modelCalls: integer("model_calls").notNull().default(0),
		/** Where the price came from; always an estimate. */
		priceBasis: text("price_basis"),
		/**
		 * `api`: per token, counted by the cap (an API key, or a subscription call that drew on
		 * paid extra usage). `subscription`: the user's own plan through a local CLI, settled at $0
		 * with real tokens, never counted by the cap.
		 */
		billing: text("billing")
			.$type<"api" | "subscription">()
			.notNull()
			.default("api"),
		error: text("error"),
		createdAt: createdAt(),
		settledAt: integer("settled_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		index("llm_usage_user_created_idx").on(t.userId, t.createdAt),
		index("llm_usage_app_idx").on(t.applicationId),
	],
);

/** The monthly spending cap. No row: on, at DEFAULT_SPENDING_CAP_MICROS. */
export const spendingSettings = sqliteTable("spending_settings", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	monthlyCapMicros: integer("monthly_cap_micros").notNull().default(20_000_000),
	/**
	 * When the user confirmed that paid extra usage is off on their Claude account. Null: not
	 * confirmed, so subscription calls are refused. Cleared when a call draws on extra usage.
	 */
	extraUsageOffConfirmedAt: integer("extra_usage_off_confirmed_at", {
		mode: "timestamp_ms",
	}),
	/**
	 * Model calls (CLI runs; a retry is another) the subscription may make in any rolling 24
	 * hours, so a big scan cannot use up the plan the user also works with. Null: the default.
	 */
	subscriptionDailyCalls: integer("subscription_daily_calls"),
	updatedAt: updatedAt(),
});

/**
 * LinkedIn's stop switch, per user (docs/decisions.md). A held stop (login wall, security check,
 * CAPTCHA, warning) sets `blocked_at`; nothing runs again until the user signs in or chooses
 * Retry now in Settings › Sources. `search_urls`, `daily_page_cap` and the gaps are no longer
 * read (2026-11-03): searches come from the shared plan (saved ones were moved there) and the
 * pace is fixed in core (`LINKEDIN_PACE`).
 */
export const linkedinSettings = sqliteTable("linkedin_settings", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	/** Saved LinkedIn job search URLs, read in order, one results page each. */
	searchUrls: text("search_urls", { mode: "json" })
		.$type<string[]>()
		.notNull()
		.$defaultFn(() => []),
	/** Pages the runner may open in any 24 hours, search and job pages alike. */
	dailyPageCap: integer("daily_page_cap").notNull().default(15),
	/** Random gap between pages, in seconds. */
	minGapSeconds: integer("min_gap_seconds").notNull().default(20),
	maxGapSeconds: integer("max_gap_seconds").notNull().default(60),
	blockedAt: integer("blocked_at", { mode: "timestamp_ms" }),
	/** login_wall, security_check, captcha, warning, unusual_page or selectors. */
	blockedKind: text("blocked_kind"),
	blockedReason: text("blocked_reason"),
	clearedAt: integer("cleared_at", { mode: "timestamp_ms" }),
	updatedAt: updatedAt(),
});

/** One LinkedIn runner run: pages it opened, what it read and saved, and why it stopped. */
export const linkedinRuns = sqliteTable(
	"linkedin_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		/** "cli" or "launchd". */
		trigger: text("trigger").notNull(),
		pagesUsed: integer("pages_used").notNull().default(0),
		listingsRead: integer("listings_read").notNull().default(0),
		jobsInserted: integer("jobs_inserted").notNull().default(0),
		duplicates: integer("duplicates").notNull().default(0),
		/** Why the run ended: done, page_cap, no_searches, blocked (refused), or a stop kind. */
		outcome: text("outcome"),
		stopReason: text("stop_reason"),
		startedAt: integer("started_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [index("linkedin_runs_user_started_idx").on(t.userId, t.startedAt)],
);

/**
 * One LinkedIn page the runner opened, reserved just before the navigation with its own time.
 * The rolling 24-hour cap counts these rows, across every run and Chrome profile of the user.
 */
export const linkedinPages = sqliteTable(
	"linkedin_pages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		runId: text("run_id").references(() => linkedinRuns.id, {
			onDelete: "set null",
		}),
		openedAt: integer("opened_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [index("linkedin_pages_user_opened_idx").on(t.userId, t.openedAt)],
);

/**
 * LinkedIn job ids the runner has read, whatever came of them (saved, already found on another
 * source, employer removed), so a later run does not open the same job page again.
 */
export const linkedinSeen = sqliteTable(
	"linkedin_seen",
	{
		userId: userId(),
		linkedinJobId: text("linkedin_job_id").notNull(),
		/** inserted, duplicate or removed_company. */
		outcome: text("outcome").notNull(),
		seenAt: integer("seen_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [
		uniqueIndex("linkedin_seen_user_job_unique").on(t.userId, t.linkedinJobId),
	],
);

/**
 * A subscription vendor stopped after a paid call (Claude extra usage, ChatGPT credits): its
 * calls are refused until the user resumes it in Settings > Models. Kept in the database, so a
 * restart does not lift it (the provider's breaker lives only in memory). A paid Claude call also
 * withdraws the Claude extra-usage confirmation; resuming Claude sets it again.
 */
export const subscriptionPauses = sqliteTable(
	"subscription_pauses",
	{
		userId: userId(),
		/** "anthropic" (Claude) or "openai" (Codex). */
		vendor: text("vendor").notNull(),
		pausedAt: integer("paused_at", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
		reason: text("reason").notNull(),
	},
	(t) => [
		uniqueIndex("subscription_pauses_user_vendor").on(t.userId, t.vendor),
	],
);

/**
 * What each subscription plan (Claude, ChatGPT for Codex) has used of its windows, as the vendor
 * last reported it, and OfferFinch's share of it (core/scoring/plan-usage.ts). One row per
 * vendor, the whole state as JSON, so a worker restart keeps the share.
 */
export const planUsage = sqliteTable(
	"plan_usage",
	{
		userId: userId(),
		/** "anthropic" (Claude) or "openai" (Codex). */
		vendor: text("vendor").notNull(),
		state: text("state", { mode: "json" }).$type<PlanUsageJson>().notNull(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex("plan_usage_user_vendor").on(t.userId, t.vendor)],
);

/**
 * A conversation with the model: one per application (beside its documents) and one for the
 * profile. `key` is "profile" or "application:<id>", so each has at most one thread per user
 * (SQLite treats NULL application ids as distinct in a unique index).
 */
export const chatThreads = sqliteTable(
	"chat_threads",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		scope: text("scope").$type<ChatScope>().notNull(),
		applicationId: text("application_id").references(() => applications.id, {
			onDelete: "cascade",
		}),
		key: text("key").notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex("chat_threads_user_key_unique").on(t.userId, t.key)],
);

/**
 * One message of a thread. An assistant message starts `working` while the model runs in the
 * worker, then becomes `done`, `error` or `paused` (the model is not connected, a usage limit,
 * the spending cap). `proposals` are what the user can accept or dismiss, each with its status.
 */
export const chatMessages = sqliteTable(
	"chat_messages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: userId(),
		threadId: text("thread_id")
			.notNull()
			.references(() => chatThreads.id, { onDelete: "cascade" }),
		role: text("role").$type<"user" | "assistant">().notNull(),
		content: text("content").notNull().default(""),
		status: text("status")
			.$type<"working" | "done" | "error" | "paused">()
			.notNull()
			.default("done"),
		proposals: text("proposals", { mode: "json" })
			.$type<ChatProposal[]>()
			.notNull()
			.$defaultFn(() => []),
		createdAt: createdAt(),
	},
	(t) => [index("chat_messages_thread_idx").on(t.threadId, t.createdAt)],
);
