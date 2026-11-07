import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import {
	launchApp,
	pickFakeModels,
	RESUME,
	skipRestOfSetup,
	tempUserData,
	toastsGone,
} from "./launch";
import { showStatus } from "./matches-setup";

/**
 * The action bar's Not interested tray keeps what was chosen when the dismissal fails (it comes
 * back open with the reasons and the note), and an Esc that ends an input method's composition
 * does not close it.
 */
const userData = tempUserData();
const run = (q: string, write = false) => {
	const d = new Database(path.join(userData, DB_FILE), {
		readonly: !write,
		fileMustExist: true,
	});
	try {
		return write ? d.exec(q) : d.prepare(q).all();
	} finally {
		d.close();
	}
};
const count = (q: string) => (run(q) as { n: number }[])[0]?.n ?? 0;

test("tray keeps the draft on a failed dismissal and ignores IME Esc", async () => {
	const boards = await startFixtureBoards();
	const { app, page } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await page.setViewportSize({ width: 1280, height: 800 });
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
					count(
						"select count(*) n from flow_runs where kind='scan' and status='complete'",
					),
				{ timeout: 120_000 },
			)
			.toBe(1);
		await expect
			.poll(
				() => count("select count(*) n from applications where state='found'"),
				{ timeout: 120_000 },
			)
			.toBe(0);
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: /^Inbox/ })
			.click();
		await showStatus(page, /^Matches/);
		await page.getByTestId("inbox-group").first().click();
		await page.locator("[data-testid=inbox-row][data-child]").first().click();
		await toastsGone(page, 15_000);

		const tray = page.getByTestId("not-interested-popover");
		await page.getByTestId("not-interested").click();
		await expect(tray).toBeVisible();
		await tray.getByTestId("dismiss-reason-location").click();
		await tray.getByTestId("dismiss-note").fill("Too far");

		// IME: an Esc that ends a composition does not close the tray.
		await tray.getByTestId("dismiss-note").evaluate((el) => {
			el.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Escape",
					isComposing: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		});
		await page.waitForTimeout(600);
		await expect(tray).toBeVisible();
		await expect(tray.getByTestId("dismiss-note")).toHaveValue("Too far");

		// A failed dismissal: the tray comes back with the choices.
		run(
			"create trigger zz_fail before insert on dismissals begin select raise(abort, 'boom'); end;",
			true,
		);
		await page.getByTestId("not-interested").click();
		await expect(tray).toBeVisible({ timeout: 5000 });
		await expect(tray.getByTestId("dismiss-note")).toHaveValue("Too far");
		await expect(tray.getByTestId("dismiss-reason-location")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(count("select count(*) n from dismissals")).toBe(0);

		// Fixed: the same press dismisses, and the draft is gone.
		run("drop trigger zz_fail;", true);
		await page.getByTestId("not-interested").click();
		await expect.poll(() => count("select count(*) n from dismissals")).toBe(1);
		await expect(tray).toBeHidden();
	} finally {
		await app.close();
		await boards.close();
	}
});
