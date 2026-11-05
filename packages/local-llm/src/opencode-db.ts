import Database from "better-sqlite3";

/**
 * OfferFinch's own connection to the user's OpenCode database (`<data home>/opencode/opencode.db`).
 * Two uses only, both tied to the tested 2.2.5 schema (docs/research/opencode-v2-shared-login.md):
 *
 * - Read, never write, which sources the user signed in to: integration, credential type, method,
 *   whether active, and an OAuth token's expiry. Never a key or token value.
 * - Remove what a call left: the call's session rows, with `secure_delete` and a truncating WAL
 *   checkpoint so the prompt is not left in freed pages or old WAL frames.
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
}

/** A connection that deletes for good: cascades on, freed pages zeroed. */
function scrubConnection(dbFile: string): Database.Database {
	const db = new Database(dbFile, { fileMustExist: true });
	db.pragma("busy_timeout = 5000");
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

function checkpoint(db: Database.Database): number {
	const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
	return row?.busy ?? 0;
}

/**
 * Deletes one call's session (and everything that cascades from it: messages, parts, inbox,
 * instructions, events) after its server exited, then truncates the WAL.
 */
export function scrubOpenCodeSessions(
	dbFile: string,
	sessionIds: string[],
): ScrubResult {
	const db = scrubConnection(dbFile);
	try {
		const rows = deleteSessions(db, sessionIds);
		return { rows, busy: checkpoint(db) };
	} finally {
		db.close();
	}
}

/**
 * The crash sweep: every session of OfferFinch's own OpenCode project (the one whose worktree is
 * the stable private root's working directory, `cwd` as a real path), left when the app stopped
 * between a prompt and its scrub. No other project is touched.
 */
export function sweepOpenCodeProject(dbFile: string, cwd: string): ScrubResult {
	const db = scrubConnection(dbFile);
	try {
		const projects = (
			db.prepare("SELECT id FROM project WHERE worktree = ?").all(cwd) as {
				id: string;
			}[]
		).map((p) => p.id);
		if (!projects.length) return { rows: 0, busy: 0 };
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
		if (!unique.length) return { rows: 0, busy: 0 };
		const rows = deleteSessions(db, unique);
		return { rows, busy: checkpoint(db) };
	} finally {
		db.close();
	}
}
