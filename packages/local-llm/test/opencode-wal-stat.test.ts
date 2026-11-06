import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCODE_SCHEMA } from "./opencode-schema";

/**
 * Finding: the `-wal` file's size was read as 0 on any error, so a checkpoint whose WAL could not
 * be read (a permission error) reported clean and the cleanup's marker was cleared. Only a
 * missing `-wal` is empty.
 */
const denied = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		statSync: ((path: string, ...rest: unknown[]) => {
			if (denied.on && String(path).endsWith("-wal"))
				throw Object.assign(new Error("EACCES: permission denied"), {
					code: "EACCES",
				});
			return (fs.statSync as (...args: unknown[]) => unknown)(path, ...rest);
		}) as typeof fs.statSync,
	};
});

const { checkpointOpenCodeDb } = await import("../src/opencode-db");

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "offerfinch-wal-stat-"));
	const db = new Database(join(dir, "opencode.db"));
	db.pragma("journal_mode = WAL");
	db.exec(OPENCODE_SCHEMA);
	db.close();
});
afterEach(async () => {
	denied.on = false;
	await rm(dir, { recursive: true, force: true });
});

describe("a checkpoint whose -wal file cannot be read", () => {
	it("is not clean; a missing -wal is", () => {
		const file = join(dir, "opencode.db");
		expect(checkpointOpenCodeDb(file).clean).toBe(true);
		denied.on = true;
		expect(checkpointOpenCodeDb(file).clean).toBe(false);
	});
});
