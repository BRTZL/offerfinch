import type { ApplyDeps } from "../apply/submit";
import type { ApprovalVerdict, DocumentHashes } from "../domain/approval";
import type { ApplicationState } from "../domain/states";
import type {
	CompanyRef,
	JobSourceKind,
	NormalizedJob,
	SourceHealth,
} from "../domain/types";
import type { BlobStore, ExportInput, ExportResult } from "../export/export";
import type { FilterResult } from "../filter/rules";
import type { FilterSettings } from "../filter/settings";
import type { Notifier } from "../notify/ntfy";
import type { ProfileSnapshot } from "../profile/types";
import type { FitResult } from "../scoring/fit";
import type { LlmProvider } from "../scoring/llm";
import type { SpendStore } from "../scoring/metered";
import type { DismissalSignal, RankResult } from "../scoring/rank";
import type { BrowserProvider } from "../scrape/browser";
import type { JobSource } from "../sources/types";
import type { CheckedSegment, ReviewFlag, ReviewStatus } from "../tailor/flags";
import type { RuleIssue } from "../tailor/profile-rules";
import type { AskedQuestion } from "../tailor/questions";
import type { RedraftDocument, RedraftRequest } from "../tailor/redraft";
import type { CitedUnit } from "../tailor/stale";
import type { ApplicationWorkflowParams } from "../workflow/types";
import type { ProviderRun, ScanProvider } from "./providers";

/**
 * The durable-step API both workflows are written against. Cloudflare's `WorkflowStep` backs it
 * in the worker; `LocalStep` runs the same code inline for the CLI and tests.
 */
export interface FlowStep {
	/**
	 * A named step. Its result is persisted; on a retry or replay the stored result is returned.
	 * Runners that can stop an attempt (the local runner, on a timeout or a stop) pass `signal`;
	 * long steps should stop what they do when it aborts.
	 */
	do<T>(
		name: string,
		fn: (signal?: AbortSignal) => Promise<T>,
		options?: { retries?: number; timeoutSeconds?: number },
	): Promise<T>;
	/** Pauses until an event of `type` arrives. Throws on timeout (Cloudflare) or `FlowPaused` (local). */
	waitForEvent<T>(
		name: string,
		options: { type: string; timeout: string },
	): Promise<{ payload: T }>;
}

/** Thrown by local runners where a real wait cannot happen. Never treated as a timeout. */
export class FlowPaused extends Error {
	constructor(readonly waitingFor: string) {
		super(`Paused waiting for ${waitingFor}`);
		this.name = "FlowPaused";
	}
}

export interface StartBatchResult {
	/** Job ids whose instance was created by this call. */
	created: string[];
	/** Job ids whose instance already existed (Cloudflare error 10405); counts as started. */
	existing: string[];
	failed: { jobId: string; error: string }[];
}

export type InstanceStatus =
	| "queued"
	| "running"
	| "paused"
	| "waiting"
	| "waitingForPause"
	| "complete"
	| "errored"
	| "terminated"
	| "unknown";

export interface WorkflowStarter {
	readonly runtime: "cloudflare" | "local";
	/** Starts up to `WORKFLOW_BATCH_SIZE` ApplicationWorkflow instances, ids derived from job ids. */
	startBatch(params: ApplicationWorkflowParams[]): Promise<StartBatchResult>;
	/** Status of a job's instance, for the sweep. */
	status(jobId: string): Promise<InstanceStatus>;
	/** Runs a job's instance again from the start (same id); Postgres decides what it does. */
	restart(params: ApplicationWorkflowParams): Promise<void>;
}

export type StoredDocumentKind =
	| "notes"
	| "cv"
	| "cover_letter"
	| "form_answers";

/** The latest editable version of one document. Form answers are JSON; the rest Markdown. */
export interface StoredDocument {
	kind: StoredDocumentKind;
	version: number;
	content: string;
	createdBy: Actor;
	/**
	 * The model that wrote this text (`LlmProvider.name`); a user's edit keeps the author of the
	 * version it edited. Null: saved before authors were recorded, when only Anthropic drafted.
	 */
	authorProvider?: string | null;
}

export interface Draft {
	notes: string;
	cv: string;
	coverLetter: string;
	formAnswers: { question: string; answer: string }[];
	/** The model that wrote it (`LlmProvider.name`), stored as each version's author. */
	provider?: string;
}

