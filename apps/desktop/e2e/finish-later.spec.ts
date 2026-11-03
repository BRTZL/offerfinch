import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { launchApp } from "./launch";

test("Finish later on the first screen goes to Home and stays there", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-later-"));
	const { app, page, errors } = await launchApp({ userData });
	try {
		await expect(page.getByTestId("welcome-start")).toBeVisible({
			timeout: 30_000,
		});
		await page.getByTestId("onboarding-later").click();
		await expect(page.getByTestId("home")).toBeVisible({ timeout: 30_000 });
		// Home must not send a user who chose to finish later straight back to setup.
		await page.waitForTimeout(3_000);
		expect(new URL(page.url()).pathname).toBe("/");
		await expect(page.getByTestId("onboarding")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});
