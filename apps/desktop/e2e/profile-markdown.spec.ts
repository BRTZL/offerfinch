import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { launchApp, RESUME, tempUserData } from "./launch";

/** Long profile fields are Markdown: they render as headings, lists and bold, not as source. */
const userData = tempUserData();

const SUMMARY = `## Positioning

Senior full-stack engineer.

- **Builds end to end:** React and Node.js.
- **Recent work:**
  - event-driven services;
  - billing.`;

test("profile summary renders as Markdown", async () => {
	const { app, page, errors } = await launchApp({ userData });
	try {
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

		// The About record's summary, written as Markdown.
		const db = new Database(path.join(userData, DB_FILE), {
			fileMustExist: true,
		});
		try {
			const row = db
				.prepare("select id, data from profile_records where kind = 'about'")
				.get() as { id: string; data: string };
			db.prepare("update profile_records set data = ? where id = ?").run(
				JSON.stringify({ ...JSON.parse(row.data), summary: SUMMARY }),
				row.id,
			);
		} finally {
			db.close();
		}
		// The record changed behind the app's back: start the page afresh, then open Profile.
		await page.reload();
		await app.evaluate(
			(_e, to) =>
				(
					globalThis as unknown as {
						__offerfinchTest: { open: (p: string) => void };
					}
				).__offerfinchTest.open(to),
			"/profile/about",
		);
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe("/profile/about");

		const summary = page
			.getByTestId("record-markdown")
			.filter({ hasText: "Positioning" });
		await expect(summary.locator("h2")).toHaveText("Positioning");
		await expect(summary.locator("strong").first()).toHaveText(
			"Builds end to end:",
		);
		await expect(summary.locator("ul ul li")).toHaveCount(2);
		await expect(summary).not.toContainText("##");
		await expect(summary).not.toContainText("**");

		// Editing it: the form lines up with the dialog's title, and Preview renders the Markdown
		// while the text stays exactly as typed.
		await page.getByTestId("profile-add").click();
		const field = page.getByTestId("record-summary");
		await expect(field).toHaveValue(SUMMARY);
		const dialog = page.locator("[data-slot=dialog-content]");
		// Measured once the dialog's 200 ms zoom-in has finished.
		await expect
			.poll(async () => (await dialog.boundingBox())?.width ?? 0)
			.toBeGreaterThanOrEqual(640);
		const [fieldBox, titleBox, dialogBox] = await Promise.all([
			field.boundingBox(),
			dialog.getByRole("heading").first().boundingBox(),
			dialog.boundingBox(),
		]);
		expect(Math.abs((fieldBox?.x ?? 0) - (titleBox?.x ?? 99))).toBeLessThan(2);
		expect(dialogBox?.width ?? 0).toBeGreaterThanOrEqual(640);
		await page.getByTestId("record-summary-preview").click();
		const rendered = page.getByTestId("record-summary-rendered");
		await expect(rendered.locator("h2")).toHaveText("Positioning");
		await expect(rendered).not.toContainText("##");
		await page.getByTestId("record-summary-write").click();
		await expect(page.getByTestId("record-summary")).toHaveValue(SUMMARY);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