export interface StoredReview {
	id: string;
	documentHashes: DocumentHashes;
	provider: string;
	passed: boolean;
	issues: RuleIssue[];
	claims: unknown[];
	atsChecked: boolean;
	createdAt: Date;
	/** claims_flagged: handed to the user with its flags; approval waits until none is open. */
	status?: ReviewStatus;
	flags?: ReviewFlag[];
	/** Every segment checked, so the next version re-checks only lines that changed. */
	segments?: CheckedSegment[];
	/** What the claims cited, bound to each record's text at check time (`citedUnits`). */
	cited?: CitedUnit[];
}

export interface ExportRecord {
	kind: "cv" | "cover_letter";
	format: "pdf" | "docx";
	sourceVersion: number;
	storageKey: string;
	meta: Record<string, unknown>;
}

export interface ApplicationRecord {
	applicationId: string;
	userId: string;
	jobId: string;
	state: ApplicationState;
	companyName: string;
	/** Absent from repositories that do not return it; ranking then skips same-company signals. */
	companyId?: string;
	job: NormalizedJob;
	/**
	 * The job filter's result, on applications checked before no rule rejected a job (docs/
	 * decisions.md, 2026-11-05); null on every newer one. Read for display only.
	 */
	filter: FilterResult | null;
	score: number | null;
	/** The order of Matches: the score less penalties; absent or null before ranking. */
	rank?: number | null;
	fit: FitResult | null;
	endedReason: string | null;
	prepareAttempts: number;
}

export type Actor = "system" | "user" | "workflow";

/**
 * Postgres operations used by both workflows. Implemented in `@offerfinch/db`.
 * Every call takes the owner's `userId`; reads, joins and writes match only rows that user owns,
 * so an id from another user reads as missing and writes nothing.
 */
/**
 * A check of one document version that kept failing after its retries, or could not run under
 * the spending cap. Bound to the hashes it was about: an edit makes it stale. Approval stays
 * blocked (no passed review for those hashes); the user can retry the check without a redraft.
 */
export interface CheckError {
	hashes: DocumentHashes;
	message: string;
	/** ISO time it was recorded; also keys the retry, so a double click retries once. */
	at: string;
}

/** How `upsertJob` records what it inserts. */
export interface UpsertJobOptions {
	/** The scan run inserting the job: a new job is recorded as that run's. */
	scanRunId?: string;
}

export interface PipelineRepository {
	listActiveCompanies(
		userId: string,
		companyIds?: string[],
	): Promise<CompanyRef[]>;
	setCompanyHealth(
		userId: string,
		companyId: string,
		health: SourceHealth,
		reason: string | null,
	): Promise<void>;
	/**
	 * Inserts the job and its `found` application in one transaction, unless a job with the same
	 * source + external id or normalized URL exists (then it only refreshes `last_seen_at`).
	 * Throws when the company is not the user's. With `scanRunId`, a job it inserts is recorded
	 * as that scan run's in the same transaction (setup's live first search), so a job is never
	 * stored without the run that found it.
	 */
	upsertJob(
		userId: string,
		companyId: string,
		job: NormalizedJob,
		options?: UpsertJobOptions,
	): Promise<{ jobId: string; inserted: boolean }>;
	/** Jobs whose ApplicationWorkflow was never started (new, or left over from a failed run). */
	listUnstartedJobIds(userId: string, limit: number): Promise<string[]>;
	markWorkflowsStarted(
		userId: string,
		jobIds: string[],
		runtime: string,
	): Promise<void>;
	/** Jobs still `found` although their workflow started before `startedBefore`. */
	listStuckFoundJobIds(
		userId: string,
		startedBefore: Date,
		limit: number,
	): Promise<string[]>;

	/** Null when the job does not exist or belongs to another user. */
	getApplicationByJob(
		userId: string,
		jobId: string,
	): Promise<ApplicationRecord | null>;
	getFilterSettings(userId: string): Promise<FilterSettings>;
	/**
	 * True once the user pressed Prepare on this application (tailoring is on demand, PLAN A).
	 * A repository without it prepares every scored match, as before.
	 */
	prepareRequested?(userId: string, applicationId: string): Promise<boolean>;
	/**
	 * True when the user chose this job anyway ("Prepare anyway" on a job they added): its fit
	 * score is shown but ends nothing.
	 */
	chosenAnyway?(userId: string, applicationId: string): Promise<boolean>;
	getProfile(userId: string): Promise<ProfileSnapshot | null>;
	/** found -> scored with the evidence. `endedReason` is set when the score is below the minimum. */
	recordScore(
		userId: string,
		applicationId: string,
		fit: FitResult,
		endedReason: string | null,
		/** The match's place in Matches (`core/scoring/rank.ts`); stored where supported. */
		rank?: RankResult,
	): Promise<boolean>;
	/** The user's "Not interested" history, for ranking; absent without a dismissals table. */
	dismissalSignals?(userId: string): Promise<DismissalSignal[]>;
	/** Atomically claims the strong-match alert. False when it was already sent. */
	claimAlert(userId: string, applicationId: string): Promise<boolean>;
	/** Releases a claim when sending failed, so a retry can send the alert. */
	releaseAlert(userId: string, applicationId: string): Promise<void>;

