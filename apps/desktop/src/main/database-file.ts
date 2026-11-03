import fs from "node:fs";
import path from "node:path";

/** The database, in the app's data folder. */
export const DB_FILE = "offerfinch.sqlite";

/**
 * The name builds up to 0.1.0 gave it (the project's working name). Read once, to move the
 * database to DB_FILE; the only reason the old name is still in the code.
 */
export const EARLIER_DB_FILE = "job-pipeline.sqlite";

/** What the move needs from SQLite (better-sqlite3 in the app, the same in tests). */
interface MoveDb {
	pragma(source: string, options?: { simple?: boolean }): unknown;
	prepare(sql: string): { all(): unknown[]; get(): unknown };
	backup(destination: string): Promise<unknown>;
	close(): void;
}

export interface MoveDeps {
	open: (file: string, readonly: boolean) => MoveDb;
	log: (message: string, data?: unknown) => void;
	/** Tests only: stop the process at a step, as a crash would. */
	crash?: (step: "copied" | "verified" | "renamed") => void;
	now?: () => Date;
}

function rowCounts(db: MoveDb): Record<string, number> {
	const tables = db
		.prepare(
			"select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
		)
		.all() as { name: string }[];
	const counts: Record<string, number> = {};
	for (const { name } of tables)
		counts[name] = (
			db
				.prepare(`select count(*) as n from "${name.replaceAll('"', '""')}"`)
				.get() as {
				n: number;
			}
		).n;
	return counts;
}

/**
 * Moves the database to its current name once, never losing it: the old file's WAL is folded
 * in, a copy is made with SQLite's backup API, the copy must pass `integrity_check` and hold
 * the same rows in every table, and only then is it put in place. The old files are renamed
 * aside (`….moved-<date>`), never deleted. Any failure leaves the old database in use.
 * Returns the file to open.
 */
export async function moveDatabaseOnce(
	userData: string,
	deps: MoveDeps,
): Promise<string> {
	const current = path.join(userData, DB_FILE);
	const earlier = path.join(userData, EARLIER_DB_FILE);
	const partial = `${current}.partial`;
	if (fs.existsSync(current) || !fs.existsSync(earlier)) {
		fs.rmSync(partial, { force: true });
		return current;
	}
	fs.rmSync(partial, { force: true });
	try {
		const source = deps.open(earlier, false);
		let before: Record<string, number>;
		try {
			// Fold the write-ahead log into the file, so the copy has every committed row.
			source.pragma("wal_checkpoint(TRUNCATE)");
			before = rowCounts(source);
			await source.backup(partial);
		} finally {
			source.close();
		}
		deps.crash?.("copied");
		const copy = deps.open(partial, true);
		try {
			const integrity = copy.pragma("integrity_check", { simple: true });
			if (integrity !== "ok") throw new Error(`integrity_check: ${integrity}`);
			const after = rowCounts(copy);
			if (JSON.stringify(after) !== JSON.stringify(before))
				throw new Error("row counts differ after the copy");
		} finally {
			copy.close();
		}
		deps.crash?.("verified");
		fs.renameSync(partial, current);
		deps.crash?.("renamed");
		const stamp = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
		for (const suffix of ["", "-wal", "-shm"]) {
			const file = `${earlier}${suffix}`;
			if (fs.existsSync(file)) fs.renameSync(file, `${file}.moved-${stamp}`);
		}
		deps.log("database moved to its current name", {
			from: EARLIER_DB_FILE,
			to: DB_FILE,
			tables: Object.keys(before).length,
		});
		return current;
	} catch (error) {
		fs.rmSync(partial, { force: true });
		deps.log("database left under its earlier name", String(error));
		return earlier;
	}
}
