import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import {
	DashboardRepository,
	type Database,
	ensureUser,
	openSqlite,
	saveFilterSettings,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { call } from "@orpc/server";
import { describe, expect, it } from "vitest";
import {
	type JobSearchWorker,
	jobSearchSettingsRouter,
	upgradeJobSearch,
} from "../src/worker/job-search";

async function worker(): Promise<JobSearchWorker & { lines: unknown[] }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-job-search-"));
	const db: Database = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, { id: "u1", name: "U", email: "u1@example.test" });
	const lines: unknown[] = [];
	return {
		db,
		log: (_level, message, data) => lines.push({ message, data }),
		deps: { llm: new FakeLlmProvider() },
		settings: { get: async () => null, set: async () => {} },
		lines,
	};
}

/** Jobs already here: a found one, a match, one a low score ended and one an old filter set aside. */
async function seed(db: Database) {
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acme",
			discoveredFrom: "t",
		},
	]);
	const repo = new DashboardRepository(db);
	const [company] = db.$client.prepare("select id from companies").all() as {
		id: string;
	}[];
	const states = ["found", "scored", "scored", "rejected_by_filter"];
	for (const [i, state] of states.entries()) {
		const { jobId } = await repo.upsertJob("u1", company?.id ?? "", {
			source: "greenhouse",
			externalId: `j${i}`,
			url: `https://boards.greenhouse.io/acme/jobs/j${i}`,
			title: "Software Engineer",
			locations: ["Owego, NY"],
			workplaceType: "onsite",
			descriptionText: "Must be a US Citizen. TypeScript.",
		});
		const id = (await repo.getApplicationByJob("u1", jobId))?.applicationId;
		db.$client
			.prepare(
				"update applications set state = ?, score = ?, ended_reason = ? where id = ?",
			)
			.run(
				state,
				state === "scored" ? 70 + i : null,
				i === 2 ? "Fit score 72 is below the minimum of 80." : null,
				id,
			);
	}
}

const snapshot = (db: Database) =>
	db.$client
		.prepare(
			"select id, state, score, rank, rank_penalties, filter_result, ended_reason, fit, state_changed_at, prepare_requested_at from applications order by id",
		)
		.all();

const context = (w: JobSearchWorker) =>
	({
		session: { user: { id: "u1", email: "u1@example.test", name: "U" } },
		db: w.db,
	}) as never;

describe("saving Job search", () => {
	it("applies to new jobs only: no job already here is filtered, scored or woken again", async () => {
		const w = await worker();
		await seed(w.db);
		await saveFilterSettings(w.db, "u1", { livesIn: "Türkiye" });
		const before = snapshot(w.db);
		const router = jobSearchSettingsRouter(() => w);
		const saved = await call(
			router.update,
			{
				livesIn: "Japan",
				rightToWork: ["Japan"],
				keepGlobalRemote: false,
				minScore: 90,
				seniority: ["Staff"],
				minSalary: 90000,
				salaryCurrency: "usd",
				avoidIndustries: ["Defense"],
			},
			{ context: context(w) },
		);
		expect(saved).toMatchObject({
			livesIn: "Japan",
			minScore: 90,
			seniority: ["Staff"],
			minSalary: 90000,
			salaryCurrency: "USD",
			avoidIndustries: ["Defense"],
		});
		expect(snapshot(w.db)).toEqual(before);
		const events = w.db.$client
			.prepare("select count(*) n from workflow_events")
			.get() as { n: number };
		expect(events.n).toBe(0);
		expect(await call(router.get, undefined, { context: context(w) })).toEqual(
			saved,
		);
	});
});

describe("the job search upgrade at startup", () => {
	it("fills the location fields once and touches no job", async () => {
		const w = await worker();
		await seed(w.db);
		const before = snapshot(w.db);
		let stored = 1;
		const version = {
			get: async () => stored,
			set: async (v: number) => {
				stored = v;
			},
		};
		expect(await upgradeJobSearch(w, "u1", version)).toBe(true);
		expect(stored).toBe(2);
		expect(await upgradeJobSearch(w, "u1", version)).toBe(false);
		expect(snapshot(w.db)).toEqual(before);
	});
});
