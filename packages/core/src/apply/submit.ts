import type { BlobStore } from "../export/export";
import type { PipelineDeps } from "../pipeline/ports";
import type { ProfileSnapshot } from "../profile/types";
import type { BrowserProvider, NetworkLogEntry } from "../scrape/browser";
import { evidenceProfile } from "../tailor/profile-rules";
import { type FormAnswer, parseContact } from "../tailor/tailor";
import {
	type ApplicationRun,
	type FilledField,
	type RunResult,
	runApplication,
} from "./applier";
import type { SavedAnswer } from "./field-answers";
import type { FormRead, FormSchema } from "./form-schema";
import {
	type ApplicantData,
	BOARDS,
	type Board,
	applyUrl as boardApplyUrl,
	exactOption,
	markdownToPlain,
	sameQuestion,
	type UnknownQuestion,
} from "./forms";
import { submissionModeForSource } from "./modes";

/**
 * Submission on approval (phase 3; automatic since 2026-11-09, docs/auto-apply-plan.md).
 * `beginSubmissionStep` moves approved -> applying on an "auto" board (`modes.ts`) when the
 * user's switch (`submission_settings.paused`) allows; `submitStep` opens the board's form, fills
 * it from the approved documents and submits once. The database decides at every gate: the claim
 * before the click is a locked transaction that checks the approval, the switch and every earlier
 * attempt.
 */

export interface SubmissionContext {
	applicationId: string;
	/** Where the job was found; a hand-off source (LinkedIn) is never filled, whatever the board. */
	source?: string;
	board: Board | null;
	companyKey: string;
	externalId: string;
	jobUrl: string;
	formAnswers: FormAnswer[];
	coverLetterMarkdown: string | null;
	/** PDF exports of the approved versions (their `source_version` equals the latest version). */
	cvPdfKey: string | null;
	coverLetterPdfKey: string | null;
}

export interface AttemptInput {
	board: string;
	url: string;
	screenshotKey: string | null;
	reason: string;
	proof: Record<string, unknown>;
}

export interface FormQuestion extends UnknownQuestion {
	board: string;
	/** A saved answer that fits this question; reused instead of asking again. */
	reuse?: string;
}

export type BeginOutcome =
	| { outcome: "started" }
	| {
			outcome: "paused" | "not_approved" | "skipped" | "handoff";
			reason: string;
	  };

export type ClaimOutcome =
	| { go: true; attemptId: string }
	| { go: false; reason: string; paused: boolean };

/** Postgres side of submission. Implemented by `DrizzlePipelineRepository`. */
export interface SubmissionStore {
	submissionsPaused(userId: string): Promise<boolean>;
	submissionContext(
		userId: string,
		applicationId: string,
	): Promise<SubmissionContext | null>;
	/** approved -> applying, unless paused; the approval is checked under the row lock. */
	beginSubmission(userId: string, applicationId: string): Promise<BeginOutcome>;
	/**
	 * An attempt left in `started` means a run died after its claim: the click may have happened.
	 * Marks it unknown and the application `needs_human`. True when there was one.
	 */
	resolveInterrupted(userId: string, applicationId: string): Promise<boolean>;
	/**
	 * The last gate before the click, in one locked transaction: state `applying`, an approval
	 * matching the documents, submissions not paused, and no earlier attempt that is started,
	 * unresolved or submitted. Records the attempt as `started`.
	 */
	claimSubmission(
		userId: string,
		applicationId: string,
		input: {
			board: string;
			url: string;
			beforeKey: string | null;
			filled: FilledField[];
		},
	): Promise<ClaimOutcome>;
	/** Records the outcome after the click: applied, or needs_human with the attempt unresolved. */
	finishSubmission(
		userId: string,
		applicationId: string,
		attemptId: string,
		input: {
			submitted: boolean;
			afterKey: string | null;
			proof: Record<string, unknown>;
			reason: string;
		},
	): Promise<void>;
	/** A stop before the click: the attempt is `not_sent`; applying -> needs_human. */
	stopSubmission(
		userId: string,
		applicationId: string,
		input: AttemptInput,
	): Promise<void>;
	/**
	 * Unknown form questions: asks the new ones in the question inbox and records reused answers.
	 * When every one has an answer, adds them to the form answers (a new version) and sends the
	 * application back to review; otherwise it waits in needs_human.
	 */
	stopForQuestions(
		userId: string,
		applicationId: string,
		input: AttemptInput & { questions: FormQuestion[] },
	): Promise<{ asked: number; reused: number }>;
	recordDryRun(
		userId: string,
		applicationId: string,
		input: AttemptInput & { afterKey?: null },
	): Promise<string>;
	/** The user's saved answers (question inbox), for reuse, with their record ids. */
	savedAnswers(userId: string): Promise<SavedAnswer[]>;
	/** The form read before review (step 2 of docs/auto-apply-plan.md), or null when never read. */
	formRead?(userId: string, applicationId: string): Promise<FormRead | null>;
	/**
	 * Saves the read, replacing an earlier one; only while the application is preparing, so a
	 * read never changes what an approval covered. False when it was not saved.
	 */
	saveFormRead?(
		userId: string,
		applicationId: string,
		read: FormRead,
	): Promise<boolean>;
	/**
	 * Adds answers to the form answers as a new version (same question: replaced), while the
	 * application is preparing. Returns how many changed.
	 */
	addFormAnswers?(
		userId: string,
		applicationId: string,
		answers: FormAnswer[],
	): Promise<number>;
	/**
	 * Applications left in `applying` since before `before` (the worker running the submission
	 * died, so nothing will wake them): a `started` attempt becomes an unknown outcome, otherwise
	 * a not-sent stop; either way they move to needs_human. Returns their ids.
	 */
	handOverStuck(userId: string, before: Date): Promise<string[]>;
}

