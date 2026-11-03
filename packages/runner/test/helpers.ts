import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Database, ensureUser, openSqlite } from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";

export function tempDbPath(): string {
	return path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "jp-runner-")),
		"runner.sqlite",
	);
}

export async function openTestDb(file = tempDbPath()): Promise<Database> {
	const db = openSqlite(file);
	await migrate(db);
	await ensureUser(db, { id: "u1", name: "Test", email: "u1@example.test" });
	db.$client.exec(
		"create table if not exists probe_log (id integer primary key, run text, entry text, pid integer)",
	);
	return db;
}

export function probeLog(db: Database, run?: string): string[] {
	const rows = db.$client
		.prepare(
			run
				? "select entry from probe_log where run = ? order by id"
				: "select entry from probe_log order by id",
		)
		.all(...(run ? [run] : [])) as { entry: string }[];
	return rows.map((r) => r.entry);
}

export async function until(
	check: () => boolean | Promise<boolean>,
	ms = 10_000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}
