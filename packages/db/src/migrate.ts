import fs from "node:fs";
import path from "node:path";

import {
	COMPANY_NAME_KEY_VERSION,
	companyNameKey,
} from "@offerfinch/core/domain/url";

import type { Database } from "./client";
import { MIGRATIONS } from "./migrations/index";

export interface MigrateOptions {
	/** Where to write a copy of the database before each migration. Unset: no backup. */
	backupDir?: string;
	/** Backups kept, newest first; older ones are deleted. */
	keepBackups?: number;
	migrations?: { name: string; sql: string }[];
	now?: () => Date;
}

export interface MigrateResult {
	applied: string[];
	backups: string[];
}

const LEDGER = "__migrations";

function hasUserTables(db: Database): boolean {
	const row = db.$client
		.prepare(
			`select count(*) as n from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '${LEDGER}'`,
		)
		.get() as { n: number };
	return row.n > 0;
}

function pruneBackups(dir: string, keep: number) {
	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".sqlite") && f.includes("-before-"))
		.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	for (const { f } of files.slice(keep)) fs.rmSync(path.join(dir, f));
}

/**
 * Applies pending migrations in order, each in its own transaction. Before each one, a database
 * that already holds tables is copied with `VACUUM INTO` (a consistent snapshot, WAL included), so a
 * failed or bad migration can be undone by restoring the file. A fresh database needs no backup.
 */
export async function migrate(
	db: Database,
	options: MigrateOptions = {},
): Promise<MigrateResult> {
	const client = db.$client;
	const migrations = options.migrations ?? MIGRATIONS;
	const now = options.now ?? (() => new Date());
	client.exec(
		`create table if not exists ${LEDGER} (name text primary key, applied_at integer not null)`,
	);
	const done = new Set(
		(
			client.prepare(`select name from ${LEDGER}`).all() as { name: string }[]
		).map((r) => r.name),
	);
	const result: MigrateResult = { applied: [], backups: [] };
	// A database that had no tables when this started needs no backup, whatever it applies.
	const fresh = !hasUserTables(db);
	for (const migration of migrations) {
		if (done.has(migration.name)) continue;
		if (options.backupDir && !fresh) {
			fs.mkdirSync(options.backupDir, { recursive: true });
			const stamp = now().toISOString().replace(/[:.]/g, "-");
			const file = path.join(
				options.backupDir,
				`db-before-${migration.name}-${stamp}.sqlite`,
			);
			client.prepare("vacuum into ?").run(file);
			result.backups.push(file);
			pruneBackups(options.backupDir, options.keepBackups ?? 3);
		}
		const statements = migration.sql
			.split("--> statement-breakpoint")
			.map((s) => s.trim())
			.filter(Boolean);
		// Table rebuilds in later migrations need foreign keys off while they run.
		client.pragma("foreign_keys = OFF");
		try {
			client.transaction(() => {
				for (const statement of statements) client.exec(statement);
				client
					.prepare(`insert into ${LEDGER} (name, applied_at) values (?, ?)`)
					.run(migration.name, now().getTime());
				const broken = client.pragma("foreign_key_check") as unknown[];
				if (broken.length > 0)
					throw new Error(
						`Migration ${migration.name} left ${broken.length} rows with broken foreign keys`,
					);
			})();
		} finally {
			client.pragma("foreign_keys = ON");
		}
		result.applied.push(migration.name);
	}
	recomputeCompanyKeys(db, now, done, result);
	return result;
}

/**
 * Company name keys are computed in code (`companyNameKey`), so a change to it is a data
 * migration: once per key version, every stored key is computed again, in one transaction.
 */
function recomputeCompanyKeys(
	db: Database,
	now: () => Date,
	done: Set<string>,
	result: MigrateResult,
) {
	const client = db.$client;
	const step = `company_name_key_v${COMPANY_NAME_KEY_VERSION}`;
	if (done.has(step)) return;
	const table = client
		.prepare(
			"select 1 from sqlite_master where type = 'table' and name = 'companies'",
		)
		.get();
	if (!table) return;
	client.transaction(() => {
		const update = client.prepare(
			"update companies set name_key = ? where id = ?",
		);
		const rows = client
			.prepare("select id, name, name_key from companies")
			.all() as { id: string; name: string; name_key: string }[];
		for (const row of rows) {
			const key = companyNameKey(row.name);
			if (key !== row.name_key) update.run(key, row.id);
		}
		client
			.prepare(`insert into ${LEDGER} (name, applied_at) values (?, ?)`)
			.run(step, now().getTime());
	})();
	result.applied.push(step);
}