/** Longer than the submit step's 15-minute timeout, so a live run is never taken over. */
export const STUCK_APPLYING_MINUTES = 20;

export interface ApplyDeps {
	store: SubmissionStore;
	browser: BrowserProvider;
	blobs: BlobStore;
	/**
	 * Hosts automatic submission may click submit on. Anything else stops before opening the form
	 * and hands over. Default: only the local fixture boards.
	 */
	allowedHosts?: string[];
	/** Base URL per board, replacing the real hosts (fixtures and tests). */
	boardBases?: Partial<Record<Board, string>>;
	/** Replaces the browser run (tests). */
	run?: (
		run: ApplicationRun,
	) => Promise<RunResult & { networkLog?: unknown[] }>;
	/** Replaces the browser read of a form before review (tests). */
	readForm?: (input: {
		board: Board;
		url: string;
	}) => Promise<
		{ ok: true; schema: FormSchema } | { ok: false; reason: string }
	>;
	now?: () => Date;
}

export const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

export function hostAllowed(
	url: string,
	allowed: string[] = LOCAL_HOSTS,
): boolean {
	const host = new URL(url).hostname;
	return allowed.some((h) => h === host);
}

/** Strips the " (one of: …)" suffix a form question gets in the inbox. */
export function formLabelOf(question: string): string {
	return question.replace(/\s*\(one of: [^)]*\)\s*$/, "").trim();
}

function boardOf(source: string): Board | null {
	return (BOARDS as readonly string[]).includes(source)
		? (source as Board)
		: null;
}

export { boardOf };

const keyFor = (userId: string, applicationId: string, label: string) =>
	`users/${userId}/applications/${applicationId}/submissions/${Date.now()}-${label}.png`;

async function store(
	blobs: BlobStore,
	key: string,
	bytes: Uint8Array | null,
): Promise<string | null> {
	if (!bytes || bytes.byteLength === 0) return null;
	await blobs.put(key, bytes, "image/png");
	return key;
}

/** The submission mode for this application: its source, then its board. */
export function modeOf(context: SubmissionContext) {
	return submissionModeForSource(context.source ?? "", context.board);
}

/**
 * approved -> applying, only on a board whose mode is "auto". A hand-off board stays approved:
 * the dashboard shows the hand-off and the user records the submission.
 */
