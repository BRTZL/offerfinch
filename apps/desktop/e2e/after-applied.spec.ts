import fs from "node:fs";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import {
	APP_DIR,
	launchApp,
	notices,
	openRoute,
	pickFakeModels,
	RESUME,
	skipRestOfSetup,
	tempUserData,
	toastsGone,
} from "./launch";

/**
 * After Applied, in the background against the fixture boards: three jobs are marked sent (1,
 * 8 and 25 days ago) while the app is closed. On the next start the 25-day one is Ghosted and
 * the 8-day one gets a follow-up reminder that opens it in Applied. The list shows stage chips
 * and filters by stage; a sent job moves to Interviewing with a time and a note, and Add to
 * Calendar saves its .ics. Screenshots go to test-results/after-applied-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ??
		path.join(APP_DIR, "test-results", "after-applied-shots"),
);
const userData = tempUserData();
const DAY = 86_400_000;

function db(readonly: boolean) {
	return new Database(path.join(userData, DB_FILE), {
		readonly,
		fileMustExist: true,
	});
}

function readDb<T>(query: string, ...params: unknown[]): T[] {
	const handle = db(true);
	try {
		return handle.prepare(query).all(...params) as T[];
	} finally {
		handle.close();
	}
}

async function shot(page: Page, name: string) {
	fs.mkdirSync(SHOTS, { recursive: true });
	// Toasts gone and the theme's colour transition finished.
	await toastsGone(page, 15_000);
	await page.waitForTimeout(600);
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function setDark(app: ElectronApplication, dark: boolean) {
	await app.evaluate(({ nativeTheme }, value) => {
		nativeTheme.themeSource = value ? "dark" : "light";
	}, dark);
}

test("After Applied: Ghosted, a follow-up reminder, stage chips, a move with notes and an .ics", async () => {
	const boards = await startFixtureBoards();
	let launched = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	let sent: { id: string; title: string; company: string }[] = [];
	try {
		const { page } = launched;
		await page.getByTestId("welcome-start").click();
		await pickFakeModels(page);
		await page.getByTestId("step-continue").click();
		await page.getByTestId("resume-option-paste").click();
		await page.getByTestId("onboarding-text").fill(RESUME);
		await page.getByTestId("onboarding-structure").click();
		await page.getByTestId("onboarding-save").click({ timeout: 60_000 });
		await skipRestOfSetup(page);
		await page.getByTestId("scan-status").click();
		await page.getByTestId("scan-now").first().click();
		await expect
			.poll(
				() =>
					readDb<{ n: number }>(
						"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
					)[0]?.n,
				{ timeout: 180_000 },
			)
			.toBe(1);
		// Every new job checked and scored (or set aside); any three will be marked sent.
		await expect
			.poll(
				() =>
					readDb<{ n: number }>(
						"select count(*) n from applications where state = 'found'",
					)[0]?.n,
				{ timeout: 180_000 },
			)
			.toBe(0);
	} finally {
		await launched.app.close();
	}

	// Three jobs the user sent 1, 8 and 25 days ago, as "I submitted this" leaves them.
	sent = readDb<{ id: string; title: string; company: string }>(
		`select a.id, j.title, c.name company from applications a
			join jobs j on j.id = a.job_id join companies c on c.id = j.company_id
			order by a.rowid limit 3`,
	);
	expect(sent).toHaveLength(3);
	const [recent, quiet, silent] = sent as [
		(typeof sent)[number],
		(typeof sent)[number],
		(typeof sent)[number],
	];
	{
		const handle = db(false);
		const now = Date.now();
		const mark = handle.prepare(
			"update applications set state = 'applied', applied_via = 'manual', applied_at = ?, state_changed_at = ? where id = ?",
		);
		for (const [row, days] of [
			[recent, 1],
			[quiet, 8],
			[silent, 25],
		] as const)
			mark.run(now - days * DAY, now - days * DAY, row.id);
		handle.close();
	}

	launched = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	const { app, page, errors } = launched;
	try {
		await page.setViewportSize({ width: 1440, height: 900 });
		// The start's sweep: one reminder (the 8-day one), opening it in Applied; Ghosted set.
		await expect
			.poll(
				async () => (await notices(app)).filter((n) => n.kind === "followup"),
				{ timeout: 60_000 },
			)
			.toEqual([
				{
					kind: "followup",
					title: "Time to follow up",
					body: `${quiet.title} at ${quiet.company}: no news for 7 days. A short follow-up may help.`,
					path: `/applied/${quiet.id}`,
					// Main answers what macOS did with it, by this id.
					id: expect.any(String),
				},
			]);
		expect(
			readDb<{ stage: string; automatic: number }>(
				"select stage, automatic from application_stages where application_id = ? order by rowid desc limit 1",
				silent.id,
			)[0],
		).toEqual({ stage: "ghosted", automatic: 1 });

		// Clicking the reminder opens the application in Applied, its progress shown.
		await openRoute(app, page, `/applied/${quiet.id}`);
		const rows = page.getByTestId("applied-row");
		await expect(rows).toHaveCount(3, { timeout: 30_000 });
		const tracking = page.getByTestId("tracking");
		await expect(tracking).toBeVisible({ timeout: 30_000 });
		await expect(tracking.getByTestId("stage-chip")).toHaveText("Applied");

		// Chips on the list, and the stage filter with counts.
		await expect(
			rows
				.filter({ hasText: silent.company })
				.first()
				.getByTestId("stage-chip"),
		).toBeVisible();
		await expect(
			page.locator('[data-testid=stage-chip][data-stage="ghosted"]'),
		).toHaveCount(1);
		await page.getByTestId("stage-filter").click();
		await page.getByRole("option", { name: "Ghosted · 1" }).click();
		await expect(rows).toHaveCount(1);
		await expect(page.getByText("1 of 3 sent")).toBeVisible();
		await page.getByTestId("stage-filter").click();
		await page.getByRole("option", { name: /^All stages/ }).click();
		await expect(rows).toHaveCount(3);

		// The recent one moves to Interviewing, with a day, a time and a note. The form is filled
		// in at 23:59 yesterday and saved after midnight, untouched: the day saved is today.
		const real = new Date();
		const dayOf = (d: Date) =>
			`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		const today = dayOf(real);
		const lateYesterday = new Date(
			real.getFullYear(),
			real.getMonth(),
			real.getDate() - 1,
			23,
			59,
		);
		await page.clock.install({ time: lateYesterday });
		await openRoute(app, page, `/applied/${recent.id}`);
		await expect(tracking).toBeVisible({ timeout: 30_000 });
		await tracking.getByTestId("move-stage-select").click();
		await page.getByRole("option", { name: "Interviewing (round 1)" }).click();
		await expect(tracking.getByTestId("stage-date")).toHaveValue(
			dayOf(lateYesterday),
		);
		await tracking.getByTestId("interview-at").fill("2026-11-20T15:30");
		await tracking
			.getByTestId("stage-note")
			.fill("Call with the hiring manager");
		// Past midnight with no timer fired, so nothing renders the form again before Save.
		await page.clock.setSystemTime(
			new Date(real.getFullYear(), real.getMonth(), real.getDate(), 0, 1),
		);
		await tracking.getByTestId("move-stage-save").click();
		await expect
			.poll(
				() =>
					readDb<{ occurred_on: string }>(
						"select occurred_on from application_stages where application_id = ? and stage = 'interviewing'",
						recent.id,
					)[0]?.occurred_on,
			)
			.toBe(today);
		await expect(tracking.getByTestId("stage-chip")).toHaveText(
			"Interviewing · round 1",
		);
		await expect(tracking.getByTestId("stage-entry")).toHaveCount(2);
		await expect(tracking).toContainText("Call with the hiring manager");
		await expect(
			rows.filter({ hasText: recent.title }).getByTestId("stage-chip"),
		).toHaveText("Interviewing · round 1");

		// A private note on the job, outside any model's reach.
		const notes = page.getByTestId("notes");
		await notes.getByTestId("note-input").fill("Referred by Lee Example");
		await notes.getByTestId("note-add").click();
		await expect(notes.getByTestId("note")).toHaveCount(2);
		await expect(notes).toContainText("Referred by Lee Example");

		// Add to Calendar saves an .ics with the time (as an instant) and the job link.
		await tracking.getByTestId("add-to-calendar").click();
		await expect(page.getByText(/Saved interview-.*\.ics/)).toBeVisible();
		const saved = fs
			.readdirSync(path.join(userData, "saved"))
			.filter((f) => f.endsWith(".ics"));
		expect(saved).toHaveLength(1);
		const ics = fs.readFileSync(
			path.join(userData, "saved", saved[0] as string),
			"utf8",
		);
		const start = new Date("2026-11-20T15:30")
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}Z$/, "Z");
		expect(ics).toContain(`DTSTART:${start}`);
		expect(ics).not.toContain("hiring manager");
		expect(ics).not.toContain("Lee Example");

		await setDark(app, false);
		await shot(page, "applied-light");
		await setDark(app, true);
		await expect(page.locator("html.dark")).toHaveCount(1);
		await shot(page, "applied-dark");
		// Ghosted, undone by the user.
		await openRoute(app, page, `/applied/${silent.id}`);
		await expect(tracking.getByTestId("undo-ghosted")).toBeVisible({
			timeout: 30_000,
		});
		await shot(page, "ghosted-dark");
		await tracking.getByTestId("undo-ghosted").click();
		await expect(tracking.getByTestId("stage-chip")).toHaveText("Applied");
		await setDark(app, false);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
