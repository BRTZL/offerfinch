import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SQL } from "drizzle-orm";

import { type Database, ensureUser, openSqlite } from "../src/index";
import { migrate } from "../src/migrate";

/** A migrated database in a fresh temporary file, with user u1. One per test file. */
export async function testDb(): Promise<Database> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jp-sqlite-test-"));
	const db = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, {
		id: "u1",
		name: "Test User",
		email: "u1@example.test",
	});
	return db;
}

/** Postgres' `db.execute(sql)` for raw test queries: the rows as objects. */
export function execute<T = Record<string, unknown>>(
	db: Database,
	query: SQL,
): Promise<T[]> {
	return db.all<Record<string, unknown>>(query) as Promise<T[]>;
}
