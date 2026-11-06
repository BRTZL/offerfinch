import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	checkpointOpenCodeDb,
	type ScrubResult,
	scrubOpenCodeSessions,
	sweepOpenCodeProject,
} from "./opencode-db";

/**
 * The cleanup an OpenCode call owes the user's database, kept until it is done
 * (docs/research/opencode-v2-shared-login.md, "Session delete and residue").
 *
 * Deleting a call's session rows is not enough: the old page versions that hold the prompt stay
 * in OpenCode's `-wal` file until a truncating checkpoint copies every frame back and empties
 * it. While any other connection (the user's own OpenCode, open or in the background) holds a
 * read transaction, that checkpoint reports busy and leaves the frames; a later sweep finds no
 * rows to delete, so the frames would stay. So an unfinished cleanup leaves a marker in
 * OfferFinch's own private root (never in the user's database), and the marker stays until a
 * sweep or checkpoint finishes: retried on a timer with backoff, before every OpenCode call and at
 * start. Past a short grace period, OpenCode calls are refused until it is done.
 *
 * The marker holds only when the cleanup became due, how often it was tried and whether session
 * rows may be left too: no session id, no text.
 *
 * A crash must not lose the debt. So before a call starts OpenCode it writes an intent file of its
 * own (its process id and start time, nothing else), fsync'd and renamed into place, and removes it
 * only after its scrub finished or the marker was written (durably) in its place. An intent whose
 * process is gone (or older than any call can run) is adopted as an unfinished cleanup, at start
 * and on every retry; one whose process still runs (another worker sharing the folder) keeps the
 * sweep to a checkpoint, so that call's session is never deleted from under it. At start, a
 * checkpoint that cannot finish is unfinished cleanup too when OfferFinch's project is in the
 * database (an older build may have crashed without an intent).
 */

/** How long OpenCode calls go on while a cleanup is unfinished, before they are refused. */
export const CLEANUP_GRACE_MS = 2 * 60_000;

/** A retry waits this long for another connection: the connection blocks the worker meanwhile. */
const RETRY_BUSY_TIMEOUT_MS = 250;

/**
 * An intent older than this is stale even when a process with its id runs (the id was reused): no
 * call runs longer (its timeout is 10 minutes by default).
 */
const INTENT_MAX_AGE_MS = 30 * 60_000;

/** Waits between retries, by attempt; the last one repeats. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000];

export const CLEANUP_REFUSAL =
	"OfferFinch has not finished removing an earlier OpenCode call from OpenCode's database: another program keeps the database busy (most likely OpenCode itself, open or running in the background), so an old copy of the prompt is still in the database's write-ahead log. OpenCode calls wait until it is removed. OfferFinch retries on its own; quitting OpenCode lets it finish.";

export interface PendingCleanup {
	/** When the cleanup became due (ISO). */
	since: string;
	/** Unfinished attempts so far. */
	attempts: number;
	/** Session rows may be left too (a scrub or sweep failed), not only old WAL frames. */
	rowsLeft: boolean;
}

export interface CleanupTarget {
	/**
	 * OfferFinch's own folder, where the marker and intents live: the app's data folder on the
	 * desktop (never the temp folder, which the system may empty), else the private root.
	 */
	base: string;
	/** The user's `opencode.db`. */
	dbFile: string;
	/** The private working directory, whose OpenCode project holds OfferFinch's sessions only. */
	cwd: string;
}

function dbId(target: CleanupTarget): string {
	return createHash("sha256").update(target.dbFile).digest("hex").slice(0, 16);
}

function markerFile(target: CleanupTarget): string {
	return join(target.base, `cleanup-pending-${dbId(target)}.json`);
}

/** The unfinished cleanup, or null. An unreadable marker counts as overdue. */
export function readPendingCleanup(
	target: CleanupTarget,
): PendingCleanup | null {
	const file = markerFile(target);
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<
			Record<keyof PendingCleanup, unknown>
		>;
		if (
			typeof raw.since === "string" &&
			!Number.isNaN(Date.parse(raw.since)) &&
			typeof raw.attempts === "number" &&
			typeof raw.rowsLeft === "boolean"
		)
			return {
				since: raw.since,
				attempts: raw.attempts,
				rowsLeft: raw.rowsLeft,
			};
	} catch {}
	return { since: new Date(0).toISOString(), attempts: 1, rowsLeft: true };
}

