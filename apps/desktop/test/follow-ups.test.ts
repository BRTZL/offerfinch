import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DashboardRepository,
	type Database,
	ensureUser,
	openSqlite,
	seedCompanies,
} from "@offerfinch/db";
import { migrate } from "@offerfinch/db/migrate";
import { describe, expect, it } from "vitest";
import type {
	NativeNotice,
	NoticeOutcome,
} from "../src/shared/worker-protocol";
import { FollowUpDelivery, runFollowUps } from "../src/worker/follow-ups";
import { NoticeBatcher } from "../src/worker/notices";
import { DEFAULT_NOTIFICATIONS } from "../src/worker/settings";

const DAY = 86_400_000;

/** A database with one job the user sent eight days ago. */
async function sentEightDaysAgo(): Promise<{ db: Database; id: string }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-followup-"));
	const db = openSqlite(path.join(dir, "test.sqlite"));
	await migrate(db);
	await ensureUser(db, { id: "u1", name: "Test", email: "u1@example.test" });
	await seedCompanies(db, "u1", [
		{
			name: "Northwind Labs",
			source: "greenhouse",
			sourceKey: "northwind",
			discoveredFrom: "t",
		},
	]);
	const companyId = (
		db.$client.prepare("select id from companies").get() as { id: string }
	).id;
	const repo = new DashboardRepository(db);
	const { jobId } = await repo.upsertJob("u1", companyId, {
		source: "greenhouse",
		externalId: "f1",
		url: "https://jobs.example.com/f1",
		title: "Backend Engineer",
		locations: ["Remote"],
		workplaceType: "remote",
		descriptionText: "Go",
	});
	const id = (await repo.getApplicationByJob("u1", jobId))?.applicationId ?? "";
	db.$client
		.prepare(
			"update applications set state = 'applied', applied_via = 'manual', applied_at = ? where id = ?",
		)
		.run(Date.now() - 8 * DAY, id);
	return { db, id };
}

/**
 * One run of the worker, wired as `WorkerApp` wires it: the batcher on manual timers, follow-ups
 * through `FollowUpDelivery`, and a fake main that answers with `outcome` (what macOS did).
 */
function workerRun(
	db: Database,
	outcome: NoticeOutcome | null = "delivered",
	now = () => new Date(),
) {
	const sent: NativeNotice[] = [];
	const timers: (() => void)[] = [];
	const answers: Promise<void>[] = [];
	const emits: Promise<void>[] = [];
	const delivery = new FollowUpDelivery({
		db,
		userId: "u1",
		// Main shows it and answers; null: the app quits before main answers.
		send: (notice) => {
			sent.push(notice);
			if (outcome && notice.id)
				answers.push(delivery.result(notice.id, outcome));
		},
		log: () => {},
		now,
	});
	const batcher = new NoticeBatcher({
		emit: (notice, items) => {
			emits.push(delivery.emit(notice, items));
		},
		settings: () => DEFAULT_NOTIFICATIONS,
		// The gap between two notifications of a kind is the batcher's, tested in notices.test.ts.
		minGapMs: 0,
		setTimer: (fn) => timers.push(fn),
		clearTimer: () => {},
	});
	return {
		sent,
		sweep: (at?: Date) =>
			runFollowUps({
				db,
				userId: "u1",
				add: (item) => batcher.add(item),
				inFlight: (stageId) => delivery.inFlight(stageId),
				log: () => {},
				now: at,
			}),
		pending: () => batcher.pending(),
		waiting: () => delivery.waiting,
		delivery,
		/** The batcher's quiet time passes: what is queued goes out, and main answers. */
		flush: async () => {
			for (const fn of timers.splice(0)) fn();
			await Promise.all(emits.splice(0));
			await Promise.all(answers);
		},
	};
}

describe("a follow-up reminder and a quit before it went out", () => {
	it("is sent on the next start, then never again for that stage", async () => {
		const { db, id } = await sentEightDaysAgo();

		// Start, the sweep queues the reminder, and the app quits within the batcher's 15 s.
		const first = workerRun(db);
		await first.sweep();
		expect(first.pending()).toBe(1);
		expect(first.sent).toEqual([]);

		// Next start: the reminder is due again and goes out, opening the application.
		const second = workerRun(db);
		await second.sweep();
		await second.flush();
		expect(second.sent).toEqual([
			expect.objectContaining({
				kind: "followup",
				path: `/applied/${id}`,
			}),
		]);

		// Shown: a later start does not remind again for the same stage entry.
		const third = workerRun(db);
		await third.sweep();
		await third.flush();
		expect(third.pending()).toBe(0);
		expect(third.sent).toEqual([]);
		db.$close();
	});
});