export async function beginSubmissionStep(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<BeginOutcome> {
	if (!deps.apply)
		return { outcome: "skipped", reason: "submission is not configured here" };
	const context = await deps.apply.store.submissionContext(
		userId,
		applicationId,
	);
	if (!context)
		return {
			outcome: "skipped",
			reason: "the application's job could not be read",
		};
	const mode = modeOf(context);
	if (mode.mode === "handoff")
		return { outcome: "handoff", reason: mode.reason };
	return deps.apply.store.beginSubmission(userId, applicationId);
}

/**
 * What the form is filled from: the profile's contact details, the approved form answers and
 * letter. Shared by the submission, the dry run and the "What will be sent" list.
 */
export function applicantData(
	profile: ProfileSnapshot,
	context: Pick<SubmissionContext, "formAnswers" | "coverLetterMarkdown">,
	hasCoverLetterFile: boolean,
): ApplicantData {
	return {
		contact: parseContact(evidenceProfile(profile)),
		answers: context.formAnswers,
		coverLetterText: context.coverLetterMarkdown
			? markdownToPlain(context.coverLetterMarkdown)
			: null,
		hasCoverLetterFile,
	};
}

/** The board's form URL for this application (fixture bases replace the real hosts). */
export function formUrlOf(
	context: Pick<SubmissionContext, "jobUrl" | "externalId" | "companyKey">,
	board: Board,
	bases?: ApplyDeps["boardBases"],
): string {
	return boardApplyUrl(
		board,
		{
			url: context.jobUrl,
			externalId: context.externalId,
			companyKey: context.companyKey,
		},
		bases,
	);
}

/** What a run needs from the approved application: URL, answers and the approved PDFs. */
async function prepareRun(
	deps: PipelineDeps,
	apply: ApplyDeps,
	userId: string,
	context: SubmissionContext,
	mode: ApplicationRun["mode"],
): Promise<{ run: ApplicationRun } | { stop: string }> {
	if (!context.board)
		return { stop: "This board has no automatic form filling; apply by hand." };
	const url = formUrlOf(context, context.board, apply.boardBases);
	if (!context.cvPdfKey)
		return { stop: "The approved CV has no PDF export to upload." };
	const cv = await apply.blobs.get(context.cvPdfKey);
	const letter = context.coverLetterPdfKey
		? await apply.blobs.get(context.coverLetterPdfKey)
		: null;
	if (!cv)
		return { stop: `The approved CV PDF is missing from ${apply.blobs.name}.` };
	const profile = await deps.repo.getProfile(userId);
	if (!profile) return { stop: "No profile to read contact details from." };
	// The form read before review: its fields are what the user approved values for.
	const read = await apply.store.formRead?.(userId, context.applicationId);
	return {
		run: {
			board: context.board,
			url,
			mode,
			...(read?.status === "read" ? { schema: read.schema.fields } : {}),
			data: applicantData(profile, context, letter !== null),
			files: {
				cv: { name: "CV.pdf", mimeType: "application/pdf", buffer: cv },
				coverLetter: letter
					? {
							name: "Cover letter.pdf",
							mimeType: "application/pdf",
							buffer: letter,
						}
					: null,
			},
		},
	};
}

async function openAndRun(
	apply: ApplyDeps,
	run: ApplicationRun,
	network: "allowlist" | "read_only",
): Promise<RunResult & { networkLog?: unknown[] }> {
	if (apply.run) return apply.run(run);
	const session = await apply.browser.openSession(
		network === "allowlist"
			? { network, allowedHosts: run.allowedHosts }
			: { network },
	);
	try {
		const page = await session.newPage();
		const result = await runApplication(page, {
			...run,
			beforeFill:
				network === "read_only"
					? () => page.restrictNetwork("none")
					: run.beforeFill,
		});
		const networkLog = page.networkLog();
		// Unload handlers (beacons) run now, while a guarded page still aborts every request.
		if (network === "read_only") await page.goto("about:blank").catch(() => {});
		return { ...result, networkLog };
	} finally {
		await session.close().catch(() => {});
	}
}

export type SubmitOutcome =
	| { outcome: "applied"; confirmation: string }
	| { outcome: "needs_human"; reason: string }
	| { outcome: "ready_for_review"; reason: string }
	| { outcome: "paused"; reason: string }
	| { outcome: "skipped"; state: string };

/**
 * One submission. Never throws: a stop before the click records a `not_sent` attempt; an error
 * after the claim becomes an unknown outcome for the user to resolve, never a retry.
 */
export async function submitStep(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<SubmitOutcome> {
	const apply = deps.apply;
	const state = await deps.repo.getState(userId, applicationId);
	if (state !== "applying") return { outcome: "skipped", state: `${state}` };
	if (!apply) return { outcome: "skipped", state: "submission not configured" };
	const { store: db } = apply;
	if (await db.resolveInterrupted(userId, applicationId))
		return {
			outcome: "needs_human",
			reason:
				"An earlier attempt was interrupted after it was cleared to submit; check before retrying.",
		};
	const context = await db.submissionContext(userId, applicationId);
	const stop = async (
		reason: string,
		board = "",
		url = "",
		screenshotKey: string | null = null,
		proof: Record<string, unknown> = {},
	) => {
		await db.stopSubmission(userId, applicationId, {
			board,
			url,
			screenshotKey,
			reason: `${reason} Nothing was submitted.`,
			proof,
		});
		return { outcome: "needs_human" as const, reason };
	};
	if (!context) return stop("The application's job could not be read.");
	// The hard gate: on a hand-off board no browser opens, whatever moved it to applying.
	const mode = modeOf(context);
	if (mode.mode === "handoff") return stop(mode.reason, context.board ?? "");
	// A pause after approval stops before the browser opens: typing on a live form can send
	// answers through the page's own scripts, long before the upload or the click.
	if (await db.submissionsPaused(userId)) {
		const reason = "Submissions were paused before the form was opened.";
		await stop(reason, context.board ?? "");
		return { outcome: "paused" as const, reason };
	}
	let attemptId: string | null = null;
	let pausedAtClaim = false;
	try {
		const prepared = await prepareRun(deps, apply, userId, context, "submit");
		if ("stop" in prepared) return stop(prepared.stop, context.board ?? "");
		const { run } = prepared;
		if (!hostAllowed(run.url, apply.allowedHosts ?? LOCAL_HOSTS))
			return stop(
				`Automatic submission to ${new URL(run.url).hostname} is not turned on (SUBMIT_ALLOWED_HOSTS).`,
				run.board,
				run.url,
			);
		pausedAtClaim = false;
		const result = await openAndRun(
			apply,
			{
				...run,
				// The run stays on these hosts: redirects, navigations, uploads and the submission
				// itself are refused anywhere else, and the page is checked again before the claim.
				allowedHosts: apply.allowedHosts ?? LOCAL_HOSTS,
				// Boards upload a file as soon as it is chosen: re-check the switch first, so a
				// pause during the fill stops before the CV leaves.
				beforeUpload: async () =>
					(await db.submissionsPaused(userId))
						? "Submissions were paused before the files were uploaded."
						: null,
				claim: async (before, filled) => {
					const beforeKey = await store(
						apply.blobs,
						keyFor(userId, applicationId, "before"),
						before,
					);
					const claimed = await db.claimSubmission(userId, applicationId, {
						board: run.board,
						url: run.url,
						beforeKey,
						filled,
					});
					if (claimed.go) {
						attemptId = claimed.attemptId;
						return { go: true };
					}
					pausedAtClaim = claimed.paused;
					return { go: false, reason: claimed.reason };
				},
			},
			"allowlist",
		);
		const proof = { filled: result.filled, board: run.board };
		switch (result.outcome) {
			case "submitted":
			case "unknown": {
				const afterKey = await store(
					apply.blobs,
					keyFor(userId, applicationId, "after"),
					result.after,
				).catch(() => null);
				const submitted = result.outcome === "submitted";
				const reason = submitted
					? `Submitted; the board confirmed: "${result.confirmation}"`
					: `Outcome unknown after the submit click: ${result.reason} Check the employer's portal or your email before retrying.`;
				await db.finishSubmission(userId, applicationId, attemptId ?? "", {
					submitted,
					afterKey,
					reason,
					proof: {
						...proof,
						finalUrl: result.finalUrl,
						...(submitted ? { confirmation: result.confirmation } : {}),
					},
				});
				return submitted
					? { outcome: "applied", confirmation: result.confirmation }
					: { outcome: "needs_human", reason };
			}
			case "not_claimed": {
				const key = await store(
					apply.blobs,
					keyFor(userId, applicationId, "stopped"),
					result.screenshot,
				);
				await db.stopSubmission(userId, applicationId, {
					board: run.board,
					url: run.url,
					screenshotKey: key,
					reason: `${result.reason} Nothing was submitted.`,
					proof,
				});
				return pausedAtClaim
					? { outcome: "paused", reason: result.reason }
					: { outcome: "needs_human", reason: result.reason };
			}
			case "stopped": {
				const key = await store(
					apply.blobs,
					keyFor(userId, applicationId, "stopped"),
					result.screenshot,
				);
				if (
					result.stop.kind === "unknown_questions" &&
					result.stop.questions?.length
				) {
					const saved = await db.savedAnswers(userId);
					const questions: FormQuestion[] = result.stop.questions.map((q) => {
						const fact = saved.find((s) =>
							sameQuestion(formLabelOf(s.question), q.label),
						);
						const fits =
							fact &&
							(q.options.length === 0 || exactOption(fact.answer, q.options));
						return {
							...q,
							board: run.board,
							...(fact && fits ? { reuse: fact.answer } : {}),
						};
					});
					const { asked, reused } = await db.stopForQuestions(
						userId,
						applicationId,
						{
							board: run.board,
							url: run.url,
							screenshotKey: key,
							reason: `${result.stop.message} Nothing was submitted.`,
							proof,
							questions,
						},
					);
					return asked > 0
						? {
								outcome: "needs_human",
								reason: `${asked} form question(s) need your answer.`,
							}
						: {
								outcome: "ready_for_review",
								reason: `${reused} saved answer(s) added to the form answers; review and approve again.`,
							};
				}
				return stop(result.stop.message, run.board, run.url, key, {
					...proof,
					stop: result.stop.kind,
				});
			}
			case "dry_run":
				return stop(
					"A dry run was started as a submission.",
					run.board,
					run.url,
				);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// After a claim the click may have happened: an unknown outcome, never "not sent".
		if (attemptId) {
			const reason = `Outcome unknown: ${message} after the attempt was cleared to submit. Check the employer's portal or your email before retrying.`;
			await db.finishSubmission(userId, applicationId, attemptId, {
				submitted: false,
				afterKey: null,
				reason,
				proof: { error: message },
			});
			return { outcome: "needs_human", reason };
		}
		return stop(`Error before submitting: ${message}`, context.board ?? "");
	}
}

export type DryRunOutcome =
	| {
			outcome: "dry_run";
			attemptId: string;
			filled: FilledField[];
			blank: string[];
			requests: number;
			allowed: number;
	  }
	| { outcome: "stopped"; attemptId: string; reason: string };

/**
 * Fills the approved application's form and screenshots it, never clicking submit. The page
 * loads read-only and the network closes before the first keystroke, so typed data and files
 * cannot leave the browser even on a live board. Changes no application state.
 *
 * It needs no approval, pause or host check on purpose: the closed network is its gate, and it
 * is how a real board's form is checked before anything is sent (docs/auto-apply-plan.md, step 4).
 */
export async function dryRunApplication(
	deps: PipelineDeps,
	userId: string,
	applicationId: string,
): Promise<DryRunOutcome> {
	const apply = deps.apply;
	if (!apply) throw new Error("Submission is not configured here");
	const context = await apply.store.submissionContext(userId, applicationId);
	if (!context) throw new Error(`Application ${applicationId} not found`);
	// A dry run fills the form too: never on a hand-off board.
	const mode = modeOf(context);
	if (mode.mode === "handoff") throw new Error(mode.reason);
	const prepared = await prepareRun(deps, apply, userId, context, "dry_run");
	if ("stop" in prepared) {
		const attemptId = await apply.store.recordDryRun(userId, applicationId, {
			board: context.board ?? "",
			url: context.jobUrl,
			screenshotKey: null,
			reason: prepared.stop,
			proof: {},
		});
		return { outcome: "stopped", attemptId, reason: prepared.stop };
	}
	const result = await openAndRun(apply, prepared.run, "read_only");
	const log = (result.networkLog ?? []) as NetworkLogEntry[];
	const screenshot =
		result.outcome === "dry_run"
			? result.screenshot
			: result.outcome === "stopped"
				? result.screenshot
				: null;
	const key = await store(
		apply.blobs,
		keyFor(userId, applicationId, "dry-run"),
		screenshot,
	);
	const reason =
		result.outcome === "dry_run"
			? `Dry run: ${result.filled.length} field(s) filled, submit not clicked.`
			: result.outcome === "stopped"
				? `Dry run stopped: ${result.stop.message}`
				: "Dry run ended unexpectedly.";
	const attemptId = await apply.store.recordDryRun(userId, applicationId, {
		board: prepared.run.board,
		url: prepared.run.url,
		screenshotKey: key,
		reason,
		proof: {
			filled: result.filled,
			...(result.outcome === "dry_run" ? { blank: result.blank } : {}),
			...(result.outcome === "stopped" ? { stop: result.stop } : {}),
			// Reads while the page loaded (GET, HEAD, GraphQL queries), then nothing at all.
			requests: log.length,
			allowedWhileLoading: log.filter((r) => r.allowed).length,
			blockedAfterNetworkClosed: log.filter(
				(r) => r.reason === "network closed",
			).length,
		},
	});
	return result.outcome === "dry_run"
		? {
				outcome: "dry_run",
				attemptId,
				filled: result.filled,
				blank: result.blank,
				requests: log.length,
				allowed: log.filter((r) => r.allowed).length,
			}
		: { outcome: "stopped", attemptId, reason };
}
