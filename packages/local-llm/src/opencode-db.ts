import { statSync } from "node:fs";
import Database from "better-sqlite3";

/**
 * OfferFinch's own connection to the user's OpenCode database (`<data home>/opencode/opencode.db`).
 * Two uses only, both tied to the tested 2.2.5 schema (docs/research/opencode-v2-shared-login.md):
 *
 * - Read, never write, which sources the user signed in to: integration, credential type, method,
 *   whether active, and an OAuth token's expiry. Never a key or token value.
 * - Remove what a call left: the call's session rows, with `secure_delete` and a truncating WAL
 *   checkpoint so the prompt is not left in freed pages or old WAL frames. Another connection
 *   (the user's own OpenCode) holding a read transaction makes the checkpoint report busy and
 *   leaves the old frames, so a result says whether it finished (`clean`); the caller keeps
 *   retrying until it does (opencode-cleanup.ts).
 */

export interface OpenCodeCredential {
	/** The integration (source) it signs in to: `opencode`, `opencode-go`, `zai-coding-plan`, … */
	integration: string;
	type: "oauth" | "key" | "other";
	/** OAuth: how it was made (`device`, `chatgpt-browser`, …). */
	method: string | null;
	/** `false` when another credential of the same integration is the active one. */
	active: boolean;
	/** OAuth: when the access token expires. */
	expiresAt: Date | null;
}

/** The tables the scrub touches, by name, as in 2.2.5. */
const SCHEMA_TABLES = ["session_v2", "event_sequence", "project"] as const;

/** The DB's tables; null when the file cannot be opened. */
function tables(db: Database.Database): Set<string> {
	return new Set(
		(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all() as { name: string }[]
		).map((row) => row.name),
	);
}

/**
 * The user's credentials, without their secrets: only `integration_id`, `active`, `method_id` and
 * the `type` and `expires` fields of the value are selected. Read-only connection.
 */
export function readOpenCodeCredentials(dbFile: string): OpenCodeCredential[] {
	const db = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		db.pragma("busy_timeout = 5000");
		const rows = db
			.prepare(
				`SELECT integration_id AS integration, active,
				        coalesce(method_id, json_extract(value, '$.methodID')) AS method,
				        json_extract(value, '$.type') AS type,
				        json_extract(value, '$.expires') AS expires
				   FROM credential`,
			)
			.all() as {
			integration: string | null;
			active: number | null;
			method: string | null;
			type: string | null;
			expires: number | null;
		}[];
		const byIntegration = new Map<string, typeof rows>();
		for (const row of rows) {
			if (!row.integration) continue;
			byIntegration.set(row.integration, [
				...(byIntegration.get(row.integration) ?? []),
				row,
			]);
		}
		return rows
			.filter((row): row is typeof row & { integration: string } =>
				Boolean(row.integration),
			)
			.map((row) => {
				const siblings = byIntegration.get(row.integration) ?? [];
				// An integration with an active credential uses that one; otherwise every one not
				// marked inactive counts.
				const anyActive = siblings.some((s) => s.active === 1);
				return {
					integration: row.integration,
					type: row.type === "oauth" || row.type === "key" ? row.type : "other",
					method: row.method,
					active: anyActive ? row.active === 1 : row.active !== 0,
					expiresAt:
						typeof row.expires === "number" && row.expires > 0
							? new Date(row.expires)
							: null,
				} satisfies OpenCodeCredential;
			});
	} finally {
		db.close();
	}
}

export interface ScrubResult {
	/** Rows deleted (the session rows and those their foreign keys cascade to). */
	rows: number;
	/** `PRAGMA wal_checkpoint(TRUNCATE)`'s busy flag: 1 when a reader kept old frames. */
	busy: number;
	/**
	 * The checkpoint finished: not busy, every frame copied back, and the `-wal` file empty (or
	 * the database is not in WAL mode). Until then old frames may still hold a deleted prompt.
	 */
	clean: boolean;
	/** The sweep only: how many projects of OfferFinch's it found (0: none of its calls ever ran). */
	projects?: number;
}

export interface ScrubOptions {
	/**
	 * How long to wait for another connection's lock (ms). The connection is synchronous, so this
	 * blocks the caller: short for retries, longer right after a call.
	 */
	busyTimeoutMs?: number;
}

/** Right after a call: the user's service may be writing for a moment. */
const SCRUB_BUSY_TIMEOUT_MS = 5000;

