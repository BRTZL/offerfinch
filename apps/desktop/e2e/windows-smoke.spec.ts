import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { DB_FILE } from "../src/main/database-file";

// Standalone packaged-app smoke: no fake shell scripts or installed CLI required.
// Also accepts a macOS .app/Contents/MacOS/OfferFinch executable for local checks.
test("packaged app opens SQLite and enters demo mode", async () => {
	const executablePath = process.env.OFFERFINCH_SMOKE_EXE;
	test.skip(
		!executablePath,
		"Set OFFERFINCH_SMOKE_EXE to a packaged executable",
	);
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-smoke-"));
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
		),
	) as Record<string, string>;
	try {
		const app = await electron.launch({
			executablePath,
			env: {
				...env,
				OFFERFINCH_USER_DATA: userData,
				OFFERFINCH_TEST: "1",
				OFFERFINCH_TEST_BACKGROUND: "1",
				OFFERFINCH_NO_SCHEDULE: "1",
				OFFERFINCH_FAKE_MODELS: "0",
			},
		});
		try {
			const page = await app.firstWindow();
			await expect(page.getByTestId("welcome")).toBeVisible({
				timeout: 60_000,
			});
			await page.getByTestId("welcome-demo").click();
			await expect(page.getByTestId("demo-banner")).toContainText(
				"Sample data. Nothing here is real.",
				{ timeout: 60_000 },
			);
			await expect(page.getByTestId("demo-banner")).toBeVisible();
			await expect(page.getByTestId("home")).toBeVisible({ timeout: 30_000 });
			const dbFile = path.join(userData, "demo", DB_FILE);
			expect(fs.existsSync(dbFile)).toBe(true);
			// A SQLite header proves the packaged native module opened a real database.
			const header = Buffer.alloc(16);
			const fd = fs.openSync(dbFile, "r");
			try {
				fs.readSync(fd, header, 0, header.length, 0);
			} finally {
				fs.closeSync(fd);
			}
			expect(header.toString()).toBe("SQLite format 3\0");
			await page.screenshot({
				path: test.info().outputPath("packaged-demo.png"),
			});
		} finally {
			await app.close();
		}
	} finally {
		fs.rmSync(userData, { recursive: true, force: true });
	}
});
