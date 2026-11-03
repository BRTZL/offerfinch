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
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import {
	launchApp,
	openRoute,
	pickFakeModels,
	RESUME,
	skipRestOfSetup,
	tempUserData,
	toastsGone,
} from "./launch";

/**
 * Backup and restore, in the background: an instance with a profile and a scan's jobs exports a
 * backup; a fresh instance restores it and its screens show the same data. Then a damaged zip
 * and one from a newer schema are refused with the current data untouched. Native dialogs are
 * answered by replacing them in main. Screenshots go to E2E_SHOTS (or test-results).
 */
const SHOTS = process.env.E2E_SHOTS ?? path.join("test-results", "backup");
const A = tempUserData();
const B = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-e2e-restore-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-e2e-zips-"));
const zip = path.join(outside, "offerfinch-backup.zip");

function count(userData: string, table: string): number {
	const db = new Database(path.join(userData, DB_FILE), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		return (
			db.prepare(`select count(*) n from ${table}`).get() as { n: number }
		).n;
	} finally {
		db.close();
	}
}

/** The next save or open dialog answers with this file, as if the user picked it. */
const answerDialogs = (app: ElectronApplication, file: string) =>
	app.evaluate(({ dialog }, f) => {
		dialog.showSaveDialog = (async () => ({
			canceled: false,
			filePath: f,
		})) as unknown as typeof dialog.showSaveDialog;
		dialog.showOpenDialog = (async () => ({
			canceled: false,
			filePaths: [f],
		})) as unknown as typeof dialog.showOpenDialog;
	}, file);

async function yourData(app: ElectronApplication, page: Page) {
	await openRoute(app, page, "/settings/your-data");
	await expect(page.getByTestId("storage-summary")).toBeVisible({
		timeout: 30_000,
	});
}

const summaryText = (page: Page) =>
	page
		.getByTestId("storage-summary")
		.locator("[data-ds=row]")
		.filter({ hasNotText: "On disk" })
		.allInnerTexts();

/** A screenshot once toasts are gone and dialogs have finished opening. */
const shot = async (page: Page, name: string) => {
	await toastsGone(page, 15_000);
	await page.waitForTimeout(500);
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, name) });
};

const theme = (app: ElectronApplication, source: "light" | "dark") =>
	app.evaluate(({ nativeTheme }, s) => {
		nativeTheme.themeSource = s;
	}, source);

let summaryA: string[] = [];
let jobsA = 0;

