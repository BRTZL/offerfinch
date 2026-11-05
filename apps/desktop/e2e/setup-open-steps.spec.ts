import { expect, test } from "@playwright/test";

import { launchApp, skipRestOfSetup, tempUserData } from "./launch";

/**
 * Setup with steps skipped and no AI: the resume step says to connect the AI before anything is
 * pasted (Start from scratch still works), a First search that cannot run leads to what it needs
 * and is never marked done, Stay in the loop never waits for a test notification, and Home names
 * what is still open and opens the first of it. Claude Code and Codex read as not installed.
 */
test("skipped steps stay open: no AI on the resume step, a blocked first search, Home's list", async () => {
	const { app, page, errors } = await launchApp({ userData: tempUserData() });
	try {
		await page.getByTestId("welcome-start").click({ timeout: 30_000 });
		await expect(page.getByTestId("step-count")).toContainText("Step 1 of 5");
		await page.getByTestId("step-skip").click();

		// 2. The resume step, with no model to draft: the notice, Upload and Paste off.
		await expect(page.getByTestId("step-count")).toContainText("Step 2 of 5");
		await expect(page.getByTestId("resume-needs-ai")).toContainText(
			"Connect your AI first to draft a profile from your resume",
		);
		await expect(page.getByTestId("resume-option-upload")).toBeDisabled();
		await expect(page.getByTestId("resume-option-paste")).toBeDisabled();
		await expect(page.getByTestId("resume-option-scratch")).toBeEnabled();

		// The first search without a profile: its action goes to the resume step; no Continue.
		await page.getByTestId("step-scan").click();
		await expect(page.getByTestId("first-scan-blocked")).toBeVisible();
		await expect(page.getByTestId("step-continue")).toHaveCount(0);
		await expect(page.getByTestId("step-skip")).toBeHidden();
		await expect(page.getByTestId("first-scan-go-profile")).toHaveText(
			"Add your resume",
		);
		await page.getByTestId("first-scan-go-profile").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 2 of 5");
		await expect(page.getByTestId("step-scan")).not.toHaveAttribute(
			"data-state",
			"done",
		);

		// The notice's button goes back to Connect AI.
		await page.getByTestId("resume-connect-ai").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 1 of 5");
		await expect(page.getByTestId("setup-ai")).toBeVisible();
		// A skipped step is not drawn as done.
		await expect(page.getByTestId("step-ai")).not.toHaveAttribute(
			"data-state",
			"done",
		);
		await page.getByTestId("step-profile").click();

		// Start from scratch still works.
		await page.getByTestId("resume-option-scratch").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 3 of 5");
		await page.getByTestId("step-skip").click();

		// 4. Stay in the loop: Continue without a test notification.
		await expect(page.getByTestId("step-count")).toContainText("Step 4 of 5");
		await expect(page.getByTestId("notify-status")).toHaveAttribute(
			"data-status",
			"unknown",
		);
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		await page.getByTestId("step-continue").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 5 of 5");
		await expect(page.getByTestId("first-scan-start")).toBeVisible();

		// Home: what is still open, by name, and Continue setup opens the first of it.
		await skipRestOfSetup(page);
		await expect(page.getByTestId("home-setup")).toContainText(
			"Setup: AI not connected, no rules or sources chosen, no first search yet.",
		);
		// The notification never shown is a Needs you line, not a wall in setup.
		await expect(page.getByTestId("home-needs-notify-test")).toBeVisible();
		await page.getByTestId("resume-setup").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 1 of 5");
		await expect(page.getByTestId("welcome")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
