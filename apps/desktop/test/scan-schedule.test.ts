import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appSettings, flowRuns } from "@offerfinch/db/schema/jobs";
import { applications, companies, jobs } from "@offerfinch/db/schema/pipeline";
import { SCAN_KIND } from "@offerfinch/runner";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_FILE } from "../src/main/database-file";
import type { NativeNotice } from "../src/shared/worker-protocol";
import { WorkerApp } from "../src/worker/app";
import { seedDemo } from "../src/worker/demo";
import { NoticeBatcher } from "../src/worker/notices";
import {
	DEFAULT_NOTIFICATIONS,
	type ScanSchedule,
} from "../src/worker/settings";

const HOUR = 3_600_000;
const open: WorkerApp[] = [];

afterEach(async () => {
	for (const app of open.splice(0)) await app.stop();
});

/** A worker on a fresh database with a profile (the sample one), its queue never started. */
async function worker(
	userData = fs.mkdtempSync(
		path.join(os.tmpdir(), "offerfinch-scan-schedule-"),
	),
	notified: NativeNotice[] = [],
): Promise<WorkerApp> {
	const app = await WorkerApp.open(
		{
			type: "init",
			userData,
			dbFile: path.join(userData, DB_FILE),
			version: "1.0.0",
			claudeHost: path.join(userData, "no-claude-host.js"),
			// No `noSchedule`: start() is never called, so no timer runs, and nextScan reads as shipped.
			test: { fakeModels: true, fakeClis: true },
		},
		{
			exit: () => {},
			status: () => {},
			notify: (notice) => notified.push(notice),
			site: async () => {
				throw new Error("no site tabs here");
			},
			log: () => {},
		},
	);
	open.push(app);
	await seedDemo(app.db, "1.0.0");
	return app;
}

