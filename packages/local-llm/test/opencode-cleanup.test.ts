import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	afterScrub,
	attemptCleanup,
	beginCall,
	CLEANUP_GRACE_MS,
	CleanupFileError,
	CleanupLockBusyError,
	type CleanupTarget,
	cleanupDue,
	cleanupOverdue,
	finishCall,
	readPendingCleanup,
	scheduleCleanupRetry,
} from "../src/opencode-cleanup";
import { scrubOpenCodeSessions } from "../src/opencode-db";
import { OPENCODE_SCHEMA } from "./opencode-schema";

/**
 * Finding: a scrub whose truncating checkpoint is busy (another connection, such as the user's
 * own OpenCode, holds a read transaction) deletes the rows but leaves the prompt in the `-wal`
 * file, and a later sweep, finding no rows, never checkpointed again. The cleanup must stay
 * pending (in OfferFinch's own root), be retried even with no rows left, stop calls past the
 * grace period, and finish once the reader is gone.
 */

const PROMPT = "PROMPT_CANARY_WAL_4b2";
const now = new Date("2026-11-06T10:00:00Z");

let dir: string;
let target: CleanupTarget;

/** A call's session, written by another connection (OpenCode's server). */
function addSession(id: string) {
	const db = new Database(target.dbFile);
	db.prepare("INSERT INTO session_v2 (id, project_id) VALUES (?, 'ours')").run(
		id,
	);
	db.prepare(
		"INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, 'user', 1, ?)",
	).run(`msg_${id}`, id, `${PROMPT} ${"filler ".repeat(800)} ${PROMPT}_END`);
	db.prepare(
		"INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, 1)",
	).run(id);
	db.prepare(
		"INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, 1, 'session.inbox.enqueued', ?)",
	).run(`evt_${id}`, id, PROMPT);
	db.close();
}

/** The prompt, in which of the database's files. */
function filesWithPrompt(): string[] {
	return ["opencode.db", "opencode.db-wal", "opencode.db-shm"].filter(
		(name) => {
			const path = join(dir, "data", name);
			return (
				existsSync(path) &&
				readFileSync(path).toString("latin1").includes(PROMPT)
			);
		},
	);
}

function count(table: string): number {
	const db = new Database(target.dbFile, { readonly: true });
	const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
		n: number;
	};
	db.close();
	return row.n;
}

