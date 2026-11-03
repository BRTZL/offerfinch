import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { launchApp } from "./launch";

/** Settings › Notifications: the chirp is the default sound, and a new choice is kept. */
test("notification sound: chirp by default, a choice is kept", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-sound-"));
	const { app, page, errors } = await launchApp({ userData });
	const open = (to: string) =>
		app.evaluate(
			(_e, where) =>
				(
					globalThis as unknown as {
						__offerfinchTest: { open: (p: string) => void };
					}
				).__offerfinchTest.open(where),
			to,
		);
	try {
		// A new user starts in setup; wait for the app, then open Settings.
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe("/onboarding");
		await open("/settings/notifications");
		const select = page.getByTestId("notify-sound");
		await expect(select).toHaveText(/Chirp/, { timeout: 30_000 });
		await select.click();
		await page.getByTestId("notify-sound-none").click();
		await expect(select).toHaveText(/None/);
		await expect
			.poll(
				() =>
					JSON.parse(
						fs.readFileSync(path.join(userData, "notifications.json"), "utf8"),
					).sound,
			)
			.toBe("none");
		// Read back from the app after a reload.
		// The page reloads where it was (Settings › Notifications) and reads the choice back.
		await page.reload();
		await expect(page.getByTestId("notify-sound")).toHaveText(/None/, {
			timeout: 30_000,
		});
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
