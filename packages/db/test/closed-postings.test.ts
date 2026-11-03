import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedJob } from "@offerfinch/core/domain/types";
import { startPreparingStep } from "@offerfinch/core/pipeline/prepare";
import { FakeLlmProvider } from "@offerfinch/core/scoring/fake";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DashboardRepository,
	type Database,
	DrizzleClosedPostingStore,
	DrizzlePipelineRepository,
	openSqlite,
	reopenPosting,
	seedCompanies,
} from "../src/index";
import { migrate } from "../src/migrate";
import { MIGRATIONS } from "../src/migrations/index";
import { execute, testDb } from "./setup";

let db: Database;
let repo: DashboardRepository;
let store: DrizzleClosedPostingStore;
let companyId = "";

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	store = new DrizzleClosedPostingStore(db);
	await seedCompanies(db, "u1", [
		{
			name: "Acme",
			source: "greenhouse",
			sourceKey: "acmerobotics",
			discoveredFrom: "t",
		},
	]);
	companyId =
		(
			await execute<{ id: string }>(
				db,
				sql`select id from companies where user_id = 'u1'`,
			)
		)[0]?.id ?? "";
});
afterAll(() => db.$close());

const posting = (id: string): NormalizedJob => ({
	source: "greenhouse",
	externalId: id,
	url: `https://boards.greenhouse.io/acmerobotics/jobs/${id}`,
	title: `Engineer ${id}`,
	locations: ["Remote"],
	workplaceType: "remote",
	descriptionText: "React",
});