/** Makes a rename or removal in `dir` survive a crash. */
function syncDir(dir: string): void {
	let fd: number | null = null;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// Some file systems cannot sync a folder; the file itself was synced.
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** Writes `file` whole or not at all, and on disk before it returns. */
function writeDurable(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const part = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
	const fd = openSync(part, "w", 0o600);
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(part, file);
	syncDir(dirname(file));
}

function removeDurable(file: string): void {
	rmSync(file, { force: true });
	syncDir(dirname(file));
}

function writePending(target: CleanupTarget, pending: PendingCleanup): void {
	writeDurable(markerFile(target), JSON.stringify(pending));
}

function clearPending(target: CleanupTarget): void {
	if (existsSync(markerFile(target))) removeDurable(markerFile(target));
}

// ---------------------------------------------------------------------------------------------
// Intents: one per running call.

/** A call's intent file: written before OpenCode starts, removed once its cleanup is settled. */
export interface CallIntent {
	file: string;
}

interface IntentRecord {
	file: string;
	pid: number | null;
	since: string | null;
}

function intentPrefix(target: CleanupTarget): string {
	return `cleanup-intent-${dbId(target)}-`;
}

function readIntents(target: CleanupTarget): IntentRecord[] {
	let names: string[];
	try {
		names = readdirSync(target.base);
	} catch {
		return [];
	}
	const prefix = intentPrefix(target);
	return names
		.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
		.map((name) => {
			const file = join(target.base, name);
			try {
				const raw = JSON.parse(readFileSync(file, "utf8")) as {
					pid?: unknown;
					since?: unknown;
				};
				return {
					file,
					pid: typeof raw.pid === "number" ? raw.pid : null,
					since:
						typeof raw.since === "string" &&
						!Number.isNaN(Date.parse(raw.since))
							? raw.since
							: null,
				};
			} catch {
				return { file, pid: null, since: null };
			}
		});
}

function processRuns(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it runs, as another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The call behind the intent may still be running (in this process or another). */
function intentLive(intent: IntentRecord, now: Date): boolean {
	if (intent.pid === null || intent.since === null) return false;
	if (now.getTime() - Date.parse(intent.since) >= INTENT_MAX_AGE_MS)
		return false;
	return intent.pid === process.pid || processRuns(intent.pid);
}

/**
 * Before a call starts OpenCode: its intent, on disk. Until it is removed, a crash at any point
 * leaves something the next start adopts as an unfinished cleanup.
 */
export function beginCall(target: CleanupTarget, now: Date): CallIntent {
	const file = join(
		target.base,
		`${intentPrefix(target)}${process.pid}-${randomBytes(6).toString("hex")}.json`,
	);
	writeDurable(
		file,
		JSON.stringify({ pid: process.pid, since: now.toISOString() }),
	);
	return { file };
}

/**
 * Intents of calls that cannot be running any more (their process is gone, or they are older than
 * any call) become the unfinished cleanup, rows possibly left; the marker is on disk before they
 * are removed. Returns whether a call of another process may still be running.
 */
function adoptStaleIntents(target: CleanupTarget, now: Date): boolean {
	let foreignLive = false;
	const stale: IntentRecord[] = [];
	for (const intent of readIntents(target)) {
		if (intentLive(intent, now)) {
			if (intent.pid !== process.pid) foreignLive = true;
		} else stale.push(intent);
	}
	if (stale.length) {
		const earliest = stale
			.map((intent) => intent.since ?? new Date(0).toISOString())
			.sort()[0] as string;
		const was = readPendingCleanup(target);
		writePending(target, {
			since: was && was.since < earliest ? was.since : earliest,
			attempts: was?.attempts ?? 0,
			rowsLeft: true,
		});
		for (const intent of stale) removeDurable(intent.file);
	}
	return foreignLive;
}

/**
 * Records one more unfinished attempt; the first `since` is kept (the cleanup has been due since
 * then). `rowsLeft` adds to rows an earlier call may have left (a call's own scrub), or with
 * `replace` (a sweep or checkpoint that already counted them) says what is left now.
 */
function markPending(
	target: CleanupTarget,
	rowsLeft: boolean,
	now: Date,
	replace = false,
): PendingCleanup {
	const was = readPendingCleanup(target);
	const pending: PendingCleanup = {
		since: was?.since ?? now.toISOString(),
		attempts: (was?.attempts ?? 0) + 1,
		rowsLeft: replace ? rowsLeft : rowsLeft || (was?.rowsLeft ?? false),
	};
	writePending(target, pending);
	return pending;
}

export interface CleanupAttempt {
	/** Still unfinished after this attempt; null when done (or nothing of OfferFinch's is known). */
	pending: PendingCleanup | null;
	result: ScrubResult | null;
	error: string | null;
}

/**
 * One try: with no other OfferFinch call running (`idle`, and no live intent of another process),
 * the sweep (every session of OfferFinch's project, then the checkpoint); otherwise only the
 * checkpoint, so a running call's session is never deleted from under it. Stale intents are
 * adopted first. A busy checkpoint with no marker and nothing deleted says nothing about
 * OfferFinch's calls (the user's service is just reading) and is not marked, except at `start`
 * when OfferFinch's project is in the database: then it may be an older crash's leftovers.
 */
export function attemptCleanup(
	target: CleanupTarget,
	options: { idle: boolean; now: Date; start?: boolean },
): CleanupAttempt {
	if (!existsSync(target.dbFile)) {
		clearPending(target);
		for (const intent of readIntents(target))
			if (!intentLive(intent, options.now)) removeDurable(intent.file);
		return { pending: null, result: null, error: null };
	}
	const foreignLive = adoptStaleIntents(target, options.now);
	const idle = options.idle && !foreignLive;
	const was = readPendingCleanup(target);
	let result: ScrubResult | null = null;
	let error: string | null = null;
	try {
		result = idle
			? sweepOpenCodeProject(target.dbFile, target.cwd, {
					busyTimeoutMs: RETRY_BUSY_TIMEOUT_MS,
				})
			: checkpointOpenCodeDb(target.dbFile, {
					busyTimeoutMs: RETRY_BUSY_TIMEOUT_MS,
				});
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	// A sweep that ran removed every row of the project; a checkpoint alone removes none.
	const rowsLeft = error
		? idle || (was?.rowsLeft ?? false)
		: !idle && (was?.rowsLeft ?? false);
	if (result?.clean && !rowsLeft) {
		clearPending(target);
		return { pending: null, result, error };
	}
	// Ours unless the sweep found no project of OfferFinch's (a checkpoint alone cannot tell).
	const ours = result?.projects === undefined || result.projects > 0;
	if (!was && !error && result && result.rows === 0 && !(options.start && ours))
		return { pending: null, result, error };
	return {
		pending: markPending(target, rowsLeft, options.now, true),
		result,
		error,
	};
}

/**
 * After a call's own scrub: unfinished (it threw, or its checkpoint did not finish) keeps the
 * marker; finished clears it, unless rows of an earlier call may be left, which takes a sweep.
 */
export function afterScrub(
	target: CleanupTarget,
	scrub: { result: ScrubResult | null; error: string | null },
	options: { idle: boolean; now: Date },
): PendingCleanup | null {
	if (scrub.error !== null || !scrub.result?.clean)
		return markPending(target, scrub.error !== null, options.now);
	const was = readPendingCleanup(target);
	if (!was) return null;
	if (!was.rowsLeft) {
		clearPending(target);
		return null;
	}
	return attemptCleanup(target, options).pending;
}

export interface FinishedCall {
	scrub: ScrubResult | null;
	scrubError: string | null;
	pending: PendingCleanup | null;
}

/**
 * A call's cleanup after its server exited, in the order a crash cannot break: its session
 * deleted and the WAL truncated, then the marker written (on disk) if that did not finish, and
 * only then its intent removed. With no session (none was opened) only the intent goes, unless a
 * marker is already due.
 */
export function finishCall(
	target: CleanupTarget,
	intent: CallIntent,
	sessionId: string | null,
	options: {
		idle: boolean;
		now: Date;
		/** Tests: runs between the deletion and the marker (a crash there). */
		afterDelete?: () => void;
	},
): FinishedCall {
	let scrub: ScrubResult | null = null;
	let scrubError: string | null = null;
	let pending: PendingCleanup | null = null;
	if (sessionId) {
		try {
			scrub = scrubOpenCodeSessions(target.dbFile, [sessionId]);
		} catch (error) {
			scrubError = error instanceof Error ? error.message : String(error);
		}
		options.afterDelete?.();
		pending = afterScrub(target, { result: scrub, error: scrubError }, options);
	} else pending = readPendingCleanup(target);
	removeDurable(intent.file);
	return { scrub, scrubError, pending };
}

/** A cleanup to try now: a marker, or the intent of a call whose process is gone. */
export function cleanupDue(target: CleanupTarget, now: Date): boolean {
	return (
		readPendingCleanup(target) !== null ||
		readIntents(target).some((intent) => !intentLive(intent, now))
	);
}

/** The cleanup has been unfinished for longer than the grace period. */
export function cleanupOverdue(
	pending: PendingCleanup | null,
	now: Date,
	graceMs: number = CLEANUP_GRACE_MS,
): boolean {
	if (!pending) return false;
	const since = Date.parse(pending.since);
	return Number.isNaN(since) || now.getTime() - since >= graceMs;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Runs `retry` after the backoff for `attempts`, once per target at a time (a later request
 * while one waits is dropped). The timer does not keep the process alive.
 */
export function scheduleCleanupRetry(
	target: CleanupTarget,
	attempts: number,
	retry: () => Promise<unknown>,
): void {
	const key = markerFile(target);
	if (timers.has(key)) return;
	const delay =
		BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1] ??
		BACKOFF_MS[0];
	const timer = setTimeout(() => {
		timers.delete(key);
		void retry().catch(() => {});
	}, delay);
	timer.unref?.();
	timers.set(key, timer);
}
