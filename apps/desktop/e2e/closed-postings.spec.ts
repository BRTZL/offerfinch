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
import { APP_DIR, launchApp, RESUME, tempUserData, toastsGone } from "./launch";

/**
 * Closed postings (docs/decisions.md, 2026-11-03), in the background against the fixture boards:
 * a match whose posting was taken down from its board is found closed when Prepare is pressed,
 * Prepare is refused with the reason, and the job leaves Matches for Closed with a Posting closed
 * badge; It's still open puts it back. A board answering 500 leaves the job open and Prepare
 * goes on. Screenshots (light and dark) go to test-results/closed-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "closed-shots"),
);
const userData = tempUserData();

function readDb<T>(query: string, ...params: unknown[]): T[] {
	const db = new Database(path.join(userData, DB_FILE), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		return db.prepare(query).all(...params) as T[];
	} finally {
		db.close();
	}
}

type Row = {
	id: string;
	state: string;
	prepare_requested_at: number | null;
	closed_at: number | null;
	closed_reason: string | null;
	open_confirmed_at: number | null;
};
const posting = (externalId: string) =>
	readDb<Row>(
		`select a.id, a.state, a.prepare_requested_at, j.closed_at, j.closed_reason, j.open_confirmed_at
		from applications a join jobs j on j.id = a.job_id where j.external_id = ?`,
		externalId,
	)[0];

async function scanAndSettle(page: Page) {
	await page.getByTestId("scan-status").click();
	await page.getByTestId("scan-now").first().click();
	await expect
		.poll(
			() =>
				readDb<{ n: number }>(
					"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
				)[0]?.n,
			{ timeout: 120_000 },
		)
		.toBe(1);
	await expect
		.poll(
			() =>
				readDb<{ n: number }>(
					"select count(*) n from applications where state = 'found'",
				)[0]?.n,
			{ timeout: 120_000 },
		)
		.toBe(0);
}

/** The page in light and dark, as the app draws it when macOS asks for either. */
async function shots(app: ElectronApplication, page: Page, name: string) {
	fs.mkdirSync(SHOTS, { recursive: true });
	for (const theme of ["light", "dark"] as const) {
		await app.evaluate(({ nativeTheme }, t) => {
			nativeTheme.themeSource = t;
		}, theme);
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.documentElement.classList.contains("dark"),
				),
			)
			.toBe(theme === "dark");
		// Colours ease between themes, and a toast slides in: let both settle.
		await page.waitForTimeout(800);
		await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
	}
	await app.evaluate(({ nativeTheme }) => {
		nativeTheme.themeSource = "system";
	});
}

test("a posting taken down from its board shows as closed, Prepare is refused with the reason, and It's still open reopens it", async () => {
	const boards = await startFixtureBoards();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.getByTestId("welcome-start").click();
		for (const role of ["scoring", "tailoring", "claims"]) {
			await page.getByTestId(`role-${role}-mode`).click();
			await page.getByTestId(`role-${role}-fake`).click();
		}
		await page.getByTestId("step-continue").click();
		await page.getByTestId("resume-option-paste").click();
		await page.getByTestId("onboarding-text").fill(RESUME);
		await page.getByTestId("onboarding-structure").click();
		await page.getByTestId("onboarding-save").click({ timeout: 60_000 });
		await page.getByTestId("onboarding-later").click();

		await scanAndSettle(page);
		const first = posting("4001");
		const second = posting("4002");
		expect(first?.state).toBe("scored");
		expect(second?.state).toBe("scored");

		// The employer takes 4001 down. Prepare checks the board first and refuses.
		boards.removeJob(4001);
		await page.goto(`app://local/applications/${first?.id}?view=all`);
		await page.getByTestId("prepare").click();
		const toast = page.locator("[data-sonner-toast]").filter({
			hasText: "This posting looks closed",
		});
		await expect(toast).toContainText(
			"Greenhouse no longer lists it (checked before Prepare). Prepare did not start.",
		);
		await expect(page.getByTestId("posting-closed")).toContainText(
			"This posting looks closed: Greenhouse no longer lists it (checked before Prepare)",
		);
		await expect(page.getByTestId("prepare")).toHaveCount(0);
		expect(posting("4001")).toMatchObject({
			state: "scored",
			prepare_requested_at: null,
			closed_reason: "Greenhouse no longer lists it (checked before Prepare)",
		});
		expect(posting("4001")?.closed_at).not.toBeNull();
		await shots(app, page, "prepare-refused");

		// It left Matches and waits in Closed with its badge.
		await page.goto("app://local/inbox?view=matches");
		await expect(page.getByTestId("inbox-view-matches")).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(
			page.getByTestId("inbox-row").filter({ hasText: "Posting closed" }),
		).toHaveCount(0);
		await page.getByTestId("inbox-view-closed").click();
		const closedRow = page
			.getByTestId("inbox-row")
			.filter({ hasText: "Posting closed" });
		await expect(closedRow).toHaveCount(1);
		await expect(closedRow).toContainText("Senior Full-Stack Engineer");
		await closedRow.click();
		await expect(page.getByTestId("posting-closed")).toBeVisible();
		await toastsGone(page, 15_000);
		await shots(app, page, "closed-in-inbox");

		// The check was wrong: It's still open puts it back, and Prepare is offered again.
		await page.getByTestId("reopen-posting").click();
		await expect(page.getByTestId("posting-closed")).toHaveCount(0);
		expect(posting("4001")).toMatchObject({ closed_at: null });
		expect(posting("4001")?.open_confirmed_at).not.toBeNull();
		await page.goto(`app://local/applications/${first?.id}?view=all`);
		await expect(page.getByTestId("prepare")).toBeVisible();

		// A board in trouble (500) says nothing about the posting: it stays open, Prepare goes on.
		boards.failPostings(500);
		await page.goto(`app://local/applications/${second?.id}?view=all`);
		await page.getByTestId("prepare").click();
		await expect(page.getByTestId("prepare")).toHaveCount(0);
		await expect
			.poll(() => posting("4002")?.prepare_requested_at ?? null)
			.not.toBeNull();
		expect(posting("4002")?.closed_at).toBeNull();
		expect(
			boards.requests.filter((r) => r.endsWith("/acmerobotics/jobs/4002")),
		).toHaveLength(1);
		boards.failPostings(null);

		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