	getState(
		userId: string,
		applicationId: string,
	): Promise<ApplicationState | null>;
	/** Moves to `to` only from one of `from`, enforcing the state machine and recording history. */
	transition(
		userId: string,
		applicationId: string,
		input: {
			from: readonly ApplicationState[];
			to: ApplicationState;
			reason: string;
			actor: Actor;
			/** Only while the application's Prepare request still stands, checked atomically. */
			requirePrepareRequest?: boolean;
		},
	): Promise<boolean>;
	/* Phase 2: preparation and review. */

	/** Saves a new version of every document. */
	saveDraft(
		userId: string,
		applicationId: string,
		draft: Draft,
		actor: Actor,
	): Promise<void>;
	latestDocuments(
		userId: string,
		applicationId: string,
	): Promise<StoredDocument[]>;
	/**
	 * Adds questions (deduped by normalized text); returns how many are open for the application.
	 * With `waitReason` ("{open}" is replaced by the count), also moves preparing -> needs_answers
	 * in the same transaction, under the lock answering takes.
	 */
	askQuestions(
		userId: string,
		applicationId: string,
		questions: {
			question: string;
			why: string;
			/** Set for a question the application form asks: its label, options and board. */
			formField?: {
				label: string;
				options: string[];
				kind: string;
				board: string;
			};
		}[],
		waitReason?: string,
	): Promise<{ open: number }>;
	/**
	 * The questions tailoring asked for this application (form questions excluded) and how many
	 * question rounds it has had: moves from preparing into needs_answers.
	 */
	questionHistory(
		userId: string,
		applicationId: string,
	): Promise<{ rounds: number; asked: AskedQuestion[] }>;
	recordReview(
		userId: string,
		applicationId: string,
		review: Omit<StoredReview, "id" | "atsChecked" | "createdAt">,
	): Promise<string>;
	/**
	 * Adds the ATS findings to a review; it passes only if it passed before and ATS found nothing.
	 * ATS findings become flags too, and a failed review takes `failedStatus`.
	 */
	completeReview(
		userId: string,
		reviewId: string,
		atsIssues: RuleIssue[],
		options?: { flags?: ReviewFlag[]; failedStatus?: ReviewStatus },
	): Promise<boolean>;
	/** Hands a failed review to the user: its status and flags. */
	flagReview(
		userId: string,
		reviewId: string,
		flags: ReviewFlag[],
	): Promise<void>;
	latestReview(
		userId: string,
		applicationId: string,
	): Promise<StoredReview | null>;
	saveExport(
		userId: string,
		applicationId: string,
		record: ExportRecord,
	): Promise<void>;
	setPrepareAttempts(
		userId: string,
		applicationId: string,
		attempts: number,
	): Promise<void>;
	/** The redraft the user asked for and that has not been saved yet (`tailor/redraft.ts`). */
	pendingRedraft?(
		userId: string,
		applicationId: string,
	): Promise<RedraftRequest | null>;
	/** Every version of one document, oldest first (who saved each: the user's own answers). */
	documentVersions?(
		userId: string,
		applicationId: string,
		kind: StoredDocumentKind,
	): Promise<{ version: number; content: string | null; createdBy: Actor }[]>;
	/**
	 * Saves a redraft's new versions and clears its request, in one transaction: "saved". When the
	 * request is gone (cancelled, already saved) "gone"; when a chosen document has a newer version
	 * than the request was made against, "conflict" (recorded on the request, nothing written).
	 */
	saveRedraft?(
		userId: string,
		applicationId: string,
		requestId: string,
		versions: { kind: RedraftDocument; content: string }[],
		/** The model that wrote the versions (`LlmProvider.name`). */
		author?: string,
	): Promise<"saved" | "gone" | "conflict">;
	/** Records why a redraft has not run (paused, an error after retries) on its request. */
	setRedraftProblem?(
		userId: string,
		applicationId: string,
		requestId: string,
		problem: NonNullable<RedraftRequest["problem"]>,
	): Promise<void>;
	/** Records (or, with null, clears) the check error of an application's current version. */
	setCheckError(
		userId: string,
		applicationId: string,
		error: CheckError | null,
	): Promise<void>;

