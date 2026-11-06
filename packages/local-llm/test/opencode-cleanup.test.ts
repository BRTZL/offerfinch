import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	afterScrub,
	attemptCleanup,
	CLEANUP_GRACE_MS,
	type CleanupTarget,
	cleanupOverdue,
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
