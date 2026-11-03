import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	addNote,
	currentStages,
	DashboardRepository,
	type Database,
	deleteNote,
	deleteUserData,
	ensureUser,
	exportUserData,
	interviewEvent,
	markReminded,
	moveStage,
	openSqlite,
	seedCompanies,
	sweepTracking,
	trackingFor,
	updateNote,
} from "../src/index";
import { migrate } from "../src/migrate";
import { MIGRATIONS } from "../src/migrations/index";
import { execute, testDb } from "./setup";

const DAY = 86_400_000;
let db: Database;
let repo: DashboardRepository;
let companyId = "";
let n = 0;

beforeAll(async () => {
	db = await testDb();
	repo = new DashboardRepository(db);
	await seedCompanies(db, "u1", [
		{
			name: "Northwind Labs",
			source: "greenhouse",
			sourceKey: "northwind",
			discoveredFrom: "t",
		},
	]);
	const [row] = await execute<{ id: string }>(
		db,
		sql`select id from companies where user_id = 'u1'`,
	);
	companyId = row?.id ?? "";
});
afterAll(() => db.$close());

/** A job the user sent `daysAgo` days before `now`. */
async function applied(daysAgo: number, now = new Date()): Promise<string> {
	n += 1;
	const { jobId } = await repo.upsertJob("u1", companyId, {
		source: "greenhouse",
		externalId: `t-${n}`,
		url: `https://jobs.example.com/${n}`,
		title: `Engineer ${n}`,
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "Go",
	});
	const app = await repo.getApplicationByJob("u1", jobId);
	if (!app) throw new Error("no application");
	const at = now.getTime() - daysAgo * DAY;
	await execute(
		db,
		sql`update applications set state = 'applied', applied_at = ${at}, applied_via = 'manual', state_changed_at = ${at} where id = ${app.applicationId}`,
	);
	return app.applicationId;
}

async function found(): Promise<string> {
	n += 1;
	const { jobId } = await repo.upsertJob("u1", companyId, {
		source: "greenhouse",
		externalId: `t-${n}`,
		url: `https://jobs.example.com/${n}`,
		title: `Engineer ${n}`,
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "Go",
	});
	const app = await repo.getApplicationByJob("u1", jobId);
	if (!app) throw new Error("no application");
	return app.applicationId;
}

describe("the after-applied migration", () => {
	it("upgrades a database with rows in it and keeps them", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-upgrade-"));
		const old = openSqlite(path.join(dir, "old.sqlite"));
		const before = MIGRATIONS.filter((m) => !m.name.endsWith("_after_applied"));
		expect(before.length).toBe(MIGRATIONS.length - 1);
		await migrate(old, { migrations: before });
		await ensureUser(old, {
			id: "u1",
			name: "Test User",
			email: "u1@example.test",
		});
		const now = Date.now();
		old.$client.exec(`
			insert into companies (id, user_id, name, name_key, source, source_key, discovered_from, created_at, updated_at)
				values ('c1', 'u1', 'Northwind Labs', 'northwind labs', 'greenhouse', 'northwind', 't', ${now}, ${now});
			insert into jobs (id, user_id, company_id, source, external_id, url, url_normalized, title, locations, first_seen_at, last_seen_at, created_at)
				values ('j1', 'u1', 'c1', 'greenhouse', 'x1', 'https://jobs.example.com/1', 'jobs.example.com/1', 'Engineer', '[]', ${now}, ${now}, ${now});
			insert into applications (id, user_id, job_id, state, flags, applied_at, applied_via, state_changed_at, created_at, updated_at)
				values ('a1', 'u1', 'j1', 'applied', '[]', ${now}, 'manual', ${now}, ${now}, ${now});
		`);
		const result = await migrate(old, { backupDir: path.join(dir, "backups") });
		expect(result.applied).toEqual(
			MIGRATIONS.filter((m) => !before.includes(m)).map((m) => m.name),
		);
		expect(result.applied.at(-1)).toMatch(/_after_applied$/);
		expect(result.backups).toHaveLength(1);
		expect(
			old.$client
				.prepare("select id, state, applied_via from applications")
				.all(),
		).toEqual([{ id: "a1", state: "applied", applied_via: "manual" }]);
		expect(old.$client.prepare("select title from jobs").all()).toEqual([
			{ title: "Engineer" },
		]);
		// The new tables take rows, and the old application gets its Applied entry on first use.
		const tracked = await trackingFor(old, "u1", "a1");
		expect(tracked.stage).toBe("applied");
		await addNote(old, { userId: "u1", applicationId: "a1", body: "Hi" });
		expect((await trackingFor(old, "u1", "a1")).notes).toHaveLength(1);
		old.$close();
	});
});

