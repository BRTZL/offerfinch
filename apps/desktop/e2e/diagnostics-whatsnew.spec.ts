import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from "@playwright/test";

import {
	APP_DIR,
	launchApp,
	openRoute,
	tempUserData,
	toastsGone,
} from "./launch";
import { onboardWithFakes, shootBothThemes, withDb } from "./matches-setup";

/**
 * Export Diagnostics (issue #54) and What's new (issue #9), in the background on a fabricated
 * profile and fabricated logs. The bundle is reviewed in a sheet, saved to a test path and
 * unzipped: no planted canary survives in any file. What's new shows nothing on a first run,
 * shows a newer version's notes once, and stays dismissed. Screenshots go to E2E_SHOTS or
 * test-results/diagnostics-whatsnew-shots.
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ??
		path.join(APP_DIR, "test-results", "diagnostics-whatsnew-shots"),
);
const userData = tempUserData();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "of-diag-e2e-"));
const zip = path.join(work, "bundle.zip");

/** Fabricated release notes, so the test does not change with the real changelog. */
const changelog = path.join(work, "CHANGELOG.md");
fs.writeFileSync(
	changelog,
	"# What's new\n\n## Unreleased\n\n- Not out yet.\n\n## 1.1.0 (2026-11-03)\n\n- **Eleven** arrived: the newer notes.\n\n## 1.0.0\n\n- The first notes.\n",
);

/** The e2e resume's fabricated person (launch.ts RESUME) and secrets, planted in the logs. */
const CANARIES = [
	"Sam Rivera",
	"sam.rivera@example.test",
	"555 010 0199",
	"sk-ant-FAKE0e2e0canary0key",
	"FAKEe2eBearerTOKEN",
	"e2eQuerySECRET",
	"/Users/e2ecanaryuser",
];
const PLANTED = [
	"2026-11-03T09:00:00.000Z worker info: profile owner Sam Rivera",
	"2026-11-03T09:00:01.000Z mail sam.rivera@example.test phone +1 555 010 0199",
	'2026-11-03T09:00:02.000Z key {"apiKey":"sk-ant-FAKE0e2e0canary0key"}',
	"2026-11-03T09:00:03.000Z Authorization: Bearer FAKEe2eBearerTOKEN",
	"2026-11-03T09:00:04.000Z GET https://jobs.example.com/search?q=e2eQuerySECRET",
	"2026-11-03T09:00:05.000Z opened /Users/e2ecanaryuser/Documents",
].join("\n");

function plant() {
	fs.mkdirSync(path.join(userData, "logs"), { recursive: true });
	fs.writeFileSync(path.join(userData, "logs", "main.log"), `${PLANTED}\n`);
	fs.mkdirSync(path.join(userData, "site-debug"), { recursive: true });
	fs.writeFileSync(
		path.join(
			userData,
			"site-debug",
			"2026-11-03T09-00-00-000Z-linkedin-selectors.html",
		),
		`<!--\nreason: ${PLANTED}\n-->\n<main><h3 class="jobTitle">Engineer</h3></main>`,
	);
}

const launch = (version: string) =>
	launchApp({
		userData,
		env: {
			OFFERFINCH_TEST_VERSION: version,
			OFFERFINCH_TEST_CHANGELOG: changelog,
			OFFERFINCH_TEST_SAVE_TO: zip,
		},
	});

/** The stored What's new version, as JSON text; null before the database exists. */
function seen(): string | null {
	try {
		return withDb(
			userData,
			(db) =>
				(
					db
						.prepare(
							"select value from app_settings where key = 'whatsNewSeen'",
						)
						.get() as { value: string } | undefined
				)?.value ?? null,
		);
	} catch {
		return null;
	}
}

function unzipped(): { name: string; text: string }[] {
	const out = path.join(work, "unzipped");
	fs.rmSync(out, { recursive: true, force: true });
	execFileSync("/usr/bin/ditto", ["-x", "-k", zip, out]);
	const read = (dir: string, prefix = ""): { name: string; text: string }[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			const name = `${prefix}${entry.name}`;
			return entry.isDirectory()
				? read(full, `${name}/`)
				: [{ name, text: fs.readFileSync(full, "utf8") }];
		});
	return read(out);
}

function expectNoCanary(text: string, where: string) {
	for (const canary of CANARIES)
		expect(text.toLowerCase(), `${canary} in ${where}`).not.toContain(
			canary.toLowerCase(),
		);
}

async function quiet(page: Page) {
	await toastsGone(page, 15_000);
}

async function close(app: ElectronApplication) {
	await app.close();
}

