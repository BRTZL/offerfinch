import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import {
	type Database,
	ensureUser,
	openSqlite,
	saveFilterSettings,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { describe, expect, it } from "vitest";
import {
	type JobSearchWorker,
	refilterAndWake,
} from "../src/worker/job-search";

async function worker(): Promise<JobSearchWorker & { lines: unknown[] }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-job-search-"));
	const db: Database = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, { id: "u1", name: "U", email: "u1@example.test" });
	const lines: unknown[] = [];
	return {
		db,
		starter: { sendEvent: async () => {} },
		log: (_level, message, data) => lines.push({ message, data }),
		deps: { llm: new FakeLlmProvider() },
		settings: { get: async () => null, set: async () => {} },
		lines,
	};
}

describe("re-filter passes in the worker", () => {
	it("run one after another, never together, each logging its counts", async () => {
		const w = await worker();
		await saveFilterSettings(w.db, "u1", { livesIn: "Turkey" });
		// What happens, in order: "s" for a read, "L" when a pass logs its end. A pass awaits
		// several reads, so passes running together would interleave theirs.
		const events: string[] = [];
		const db = new Proxy(w.db, {
			get(target, key) {
				if (key === "select") events.push("s");
				return Reflect.get(target, key);
			},
		});
		const tracked: JobSearchWorker = {
			...w,
			db,
			log: (level, message, data) => {
				events.push("L");
				w.log(level, message, data);
			},
		};
		const passes = await Promise.all([
			refilterAndWake(tracked, "u1", "settings"),
			refilterAndWake(tracked, "u1", "settings"),
			refilterAndWake(tracked, "u1", "settings"),
		]);
		expect(passes.every((p) => p.superseded === false)).toBe(true);
		// Each pass's reads, then its log line: never a read of the next before.
		const perPass = events.join("").split("L").filter(Boolean);
		expect(perPass).toHaveLength(3);
		expect(new Set(perPass).size).toBe(1);
		expect(w.lines[0]).toMatchObject({
			message: "job search re-filtered",
			data: { why: "settings", checked: 0, rejected: 0, superseded: false },
		});
	});

	it("keeps going after a failed pass", async () => {
		const w = await worker();
		const broken = {
			...w,
			db: new Proxy(w.db, {
				get(target, key) {
					if (key === "select") throw new Error("disk gone");
					return Reflect.get(target, key);
				},
			}),
		};
		await expect(refilterAndWake(broken, "u1", "settings")).rejects.toThrow(
			"disk gone",
		);
		await expect(refilterAndWake(w, "u1", "settings")).resolves.toMatchObject({
			checked: 0,
		});
	});
});