describe("stages after Applied", () => {
	it("starts at Applied, dated when it was sent, and moves with dates and rounds", async () => {
		const id = await applied(2);
		const start = await trackingFor(db, "u1", id);
		expect(start.applied).toBe(true);
		expect(start.stage).toBe("applied");
		expect(start.stages).toHaveLength(1);

		await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "heard_back",
			occurredOn: "2026-11-01",
			note: "Recruiter Dana wrote back",
		});
		const first = await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "interviewing",
			interviewAt: "2026-11-10T14:30:00.000Z",
		});
		expect(first.interviewRound).toBe(1);
		const second = await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "interviewing",
		});
		expect(second.interviewRound).toBe(2);
		const now = await trackingFor(db, "u1", id);
		expect(now.stages.map((s) => s.stage)).toEqual([
			"applied",
			"heard_back",
			"interviewing",
			"interviewing",
		]);
		expect(now.stages[1]?.occurredOn).toBe("2026-11-01");
		expect(now.stages.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
		// The move's note belongs to its stage entry.
		expect(now.notes[0]).toMatchObject({
			body: "Recruiter Dana wrote back",
			stageId: now.stages[1]?.id,
		});
		expect((await currentStages(db, "u1")).get(id)).toMatchObject({
			stage: "interviewing",
			round: 2,
		});
	});

	it("refuses the same stage again, a future date, and a job not yet sent", async () => {
		const id = await applied(1);
		await moveStage(db, { userId: "u1", applicationId: id, stage: "offer" });
		await expect(
			moveStage(db, { userId: "u1", applicationId: id, stage: "offer" }),
		).rejects.toThrow(/already at Offer/);
		await expect(
			moveStage(db, {
				userId: "u1",
				applicationId: id,
				stage: "withdrawn",
				occurredOn: "2999-01-01",
			}),
		).rejects.toThrow(/future/);
		const open = await found();
		await expect(
			moveStage(db, { userId: "u1", applicationId: open, stage: "heard_back" }),
		).rejects.toThrow(/only an application you sent/);
		// Its notes still work: private notes are on any job.
		const note = await addNote(db, {
			userId: "u1",
			applicationId: open,
			body: "Referred by Lee",
		});
		expect(note.stageId).toBeNull();
		const tracked = await trackingFor(db, "u1", open);
		expect(tracked).toMatchObject({ applied: false, stage: null, stages: [] });
	});

	it("never changes the application's own state (the Rejected list keeps its meaning)", async () => {
		const id = await applied(1);
		await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "company_rejected",
		});
		const [row] = await execute<{ state: string }>(
			db,
			sql`select state from applications where id = ${id}`,
		);
		expect(row?.state).toBe("applied");
		expect((await repo.listRejected("u1")).some((r) => r.id === id)).toBe(
			false,
		);
	});
});