/** A listed match (scored, nobody acted on it), first seen `daysAgo` days ago. */
async function match(id: string, daysAgo = 0) {
	const { jobId } = await repo.upsertJob("u1", companyId, posting(id));
	const appId =
		(await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
	await repo.transition("u1", appId, {
		from: ["found"],
		to: "scored",
		reason: "t",
		actor: "workflow",
	});
	await db.run(
		sql`update jobs set first_seen_at = ${Date.now() - daysAgo * 86_400_000} where id = ${jobId}`,
	);
	return { jobId, appId };
}

const ids = async (view: "matches" | "closed" | "approved") =>
	(await repo.listApplications("u1", { view })).map((r) => r.id);

describe("closed postings", () => {
	it("a closed match leaves Matches for Closed, says how, and Prepare is refused with the reason", async () => {
		const { jobId, appId } = await match("101");
		expect(await ids("matches")).toContain(appId);

		const closed = await store.recordCheck("u1", jobId, {
			origin: "prepare",
			at: new Date(),
			gone: {
				reason: "Greenhouse no longer lists it (checked before Prepare)",
			},
		});
		expect(closed).toBe(true);
		expect(await ids("matches")).not.toContain(appId);
		expect(await ids("closed")).toContain(appId);
		const counts = await repo.inboxCounts("u1");
		expect(counts.closed).toBeGreaterThanOrEqual(1);
		const row = (await repo.listApplications("u1", { view: "closed" })).find(
			(r) => r.id === appId,
		);
		expect(row?.closedAt).toBeInstanceOf(Date);
		const detail = await repo.getApplication("u1", appId);
		expect(detail?.job.closedReason).toBe(
			"Greenhouse no longer lists it (checked before Prepare)",
		);

		await expect(
			repo.requestPrepare({ userId: "u1", applicationId: appId }),
		).rejects.toThrow(
			/^Refusing: this posting looks closed \(Greenhouse no longer lists it \(checked before Prepare\)\), so Prepare did not start/,
		);
		expect(await repo.prepareRequested("u1", appId)).toBe(false);
	});

	it("It's still open puts it back, and later checks never close it again", async () => {
		const { jobId, appId } = await match("102");
		await store.recordCheck("u1", jobId, {
			origin: "sweep",
			at: new Date(),
			gone: { reason: "Greenhouse no longer lists it" },
		});
		expect(await reopenPosting(db, "u1", appId)).toBe(true);
		expect(await ids("matches")).toContain(appId);
		expect(await ids("closed")).not.toContain(appId);

		expect(
			await store.recordCheck("u1", jobId, {
				origin: "sweep",
				at: new Date(),
				gone: { reason: "Greenhouse no longer lists it" },
			}),
		).toBe(false);
		expect(await ids("matches")).toContain(appId);
		await expect(
			repo.requestPrepare({ userId: "u1", applicationId: appId }),
		).resolves.toBeTruthy();
		expect(
			await reopenPosting(db, "u1", "00000000-0000-4000-8000-000000000000"),
		).toBe(false);
	});

	it("never closes a job whose preparation was requested, and a closed job is never prepared", async () => {
		// The sweep picked it, then the user pressed Prepare before the sweep's answer came.
		const { jobId, appId } = await match("105", 10);
		await repo.requestPrepare({ userId: "u1", applicationId: appId });
		expect(
			await store.recordCheck("u1", jobId, {
				origin: "sweep",
				at: new Date(),
				gone: { reason: "Greenhouse no longer lists it" },
			}),
		).toBe(false);
		const [job] = await execute<{ closed_at: number | null }>(
			db,
			sql`select closed_at from jobs where id = ${jobId}`,
		);
		expect(job?.closed_at).toBeNull();
		expect(await repo.prepareRequested("u1", appId)).toBe(true);

		// A request recorded on a job closed anyway (older data, a direct write): the run that
		// would start drafting reads "not requested", so preparation never starts.
		const other = await match("106");
		await repo.requestPrepare({ userId: "u1", applicationId: other.appId });
		await db.run(
			sql`update jobs set closed_at = ${Date.now()}, closed_reason = 'gone' where id = ${other.jobId}`,
		);
		expect(await repo.prepareRequested("u1", other.appId)).toBe(false);
	});

	it("a check begun before a later Prepare and approval never closes the approved application", async () => {
		// The sweep picks a listed match; meanwhile the user prepares and approves it; then the
		// sweep's answer arrives. Only a check made at the hand-off may close an approved one.
		const { jobId, appId } = await match("107", 10);
		await repo.requestPrepare({ userId: "u1", applicationId: appId });
		await db.run(
			sql`update applications set state = 'approved' where id = ${appId}`,
		);
		for (const origin of ["sweep", "prepare"] as const)
			expect(
				await store.recordCheck("u1", jobId, {
					at: new Date(),
					origin,
					gone: { reason: "Greenhouse no longer lists it" },
				}),
			).toBe(false);
		expect(await ids("approved")).toContain(appId);
		expect(
			await store.recordCheck("u1", jobId, {
				at: new Date(),
				origin: "handoff",
				gone: { reason: "Greenhouse no longer lists it" },
			}),
		).toBe(true);
		// And a hand-off check never closes a listed match.
		const listed = await match("108");
		expect(
			await store.recordCheck("u1", listed.jobId, {
				at: new Date(),
				origin: "handoff",
				gone: { reason: "Greenhouse no longer lists it" },
			}),
		).toBe(false);
	});

	it("the move into preparing refuses a closed posting, even after a replayed 'prepare requested'", async () => {
		// The run's journal says Prepare was requested (recorded before the posting closed), so on
		// replay it goes straight to the step that starts drafting: the database move must refuse.
		const { jobId, appId } = await match("109");
		await repo.requestPrepare({ userId: "u1", applicationId: appId });
		await db.run(
			sql`update jobs set closed_at = ${Date.now()}, closed_reason = 'gone' where id = ${jobId}`,
		);
		const pipeline = new DrizzlePipelineRepository(db);
		const started = await startPreparingStep(
			{
				repo: pipeline,
				sources: {},
				llm: new FakeLlmProvider(),
				notifier: { notifyStrongMatch: async () => {} },
				workflows: {
					runtime: "local",
					startBatch: async () => ({ created: [], existing: [], failed: [] }),
					status: async () => "unknown",
					restart: async () => {},
				},
			},
			"u1",
			jobId,
		);
		expect(started).toBe(false);
		expect(await pipeline.getState("u1", appId)).toBe("scored");
	});

	it("an open answer or an error only records the check time", async () => {
		const { jobId, appId } = await match("103");
		expect(
			await store.recordCheck("u1", jobId, {
				at: new Date(),
				origin: "sweep",
			}),
		).toBe(false);
		expect(await ids("matches")).toContain(appId);
		const [job] = await execute<{
			closed_at: number | null;
			open_checked_at: number | null;
		}>(
			db,
			sql`select closed_at, open_checked_at from jobs where id = ${jobId}`,
		);
		expect(job?.closed_at).toBeNull();
		expect(job?.open_checked_at).not.toBeNull();
	});

	it("an approved application whose posting closed leaves Approved for Closed", async () => {
		const { jobId, appId } = await match("104");
		await db.run(
			sql`update applications set state = 'approved' where id = ${appId}`,
		);
		expect(await ids("approved")).toContain(appId);
		await store.recordCheck("u1", jobId, {
			origin: "handoff",
			at: new Date(),
			gone: { reason: "Greenhouse no longer lists it" },
		});
		expect(await ids("approved")).not.toContain(appId);
		expect(await ids("closed")).toContain(appId);
	});

	it("the sweep picks listed board matches older than a week, never-checked first, up to its limit", async () => {
		const fresh = await match("201", 2);
		const old1 = await match("202", 10);
		const old2 = await match("203", 9);
		const old3 = await match("204", 8);
		const prepared = await match("205", 12);
		await db.run(
			sql`update applications set prepare_requested_at = ${Date.now()} where id = ${prepared.appId}`,
		);
		// Checked an hour ago: not again today.
		await db.run(
			sql`update jobs set open_checked_at = ${Date.now() - 3_600_000} where id = ${old3.jobId}`,
		);
		// Checked two days ago: due, after the never-checked ones.
		await db.run(
			sql`update jobs set open_checked_at = ${Date.now() - 2 * 86_400_000} where id = ${old1.jobId}`,
		);
		const now = Date.now();
		const pick = (limit: number) =>
			store.sweepCandidates("u1", {
				foundBefore: new Date(now - 7 * 86_400_000),
				checkedBefore: new Date(now - 86_400_000),
				limit,
			});
		const all = (await pick(10)).map((j) => j.jobId);
		expect(all).toContain(old2.jobId);
		expect(all).toContain(old1.jobId);
		expect(all.indexOf(old2.jobId)).toBeLessThan(all.indexOf(old1.jobId));
		for (const left of [fresh.jobId, old3.jobId, prepared.jobId])
			expect(all).not.toContain(left);
		expect(await pick(1)).toHaveLength(1);
		const [first] = await pick(1);
		expect(first).toMatchObject({
			source: "greenhouse",
			companyKey: "acmerobotics",
		});
	});
});

describe("closed postings migration", () => {
	it("upgrades a database with jobs: rows kept, the new columns empty", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jp-closed-mig-"));
		const old = openSqlite(path.join(dir, "old.sqlite"));
		const before = MIGRATIONS.filter(
			(m) => !m.name.endsWith("_closed_postings"),
		);
		expect(before).toHaveLength(MIGRATIONS.length - 1);
		await migrate(old, { migrations: before });
		await old.run(
			sql`insert into user (id, name, email, email_verified, created_at, updated_at) values ('u1', 'T', 'u1@example.test', 0, 0, 0)`,
		);
		await old.run(
			sql`insert into companies (id, user_id, name, name_key, source, source_key, status, health, created_at, updated_at) values ('c1', 'u1', 'Acme', 'acme', 'greenhouse', 'acmerobotics', 'active', 'ok', 0, 0)`,
		);
		await old.run(
			sql`insert into jobs (id, user_id, company_id, source, external_id, url, url_normalized, title, locations, first_seen_at, last_seen_at, created_at) values ('j1', 'u1', 'c1', 'greenhouse', '9', 'https://x.example/9', 'x.example/9', 'Engineer', '[]', 5, 5, 5)`,
		);
		const result = await migrate(old);
		expect(result.applied).toEqual([
			MIGRATIONS.find((m) => m.name.endsWith("_closed_postings"))?.name,
		]);
		const rows = await execute<Record<string, unknown>>(
			old,
			sql`select id, title, valid_through, closed_at, closed_reason, open_checked_at, open_confirmed_at from jobs`,
		);
		expect(rows).toEqual([
			{
				id: "j1",
				title: "Engineer",
				valid_through: null,
				closed_at: null,
				closed_reason: null,
				open_checked_at: null,
				open_confirmed_at: null,
			},
		]);
		old.$close();
	});
});