/** A connection that deletes for good: cascades on, freed pages zeroed. */
function scrubConnection(
	dbFile: string,
	options: ScrubOptions = {},
): Database.Database {
	const db = new Database(dbFile, { fileMustExist: true });
	db.pragma(
		`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? SCRUB_BUSY_TIMEOUT_MS))}`,
	);
	db.pragma("foreign_keys = ON");
	db.pragma("secure_delete = ON");
	const have = tables(db);
	const missing = SCHEMA_TABLES.filter((t) => !have.has(t));
	if (missing.length) {
		db.close();
		throw new Error(
			`OpenCode's database does not have the tested shape (missing ${missing.join(", ")})`,
		);
	}
	return db;
}

function deleteSessions(db: Database.Database, ids: string[]): number {
	const legacy = tables(db).has("session");
	const before = db.prepare("SELECT total_changes() AS n").get() as {
		n: number;
	};
	db.transaction(() => {
		for (const id of ids) {
			db.prepare("DELETE FROM session_v2 WHERE id = ?").run(id);
			db.prepare("DELETE FROM event_sequence WHERE aggregate_id = ?").run(id);
			if (legacy) db.prepare("DELETE FROM session WHERE id = ?").run(id);
		}
	}).immediate();
	const after = db.prepare("SELECT total_changes() AS n").get() as {
		n: number;
	};
	return after.n - before.n;
}

/** The `-wal` file's size; 0 when there is none. */
function walBytes(dbFile: string): number {
	try {
		return statSync(`${dbFile}-wal`).size;
	} catch {
		return 0;
	}
}

/** A truncating checkpoint, and whether it finished (see `ScrubResult.clean`). */
function checkpoint(
	db: Database.Database,
	dbFile: string,
): Omit<ScrubResult, "rows"> {
	const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as {
		busy: number;
		log: number;
		checkpointed: number;
	}[];
	const busy = row?.busy ?? 1;
	const log = row?.log ?? 1;
	// Not in WAL mode: log and checkpointed are -1 and there are no frames to keep anything.
	if (log === -1) return { busy, clean: busy === 0 };
	return {
		busy,
		clean:
			busy === 0 &&
			log === row?.checkpointed &&
			log === 0 &&
			walBytes(dbFile) === 0,
	};
}

/**
 * Deletes one call's session (and everything that cascades from it: messages, parts, inbox,
 * instructions, events) after its server exited, then truncates the WAL.
 */
export function scrubOpenCodeSessions(
	dbFile: string,
	sessionIds: string[],
	options: ScrubOptions = {},
): ScrubResult {
	const db = scrubConnection(dbFile, options);
	try {
		const rows = deleteSessions(db, sessionIds);
		return { rows, ...checkpoint(db, dbFile) };
	} finally {
		db.close();
	}
}

/**
 * Only the truncating checkpoint, no deletion: the retry while another OfferFinch call is still
 * running (its session must not be swept from under it).
 */
export function checkpointOpenCodeDb(
	dbFile: string,
	options: ScrubOptions = {},
): ScrubResult {
	const db = scrubConnection(dbFile, options);
	try {
		return { rows: 0, ...checkpoint(db, dbFile) };
	} finally {
		db.close();
	}
}

/**
 * The crash sweep: every session of OfferFinch's own OpenCode project (the one whose worktree is
 * the stable private root's working directory, `cwd` as a real path), left when the app stopped
 * between a prompt and its scrub, then a truncating checkpoint (always, even with nothing to
 * delete). No other project is touched.
 */
export function sweepOpenCodeProject(
	dbFile: string,
	cwd: string,
	options: ScrubOptions = {},
): ScrubResult {
	const db = scrubConnection(dbFile, options);
	try {
		const projects = (
			db.prepare("SELECT id FROM project WHERE worktree = ?").all(cwd) as {
				id: string;
			}[]
		).map((p) => p.id);
		const ids: string[] = [];
		const legacy = tables(db).has("session");
		for (const project of projects) {
			for (const table of legacy ? ["session_v2", "session"] : ["session_v2"])
				ids.push(
					...(
						db
							.prepare(`SELECT id FROM ${table} WHERE project_id = ?`)
							.all(project) as { id: string }[]
					).map((r) => r.id),
				);
		}
		const unique = [...new Set(ids)];
		const rows = unique.length ? deleteSessions(db, unique) : 0;
		// Always checkpoint: a scrub whose checkpoint was busy left its frames behind even though
		// its rows are gone, so "no rows" does not mean "nothing left".
		return { rows, ...checkpoint(db, dbFile), projects: projects.length };
	} finally {
		db.close();
	}
}
