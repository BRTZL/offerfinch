import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { openSqlite } from "../src/client";
import { migrate } from "../src/migrate";

function tempFile(name: string) {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jp-client-")), name);
}

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("one transaction at a time", () => {
	it("keeps concurrent read-then-write transactions from interleaving", async () => {
		const db = openSqlite(tempFile("lock.sqlite"));
		await db.run(sql`create table counter (n integer not null)`);
		await db.run(sql`insert into counter (n) values (0)`);
		// Each transaction reads, yields to the event loop, then writes what it read plus one.
		// Interleaved, they would all read 0 and the counter would end at 1.
		const bump = () =>
			db.transaction(async (tx) => {
				const [row] = await tx.all<{ n: number }>(sql`select n from counter`);
				await tick();
				await tx.run(sql`update counter set n = ${(row?.n ?? 0) + 1}`);
			});
		await Promise.all(Array.from({ length: 10 }, bump));
		const [row] = await db.all<{ n: number }>(sql`select n from counter`);
		expect(row?.n).toBe(10);
		db.$close();
	});

	it("makes a statement outside the transaction wait for its commit", async () => {
		const db = openSqlite(tempFile("wait.sqlite"));
		await db.run(sql`create table t (v text)`);
		const order: string[] = [];
		const tx = db.transaction(async (t) => {
			await t.run(sql`insert into t (v) values ('in-tx')`);
			await tick();
			order.push("tx done");
		});
		const outside = db
			.all<{ n: number }>(sql`select count(*) as n from t`)
			.then((rows) => {
				order.push(`outside saw ${rows[0]?.n}`);
			});
		await Promise.all([tx, outside]);
		expect(order).toEqual(["tx done", "outside saw 1"]);
		db.$close();
	});

	it("rolls back a failed transaction and refuses db.transaction nested inside one", async () => {
		const db = openSqlite(tempFile("rollback.sqlite"));
		await db.run(sql`create table t (v text)`);
		await expect(
			db.transaction(async (t) => {
				await t.run(sql`insert into t (v) values ('x')`);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(
			db.transaction(async () => {
				await db.transaction(async () => {});
			}),
		).rejects.toThrow(/Nested/);
		const rows = await db.all(sql`select * from t`);
		expect(rows).toEqual([]);
		db.$close();
	});

	it("opens in WAL mode with foreign keys on", () => {
		const db = openSqlite(tempFile("wal.sqlite"));
		expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
		expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
		db.$close();
	});
});

describe("migrations", () => {
	it("backs up a database with tables before each migration, and keeps the last few", async () => {
		const file = tempFile("app.sqlite");
		const backups = path.join(path.dirname(file), "backups");
		const db = openSqlite(file);
		const first = await migrate(db, { backupDir: backups });
		// A fresh database needs no backup.
		expect(first.applied.length).toBeGreaterThan(0);
		expect(first.backups).toEqual([]);
		await db.run(
			sql`insert into user (id, name, email, created_at, updated_at) values ('me', 'Me', 'me@localhost.invalid', 0, 0)`,
		);
		let clock = Date.parse("2026-11-01T10:00:00Z");
		for (const n of [1, 2, 3, 4]) {
			const result = await migrate(db, {
				backupDir: backups,
				now: () => new Date(clock++),
				migrations: [
					{
						name: `9999_test_${n}`,
						sql: `alter table user add column extra_${n} text`,
					},
				],
			});
			expect(result.applied).toEqual([`9999_test_${n}`]);
			expect(result.backups).toHaveLength(1);
			// The backup is the database as it was: it has the user, not the new column.
			const copy = openSqlite(result.backups[0] ?? "", { readonly: true });
			const cols = copy.$client
				.prepare("select name from pragma_table_info('user')")
				.all() as { name: string }[];
			expect(cols.map((c) => c.name)).not.toContain(`extra_${n}`);
			expect(copy.$client.prepare("select id from user").all()).toEqual([
				{ id: "me" },
			]);
			copy.$close();
		}
		expect(fs.readdirSync(backups)).toHaveLength(3);
		// Applied migrations are not applied again.
		expect((await migrate(db, { backupDir: backups })).applied).toEqual([]);
		db.$close();
	});

	it("computes every stored company name key again when the key changes", async () => {
		const db = openSqlite(tempFile("keys.sqlite"));
		await migrate(db);
		await db.run(
			sql`insert into user (id, name, email, created_at, updated_at) values ('me', 'Me', 'me@localhost.invalid', 0, 0)`,
		);
		// Keys an earlier version stored: letters of other scripts dropped.
		for (const [id, name] of [
			["c1", "東京Tech"],
			["c2", "大阪Tech"],
			["c3", "Société Générale"],
		])
			await db.run(
				sql`insert into companies (id, user_id, name, name_key, source, source_key, created_at, updated_at) values (${id}, 'me', ${name}, ${name === "Société Générale" ? "societegenerale" : "tech"}, 'greenhouse', ${id}, 0, 0)`,
			);
		db.$client
			.prepare("delete from __migrations where name like 'company_name_key_v%'")
			.run();
		const result = await migrate(db);
		expect(result.applied).toEqual([
			expect.stringMatching(/^company_name_key_v\d+$/),
		]);
		expect(
			db.$client
				.prepare("select id, name_key from companies order by id")
				.all(),
		).toEqual([
			{ id: "c1", name_key: "東京tech" },
			{ id: "c2", name_key: "大阪tech" },
			{ id: "c3", name_key: "societegenerale" },
		]);
		// Once per key version.
		expect((await migrate(db)).applied).toEqual([]);
		db.$close();
	});
});