const clock = (at: Date) =>
	`${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** Quiet hours from an hour ago to an hour from now (local time), so now is inside. */
function quietNow(): ScanSchedule["quietHours"] {
	const now = Date.now();
	return {
		enabled: true,
		start: clock(new Date(now - HOUR)),
		end: clock(new Date(now + HOUR)),
	};
}
const off: ScanSchedule["quietHours"] = {
	enabled: false,
	start: "22:00",
	end: "07:00",
};

const scans = (app: WorkerApp) =>
	app.db
		.select()
		.from(flowRuns)
		.where(eq(flowRuns.kind, SCAN_KIND))
		.orderBy(flowRuns.createdAt);

/** Ends every scan and moves its start `hoursAgo` back, as if it ran then. */
async function finishScans(app: WorkerApp, hoursAgo: number) {
	await app.db
		.update(flowRuns)
		.set({
			status: "complete",
			createdAt: new Date(Date.now() - hoursAgo * HOUR),
		})
		.where(eq(flowRuns.kind, SCAN_KIND));
}

describe("scan schedule", () => {
	it("starts no timer scan in quiet hours, but Scan now still runs", async () => {
		const app = await worker();
		await app.setScanSchedule({ every: 1, quietHours: quietNow() });
		await app.scheduleTick("timer");
		await app.scheduleTick("resume");
		expect(await scans(app)).toHaveLength(0);
		const manual = await app.scanNow();
		expect(manual.started).toBe(true);
		const rows = await scans(app);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.params).toMatchObject({ trigger: "manual" });
		// The control: the same tick with quiet hours off starts one (once the manual one ended).
		await finishScans(app, 2);
		await app.setScanSchedule({ every: 1, quietHours: off });
		await app.scheduleTick("timer");
		expect(await scans(app)).toHaveLength(2);
	});

	it("waits `every` hours after the last scan started, Scan now's included", async () => {
		const app = await worker();
		await app.setScanSchedule({ every: 3, quietHours: off });
		await app.scanNow();
		// Ended half an hour ago: not due (the busy-scan check is not what holds it back).
		await finishScans(app, 0.5);
		await app.scheduleTick("timer");
		expect(await scans(app)).toHaveLength(1);
		await finishScans(app, 2.9);
		await app.scheduleTick("timer");
		expect(await scans(app)).toHaveLength(1);
		await finishScans(app, 3);
		await app.scheduleTick("timer");
		const rows = await scans(app);
		expect(rows).toHaveLength(2);
		expect(rows[1]?.params).toMatchObject({ trigger: "cron" });
		// The clock-hour dedupe still holds: due again by the interval, but this hour's id exists.
		await finishScans(app, 4);
		await app.scheduleTick("timer");
		expect(await scans(app)).toHaveLength(2);
	});

	it("says when the next scan is due, after quiet hours when it falls in them", async () => {
		const app = await worker();
		await app.setScanSchedule({ every: 6, quietHours: off });
		await app.scanNow();
		await finishScans(app, 1);
		const next = await app.nextScan();
		expect(next.note).toBe("Every 6 hours while your Mac is awake");
		const quiet = quietNow();
		// Due in five hours, after these quiet hours end: they do not move it.
		await app.setScanSchedule({ every: 6, quietHours: quiet });
		expect((await app.nextScan()).note).toBe(
			`Every 6 hours while your Mac is awake, outside ${quiet.start}–${quiet.end}`,
		);
		// Due now: it waits for their end.
		await app.setScanSchedule({ every: 1, quietHours: quiet });
		expect((await app.nextScan()).note).toBe(`Quiet hours until ${quiet.end}`);
	});

	it("holds notifications in quiet hours: nothing is read or marked seen until they end", async () => {
		const app = await worker();
		await app.setScanSchedule({ every: 1, quietHours: quietNow() });
		const before = await app.settings.get("noticeWatermark");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await app.collectNotices();
		// The watermark stays: what happened meanwhile is still unannounced, across a restart too.
		expect(await app.settings.get("noticeWatermark")).toBe(before);
		// Turning them off reads what waited at once.
		await app.setScanSchedule({ every: 1, quietHours: off });
		expect(await app.settings.get("noticeWatermark")).toBeGreaterThan(before);
	});

	it("keeps the schedule across a restart of the worker", async () => {
		const app = await worker();
		const saved: ScanSchedule = {
			every: 12,
			quietHours: { enabled: true, start: "21:30", end: "06:45" },
		};
		await app.setScanSchedule(saved);
		await app.stop();
		open.splice(open.indexOf(app), 1);
		const again = await worker(app.init.userData);
		expect(again.getScanSchedule()).toEqual(saved);
	});

	it("sends a notification held by quiet hours once, after a restart, when they end", async () => {
		const notified: NativeNotice[] = [];
		const app = await worker(undefined, notified);
		// The sample data turns notifications off; this user has them on.
		await app.setNotifications(DEFAULT_NOTIFICATIONS);
		// Whatever the sample data alerted at open goes out first, so only the new match is left.
		await app.collectNotices();
		await app.settings.set("heldNotices", []);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const [company] = await app.db
			.insert(companies)
			.values({
				userId: "local",
				name: "Acme",
				nameKey: "acme",
				source: "greenhouse",
				sourceKey: "acme",
			})
			.returning({ id: companies.id });
		const [job] = await app.db
			.insert(jobs)
			.values({
				userId: "local",
				companyId: company?.id as string,
				source: "greenhouse",
				externalId: "1",
				url: "https://example.com/jobs/1",
				urlNormalized: "https://example.com/jobs/1",
				title: "Engineer",
			})
			.returning({ id: jobs.id });
		const [row] = await app.db
			.insert(applications)
			.values({
				userId: "local",
				jobId: job?.id as string,
				state: "scored",
				score: 90,
				alertedAt: new Date(),
			})
			.returning({ id: applications.id });
		if (!row) throw new Error("no application");
		// A match read just before quiet hours start: past the watermark, still waiting (15 s).
		await app.collectNotices();
		const watermark = await app.settings.get("noticeWatermark");
		expect(await app.settings.get("heldNotices")).toEqual([
			expect.objectContaining({ kind: "match", applicationId: row.id }),
		]);
		await app.setScanSchedule({ every: 1, quietHours: quietNow() });
		// The app quits overnight, before it went out. Its held notice's timer stops with it.
		const dispose = vi.spyOn(NoticeBatcher.prototype, "dispose");
		await app.stop();
		open.splice(open.indexOf(app), 1);
		expect(dispose).toHaveBeenCalledTimes(1);
		dispose.mockRestore();
		expect(notified).toEqual([]);

		const after: NativeNotice[] = [];
		const again = await worker(app.init.userData, after);
		await new Promise((resolve) => setTimeout(resolve, 50));
		// Still quiet: it waits.
		expect(after).toEqual([]);
		expect(await again.settings.get("noticeWatermark")).toBe(watermark);
		// Quiet hours end (turned off here): it goes out, once.
		await again.setScanSchedule({ every: 1, quietHours: off });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			kind: "match",
			path: `/applications/${row.id}`,
		});
		// Nothing is left to send again: not kept, and not read again from the database.
		await again.collectNotices();
		expect(await again.settings.get("heldNotices")).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(after).toHaveLength(1);
	});

	it("reads back each schedule field on its own: one bad field keeps the others", async () => {
		const app = await worker();
		const store = async (value: unknown) => {
			await app.db
				.insert(appSettings)
				.values({ key: "scanSchedule", value, updatedAt: new Date() })
				.onConflictDoUpdate({
					target: appSettings.key,
					set: { value, updatedAt: new Date() },
				});
			return app.settings.get("scanSchedule");
		};
		expect(
			await store({
				every: 24,
				quietHours: { enabled: true, start: "bad", end: "08:00" },
			}),
		).toEqual({
			every: 24,
			quietHours: { enabled: true, start: "22:00", end: "08:00" },
		});
		expect(
			await store({
				every: 2,
				quietHours: { enabled: "yes", start: "21:30", end: "06:45" },
			}),
		).toEqual({
			every: 1,
			quietHours: { enabled: false, start: "21:30", end: "06:45" },
		});
		expect(await store({ every: 12, quietHours: "night" })).toEqual({
			every: 12,
			quietHours: { enabled: false, start: "22:00", end: "07:00" },
		});
		expect(await store({ every: 6 })).toEqual({
			every: 6,
			quietHours: { enabled: false, start: "22:00", end: "07:00" },
		});
		expect(await store("hourly")).toEqual({
			every: 1,
			quietHours: { enabled: false, start: "22:00", end: "07:00" },
		});
		// Writes stay strict: a bad field is refused, not quietly fixed.
		await expect(
			app.settings.set("scanSchedule", {
				every: 24,
				quietHours: { enabled: true, start: "bad", end: "08:00" },
			}),
		).rejects.toThrow();
	});
});
