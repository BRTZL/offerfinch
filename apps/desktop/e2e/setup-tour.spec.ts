import fs from "node:fs";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from "@playwright/test";

import { startFixtureBoards } from "./fixture-boards";
import { chirps, fakeClis, launchApp, RESUME, tempUserData } from "./launch";

/**
 * The happy path a new user with Claude Code and Codex signed in walks: Welcome, Connect AI
 * found both by itself, the resume and its review, what you want, stay in the loop, the first
 * search and its first matches. Stand-in CLIs (no model is called) and fixture boards.
 * E2E_SHOTS: each step in light and dark. E2E_VIDEO: a recording of the walk, in that folder.
 */
const SHOTS = process.env.E2E_SHOTS
	? path.resolve(process.env.E2E_SHOTS)
	: null;
const VIDEO = process.env.E2E_VIDEO
	? path.resolve(process.env.E2E_VIDEO)
	: null;

async function frames(app: ElectronApplication, page: Page, name: string) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	for (const scheme of ["light", "dark"] as const) {
		await app.evaluate(({ nativeTheme }, s) => {
			nativeTheme.themeSource = s;
		}, scheme);
		await page.waitForTimeout(450);
		await page.screenshot({
			path: path.join(SHOTS, `setup-${name}-${scheme}.png`),
			fullPage: true,
		});
	}
	await app.evaluate(({ nativeTheme }) => {
		nativeTheme.themeSource = "light";
	});
}

/** A beat for the recording, so each step can be seen; nothing when not recording. */
const beat = (page: Page, ms = 900) =>
	VIDEO ? page.waitForTimeout(ms) : Promise.resolve();

test("setup's happy path: found both CLIs, five steps, first matches with a chirp", async () => {
	const boards = await startFixtureBoards();
	const userData = tempUserData();
	fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		recordVideoDir: VIDEO ?? undefined,
	});
	try {
		await app.evaluate(({ BrowserWindow, nativeTheme }) => {
			nativeTheme.themeSource = "light";
			BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
		});
		await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 30_000 });
		await frames(app, page, "1-welcome");
		await beat(page, 1500);
		await page.getByTestId("welcome-start").click();

		// 1. Connect AI: found and set by itself.
		await expect(page.getByTestId("setup-ai-summary")).toHaveAttribute(
			"data-all-set",
			"true",
			{ timeout: 30_000 },
		);
		await expect(page.getByTestId("step-count")).toHaveText(
			"Step 1 of 5 · about 5 minutes left",
		);
		await expect.poll(async () => (await chirps(app)).length).toBe(1);
		await beat(page, 1500);
		await frames(app, page, "2-connect-ai");
		await page.getByTestId("step-continue").click();

		// 2. Your resume, reviewed in the same step.
		await expect(page.getByTestId("step-count")).toContainText("Step 2 of 5");
		await frames(app, page, "3-resume");
		await page.getByTestId("resume-option-paste").click();
		await page.getByTestId("onboarding-text").fill(RESUME);
		await beat(page);
		await page.getByTestId("onboarding-structure").click();
		await expect(page.getByTestId("onboarding-draft")).toBeVisible({
			timeout: 60_000,
		});
		await beat(page, 1200);
		await frames(app, page, "4-review");
		await page.getByTestId("onboarding-save").click();

		// 3. What you want. "Profile saved." shows above the footer, never over Back or Continue.
		await expect(page.getByTestId("step-count")).toContainText("Step 3 of 5");
		const toast = page.locator("[data-sonner-toast]").first();
		await expect(toast).toBeVisible();
		const continueBox = await page.getByTestId("step-continue").boundingBox();
		// Once it has slid in: its bottom edge above the footer's buttons.
		await expect
			.poll(async () => {
				const box = await toast.boundingBox();
				return box && continueBox ? box.y + box.height <= continueBox.y : false;
			})
			.toBe(true);
		// The step bar: the first two done, this one current, the rest still to do.
		for (const [key, state] of [
			["ai", "done"],
			["profile", "done"],
			["wants", "current"],
			["loop", "todo"],
			["scan", "todo"],
		] as const)
			await expect(page.getByTestId(`step-${key}`)).toHaveAttribute(
				"data-state",
				state,
			);
		// The same, for a screen reader.
		await expect(page.getByTestId("step-profile")).toHaveAttribute(
			"aria-label",
			"Step 2 of 5, Your resume, done",
		);
		await expect(page.getByTestId("step-wants")).toHaveAttribute(
			"aria-label",
			"Step 3 of 5, What you want, current",
		);
		await expect(page.getByTestId("step-scan")).toHaveAttribute(
			"aria-label",
			"Step 5 of 5, First search, not done yet",
		);
		await expect(page.getByTestId("setup-sources")).toBeVisible();
		await beat(page, 1200);
		await frames(app, page, "5-what-you-want");
		await page.getByTestId("step-continue").click();

		// 4. Stay in the loop.
		await expect(page.getByTestId("step-count")).toContainText("Step 4 of 5");
		await page.getByTestId("notify-test").click();
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		await beat(page);
		await frames(app, page, "6-stay-in-the-loop");
		await page.getByTestId("step-continue").click();

		// 5. First search, and its first matches.
		await expect(page.getByTestId("step-count")).toContainText("Step 5 of 5");
		await frames(app, page, "7-first-search");
		await page.getByTestId("first-scan-start").click();
		await expect(page.getByTestId("first-scan-progress")).toContainText(
			/Done: .* waiting in your Inbox\./,
			{ timeout: 120_000 },
		);
		await expect.poll(async () => (await chirps(app)).length).toBe(2);
		// The jobs it found, live; the matches with company, title and fit.
		const rows = page.getByTestId("first-match");
		await expect(rows.first()).toBeVisible();
		expect(await rows.count()).toBeGreaterThanOrEqual(1);
		await expect(rows.first().locator("[data-fit]")).toBeVisible();
		await expect(page.getByTestId("onboarding-finish")).toHaveText(
			"Open the Inbox",
		);
		await beat(page, 1500);
		await frames(app, page, "8-first-matches");
		await page.getByTestId("onboarding-finish").click();
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe("/inbox");
		await beat(page, 1500);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
		if (VIDEO) {
			const video = page.video();
			if (video) {
				const file = await video.path();
				fs.renameSync(file, path.join(VIDEO, "setup-happy-path.webm"));
			}
		}
	}
});