test("diagnostics: reviewed, redacted and saved; What's new: once per version", async () => {
	test.setTimeout(240_000);
	fs.mkdirSync(SHOTS, { recursive: true });
	plant();

	// First run on 1.0.0: onboarding, no release notes; the version is stored at once.
	{
		const { app, page, errors } = await launch("1.0.0");
		try {
			await page.setViewportSize({ width: 1280, height: 800 });
			await expect.poll(seen, { timeout: 30_000 }).toBe('"1.0.0"');
			await onboardWithFakes(page);
			await quiet(page);
			await expect(page.getByTestId("whats-new-sheet")).toHaveCount(0);

			// Help › Export Diagnostics…: the sheet lists every file, previews each, holds no
			// planted detail (the profile's name included), and saves only on Save.
			await app.evaluate(({ Menu }) => {
				Menu.getApplicationMenu()
					?.getMenuItemById("export-diagnostics")
					?.click();
			});
			const sheet = page.getByTestId("diagnostics-sheet");
			await expect(sheet).toBeVisible();
			const files = sheet.getByTestId("diagnostics-file");
			await expect(files.first()).toBeVisible({ timeout: 30_000 });
			const names = await files.allTextContents();
			for (const want of [
				"manifest.json",
				"system.txt",
				"settings.json",
				"logs/main.log",
			])
				expect(names.join(" ")).toContain(want);
			expect(names.join(" ")).toContain("site-debug/");
			await expect(sheet.getByTestId("diagnostics-warning")).toHaveCount(0);
			const preview = sheet.getByTestId("diagnostics-preview");
			for (let i = 0; i < names.length; i++) {
				await files.nth(i).click();
				expectNoCanary((await preview.textContent()) ?? "", names[i] ?? "");
			}
			await files.filter({ hasText: "logs/main.log" }).click();
			await expect(preview).toContainText("[name]");
			await expect(preview).toContainText('"apiKey":"[redacted]"');
			// Migration names keep their time stamps (not taken for phone numbers).
			await expect(preview).toContainText(/\d{14}_init/);
			expect(fs.existsSync(zip)).toBe(false);
			await shootBothThemes(app, page, (t) =>
				path.join(SHOTS, `diagnostics-review-${t}.png`),
			);
			await sheet.getByTestId("diagnostics-save").click();
			await expect(sheet).toHaveCount(0);
			const bundle = unzipped();
			expect(bundle.map((f) => f.name)).toContain(
				"offerfinch-diagnostics/settings.json",
			);
			for (const file of bundle)
				expectNoCanary(`${file.name}\n${file.text}`, file.name);
			const settings = JSON.parse(
				bundle.find((f) => f.name.endsWith("settings.json"))?.text ?? "{}",
			);
			expect(settings.models.map((m: { kind: string }) => m.kind)).toEqual([
				"fake",
				"fake",
				"fake",
			]);

			// Settings › General opens it too; Cancel leaves nothing behind.
			fs.rmSync(zip);
			await openRoute(app, page, "/settings/general");
			await page.getByTestId("diagnostics-open").click();
			await expect(sheet.getByTestId("diagnostics-file").first()).toBeVisible({
				timeout: 30_000,
			});
			await sheet.getByRole("button", { name: "Cancel" }).click();
			await expect(sheet).toHaveCount(0);
			expect(fs.existsSync(zip)).toBe(false);
			expect(errors).toEqual([]);
		} finally {
			await close(app);
		}
	}

	// Same version again: nothing. Help › Export Diagnostics… with the window closed opens a
	// new window with the sheet in it (the app lives in the menu bar).
	{
		const { app, page } = await launch("1.0.0");
		try {
			await expect(page.getByTestId("scan-status")).toBeVisible({
				timeout: 30_000,
			});
			await page.waitForTimeout(2_000);
			await expect(page.getByTestId("whats-new-sheet")).toHaveCount(0);

			const reopened = app.waitForEvent("window");
			await app.evaluate(({ BrowserWindow }) => {
				for (const win of BrowserWindow.getAllWindows()) win.close();
			});
			await expect.poll(() => app.windows().length).toBe(0);
			await app.evaluate(({ Menu }) => {
				Menu.getApplicationMenu()
					?.getMenuItemById("export-diagnostics")
					?.click();
			});
			const fresh = await reopened;
			await expect(
				fresh
					.getByTestId("diagnostics-sheet")
					.getByTestId("diagnostics-file")
					.first(),
			).toBeVisible({ timeout: 30_000 });
		} finally {
			await close(app);
		}
	}

	// Updated to 1.1.0: the newer notes, once.
	{
		const { app, page } = await launch("1.1.0");
		try {
			await page.setViewportSize({ width: 1280, height: 800 });
			const sheet = page.getByTestId("whats-new-sheet");
			await expect(sheet).toBeVisible({ timeout: 30_000 });
			await expect(sheet).toContainText("Version 1.1.0");
			await expect(sheet).toContainText("the newer notes");
			await expect(sheet).not.toContainText("The first notes");
			await expect(sheet).not.toContainText("Not out yet");
			expect(seen()).toBe('"1.0.0"');
			await shootBothThemes(app, page, (t) =>
				path.join(SHOTS, `whats-new-${t}.png`),
			);
			await sheet.getByTestId("whats-new-done").click();
			await expect(sheet).toHaveCount(0);
			await expect.poll(seen).toBe('"1.1.0"');
		} finally {
			await close(app);
		}
	}

	// 1.1.0 again: dismissed for good; Settings › General › What's new still opens it.
	{
		const { app, page } = await launch("1.1.0");
		try {
			await expect(page.getByTestId("scan-status")).toBeVisible({
				timeout: 30_000,
			});
			await page.waitForTimeout(2_000);
			const sheet = page.getByTestId("whats-new-sheet");
			await expect(sheet).toHaveCount(0);
			await openRoute(app, page, "/settings/general");
			await page.getByTestId("whats-new-open").click();
			await expect(sheet).toBeVisible();
			await expect(sheet).toContainText("the newer notes");
			await expect(sheet).toContainText("The first notes");
		} finally {
			await close(app);
		}
	}
});
