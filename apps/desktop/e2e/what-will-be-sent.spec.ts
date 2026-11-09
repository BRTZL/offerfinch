import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { startFixtureBoards as startFormBoards } from "../../../packages/core/test/browser/fixture-boards";
import { startFixtureBoards } from "./fixture-boards";
import { APP_DIR, launchApp, tempUserData, toastsGone } from "./launch";
import {
	countIn,
	onboardWithFakes,
	scanOnce,
	showStatus,
} from "./matches-setup";

/**
 * The form read before review (docs/auto-apply-plan.md, steps 2 and 3): with the Greenhouse
 * board's hosted form served by the local fixture boards, preparing an application reads its
 * form read-only, and review lists every field with the exact value that will be sent, grouped
 * by section, before anything is approved. Nothing is posted to the form. The screenshot goes to
 * test-results/form-shots (or E2E_SHOTS); docs/screenshots/desktop/what-will-be-sent.png is one
 * of these (fabricated fixture data only).
 */
const SHOT = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "form-shots"),
	"what-will-be-sent.png",
);
const userData = tempUserData();

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

test("review lists every field of the form and the value it gets", async () => {
	const boards = await startFixtureBoards();
	const forms = await startFormBoards();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		env: {
			OFFERFINCH_BOARD_BASES: JSON.stringify({
				greenhouse: `${forms.url}/greenhouse`,
			}),
		},
	});
	try {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await onboardWithFakes(page);
		await scanOnce(page, userData);

		await sidebar(page, "Inbox").click();
		await showStatus(page, /^Matches/);
		await page
			.getByTestId("inbox-group")
			.filter({ hasText: "Acme Robotics" })
			.click();
		const match = page
			.getByTestId("inbox-row")
			.filter({ hasText: "Senior Full-Stack Engineer" });
		await match.click();
		await page.getByTestId("interested").click();

		// The posting and its form both ask for a notice period: one question waits.
		await sidebar(page, "Questions").click();
		const answer = page.getByRole("textbox").first();
		await expect(answer).toBeVisible({ timeout: 90_000 });
		await answer.fill("One month.");
		await page
			.getByRole("button", { name: /save|answer/i })
			.first()
			.click();

		await sidebar(page, "Inbox").click();
		await showStatus(page, /^To review/);
		const row = page
			.getByTestId("inbox-row")
			.filter({ hasText: "Senior Full-Stack Engineer" });
		await expect(row).toBeVisible({ timeout: 120_000 });
		await row.click();
		await expect(
			page.locator("[data-testid=action-bar][data-kind=review]"),
		).toBeVisible({ timeout: 90_000 });

		// The form was read once, read-only: saved before review, nothing posted to it.
		expect(
			countIn(
				userData,
				"select count(*) n from application_forms where status = 'read'",
			),
		).toBe(1);
		expect(forms.count()).toBe(0);

		const inspector = page.getByTestId("inspector");
		if (!(await inspector.isVisible()))
			await page.getByRole("button", { name: "Details" }).first().click();
		const list = inspector.getByTestId("what-will-be-sent");
		await expect(list).toBeVisible();
		const line = (label: string) =>
			list.getByTestId("sent-field").filter({
				has: page.locator("dt", { hasText: label }),
			});
		// Every field of the fixture's Greenhouse form, with its exact value.
		await expect(list.getByTestId("sent-field")).toHaveCount(10);
		await expect(line("First Name").getByTestId("sent-value")).toHaveText(/\S/);
		await expect(line("Email").getByTestId("sent-value")).toContainText("@");
		await expect(line("Resume/CV").getByTestId("sent-value")).toHaveText(
			"CV.pdf",
		);
		await expect(line("Cover Letter").getByTestId("sent-value")).toHaveText(
			"Cover letter.pdf",
		);
		await expect(
			line("What is your notice period?").getByTestId("sent-value"),
		).toHaveText("One month.");
		await expect(line("Why do you want to work at")).toHaveAttribute(
			"data-source",
			"form_answer",
		);
		// Self-identification: its own decline option, under its section heading.
		await expect(line("Gender").getByTestId("sent-value")).toHaveText(
			"Decline To Self Identify",
		);
		await expect(list).toContainText(/Voluntary self-identification/i);
		await expect(list).toContainText('"Submit application" is clicked once');

		await list.scrollIntoViewIfNeeded();
		await toastsGone(page, 15_000);
		fs.mkdirSync(path.dirname(SHOT), { recursive: true });
		await page.screenshot({ path: SHOT });
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
		await forms.close();
	}
});