test.describe
	.serial("backup and restore", () => {
		test("a backup exported on one instance restores on a fresh one with the same data", async () => {
			const boards = await startFixtureBoards();
			const a = await launchApp({
				userData: A,
				rewrite: boards.rewrite,
				siteOrigins: boards.siteOrigins,
			});
			try {
				const { page } = a;
				await page.setViewportSize({ width: 1280, height: 860 });
				await page.getByTestId("welcome-start").click();
				await pickFakeModels(page);
				await page.getByTestId("step-continue").click();
				await page.getByTestId("resume-option-paste").click();
				await page.getByTestId("onboarding-text").fill(RESUME);
				await page.getByTestId("onboarding-structure").click();
				await page.getByTestId("onboarding-save").click({ timeout: 60_000 });
				await skipRestOfSetup(page);
				await page.getByTestId("scan-status").click();
				await page.getByTestId("scan-now").first().click();
				await expect
					.poll(
						() =>
							count(A, "flow_runs where kind = 'scan' and status = 'complete'"),
						{ timeout: 120_000 },
					)
					.toBe(1);
				await expect
					.poll(() => count(A, "applications where state = 'found'"), {
						timeout: 120_000,
					})
					.toBe(0);
				jobsA = count(A, "jobs");
				expect(jobsA).toBeGreaterThan(0);
				// An API key on A must not travel; a stored file must.
				fs.writeFileSync(
					path.join(A, "secrets.json"),
					'{"anthropic":"sealed"}',
				);
				fs.mkdirSync(path.join(A, "files", "e2e"), { recursive: true });
				fs.writeFileSync(path.join(A, "files", "e2e", "note.txt"), "from A");

				await yourData(a.app, page);
				summaryA = await summaryText(page);
				expect(summaryA.find((t) => t.startsWith("Jobs found"))).toContain(
					String(jobsA),
				);
				await answerDialogs(a.app, zip);
				await page.getByTestId("backup-export").click();
				await expect(page.getByText("Saved the backup as")).toBeVisible({
					timeout: 30_000,
				});
				await theme(a.app, "light");
				await expect(page.locator("html")).not.toHaveClass(/dark/);
				await page.getByTestId("backup").scrollIntoViewIfNeeded();
				await shot(page, "your-data-light.png");
				await theme(a.app, "dark");
				await expect(page.locator("html")).toHaveClass(/dark/);
				await shot(page, "your-data-dark.png");
				await page.getByTestId("privacy-doc-open").click();
				await expect(page.getByTestId("privacy-doc")).toContainText(
					"What leaves this Mac",
				);
				await expect(page.getByTestId("privacy-doc")).toContainText(
					"uninstall guide",
				);
				await shot(page, "privacy-dark.png");
				await page.keyboard.press("Escape");
				await expect(page.getByTestId("privacy-doc")).toHaveCount(0);
				await page.getByTestId("uninstall-doc-open").click();
				await expect(page.getByTestId("uninstall-doc")).toContainText(
					"OfferFinch Safe Storage",
				);
				await expect(page.getByTestId("uninstall-doc")).toContainText(
					"Privacy",
				);
			} finally {
				await a.app.close();
				await boards.close();
			}
			const unpacked = fs.mkdtempSync(path.join(outside, "unpacked-"));
			execFileSync("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
			expect(fs.readdirSync(unpacked).sort()).toEqual(
				["files", "manifest.json", DB_FILE].sort(),
			);

			const b = await launchApp({ userData: B });
			try {
				const { page } = b;
				await page.setViewportSize({ width: 1280, height: 860 });
				await expect
					.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
					.toBe("/onboarding");
				fs.writeFileSync(path.join(B, "secrets.json"), '{"openai":"b-sealed"}');
				await yourData(b.app, page);
				await answerDialogs(b.app, zip);
				await page.getByTestId("backup-restore").click();
				const confirm = page.getByTestId("restore-confirm-dialog");
				await expect(confirm).toBeVisible({ timeout: 30_000 });
				await expect(confirm.getByTestId("backup-Jobs found")).toHaveText(
					String(jobsA),
				);
				await theme(b.app, "light");
				await shot(page, "restore-confirm-light.png");
				await confirm.getByTestId("restore-confirm").click();
				await expect(page.getByText("Backup restored.")).toBeVisible({
					timeout: 90_000,
				});
				await expect(page.getByTestId("storage-summary")).toBeVisible();
				await expect.poll(() => summaryText(page)).toEqual(summaryA);
				expect(count(B, "jobs")).toBe(jobsA);
				// B's own key stays; A's never arrived.
				expect(fs.readFileSync(path.join(B, "secrets.json"), "utf8")).toBe(
					'{"openai":"b-sealed"}',
				);
				// The empty data B had is kept as a safety backup.
				expect(
					fs
						.readdirSync(path.join(B, "backups"))
						.filter((f) => /^before-restore-.*\.zip$/.test(f)),
				).toHaveLength(1);
				expect(fs.readdirSync(path.join(B, "staging"))).toEqual([]);
				expect(
					fs.readFileSync(path.join(B, "files", "e2e", "note.txt"), "utf8"),
				).toBe("from A");

				// The screens read the restored data: the profile, and the Inbox's matches.
				await openRoute(b.app, page, "/profile/experience");
				await expect(page.getByText("Tidewater Health").first()).toBeVisible({
					timeout: 30_000,
				});
				await openRoute(b.app, page, "/inbox");
				await expect(
					page
						.getByTestId("inbox-group")
						.or(page.getByTestId("inbox-row"))
						.first(),
				).toBeVisible({ timeout: 30_000 });
			} finally {
				await b.app.close();
			}
		});

		test("a damaged backup and one from a newer schema are refused, and the data stays", async () => {
			const damaged = path.join(outside, "damaged.zip");
			const bytes = fs.readFileSync(zip);
			fs.writeFileSync(
				damaged,
				bytes.subarray(0, Math.floor(bytes.length / 2)),
			);

			// A's backup as a newer version would write it: a migration this app does not know.
			const unpacked = fs.mkdtempSync(path.join(outside, "newer-"));
			execFileSync("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
			const db = new Database(path.join(unpacked, DB_FILE));
			db.prepare(
				"insert into __migrations (name, applied_at) values (?, ?)",
			).run("29991231000000_from_the_future", Date.now());
			db.close();
			const manifestFile = path.join(unpacked, "manifest.json");
			const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
			manifest.tables.__migrations += 1;
			fs.writeFileSync(manifestFile, JSON.stringify(manifest));
			const newer = path.join(outside, "newer.zip");
			execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", unpacked, newer]);

			const b = await launchApp({ userData: B });
			try {
				const { page } = b;
				await page.setViewportSize({ width: 1280, height: 860 });
				await yourData(b.app, page);
				const before = await summaryText(page);
				const backupsBefore = fs.readdirSync(path.join(B, "backups")).sort();
				for (const [file, said] of [
					[damaged, "not an OfferFinch backup, or it is damaged"],
					[newer, "made by a newer version of OfferFinch"],
				] as const) {
					await answerDialogs(b.app, file);
					await page.getByTestId("backup-restore").click();
					await expect(page.getByText(said)).toBeVisible({ timeout: 30_000 });
					await expect(page.getByTestId("restore-confirm-dialog")).toHaveCount(
						0,
					);
				}
				await expect.poll(() => summaryText(page)).toEqual(before);
				expect(count(B, "jobs")).toBe(jobsA);
				expect(fs.readdirSync(path.join(B, "backups")).sort()).toEqual(
					backupsBefore,
				);
				expect(fs.readdirSync(path.join(B, "staging"))).toEqual([]);
			} finally {
				await b.app.close();
			}
		});
	});
