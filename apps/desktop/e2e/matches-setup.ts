import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { RESUME, skipRestOfSetup } from "./launch";

/** Runs `fn` on the app's database in `userData` (read only unless asked). */
export function withDb<T>(
	userData: string,
	fn: (db: Database.Database) => T,
	readonly = true,
): T {
	const db = new Database(path.join(userData, DB_FILE), {
		readonly,
		fileMustExist: true,
	});
	db.pragma("busy_timeout = 5000");
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

export const countIn = (userData: string, query: string) =>
	withDb(userData, (db) => (db.prepare(query).get() as { n: number }).n);

/** Setup as a new user does it, with the test models; the rest of setup put off. */
export async function onboardWithFakes(page: Page) {
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
	await skipRestOfSetup(page);
}

/** One scan of the fixture boards, waited for until every new job is scored or set aside. */
export async function scanOnce(page: Page, userData: string) {
	await page.getByTestId("scan-status").click();
	await page.getByTestId("scan-now").first().click();
	await expect
		.poll(
			() =>
				countIn(
					userData,
					"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
				),
			{ timeout: 120_000 },
		)
		.toBe(1);
	await expect
		.poll(
			() =>
				countIn(
					userData,
					"select count(*) n from applications where state = 'found'",
				),
			{ timeout: 120_000 },
		)
		.toBe(0);
}

/** The Inbox's Matches, with the fixture boards' one company opened: its two roles. */
export async function openMatches(page: Page) {
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: /^Inbox/ })
		.click();
	await page.getByTestId("inbox-group").first().click();
	const rows = page.locator("[data-testid=inbox-row][data-child]");
	await expect(rows).toHaveCount(2);
	return rows;
}

/** A screenshot in light and then dark appearance (the app follows `nativeTheme`). */
export async function shootBothThemes(
	app: ElectronApplication,
	page: Page,
	file: (theme: "light" | "dark") => string,
) {
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
		await page.waitForTimeout(300);
		await page.screenshot({ path: file(theme) });
	}
	await app.evaluate(({ nativeTheme }) => {
		nativeTheme.themeSource = "system";
	});
}
