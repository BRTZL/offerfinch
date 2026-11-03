import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	DB_FILE,
	EARLIER_DB_FILE,
	type MoveDeps,
	moveDatabaseOnce,
} from "../src/main/database-file";

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), "of-dbmove-"));
const deps = (extra: Partial<MoveDeps> = {}): MoveDeps => ({
	open: (file, readonly) => new Database(file, { readonly }),
	log: () => {},
	now: () => new Date("2026-11-02T00:00:00Z"),
	...extra,
});

/** A database under the earlier name, with rows still only in its write-ahead log. */
function earlierDatabase(dir: string) {
	const db = new Database(path.join(dir, EARLIER_DB_FILE));
	db.pragma("journal_mode = WAL");
	db.pragma("wal_autocheckpoint = 0");
	db.exec("create table jobs (id integer primary key, title text)");
	const insert = db.prepare("insert into jobs (title) values (?)");
	for (let i = 0; i < 500; i++) insert.run(`Job ${i}`);
	// Left open: the rows are in -wal, not yet in the main file.
	return db;
}

const count = (file: string) => {
	const db = new Database(file, { readonly: true });
	try {
		return (db.prepare("select count(*) as n from jobs").get() as { n: number })
			.n;
	} finally {
		db.close();
	}
};

describe("moving the database to its current name", () => {
	it("moves every row, including those only in the WAL, and keeps the old files", async () => {
		const dir = folder();
		const writer = earlierDatabase(dir);
		expect(
			fs.statSync(path.join(dir, `${EARLIER_DB_FILE}-wal`)).size,
		).toBeGreaterThan(0);
		writer.close();
		const file = await moveDatabaseOnce(dir, deps());
		expect(file).toBe(path.join(dir, DB_FILE));
		expect(count(file)).toBe(500);
		expect(fs.existsSync(path.join(dir, EARLIER_DB_FILE))).toBe(false);
		expect(
			fs.existsSync(path.join(dir, `${EARLIER_DB_FILE}.moved-2026-11-02`)),
		).toBe(true);
		expect(count(path.join(dir, `${EARLIER_DB_FILE}.moved-2026-11-02`))).toBe(
			500,
		);
	});

	it("does nothing on a fresh folder or once moved", async () => {
		const dir = folder();
		expect(await moveDatabaseOnce(dir, deps())).toBe(path.join(dir, DB_FILE));
		earlierDatabase(dir).close();
		await moveDatabaseOnce(dir, deps());
		const again = await moveDatabaseOnce(dir, deps());
		expect(again).toBe(path.join(dir, DB_FILE));
		expect(count(again)).toBe(500);
	});

	for (const step of ["copied", "verified", "renamed"] as const)
		it(`survives a crash after the copy is ${step}`, async () => {
			const dir = folder();
			earlierDatabase(dir).close();
			const crash = (at: string) => {
				if (at === step) throw new Error("crash");
			};
			// A crash inside the move: the old database stays usable, nothing is lost.
			await moveDatabaseOnce(dir, deps({ crash })).catch(() => {});
			const usable = fs.existsSync(path.join(dir, DB_FILE))
				? path.join(dir, DB_FILE)
				: path.join(dir, EARLIER_DB_FILE);
			expect(count(usable)).toBe(500);
			// The next start finishes (or has finished) the move.
			const file = await moveDatabaseOnce(dir, deps());
			expect(file).toBe(path.join(dir, DB_FILE));
			expect(count(file)).toBe(500);
			expect(fs.existsSync(path.join(dir, `${DB_FILE}.partial`))).toBe(false);
		});

	it("keeps using the earlier file when the copy does not check out", async () => {
		const dir = folder();
		earlierDatabase(dir).close();
		const file = await moveDatabaseOnce(
			dir,
			deps({
				open: (f, readonly) => {
					const db = new Database(f, { readonly });
					if (f.endsWith(".partial"))
						return Object.assign(db, {
							pragma: () => "*** database is corrupt",
						}) as never;
					return db;
				},
			}),
		);
		expect(file).toBe(path.join(dir, EARLIER_DB_FILE));
		expect(count(file)).toBe(500);
		expect(fs.existsSync(path.join(dir, DB_FILE))).toBe(false);
	});
});
