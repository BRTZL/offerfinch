import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startFixtureBoards } from "./fixture-boards";
import { APP_DIR, launchApp, tempUserData, toastsGone } from "./launch";
import {
	countIn,
	onboardWithFakes,
	openMatches,
	scanOnce,
	shootBothThemes,
} from "./matches-setup";

/**
 * Prepare, in the background against the fixture boards and fake models: its hover says what it
 * does and never shows a cost (the owner mostly uses subscriptions; 2026-11-03), and a selection
 * of matches prepares them all with Prepare N. Screenshots go to test-results/prepare-shots (or
 * E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "prepare-shots"),
);
const userData = tempUserData();

const count = (query: string) => countIn(userData, query);

test("Prepare says what it does, with no cost, and Prepare N prepares a selection", async () => {
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
		await rows.first().click();
		const prepare = page.getByTestId("prepare");
		await expect(prepare).toBeVisible();
		await toastsGone(page, 15_000);

		await prepare.hover();
		const tip = page.getByTestId("prepare-tip");
		await expect(tip).toBeVisible();
		await expect(tip).toContainText("Drafts a CV, letter and answers");
		await expect(tip).not.toContainText("$");
		await expect(tip).not.toContainText(/estimate|cost/i);
		await shootBothThemes(app, page, (t) =>
			path.join(SHOTS, `prepare-tooltip-${t}.png`),
		);
		await page.mouse.move(10, 400);

		// Two matches selected: Prepare 2 prepares both; no total is shown.
		await rows.nth(0).click();
		await rows.nth(1).click({ modifiers: ["Meta"] });
		const summary = page.getByTestId("selection-summary");
		await expect(summary).toContainText("2 jobs selected");
		await expect(summary).not.toContainText("$");
		await page.getByTestId("prepare-selection").click();
		await expect
			.poll(() =>
				count(
					"select count(*) n from applications where prepare_requested_at is not null",
				),
			)
			.toBe(2);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