describe("the follow-up sweep", () => {
	it("reminds once after 7 days, ghosts after 21, and a move back restarts the clock", async () => {
		const now = new Date();
		const fresh = await applied(3, now);
		const quiet = await applied(8, now);
		const silent = await applied(25, now);
		const first = await sweepTracking(db, "u1", now);
		const mine = (ids: string[]) =>
			ids.filter((id) => [fresh, quiet, silent].includes(id));
		expect(mine(first.reminders.map((r) => r.applicationId))).toEqual([quiet]);
		expect(
			first.reminders.find((r) => r.applicationId === quiet),
		).toMatchObject({ company: "Northwind Labs" });
		expect(mine(first.ghosted)).toEqual([silent]);

		// Once per stage entry: once it went out, a later sweep (or a restart) does not repeat it.
		await markReminded(
			db,
			"u1",
			first.reminders.map((r) => r.stageId),
			"shown",
			now,
		);
		const again = await sweepTracking(db, "u1", new Date(now.getTime() + DAY));
		expect(mine(again.reminders.map((r) => r.applicationId))).toEqual([]);
		expect(mine(again.ghosted)).toEqual([]);
		const ghost = await trackingFor(db, "u1", silent);
		expect(ghost.stage).toBe("ghosted");
		expect(ghost.stages.at(-1)?.automatic).toBe(true);

		// Ghosted is reversible: back to Heard back, dated last month, waits from today.
		await moveStage(db, {
			userId: "u1",
			applicationId: silent,
			stage: "heard_back",
			occurredOn: new Date(now.getTime() - 30 * DAY).toISOString().slice(0, 10),
			now,
		});
		const after = await sweepTracking(db, "u1", new Date(now.getTime() + DAY));
		expect(mine(after.ghosted)).toEqual([]);
		expect(mine(after.reminders.map((r) => r.applicationId))).toEqual([]);
		// Its new entry gets its own reminder after 7 more days, then Ghosted after 21.
		const week = await sweepTracking(
			db,
			"u1",
			new Date(now.getTime() + 8 * DAY),
		);
		expect(mine(week.reminders.map((r) => r.applicationId))).toContain(silent);
		const month = await sweepTracking(
			db,
			"u1",
			new Date(now.getTime() + 22 * DAY),
		);
		expect(mine(month.ghosted)).toContain(silent);
	});

	it("leaves Interviewing, Offer and closed stages alone", async () => {
		const now = new Date();
		const id = await applied(40, now);
		await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "interviewing",
			now: new Date(now.getTime() - 30 * DAY),
		});
		const result = await sweepTracking(db, "u1", now);
		expect(result.ghosted).not.toContain(id);
		expect(result.reminders.map((r) => r.applicationId)).not.toContain(id);
	});
});

describe("private notes", () => {
	it("are added, edited and deleted, and go out in the export", async () => {
		const id = await applied(1);
		const note = await addNote(db, {
			userId: "u1",
			applicationId: id,
			body: "  Hiring manager: Pat Example  ",
		});
		expect(note.body).toBe("Hiring manager: Pat Example");
		const tracked = await trackingFor(db, "u1", id);
		expect(note.stageId).toBe(tracked.stages.at(-1)?.id);
		await updateNote(db, { userId: "u1", noteId: note.id, body: "Pat (HM)" });
		await expect(
			addNote(db, { userId: "u1", applicationId: id, body: "   " }),
		).rejects.toThrow(/empty/);
		await expect(
			updateNote(db, { userId: "u2", noteId: note.id, body: "x" }),
		).rejects.toThrow(/Not found/);
		const exported = await exportUserData(
			db,
			{ get: async () => null } as never,
			"u1",
		);
		expect((exported.tables.job_notes ?? []).map((r) => r.body)).toContain(
			"Pat (HM)",
		);
		expect(exported.tables.application_stages?.length).toBeGreaterThan(0);
		await deleteNote(db, { userId: "u1", noteId: note.id });
		expect((await trackingFor(db, "u1", id)).notes).toEqual([]);
	});
});

describe("an interview as a calendar event", () => {
	it("is an .ics with the time and the job link, without notes", async () => {
		const id = await applied(1);
		const stage = await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "interviewing",
			interviewAt: "2026-11-10T14:30:00.000Z",
			note: "PRIVATE-NOTE-TEXT",
		});
		const file = await interviewEvent(db, "u1", stage.id);
		expect(file.name).toBe("interview-northwind-labs-round-1.ics");
		expect(file.text).toContain("DTSTART:20261110T143000Z");
		expect(file.text).toContain("DTEND:20261110T153000Z");
		expect(file.text).toMatch(/URL:https:\/\/jobs\.example\.com\/\d+/);
		expect(file.text).not.toContain("PRIVATE-NOTE-TEXT");
		const plain = await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "offer",
		});
		await expect(interviewEvent(db, "u1", plain.id)).rejects.toThrow(
			/no interview time/,
		);
		await expect(interviewEvent(db, "u2", stage.id)).rejects.toThrow(
			/Not found/,
		);
	});
});

