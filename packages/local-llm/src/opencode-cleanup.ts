import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
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
 * sweep to a checkpoint, so that call's session is never deleted from under it.
 *
 * Whether anything can be owed is never read from the user's database (a project row can be
 * deleted while the prompt is still in the WAL): before its first intent, a call writes a use
 * record (durably) saying OfferFinch has run OpenCode calls on this database. At start, a
 * checkpoint that cannot finish is unfinished cleanup when that record exists (or OfferFinch's
 * project is in the database: an older build ran calls without one); with neither, a busy
 * checkpoint is only the user's OpenCode reading.
 *
 * Another OfferFinch process (the desktop holds a single-instance lock, but a restarted worker
 * can overlap the one it replaces) could publish its intent and create its session between a
 * sweep's intent check and its deletion. So one lock per database is held across a call's intent
 * publication and across a sweep's intent check and deletion: an exclusive transaction on a small
 * SQLite file of OfferFinch's own, i.e. the operating system's file lock, which nobody else can
 * take over and which goes when its process dies. A call waits for it (SQLite's busy timeout,
 * 5 s, then is refused); a sweep that cannot take it at once only checkpoints.
 *
 * A file the cleanup needs that cannot be read for any reason but its absence (a permission or
 * disk error) is never taken for missing: OpenCode calls are refused until it can be read.
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

function useFile(target: CleanupTarget): string {
	return join(target.base, `opencode-used-${dbId(target)}.json`);
}

/**
 * A file the cleanup needs could not be read or written, and not because it is missing (a
 * permission or disk error). Nothing is assumed about it: OpenCode calls are refused until it
 * can be. No path or system message is kept (a path names the user).
 */
export class CleanupFileError extends Error {
	constructor() {
		super(
			"a file OfferFinch's OpenCode cleanup needs could not be read or written",
		);
		this.name = "CleanupFileError";
	}
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** The file exists; false only when it does not (any other failure throws). */
function exists(file: string): boolean {
	try {
		statSync(file);
		return true;
	} catch (error) {
		if (missing(error)) return false;
		throw new CleanupFileError();
	}
}

/** The file's text; null only when it does not exist (any other failure throws). */
function readOwn(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if (missing(error)) return null;
		throw new CleanupFileError();
	}
}

/** OfferFinch has run (or started) an OpenCode call on this database. */
function everUsed(target: CleanupTarget): boolean {
	return exists(useFile(target));
}

/** The use record, on disk; written once, never removed. */
function recordUse(target: CleanupTarget, now: Date): void {
	if (!everUsed(target))
		writeDurable(useFile(target), JSON.stringify({ since: now.toISOString() }));
}

/**
 * The unfinished cleanup, or null when there is no marker. A marker that cannot be read or parsed
 * counts as overdue (rows possibly left): only a finished sweep removes it.
 */
export function readPendingCleanup(
	target: CleanupTarget,
): PendingCleanup | null {
	let text: string | null;
	try {
		text = readOwn(markerFile(target));
	} catch {
		return OVERDUE;
	}
	if (text === null) return null;
	try {
		const raw = JSON.parse(text) as Partial<
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
	return OVERDUE;
}

const OVERDUE: PendingCleanup = Object.freeze({
	since: new Date(0).toISOString(),
	attempts: 1,
	rowsLeft: true,
});

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
	const part = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const fd = openSync(part, "w", 0o600);
		try {
			writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(part, file);
	} catch {
		try {
			rmSync(part, { force: true });
		} catch {}
		throw new CleanupFileError();
	}
	syncDir(dirname(file));
}

/** Removes `file` (a missing one is fine), on disk before it returns. */
function removeDurable(file: string): void {
	try {
		rmSync(file, { force: true });
	} catch {
		throw new CleanupFileError();
	}
	syncDir(dirname(file));
}

// ---------------------------------------------------------------------------------------------
// The interprocess lock: one per database, held for a few synchronous steps at a time.

/** How long a call waits for the lock before it is refused (a sweep holds it about a second). */
const LOCK_WAIT_MS = 5_000;

/**
 * The lock is an exclusive transaction on a small SQLite file of OfferFinch's own (no data, never
 * written): the operating system's file lock, which only its holder releases and which goes when
 * the holder's process dies. So no lock is ever taken over, and none is left by a crash.
 */
