import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	checkpointOpenCodeDb,
	type ScrubResult,
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
 */

/** How long OpenCode calls go on while a cleanup is unfinished, before they are refused. */
export const CLEANUP_GRACE_MS = 2 * 60_000;

/** A retry waits this long for another connection: the connection blocks the worker meanwhile. */
const RETRY_BUSY_TIMEOUT_MS = 250;

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
	/** OfferFinch's own folder (the stable private root's real path): where the marker lives. */
	base: string;
	/** The user's `opencode.db`. */
	dbFile: string;
	/** The private working directory, whose OpenCode project holds OfferFinch's sessions only. */
	cwd: string;
}

function markerFile(target: CleanupTarget): string {
	const id = createHash("sha256").update(target.dbFile).digest("hex");
	return join(target.base, `cleanup-pending-${id.slice(0, 16)}.json`);
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

function writePending(target: CleanupTarget, pending: PendingCleanup): void {
	const file = markerFile(target);
	const part = `${file}.${process.pid}.part`;
	writeFileSync(part, JSON.stringify(pending), { mode: 0o600 });
	renameSync(part, file);
}

function clearPending(target: CleanupTarget): void {
	rmSync(markerFile(target), { force: true });
}

/** Records one more unfinished attempt; the first `since` is kept. */
function markPending(
	target: CleanupTarget,
	rowsLeft: boolean,
	now: Date,
): PendingCleanup {
	const was = readPendingCleanup(target);
	const pending: PendingCleanup = {
		since: was?.since ?? now.toISOString(),
		attempts: (was?.attempts ?? 0) + 1,
		rowsLeft: rowsLeft || (was?.rowsLeft ?? false),
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
 * One try: with no other OfferFinch call running (`idle`), the sweep (every session of
 * OfferFinch's project, then the checkpoint); otherwise only the checkpoint, so a running call's
 * session is never deleted from under it. A busy checkpoint with no marker and nothing deleted
 * says nothing about OfferFinch's calls (the user's service is just reading): it is not marked.
 */
export function attemptCleanup(
	target: CleanupTarget,
	options: { idle: boolean; now: Date },
): CleanupAttempt {
	const was = readPendingCleanup(target);
	if (!existsSync(target.dbFile)) {
		clearPending(target);
		return { pending: null, result: null, error: null };
	}
	let result: ScrubResult | null = null;
	let error: string | null = null;
	try {
		result = options.idle
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
		? options.idle || (was?.rowsLeft ?? false)
		: !options.idle && (was?.rowsLeft ?? false);
	if (result?.clean && !rowsLeft) {
		clearPending(target);
		return { pending: null, result, error };
	}
	if (!was && !error && result && result.rows === 0)
		return { pending: null, result, error };
	return { pending: markPending(target, rowsLeft, options.now), result, error };
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