describe("the order of record, not the clock", () => {
	it("a move recorded after the clock went back is the current stage", async () => {
		const id = await applied(1);
		const ten = new Date();
		await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "heard_back",
			now: ten,
		});
		// The Mac's clock goes back a minute; then the offer comes in.
		await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "offer",
			now: new Date(ten.getTime() - 60_000),
		});
		const tracked = await trackingFor(db, "u1", id);
		expect(tracked.stage).toBe("offer");
		expect(tracked.stages.map((s) => s.stage)).toEqual([
			"applied",
			"heard_back",
			"offer",
		]);
		expect((await currentStages(db, "u1")).get(id)?.stage).toBe("offer");
		// An offer is not waiting on the employer: no reminder, no Ghosted, weeks later.
		const later = await sweepTracking(
			db,
			"u1",
			new Date(ten.getTime() + 30 * DAY),
		);
		expect(later.ghosted).not.toContain(id);
		expect(later.reminders.map((r) => r.applicationId)).not.toContain(id);
	});

	it("Not ghosted after the clock went back stays the current stage", async () => {
		const now = new Date();
		const id = await applied(25, now);
		expect((await sweepTracking(db, "u1", now)).ghosted).toContain(id);
		// Undone with the clock an hour behind the automatic Ghosted.
		await moveStage(db, {
			userId: "u1",
			applicationId: id,
			stage: "applied",
			now: new Date(now.getTime() - 3_600_000),
		});
		expect((await trackingFor(db, "u1", id)).stage).toBe("applied");
		expect((await currentStages(db, "u1")).get(id)?.stage).toBe("applied");
		// And the next sweep does not ghost it again: it waits from when it was undone.
		const next = await sweepTracking(db, "u1", new Date(now.getTime() + DAY));
		expect(next.ghosted).not.toContain(id);
	});
});

describe("a reminder lost to a quit or crash", () => {
	it("is due again on the next start until it went out", async () => {
		const now = new Date();
		const id = await applied(8, now);
		const first = await sweepTracking(db, "u1", now);
		const due = first.reminders.find((r) => r.applicationId === id);
		expect(due).toBeDefined();
		// The app quits here: the reminder was only queued in memory, never shown.
		const restart = await sweepTracking(
			db,
			"u1",
			new Date(now.getTime() + 60_000),
		);
		expect(restart.reminders.map((r) => r.applicationId)).toContain(id);
		// Shown: marked, and not due again for this stage entry.
		await markReminded(db, "u1", [due?.stageId ?? ""], "shown", now);
		const after = await sweepTracking(
			db,
			"u1",
			new Date(now.getTime() + 2 * DAY),
		);
		expect(after.reminders.map((r) => r.applicationId)).not.toContain(id);
	});
});

describe("stage days in other time zones", () => {
	const zones = [
		// 09:00 on Nov 3 in Auckland (UTC+13) is 20:00 on Nov 2 in UTC.
		{ zone: "Pacific/Auckland", now: "2026-11-02T20:00:00Z" },
		// 17:00 on Nov 3 in Los Angeles (UTC-8) is 01:00 on Nov 4 in UTC.
		{ zone: "America/Los_Angeles", now: "2026-11-04T01:00:00Z" },
	];
	for (const { zone, now } of zones)
		it(`the day picked is the day kept and the default is today, in ${zone}`, async () => {
			const before = process.env.TZ;
			process.env.TZ = zone;
			try {
				const id = await applied(1, new Date(now));
				const picked = await moveStage(db, {
					userId: "u1",
					applicationId: id,
					stage: "heard_back",
					occurredOn: "2026-11-03",
					now: new Date(now),
				});
				expect(picked.occurredOn).toBe("2026-11-03");
				const today = await moveStage(db, {
					userId: "u1",
					applicationId: id,
					stage: "interviewing",
					now: new Date(now),
				});
				expect(today.occurredOn).toBe("2026-11-03");
				await expect(
					moveStage(db, {
						userId: "u1",
						applicationId: id,
						stage: "offer",
						occurredOn: "2026-11-04",
						now: new Date(now),
					}),
				).rejects.toThrow(/future/);
			} finally {
				process.env.TZ = before;
			}
		});

	it("a job sent with I submitted this keeps its picked day as its Applied day", async () => {
		const before = process.env.TZ;
		process.env.TZ = "Pacific/Auckland";
		try {
			const id = await applied(0);
			// "I submitted this" on Nov 3 stores noon UTC of that day.
			await execute(
				db,
				sql`update applications set applied_at = ${Date.parse("2026-11-03T12:00:00Z")} where id = ${id}`,
			);
			const tracked = await trackingFor(db, "u1", id);
			expect(tracked.stages[0]?.occurredOn).toBe("2026-11-03");
		} finally {
			process.env.TZ = before;
		}
	});
});

