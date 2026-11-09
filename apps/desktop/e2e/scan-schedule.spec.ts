import { expect, test } from "@playwright/test";

import { launchApp, openRoute, tempUserData } from "./launch";
import { withDb } from "./matches-setup";

/**
 * Settings › General › Running: the scan interval and quiet hours save as they change and are
 * the same after a restart.
 */
test("scan interval and quiet hours are saved and kept across a restart", async () => {
	test.setTimeout(120_000);
	const userData = tempUserData();
	{
		const { app, page, errors } = await launchApp({ userData });
		try {
			await openRoute(app, page, "/settings/general");
			await expect(page.getByLabel("Pause scans")).toBeVisible({
				timeout: 30_000,
			});
			await expect(page.getByTestId("scan-every")).toHaveText(/Every hour/);
			// Off by default: no times shown.
			await expect(page.getByTestId("quiet-start")).toHaveCount(0);

			await page.getByTestId("scan-every").click();
			await page.getByTestId("scan-every-6").click();
			await expect(page.getByTestId("scan-every")).toHaveText(/Every 6 hours/);

			await page.getByTestId("quiet-hours").click();
			await expect(page.getByTestId("quiet-start")).toHaveValue("22:00");
			await expect(page.getByTestId("quiet-end")).toHaveValue("07:00");
			await page.getByTestId("quiet-start").fill("23:30");
			await expect(page.getByTestId("quiet-start")).toHaveValue("23:30");
			// Saved once the worker has it: the stored row, read from the database.
			await expect
				.poll(() =>
					withDb(userData, (db) =>
						JSON.parse(
							(
								db
									.prepare("select value from app_settings where key = ?")
									.get("scanSchedule") as { value: string } | undefined
							)?.value ?? "null",
						),
					),
				)
				.toEqual({
					every: 6,
					quietHours: { enabled: true, start: "23:30", end: "07:00" },
				});
			expect(errors).toEqual([]);
		} finally {
			await app.close();
		}
	}
	{
		const { app, page, errors } = await launchApp({ userData });
		try {
			await openRoute(app, page, "/settings/general");
			await expect(page.getByTestId("scan-every")).toHaveText(/Every 6 hours/, {
				timeout: 30_000,
			});
			await expect(page.getByTestId("quiet-hours")).toBeChecked();
			await expect(page.getByTestId("quiet-start")).toHaveValue("23:30");
			await expect(page.getByTestId("quiet-end")).toHaveValue("07:00");
			expect(errors).toEqual([]);
		} finally {
			await app.close();
		}
	}
});