function lockFile(target: CleanupTarget): string {
	return join(target.base, `cleanup-lock-${dbId(target)}.sqlite`);
}

/** Takes the lock, waiting up to `waitMs` (SQLite's busy timeout, which sleeps). */
function acquireLock(
	target: CleanupTarget,
	waitMs: number,
): { ok: true; db: Database.Database } | { ok: false; busy: boolean } {
	let db: Database.Database | null = null;
	try {
		mkdirSync(target.base, { recursive: true, mode: 0o700 });
		const file = lockFile(target);
		// Created private before SQLite opens it (SQLite would use the umask).
		closeSync(openSync(file, "a", 0o600));
		db = new Database(file, { timeout: waitMs });
		db.exec("BEGIN EXCLUSIVE");
		return { ok: true, db };
	} catch (error) {
		db?.close();
		return {
			ok: false,
			busy: (error as { code?: unknown }).code === "SQLITE_BUSY",
		};
	}
}

function releaseLock(db: Database.Database): void {
	try {
		db.exec("ROLLBACK");
	} finally {
		db.close();
	}
}

function writePending(target: CleanupTarget, pending: PendingCleanup): void {
	writeDurable(markerFile(target), JSON.stringify(pending));
}

function clearPending(target: CleanupTarget): void {
	removeDurable(markerFile(target));
}

// ---------------------------------------------------------------------------------------------
// Intents: one per running call.

/** Another OfferFinch process held the cleanup lock for longer than a call waits for it. */
export class CleanupLockBusyError extends Error {
	constructor() {
		super("another OfferFinch process holds the OpenCode cleanup lock");
		this.name = "CleanupLockBusyError";
	}
}

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

/**
 * The intents on disk. One that cannot be read (not missing) throws: it may be a running call's
 * or a crashed one's, so neither a sweep nor a call may go on as if it were not there.
 */
function readIntents(target: CleanupTarget): IntentRecord[] {
	let names: string[];
	try {
		names = readdirSync(target.base);
	} catch (error) {
		if (missing(error)) return [];
		throw new CleanupFileError();
	}
	const prefix = intentPrefix(target);
	const intents: IntentRecord[] = [];
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
		const file = join(target.base, name);
		// Missing: its call removed it after the listing.
		const text = readOwn(file);
		if (text === null) continue;
		let raw: { pid?: unknown; since?: unknown } = {};
		try {
			raw = JSON.parse(text);
		} catch {}
		intents.push({
			file,
			pid: typeof raw?.pid === "number" ? raw.pid : null,
			since:
				typeof raw?.since === "string" && !Number.isNaN(Date.parse(raw.since))
					? raw.since
					: null,
		});
	}
	return intents;
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

/**
 * This module's calls still running: an intent of this process's id that is not here was left by
 * a call whose cleanup threw before its marker (or by an earlier instance with the same id), so it
 * is stale at once. (The desktop runs the worker as a utility process; a restarted worker gets a
 * new id, but this does not rely on it.)
 */
const activeIntents = new Set<string>();

