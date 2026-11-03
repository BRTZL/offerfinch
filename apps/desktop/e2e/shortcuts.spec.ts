import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { SHORTCUTS } from "../src/shared/shortcuts";
import { startFixtureBoards } from "./fixture-boards";
import { APP_DIR, launchApp, tempUserData } from "./launch";
import {
	countIn,
	onboardWithFakes,
	openMatches,
	scanOnce,
	shootBothThemes,
} from "./matches-setup";

/**
 * Keyboard shortcuts (issue #48), in the background against the fixture boards: the sheet opens
 * with ⌘/ and from Help › Keyboard Shortcuts and lists every shortcut in shared/shortcuts.ts;
 * the Inbox moves with J and K, P prepares the one selected match and never a selection, and ⌘K
 * opens the command menu. Screenshots go to test-results/shortcut-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "shortcut-shots"),
);
const userData = tempUserData();
const count = (query: string) => countIn(userData, query);
const prepared = () =>
	count(
		"select count(*) n from applications where prepare_requested_at is not null",
	);

test("the shortcut sheet lists every shortcut, and the Inbox keys move and prepare", async () => {
	const boards = await startFixtureBoards();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await onboardWithFakes(page);
		await scanOnce(page, userData);
		const rows = await openMatches(page);
		await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
			timeout: 15_000,
		});

		// ⌘/ opens the sheet: every registered shortcut, once, in its screen's group.
		await page.keyboard.press("Meta+/");
		const sheet = page.getByTestId("shortcuts-sheet");
		await expect(sheet).toBeVisible();
		const listed = await sheet
			.getByTestId("shortcut")
			.evaluateAll((items) =>
				items.map((i) => i.getAttribute("data-shortcut")),
			);
		expect(listed.sort()).toEqual(SHORTCUTS.map((s) => s.id).sort());
		// No key approves (the sheet says so; no shortcut row is one).
		for (const text of await sheet.getByTestId("shortcut").allTextContents())
			expect(text).not.toMatch(/approv/i);
		await expect(sheet).toContainText("⌘K");
		await shootBothThemes(app, page, (t) =>
			path.join(SHOTS, `shortcut-sheet-${t}.png`),
		);
		await page.keyboard.press("Escape");
		await expect(sheet).toHaveCount(0);

		// Help › Keyboard Shortcuts opens it too.
		await app.evaluate(({ Menu }) => {
			Menu.getApplicationMenu()?.getMenuItemById("shortcuts")?.click();
		});
		await expect(sheet).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(sheet).toHaveCount(0);

		// ⌘K opens the command menu; Esc closes it.
		await page.keyboard.press("Meta+k");
		const menu = page.getByRole("dialog", { name: "Command menu" });
		await expect(menu).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);

		// J and K move through the company's roles; ← goes back to the company.
		await page.getByTestId("inbox-scroll").focus();
		await page.keyboard.press("j");
		await expect(page).toHaveURL(/\/applications\//);
		const first = page.url();
		await page.keyboard.press("j");
		await expect(page).not.toHaveURL(first);
		await page.keyboard.press("k");
		await expect(page).toHaveURL(first);
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByTestId("company-summary")).toBeVisible();

		// P never prepares a selection of several.
		await rows.nth(0).click();
		await rows.nth(1).click({ modifiers: ["Meta"] });
		await expect(page.getByTestId("selection-summary")).toBeVisible();
		await page.getByTestId("inbox-scroll").focus();
		await page.keyboard.press("p");
		await page.waitForTimeout(500);
		expect(prepared()).toBe(0);

		// P prepares the one selected match.
		await rows.nth(0).click();
		await expect(page).toHaveURL(/\/applications\//);
		await page.getByTestId("inbox-scroll").focus();
		await page.keyboard.press("p");
		await expect.poll(prepared).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
