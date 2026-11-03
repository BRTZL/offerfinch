import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";

/** A new user is sent to setup first; Settings opens once that has happened. */
async function openSettings(app: ElectronApplication, page: Page) {
	await expect
		.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
		.toBe("/onboarding");
	await app.evaluate(
		(_e, to) =>
			(
				globalThis as unknown as {
					__offerfinchTest: { open: (p: string) => void };
				}
			).__offerfinchTest.open(to),
		"/settings/general",
	);
}

/**
 * Over-the-air updates, with a fake updater standing in for GitHub Releases: the update is found
 * at launch, downloads in the background, is announced once, and installs only on the user's
 * click (Settings, the sidebar, the app menu or the menu bar icon).
 */
test("an update downloads in the background and installs on Restart to Update", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-update-"));
	const { app, page, errors } = await launchApp({
		userData,
		env: { OFFERFINCH_FAKE_UPDATE: "9.9.9" },
	});
	try {
		await openSettings(app, page);
		await expect(page.getByTestId("update-status")).toContainText(
			"Version 9.9.9 is downloaded",
			{ timeout: 15_000 },
		);
		const hooks = () =>
			app.evaluate(() => {
				const g = globalThis as unknown as {
					__offerfinchTest: { updateNotices: { title: string }[] };
					__offerfinchInstalls?: number;
				};
				return {
					notices: g.__offerfinchTest.updateNotices.map((n) => n.title),
					installs: g.__offerfinchInstalls ?? 0,
				};
			});
		expect(await hooks()).toEqual({
			notices: ["OfferFinch 9.9.9 is ready"],
			installs: 0,
		});
		const appMenu = await app.evaluate(({ Menu }) =>
			(Menu.getApplicationMenu()?.items[0]?.submenu?.items ?? []).map(
				(i) => i.label,
			),
		);
		expect(appMenu).toContain("Restart to Update to 9.9.9");

		// Checking again while one is ready does nothing; the sidebar offers the restart too.
		await expect(page.getByTestId("update-check")).toHaveCount(0);
		await expect(page.getByTestId("sidebar-update")).toBeVisible();
		await page.getByTestId("update-install").click();
		await expect.poll(async () => (await hooks()).installs).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("a test build without an update feed says it doesn't update itself", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-update-"));
	const { app, page } = await launchApp({ userData });
	try {
		await openSettings(app, page);
		await expect(page.getByTestId("update-status")).toHaveText(
			"Test builds don't update themselves.",
			{ timeout: 15_000 },
		);
		await expect(page.getByTestId("update-check")).toBeDisabled();
		await expect(page.getByTestId("sidebar-update")).toHaveCount(0);
	} finally {
		await app.close();
	}
});
