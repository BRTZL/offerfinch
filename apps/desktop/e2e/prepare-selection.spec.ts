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
	withDb,
} from "./matches-setup";

/**
 * Interested (what Prepare was), in the background against the fixture boards and fake models:
 * the caption under the action bar says what it does and never shows a cost (the owner mostly uses subscriptions; 2026-11-03), and a selection
 * of matches prepares them all with Prepare N. Home and an application's details show no costs
 * either. Screenshots go to test-results/prepare-shots (or
 * E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "prepare-shots"),
);
const userData = tempUserData();

const count = (query: string) => countIn(userData, query);

test("Interested says what it does, with no cost, and Prepare N prepares a selection", async () => {
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
		// Interested says what it does in the caption under the bar, with no cost.
		const interested = page.getByTestId("interested");
		await expect(interested).toBeVisible();
		await toastsGone(page, 15_000);
		const caption = page.getByTestId("action-bar-caption");
		await expect(caption).toHaveText("Interested drafts your CV and letter");
		await expect(interested).toHaveAttribute(
			"title",
			/drafts a CV, letter and answers/,
		);
		await expect(caption).not.toContainText("$");
		await expect(caption).not.toContainText(/estimate|cost/i);
		await shootBothThemes(app, page, (t) =>
			path.join(SHOTS, `interested-caption-${t}.png`),
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

		// An application's details list its model calls, never what they cost.
		const scored = withDb(userData, (db) =>
			db
				.prepare(
					"select application_id id from llm_usage where application_id is not null limit 1",
				)
				.get(),
		) as { id: string };
		await page.goto(`app://local/applications/${scored.id}?view=all`);
		const inspector = page.getByTestId("inspector");
		if (!(await inspector.isVisible()))
			await page.getByRole("button", { name: "Details" }).first().click();
		await expect(inspector).toBeVisible();
		await inspector.getByText("Model calls").click();
		await expect(inspector.getByTestId("model-calls")).toContainText(" in / ");
		await expect(inspector).not.toContainText(/\$\d|<\$0/);
		await toastsGone(page, 15_000);
		await shootBothThemes(app, page, (t) =>
			path.join(SHOTS, `details-no-cost-${t}.png`),
		);

		// Home: no spend line.
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: /^Home/ })
			.click();
		await expect(page.getByTestId("home-scans")).toBeVisible();
		await expect(page.getByTestId("home-scans")).not.toContainText("$");
		await expect(page.getByTestId("home")).not.toContainText(/\$\d|spent/);
		await toastsGone(page, 15_000);
		await shootBothThemes(app, page, (t) =>
			path.join(SHOTS, `home-no-cost-${t}.png`),
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