	/** Whether the unrevoked approval matches the current submitted documents' hashes. */
	checkApproval(
		userId: string,
		applicationId: string,
	): Promise<ApprovalVerdict>;
	/** Marks a workflow event for this application consumed. False on a duplicate delivery or a foreign event. */
	consumeEvent(
		userId: string,
		applicationId: string,
		eventId: string,
	): Promise<boolean>;
}

/** Thrown when a workflow is given a job its user does not own (or that does not exist). */
export class ApplicationNotFoundError extends Error {
	constructor(
		readonly userId: string,
		readonly jobId: string,
	) {
		super(`No application for job ${jobId} owned by user ${userId}`);
		this.name = "ApplicationNotFoundError";
	}
}

export interface PipelineDeps {
	repo: PipelineRepository;
	sources: Partial<Record<JobSourceKind, JobSource>>;
	/**
	 * Where a scan looks for jobs (PLAN A). When set, a scan runs these and never the company
	 * watchlist; unset, it scans the active companies as before.
	 */
	providers?: (userId: string) => Promise<ScanProvider[]>;
	/** Scan history, bound to the scan run being executed (`scan-report.ts`). */
	scanLog?: import("./scan-report").ScanLog;
	/**
	 * Live progress for the scan history: a provider may call it with the search it runs now.
	 * Set only while a scan runs; absent otherwise.
	 */
	scanProgress?: (
		userId: string,
		progress: import("./scan-report").ScanProgress,
	) => void;
	/**
	 * Today's shared search plan (the model's, written once a day, with the user's own searches).
	 * Never throws: without a model it falls back to yesterday's or the rules' plan. Unset: the
	 * rules' plan from Job search.
	 */
	searchPlan?: (userId: string) => Promise<import("../search/plan").PlanResult>;
	/** Saves each provider's last run, for its status in Settings › Sources. */
	recordProviderRun?: (userId: string, run: ProviderRun) => Promise<void>;
	/**
	 * Where a source's next run starts in its list of searches (`ProviderRun.cursor` of its last
	 * run that got through any), so each run moves on through the plan by the searches it actually
	 * made, whatever the time between scans. Unset: by the hour.
	 */
	providerCursor?: (userId: string, provider: string) => Promise<number>;
	/** Scoring, and tailoring unless `tailorLlm` is set. */
	llm: LlmProvider;
	/** Tailoring, when it uses another model or effort than scoring (TAILOR_MODEL, TAILOR_EFFORT). */
	tailorLlm?: LlmProvider;
	/** The independent claims check: a different provider from `llm`. Required to prepare applications. */
	claimsLlm?: LlmProvider;
	notifier: Notifier;
	workflows: WorkflowStarter;
	/**
	 * While a scan's sources run, how often (ms) it starts the runs of jobs they saved so far, so
	 * each job is scored as soon as it is saved, not after the last source. Unset:
	 * runs start once, after every source (tests, and runtimes with their own queue).
	 */
	startDuringScanMs?: number;
	/** Prints documents to PDF: Browser Run in the worker, local Playwright otherwise. */
	browser?: BrowserProvider;
	/**
	 * Jobs added by link (desktop): the application run's first step reads the posting. Never
	 * throws: a wall, an error or a page that is not a posting comes back as `ok: false` with
	 * the cause, and the run ends there. `ok: true` when there was nothing to read.
	 */
	postingReader?: (
		userId: string,
		jobId: string,
	) => Promise<{ ok: true } | { ok: false; reason: string }>;
	/** Stores exported files: R2 in the worker, a local directory otherwise. */
	blobs?: BlobStore;
	/**
	 * Closed postings (`closed.ts`): where the scan's re-check of listed board matches reads and
	 * records. Unset: the scan checks none.
	 */
	closedPostings?: import("./closed").ClosedPostingStore;
	/** Between two of the re-check's requests (tests pass one that returns at once). */
	sleep?: (ms: number) => Promise<void>;
	/** Submission on approval: store, browser and blobs for forms. Without it, approved waits. */
	apply?: ApplyDeps;
	/** Cost tracking and the spending cap; every LLM call for a user goes through it when set. */
	spend?: SpendStore;
	/** Replaces browser + blob export (tests). */
	exporter?: (input: ExportInput) => Promise<ExportResult>;
	/** Clock for letter dates; tests pin it. */
	now?: () => Date;
	log?: (message: string, data?: Record<string, unknown>) => void;
}