/** The call behind the intent may still be running (in this process or another). */
function intentLive(intent: IntentRecord, now: Date): boolean {
	if (intent.pid === process.pid) return activeIntents.has(intent.file);
	if (intent.pid === null || intent.since === null) return false;
	if (now.getTime() - Date.parse(intent.since) >= INTENT_MAX_AGE_MS)
		return false;
	return processRuns(intent.pid);
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
	// Under the lock: a sweep that checked the intents must finish deleting before this one appears.
	const lock = acquireLock(target, LOCK_WAIT_MS);
	if (!lock.ok)
		throw lock.busy ? new CleanupLockBusyError() : new CleanupFileError();
	activeIntents.add(file);
	try {
		recordUse(target, now);
		writeDurable(
			file,
			JSON.stringify({ pid: process.pid, since: now.toISOString() }),
		);
	} catch (error) {
		activeIntents.delete(file);
		throw error;
	} finally {
		releaseLock(lock.db);
	}
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

interface SweepOutcome {
	/** The sweep ran (else only the checkpoint). */
	idle: boolean;
	/** The marker before this attempt. */
	was: PendingCleanup | null;
	result: ScrubResult | null;
	error: string | null;
}

/**
 * Stale intents adopted, then the sweep when nothing else of OfferFinch's runs (no call here, no
 * live intent of another process, and this process holds the lock from the check through the
 * deletion), else only the checkpoint.
 */
function sweepOrCheckpoint(
	target: CleanupTarget,
	options: { idle: boolean; now: Date; beforeSweep?: () => void },
): SweepOutcome {
	// Never waited for: a call holds it only while it publishes its intent. Not taken (held, or
	// the file cannot be opened): only the checkpoint.
	const taken = options.idle ? acquireLock(target, 0) : null;
	const lock = taken?.ok ? taken.db : null;
	const outcome: SweepOutcome = {
		idle: false,
		was: null,
		result: null,
		error: null,
	};
	try {
		const foreignLive = adoptStaleIntents(target, options.now);
		outcome.idle = lock !== null && !foreignLive;
		outcome.was = readPendingCleanup(target);
		if (outcome.idle) options.beforeSweep?.();
		try {
			outcome.result = outcome.idle
				? sweepOpenCodeProject(target.dbFile, target.cwd, {
						busyTimeoutMs: RETRY_BUSY_TIMEOUT_MS,
					})
				: checkpointOpenCodeDb(target.dbFile, {
						busyTimeoutMs: RETRY_BUSY_TIMEOUT_MS,
					});
		} catch (caught) {
			outcome.error = caught instanceof Error ? caught.message : String(caught);
		}
	} finally {
		if (lock) releaseLock(lock);
	}
	return outcome;
}

/**
 * One try: with no other OfferFinch call running (`idle`, and no live intent of another process),
 * the sweep (every session of OfferFinch's project, then the checkpoint); otherwise only the
 * checkpoint, so a running call's session is never deleted from under it. The sweep holds the
 * lock from the intent check through the deletion; when another process holds it, only the
 * checkpoint. Stale intents are adopted first. A busy checkpoint with no marker and nothing
 * deleted is not marked unless at `start` OfferFinch has used this database (the use record, or
 * its project in the database): then it may be a crash's leftovers.
 */
export function attemptCleanup(
	target: CleanupTarget,
	options: {
		idle: boolean;
		now: Date;
		start?: boolean;
		/** Tests: runs between the intent check and the sweep (another process starting a call). */
		beforeSweep?: () => void;
	},
): CleanupAttempt {
	if (!exists(target.dbFile)) {
		clearPending(target);
		for (const intent of readIntents(target))
			if (!intentLive(intent, options.now)) removeDurable(intent.file);
		return { pending: null, result: null, error: null };
	}
	const { idle, was, result, error } = sweepOrCheckpoint(target, options);
	// A sweep that ran removed every row of the project; a checkpoint alone removes none.
	const rowsLeft = error
		? idle || (was?.rowsLeft ?? false)
		: !idle && (was?.rowsLeft ?? false);
	if (result?.clean && !rowsLeft) {
		clearPending(target);
		return { pending: null, result, error };
	}
	// Debt may be owed when OfferFinch has used this database. The database can prove it (its
	// project is there: recorded, for builds that ran calls before the record) but never disprove
	// it: the project row can be gone while the prompt is still in the WAL. A checkpoint alone
	// (another call runs) counts as used.
	if ((result?.projects ?? 0) > 0) recordUse(target, options.now);
	const used =
		everUsed(target) || (result !== null && result.projects === undefined);
	if (!was && !error && result && result.rows === 0 && !(options.start && used))
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
	try {
		if (sessionId) {
			try {
				scrub = scrubOpenCodeSessions(target.dbFile, [sessionId]);
			} catch (error) {
				scrubError = error instanceof Error ? error.message : String(error);
			}
			options.afterDelete?.();
			pending = afterScrub(
				target,
				{ result: scrub, error: scrubError },
				options,
			);
		} else pending = readPendingCleanup(target);
		// Only once the marker is on disk (or nothing is owed).
		removeDurable(intent.file);
	} finally {
		// A throw above leaves the file: no longer this call's, so the next attempt adopts it.
		activeIntents.delete(intent.file);
	}
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