describe("a follow-up reminder macOS refused", () => {
	for (const outcome of ["blocked", null] as const)
		it(`stays due when main answers ${outcome ?? "nothing (quit after sending)"}, retried a day later`, async () => {
			const { db } = await sentEightDaysAgo();
			const t = Date.now();
			const run = workerRun(db, outcome, () => new Date(t));
			await run.sweep(new Date(t));
			await run.flush();
			expect(run.sent).toHaveLength(1);

			// An hour later: not again yet when macOS said no (no spam), again after a quit.
			const hour = workerRun(db, "delivered");
			await hour.sweep(new Date(t + 3_600_000));
			expect(hour.pending()).toBe(outcome === null ? 1 : 0);

			// A day later it is due again, and once shown it is done.
			const day = workerRun(db, "delivered");
			await day.sweep(new Date(t + DAY + 60_000));
			expect(day.pending()).toBe(1);
			await day.flush();
			const after = workerRun(db, "delivered");
			await after.sweep(new Date(t + 2 * DAY));
			expect(after.pending()).toBe(0);
			db.$close();
		});
});

describe("a follow-up reminder macOS showed late", () => {
	it("counts as shown when main's 6 s ran out (unknown), and never repeats", async () => {
		const { db } = await sentEightDaysAgo();
		const t = Date.now();
		// Main's Notifier answers unknown after 6 s; macOS shows it a moment later.
		const run = workerRun(db, "unknown", () => new Date(t));
		await run.sweep(new Date(t));
		await run.flush();
		expect(run.sent).toHaveLength(1);
		for (const later of [3_600_000, DAY + 60_000, 7 * DAY]) {
			const next = workerRun(db, "delivered");
			await next.sweep(new Date(t + later));
			expect(next.pending()).toBe(0);
		}
		db.$close();
	});
});

describe("a reminder whose answer never comes", () => {
	it("is not sent again while in flight, and is dropped after a minute", async () => {
		const { db } = await sentEightDaysAgo();
		let t = Date.now();
		const run = workerRun(db, null, () => new Date(t));
		await run.sweep(new Date(t));
		await run.flush();
		// Sweeps while it waits for main's answer: nothing queued again, nothing piles up.
		for (let i = 0; i < 100; i++) {
			await run.sweep(new Date(t));
			await run.flush();
		}
		expect(run.sent).toHaveLength(1);
		expect(run.waiting()).toBe(1);
		// A minute without an answer: the entry is dropped and the next sweep sends it again.
		t += 61_000;
		expect(run.waiting()).toBe(0);
		await run.sweep(new Date(t));
		await run.flush();
		expect(run.sent).toHaveLength(2);
		expect(run.waiting()).toBe(1);
		db.$close();
	});
});

describe("an answer that comes after the reminder stopped being in flight", () => {
	it("still marks it shown when it comes at 65 s, so no sweep sends it again", async () => {
		const { db } = await sentEightDaysAgo();
		let t = Date.now();
		const run = workerRun(db, null, () => new Date(t));
		await run.sweep(new Date(t));
		await run.flush();
		const id = run.sent[0]?.id ?? "";
		// At 61 s it is no longer in flight (a later sweep may queue it again)...
		t += 61_000;
		expect(run.waiting()).toBe(0);
		// ...and at 65 s main's answer comes after all.
		t += 4_000;
		await run.delivery.result(id, "delivered");
		for (const later of [60_000, DAY + 60_000]) {
			await run.sweep(new Date(t + later));
			await run.flush();
		}
		expect(run.sent).toHaveLength(1);
		db.$close();
	});

	it("drops a reminder queued at 61 s when the first one's answer comes at 62 s", async () => {
		const { db } = await sentEightDaysAgo();
		let t = Date.now();
		const run = workerRun(db, null, () => new Date(t));
		await run.sweep(new Date(t));
		await run.flush();
		const id = run.sent[0]?.id ?? "";
		// 61 s: no longer in flight, so the sweep queues it again (the batcher waits 15 s).
		t += 61_000;
		await run.sweep(new Date(t));
		expect(run.pending()).toBe(1);
		// 62 s: macOS showed the first after all.
		t += 1_000;
		await run.delivery.result(id, "unknown");
		// The queued one is dropped before it goes out.
		await run.flush();
		expect(run.sent).toHaveLength(1);
		db.$close();
	});
});