describe("erasing the account", () => {
	it("removes every stage and note, foreign keys and all", async () => {
		const own = await testDb();
		const ownRepo = new DashboardRepository(own);
		await seedCompanies(own, "u1", [
			{
				name: "Northwind Labs",
				source: "greenhouse",
				sourceKey: "northwind",
				discoveredFrom: "t",
			},
		]);
		const [company] = await execute<{ id: string }>(
			own,
			sql`select id from companies`,
		);
		const { jobId } = await ownRepo.upsertJob("u1", company?.id ?? "", {
			source: "greenhouse",
			externalId: "erase-1",
			url: "https://jobs.example.com/erase-1",
			title: "Engineer",
			locations: [],
			workplaceType: "remote",
			descriptionText: "",
		});
		const app = await ownRepo.getApplicationByJob("u1", jobId);
		const id = app?.applicationId ?? "";
		await execute(
			own,
			sql`update applications set state = 'applied', applied_at = ${Date.now()}, applied_via = 'manual' where id = ${id}`,
		);
		const stage = await moveStage(own, {
			userId: "u1",
			applicationId: id,
			stage: "interviewing",
		});
		await addNote(own, { userId: "u1", applicationId: id, body: "Pat (HM)" });
		await moveStage(own, {
			userId: "u1",
			applicationId: id,
			stage: "offer",
			note: "Offer by phone",
		});
		expect(stage.seq).toBe(2);
		const count = () =>
			own.$client
				.prepare(
					"select (select count(*) from application_stages) stages, (select count(*) from job_notes) notes",
				)
				.get();
		expect(count()).toEqual({ stages: 3, notes: 2 });
		expect(own.$client.pragma("foreign_keys", { simple: true })).toBe(1);
		// As Settings › Your data › Erase does: files, then the user row (rows cascade).
		await deleteUserData(
			own,
			{ get: async () => null, deletePrefix: async () => 0 } as never,
			{ id: "u1", email: "u1@example.test" },
		);
		own.$client.prepare("delete from user where id = ?").run("u1");
		expect(count()).toEqual({ stages: 0, notes: 0 });
		own.$close();
	});
});

describe("a reminder macOS did not show", () => {
	it("is tried again after a day, not on every sweep", async () => {
		const now = new Date();
		const id = await applied(9, now);
		const due = (await sweepTracking(db, "u1", now)).reminders.find(
			(r) => r.applicationId === id,
		);
		await markReminded(db, "u1", [due?.stageId ?? ""], "not_shown", now);
		const soon = await sweepTracking(
			db,
			"u1",
			new Date(now.getTime() + 3_600_000),
		);
		expect(soon.reminders.map((r) => r.applicationId)).not.toContain(id);
		const tomorrow = await sweepTracking(
			db,
			"u1",
			new Date(now.getTime() + DAY),
		);
		expect(tomorrow.reminders.map((r) => r.applicationId)).toContain(id);
	});
});

describe("two first reads at once", () => {
	it("write one Applied entry and both succeed", async () => {
		const id = await applied(1);
		const [a, b] = await Promise.all([
			trackingFor(db, "u1", id),
			trackingFor(db, "u1", id),
		]);
		expect(a.stages).toHaveLength(1);
		expect(b.stages.map((s) => s.id)).toEqual(a.stages.map((s) => s.id));
	});
});