/** A connection with an open read transaction, like a long-running reader in OpenCode. */
function holdReader(): Database.Database {
	const reader = new Database(target.dbFile);
	reader.prepare("BEGIN").run();
	reader.prepare("SELECT count(*) FROM session_v2").get();
	return reader;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "offerfinch-opencode-cleanup-"));
	await mkdir(join(dir, "data"));
	await mkdir(join(dir, "root", "work"), { recursive: true });
	target = {
		base: join(dir, "root"),
		dbFile: join(dir, "data", "opencode.db"),
		cwd: join(dir, "root", "work"),
	};
	const db = new Database(target.dbFile);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.exec(OPENCODE_SCHEMA);
	db.prepare("INSERT INTO project (id, worktree) VALUES ('ours', ?)").run(
		target.cwd,
	);
	db.prepare(
		"INSERT INTO project (id, worktree) VALUES ('theirs', '/Users/me/code')",
	).run();
	db.close();
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe("an OpenCode cleanup while another connection reads the database", () => {
	it("keeps the cleanup pending, refuses calls past the grace period, and finishes once the reader closes", () => {
		const reader = holdReader();
		addSession("ses_call");
		const scrub = scrubOpenCodeSessions(target.dbFile, ["ses_call"], {
			busyTimeoutMs: 50,
		});
		// The rows are gone, but the checkpoint could not finish: the prompt is in the WAL.
		expect(scrub.rows).toBeGreaterThan(0);
		expect(scrub.busy).toBe(1);
		expect(scrub.clean).toBe(false);
		expect(count("session_v2")).toBe(0);
		expect(filesWithPrompt()).toContain("opencode.db-wal");

		const pending = afterScrub(
			target,
			{ result: scrub, error: null },
			{ idle: true, now },
		);
		expect(pending).toMatchObject({
			since: now.toISOString(),
			attempts: 1,
			rowsLeft: false,
		});
		expect(readPendingCleanup(target)).toEqual(pending);
		// The marker is OfferFinch's own file, never anything in the user's database folder.
		expect(readdirSync(target.base).some((f) => f.startsWith("cleanup-"))).toBe(
			true,
		);
		expect(readdirSync(join(dir, "data")).sort()).toEqual([
			"opencode.db",
			"opencode.db-shm",
			"opencode.db-wal",
		]);

		// A retry with no rows left still checkpoints, and stays pending while the reader stays.
		const later = new Date(now.getTime() + 30_000);
		const retry = attemptCleanup(target, { idle: true, now: later });
		expect(retry.result).toMatchObject({ rows: 0, busy: 1, clean: false });
		expect(retry.pending).toMatchObject({
			since: now.toISOString(),
			attempts: 2,
		});
		expect(filesWithPrompt()).toContain("opencode.db-wal");

		// Calls go on during the grace period, and are refused after it.
		expect(cleanupOverdue(retry.pending, later)).toBe(false);
		expect(
			cleanupOverdue(retry.pending, new Date(now.getTime() + CLEANUP_GRACE_MS)),
		).toBe(true);

		reader.prepare("COMMIT").run();
		reader.close();
		const done = attemptCleanup(target, {
			idle: true,
			now: new Date(now.getTime() + CLEANUP_GRACE_MS + 1),
		});
		expect(done.pending).toBeNull();
		expect(done.result).toMatchObject({ busy: 0, clean: true });
		expect(readPendingCleanup(target)).toBeNull();
		expect(filesWithPrompt()).toEqual([]);

		// The user's OpenCode writing afterwards only adds frames of pages as they are now.
		const service = new Database(target.dbFile);
		for (let i = 0; i < 20; i++)
			service
				.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)")
				.run(`p${i}`, `/Users/me/p${i}`);
		service
			.prepare(
				"INSERT INTO session_v2 (id, project_id, title) VALUES ('ses_theirs', 'theirs', 'x')",
			)
			.run();
		service.close();
		expect(filesWithPrompt()).toEqual([]);
	});

	it("does not mark a busy checkpoint that removed nothing of OfferFinch's (no marker, no rows)", () => {
		const reader = holdReader();
		const service = new Database(target.dbFile);
		service
			.prepare("INSERT INTO project (id, worktree) VALUES ('p', '/Users/me/p')")
			.run();
		service.close();
		const start = attemptCleanup(target, { idle: true, now });
		expect(start.result).toMatchObject({ rows: 0, busy: 1 });
		expect(start.pending).toBeNull();
		expect(readPendingCleanup(target)).toBeNull();
		reader.close();
	});

	it("never sweeps the session of a call still running, and keeps rows a failed scrub left pending until a sweep runs", () => {
		addSession("ses_call");
		const failed = afterScrub(
			target,
			{ result: null, error: "database is locked" },
			{ idle: false, now },
		);
		expect(failed).toMatchObject({ rowsLeft: true });
		// Another call is running: only the checkpoint, which leaves its session alone.
		const busy = attemptCleanup(target, { idle: false, now });
		expect(busy.result?.rows).toBe(0);
		expect(count("session_v2")).toBe(1);
		expect(busy.pending).toMatchObject({ rowsLeft: true, attempts: 2 });
		// A clean scrub of some other call does not clear rows an earlier one left: it sweeps.
		const after = afterScrub(
			target,
			{ result: { rows: 6, busy: 0, clean: true }, error: null },
			{ idle: true, now },
		);
		expect(after).toBeNull();
		expect(count("session_v2")).toBe(0);
		expect(filesWithPrompt()).toEqual([]);
	});

	it("counts an unreadable marker as overdue", () => {
		const reader = holdReader();
		addSession("ses_call");
		const scrub = scrubOpenCodeSessions(target.dbFile, ["ses_call"], {
			busyTimeoutMs: 50,
		});
		afterScrub(target, { result: scrub, error: null }, { idle: true, now });
		const marker = readdirSync(target.base).find((f) =>
			f.startsWith("cleanup-"),
		) as string;
		writeFileSync(join(target.base, marker), "{not json");
		expect(cleanupOverdue(readPendingCleanup(target), now)).toBe(true);
		reader.close();
	});

	it("retries on a timer with backoff, one timer per database", async () => {
		vi.useFakeTimers();
		try {
			let runs = 0;
			const retry = async () => {
				runs++;
			};
			scheduleCleanupRetry(target, 1, retry);
			scheduleCleanupRetry(target, 1, retry);
			await vi.advanceTimersByTimeAsync(4_999);
			expect(runs).toBe(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(runs).toBe(1);
			scheduleCleanupRetry(target, 2, retry);
			await vi.advanceTimersByTimeAsync(14_999);
			expect(runs).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(runs).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

const CHILD = resolve(__dirname, "fixtures", "cleanup-child.mjs");
const intents = () =>
	readdirSync(target.base).filter((f) => f.startsWith("cleanup-intent-"));

describe("a crash between a call's deletion and its marker", () => {
	it("leaves the call's intent, which the next start adopts: pending, refused past the grace period, finished once the reader closes", () => {
		const reader = holdReader();
		// Another OfferFinch process makes a call and dies right after deleting its rows, while
		// the reader keeps the truncating checkpoint from finishing.
		const child = spawnSync(
			process.execPath,
			[CHILD, "crash", JSON.stringify(target), "ses_crash"],
			{ env: { ...process.env, PROMPT_CANARY: PROMPT }, encoding: "utf8" },
		);
		expect(child.status, child.stderr).toBe(1);
		expect(count("session_v2")).toBe(0);
		expect(filesWithPrompt()).toContain("opencode.db-wal");
		// No marker was written, but the intent is still there.
		expect(readPendingCleanup(target)).toBeNull();
		expect(intents()).toHaveLength(1);
		expect(cleanupDue(target, now)).toBe(true);

		// The next start: the intent becomes the unfinished cleanup, whose checkpoint is still busy.
		const start = new Date();
		const first = attemptCleanup(target, {
			idle: true,
			now: start,
			start: true,
		});
		expect(first.result).toMatchObject({ rows: 0, busy: 1, clean: false });
		expect(first.pending).toMatchObject({ rowsLeft: false, attempts: 1 });
		expect(readPendingCleanup(target)).toEqual(first.pending);
		expect(intents()).toEqual([]);
		expect(filesWithPrompt()).toContain("opencode.db-wal");
		// Calls are refused once the grace period is over (counted from the crashed call).
		const late = new Date(start.getTime() + CLEANUP_GRACE_MS);
		const retry = attemptCleanup(target, { idle: true, now: late });
		expect(retry.pending).not.toBeNull();
		expect(cleanupOverdue(retry.pending, late)).toBe(true);

		reader.prepare("COMMIT").run();
		reader.close();
		const done = attemptCleanup(target, { idle: true, now: late });
		expect(done.pending).toBeNull();
		expect(readPendingCleanup(target)).toBeNull();
		expect(filesWithPrompt()).toEqual([]);
	}, 30_000);

	it("never sweeps the session of a call another live process is running, and that call cleans up after itself", async () => {
		const child = spawn(
			process.execPath,
			[CHILD, "overlap", JSON.stringify(target), "ses_other"],
			{ env: { ...process.env, PROMPT_CANARY: PROMPT } },
		);
		let out = "";
		const line = (n: number) =>
			new Promise<string>((done, fail) => {
				child.stdout.on("data", (chunk) => {
					out += String(chunk);
					const lines = out.split("\n").filter(Boolean);
					if (lines.length >= n) done(lines[n - 1] as string);
				});
				child.once("exit", (code) => fail(new Error(`child exited ${code}`)));
			});
		try {
			expect(await line(1)).toBe("ready");
			expect(intents()).toHaveLength(1);
			// This process starts while the other one's call runs: only the checkpoint.
			const start = attemptCleanup(target, {
				idle: true,
				now: new Date(),
				start: true,
			});
			expect(start.result?.rows).toBe(0);
			expect(count("session_v2")).toBe(1);
			expect(start.pending).toBeNull();
			expect(intents()).toHaveLength(1);
			child.stdin.write("finish\n");
			const finished = JSON.parse(await line(2));
			expect(finished.scrub).toMatchObject({ clean: true });
			expect(finished.pending).toBeNull();
		} finally {
			child.kill();
		}
		expect(count("session_v2")).toBe(0);
		expect(intents()).toEqual([]);
		expect(readPendingCleanup(target)).toBeNull();
		expect(filesWithPrompt()).toEqual([]);
	}, 30_000);

	it("removes a finished call's intent, and keeps the marker before the intent goes when the checkpoint is busy", () => {
		const call = beginCall(target, now);
		expect(intents()).toHaveLength(1);
		addSession("ses_ok");
		const ok = finishCall(target, call, "ses_ok", { idle: false, now });
		expect(ok.scrub).toMatchObject({ clean: true });
		expect(ok.pending).toBeNull();
		expect(intents()).toEqual([]);

		const reader = holdReader();
		const busy = beginCall(target, now);
		addSession("ses_busy");
		let seen: { marker: unknown; intents: number } | null = null;
		const unfinished = finishCall(target, busy, "ses_busy", {
			idle: false,
			now,
			afterDelete: () => {
				seen = {
					marker: readPendingCleanup(target),
					intents: intents().length,
				};
			},
		});
		// Between the deletion and the marker, the intent alone holds the debt.
		expect(seen).toEqual({ marker: null, intents: 1 });
		expect(unfinished.pending).toMatchObject({ rowsLeft: false });
		expect(readPendingCleanup(target)).not.toBeNull();
		expect(intents()).toEqual([]);
		reader.close();
	}, 30_000);

	it("adopts at once the intent a call of this process left when its cleanup threw before the marker", () => {
		const reader = holdReader();
		const call = beginCall(target, now);
		addSession("ses_throw");
		expect(cleanupDue(target, now)).toBe(false);
		expect(() =>
			finishCall(target, call, "ses_throw", {
				idle: true,
				now,
				afterDelete: () => {
					throw new Error("disk full");
				},
			}),
		).toThrow("disk full");
		expect(readPendingCleanup(target)).toBeNull();
		expect(intents()).toHaveLength(1);
		expect(filesWithPrompt()).toContain("opencode.db-wal");
		// Same process, no restart: the next call sees the cleanup due, and past the grace period
		// it is refused.
		expect(cleanupDue(target, now)).toBe(true);
		const late = new Date(now.getTime() + CLEANUP_GRACE_MS);
		const retry = attemptCleanup(target, { idle: true, now: late });
		expect(retry.pending).toMatchObject({ since: now.toISOString() });
		expect(cleanupOverdue(retry.pending, late)).toBe(true);
		expect(intents()).toEqual([]);
		reader.close();
		expect(
			attemptCleanup(target, { idle: true, now: late }).pending,
		).toBeNull();
		expect(filesWithPrompt()).toEqual([]);
	}, 30_000);

	it("removes an intent with no session (no prompt was sent) and leaves no marker", () => {
		const call = beginCall(target, now);
		expect(
			finishCall(target, call, null, { idle: true, now }).pending,
		).toBeNull();
		expect(intents()).toEqual([]);
		expect(readPendingCleanup(target)).toBeNull();
	});
});

describe("an unknown state at start", () => {
	it("marks a checkpoint that cannot finish when OfferFinch's project is in the database, with no marker or intent", () => {
		const reader = holdReader();
		const service = new Database(target.dbFile);
		service
			.prepare("INSERT INTO project (id, worktree) VALUES ('p', '/Users/me/p')")
			.run();
		service.close();
		const start = attemptCleanup(target, { idle: true, now, start: true });
		expect(start.result).toMatchObject({ rows: 0, busy: 1, projects: 1 });
		expect(start.pending).toMatchObject({
			since: now.toISOString(),
			rowsLeft: false,
		});
		reader.close();
		expect(attemptCleanup(target, { idle: true, now }).pending).toBeNull();
	});

	it("does not mark it when OfferFinch never used this database (no project of its own)", () => {
		const db = new Database(target.dbFile);
		db.prepare("DELETE FROM project WHERE id = 'ours'").run();
		db.close();
		const reader = holdReader();
		const service = new Database(target.dbFile);
		service
			.prepare("INSERT INTO project (id, worktree) VALUES ('p', '/Users/me/p')")
			.run();
		service.close();
		const start = attemptCleanup(target, { idle: true, now, start: true });
		expect(start.result).toMatchObject({ busy: 1, projects: 0 });
		expect(start.pending).toBeNull();
		reader.close();
	});
});

/**
 * Finding: start treated "no project row of OfferFinch's" as proof nothing was owed. A call's
 * scrub ran while a reader blocked the checkpoint, its intent and marker were gone (an older
 * build, or a lost file), then the project row was deleted: start found projects 0, busy 1 and
 * marked nothing, with the prompt still in the WAL. The use record says OfferFinch ran calls.
 */
describe("a database OfferFinch has used, with its project row gone", () => {
	it("marks a checkpoint that cannot finish at start, and finishes once the reader closes", () => {
		const reader = holdReader();
		const call = beginCall(target, now);
		addSession("ses_gone");
		const scrub = scrubOpenCodeSessions(target.dbFile, ["ses_gone"], {
			busyTimeoutMs: 50,
		});
		expect(scrub).toMatchObject({ busy: 1, clean: false });
		// No intent, no marker, no project row: nothing in the database says OfferFinch was here.
		rmSync(call.file);
		const db = new Database(target.dbFile);
		db.prepare("DELETE FROM project WHERE id = 'ours'").run();
		db.close();
		expect(intents()).toEqual([]);
		expect(readPendingCleanup(target)).toBeNull();
		expect(count("session_v2")).toBe(0);
		expect(filesWithPrompt()).toContain("opencode.db-wal");

		const start = attemptCleanup(target, { idle: true, now, start: true });
		expect(start.result).toMatchObject({ rows: 0, busy: 1, projects: 0 });
		expect(start.pending).toMatchObject({ since: now.toISOString() });
		expect(readPendingCleanup(target)).not.toBeNull();
		expect(filesWithPrompt()).toContain("opencode.db-wal");

		reader.prepare("COMMIT").run();
		reader.close();
		expect(attemptCleanup(target, { idle: true, now }).pending).toBeNull();
		expect(readPendingCleanup(target)).toBeNull();
		expect(filesWithPrompt()).toEqual([]);
	}, 30_000);
});

/**
 * Finding: another process could publish its intent and create its session after a sweep checked
 * the intents and before it deleted (foreign call alive, its session swept). The lock is held
 * across both, so a call starting then waits until the sweep is done.
 */
describe("a call another process starts while a sweep runs", () => {
	const wait = (ms: number) =>
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	/** Anything of the lock but its own file (SQLite's journal, a temporary file). */
	const lockLeftovers = () =>
		readdirSync(target.base).filter(
			(f) => f.startsWith("cleanup-lock-") && !f.endsWith(".sqlite"),
		);

	it("waits for the sweep: its session is never deleted", async () => {
		addSession("ses_left");
		const started = join(target.base, "racer-started");
		const inserted = join(target.base, "racer-inserted");
		let child: ReturnType<typeof spawn> | null = null;
		let exited: Promise<number | null> | null = null;
		const attempt = attemptCleanup(target, {
			idle: true,
			now: new Date(),
			start: true,
			beforeSweep: () => {
				// Intents checked, nothing deleted yet: the other process starts its call now.
				child = spawn(
					process.execPath,
					[CHILD, "racer", JSON.stringify(target), "ses_race"],
					{ env: { ...process.env, PROMPT_CANARY: PROMPT }, stdio: "ignore" },
				);
				const spawned = child;
				exited = new Promise((done) => spawned.once("exit", done));
				const deadline = Date.now() + 15_000;
				while (!existsSync(started) && Date.now() < deadline) wait(10);
				expect(existsSync(started)).toBe(true);
				// Long enough for it to publish its intent and write its session, were it not waiting.
				const settle = Date.now() + 1500;
				while (!existsSync(inserted) && Date.now() < settle) wait(10);
			},
		});
		expect(await exited).toBe(0);
		// Only the session that was there before the sweep; the other call's is intact.
		expect(attempt.result?.rows).toBeGreaterThan(0);
		const db = new Database(target.dbFile, { readonly: true });
		const ids = db.prepare("SELECT id FROM session_v2").all();
		db.close();
		expect(ids).toEqual([{ id: "ses_race" }]);
		expect(lockLeftovers()).toEqual([]);
	}, 30_000);

	it("refuses a call while another process holds the lock, only checkpoints, and is free the moment that process dies", async () => {
		addSession("ses_held");
		const holder = spawn(process.execPath, [
			CHILD,
			"hold",
			JSON.stringify(target),
		]);
		const exited = new Promise<unknown>((done) => holder.once("exit", done));
		try {
			await new Promise<void>((done, fail) => {
				let out = "";
				holder.stdout.on("data", (chunk) => {
					out += String(chunk);
					if (out.includes("held")) done();
				});
				holder.once("exit", (code) => fail(new Error(`holder exited ${code}`)));
			});

			// A sweep does not wait for it: only the checkpoint, the session kept.
			let began = Date.now();
			const held = attemptCleanup(target, { idle: true, now: new Date() });
			expect(Date.now() - began).toBeLessThan(1_000);
			expect(held.result?.rows).toBe(0);
			expect(count("session_v2")).toBe(1);

			// A call waits its 5 s, then is refused, with no intent published.
			began = Date.now();
			expect(() => beginCall(target, now)).toThrow(CleanupLockBusyError);
			expect(Date.now() - began).toBeGreaterThanOrEqual(4_900);
			expect(intents()).toEqual([]);
		} finally {
			holder.kill("SIGKILL");
		}
		await exited;

		// The operating system released it with the process: nothing to take over, no wait.
		const began = Date.now();
		const intent = beginCall(target, now);
		expect(Date.now() - began).toBeLessThan(1_000);
		finishCall(target, intent, null, { idle: true, now });
		const swept = attemptCleanup(target, { idle: true, now: new Date() });
		expect(swept.result?.rows).toBeGreaterThan(0);
		expect(count("session_v2")).toBe(0);
		expect(lockLeftovers()).toEqual([]);
	}, 30_000);
});

/**
 * Finding: a file the cleanup could not read was taken for missing (or, for the lock, spun on
 * synchronously with no deadline). Only a missing file is missing: anything else refuses the
 * call at once, and nothing is swept, adopted or cleared on its account.
 */
describe.skipIf(process.getuid?.() === 0)(
	"a cleanup file that cannot be read",
	() => {
		const locked: string[] = [];
		const lock = (path: string) => {
			chmodSync(path, 0o000);
			locked.push(path);
		};
		afterEach(() => {
			for (const path of locked.splice(0))
				if (existsSync(path)) chmodSync(path, 0o700);
		});
		const quickly = <T>(run: () => T): T => {
			const began = Date.now();
			try {
				return run();
			} finally {
				expect(Date.now() - began).toBeLessThan(1_000);
			}
		};

		it("the lock's file: the call is refused at once, the sweep only checkpoints", () => {
			addSession("ses_kept");
			// Takes and gives back the lock once, so its file is there.
			finishCall(target, beginCall(target, now), null, { idle: true, now });
			const [file] = readdirSync(target.base).filter((f) =>
				f.startsWith("cleanup-lock-"),
			);
			lock(join(target.base, file as string));
			expect(() => quickly(() => beginCall(target, now))).toThrow(
				CleanupFileError,
			);
			expect(intents()).toEqual([]);
			const attempt = quickly(() =>
				attemptCleanup(target, { idle: true, now: new Date() }),
			);
			expect(attempt.result?.rows).toBe(0);
			expect(count("session_v2")).toBe(1);
		});

		it("an intent: never adopted, removed or swept past; calls refused", () => {
			addSession("ses_running");
			const intent = beginCall(target, now);
			const [file] = intents();
			lock(join(target.base, file as string));
			expect(() => quickly(() => cleanupDue(target, now))).toThrow(
				CleanupFileError,
			);
			expect(() =>
				quickly(() => attemptCleanup(target, { idle: true, now: new Date() })),
			).toThrow(CleanupFileError);
			expect(count("session_v2")).toBe(1);
			expect(intents()).toHaveLength(1);
			expect(readPendingCleanup(target)).toBeNull();
			chmodSync(join(target.base, file as string), 0o600);
			finishCall(target, intent, null, { idle: true, now });
		});

		it("the marker: counts as overdue, and stays while the checkpoint cannot finish", () => {
			const reader = holdReader();
			try {
				addSession("ses_left");
				const scrub = scrubOpenCodeSessions(target.dbFile, ["ses_left"], {
					busyTimeoutMs: 50,
				});
				afterScrub(target, { result: scrub, error: null }, { idle: true, now });
				const marker = readdirSync(target.base).find((f) =>
					f.startsWith("cleanup-pending-"),
				) as string;
				lock(join(target.base, marker));
				expect(cleanupOverdue(readPendingCleanup(target), now)).toBe(true);
				expect(cleanupDue(target, now)).toBe(true);
				const retry = attemptCleanup(target, { idle: true, now });
				expect(cleanupOverdue(retry.pending, now)).toBe(true);
			} finally {
				reader.prepare("COMMIT").run();
				reader.close();
			}
		});

		it("OfferFinch's folder: the call is refused at once, and the sweep finds nothing to clear", () => {
			const intent = beginCall(target, now);
			finishCall(target, intent, null, { idle: true, now });
			lock(target.base);
			expect(() => quickly(() => beginCall(target, now))).toThrow(
				CleanupFileError,
			);
			expect(() =>
				quickly(() => attemptCleanup(target, { idle: true, now: new Date() })),
			).toThrow(CleanupFileError);
		});

		it("OfferFinch's folder, with OpenCode's database gone: fixed words, no path", () => {
			for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"])
				rmSync(join(dir, "data", name), { force: true });
			lock(target.base);
			const error = (() => {
				try {
					attemptCleanup(target, { idle: true, now });
				} catch (caught) {
					return caught;
				}
			})();
			expect(error).toBeInstanceOf(CleanupFileError);
			expect(String(error)).not.toContain(dir);
		});

		it("the folder of OpenCode's database: its debt is kept, not cleared as if the database were gone", () => {
			// A call's scrub failed: a marker is due.
			afterScrub(
				target,
				{ result: null, error: "database is locked" },
				{ idle: true, now },
			);
			expect(readPendingCleanup(target)).not.toBeNull();
			lock(join(dir, "data"));
			expect(() =>
				quickly(() => attemptCleanup(target, { idle: true, now: new Date() })),
			).toThrow(CleanupFileError);
			chmodSync(join(dir, "data"), 0o700);
			expect(readPendingCleanup(target)).not.toBeNull();
		});
	},
);
