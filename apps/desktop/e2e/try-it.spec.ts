import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { DB_FILE } from "../src/main/database-file";
import type { DesktopBridge } from "../src/shared/bridge";
import { APP_DIR, launchApp, tempUserData } from "./launch";
import { showStatus } from "./matches-setup";

/**
 * Try-it mode (issue #47) from a fresh install: Try it with sample data on the welcome, the
 * sample matches in the Inbox with the strip on every screen, one prepared by the test models,
 * reviewed, approved, handed off and marked applied, then Leave demo back to the real first-run
 * welcome. The real database is never opened while the demo runs: its bytes, mtime and
 * WAL files stay the same, and the demo folder is gone after. Test models are not turned on by
 * the test (`OFFERFINCH_FAKE_MODELS=0`): demo mode turns them on itself, as in a shipped build.
 * Screenshots go to test-results/try-it-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "try-it-shots"),
);
const userData = tempUserData();
const realDb = path.join(userData, DB_FILE);
const demoDir = path.join(userData, "demo");

/** A read of the demo database (only the real one must stay closed). */
function demoDb<T>(query: string, ...params: unknown[]): T[] {
	const db = new Database(path.join(demoDir, DB_FILE), {
		readonly: true,
		fileMustExist: true,
	});
	db.pragma("busy_timeout = 5000");
	try {
		return db.prepare(query).all(...params) as T[];
	} finally {
		db.close();
	}
}

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

const docTab = (page: Page, name: RegExp) =>
	page.getByRole("tablist", { name: "Document" }).getByRole("tab", { name });

/** The fake checker flags lines of its own draft: settle one open flag, as a user would. */
async function settleOneFlag(page: Page) {
	for (const tab of [/^CV/, /^Letter/, /^Answers/]) {
		const t = docTab(page, tab);
		if ((await t.count()) === 0) continue;
		await t.click();
		const open = page
			.getByTestId("flag")
			.filter({ has: page.getByTestId("flag-delete") });
		if ((await open.count()) === 0) continue;
		const first = open.first();
		const confirm = first.getByTestId("flag-confirm");
		if (await confirm.count()) {
			await confirm.click();
			await page.getByTestId("flag-confirm-yes").click();
		} else await first.getByTestId("flag-delete").click();
		return;
	}
}

/** The real database as files on disk, read with fs only (opening it could touch -shm). */
function fingerprint() {
	const side = (suffix: string) => {
		const f = `${realDb}${suffix}`;
		return fs.existsSync(f) ? fs.statSync(f).size : null;
	};
	return {
		sha256: createHash("sha256").update(fs.readFileSync(realDb)).digest("hex"),
		mtimeMs: fs.statSync(realDb).mtimeMs,
		wal: side("-wal"),
		shm: side("-shm"),
	};
}

test("try it with sample data: matches, prepare, review, applied, then leave without touching the real data", async () => {
	fs.mkdirSync(SHOTS, { recursive: true });
	const { app, page, errors } = await launchApp({
		userData,
		env: { OFFERFINCH_FAKE_MODELS: "0" },
	});
	try {
		await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 30_000 });
		await page.screenshot({ path: path.join(SHOTS, "1-welcome.png") });
		expect(fs.existsSync(realDb)).toBe(true);

		await page.getByTestId("welcome-demo").click();
		const banner = page.getByTestId("demo-banner");
		await expect(banner).toBeVisible({ timeout: 60_000 });
		await expect(banner).toContainText("Sample data. Nothing here is real.");
		expect(fs.existsSync(path.join(demoDir, DB_FILE))).toBe(true);
		// The real worker has closed the real database: from here on it must not change.
		const before = fingerprint();
		expect(before.wal).toBeNull();
		expect(
			await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0]?.getTitle(),
			),
		).toBe("OfferFinch (sample data)");

		// Setup is done in the demo: Home, then the Inbox fills with the sample matches.
		await expect(page.getByTestId("home")).toBeVisible({ timeout: 30_000 });
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: /^Inbox/ })
			.click();
		await expect
			.poll(() => page.getByTestId("inbox-row").count(), { timeout: 120_000 })
			.toBeGreaterThanOrEqual(4);
		await expect(
			page.getByTestId("inbox-row").filter({ hasText: "Lumen Clinics" }),
		).toBeVisible();
		await expect(banner).toBeVisible();
		// The first search of the sample jobs ends, every job checked.
		await expect
			.poll(
				() =>
					demoDb<{ n: number }>(
						"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
					)[0]?.n,
				{ timeout: 120_000 },
			)
			.toBe(1);
		await expect(page.getByTestId("scan-status")).toContainText(/Scanned/, {
			timeout: 30_000,
		});
		await page.screenshot({ path: path.join(SHOTS, "2-demo-inbox.png") });

		// Interested in a match: drafted by the test model, checked, then review.
		const kestrel = page
			.getByTestId("inbox-row")
			.filter({ hasText: "Kestrel Freight" });
		await kestrel.click();
		await expect(page.getByTestId("interested")).toBeVisible();
		// No link leaves the app in the demo: one the page asks to open is refused, with a toast
		// (an .invalid name, so even a slip would reach nothing).
		await page.evaluate(() =>
			(window as unknown as { desktop: DesktopBridge }).desktop.openExternal(
				"https://posting.example.invalid/jobs/1",
			),
		);
		await expect(page.getByText("Links are off in the demo")).toBeVisible();
		const appId = new URL(page.url()).pathname.split("/").pop();
		await page.getByTestId("interested").click();
		await expect(page.getByTestId("interested")).toHaveCount(0);
		const stateOf = () =>
			demoDb<{ state: string }>(
				"select state from applications where id = ?",
				appId,
			)[0]?.state;
		await expect
			.poll(stateOf, { timeout: 120_000 })
			.toMatch(/^(needs_answers|ready_for_review|needs_human)$/);
		if (stateOf() === "needs_answers") {
			// A question for a fact the profile lacks: answer it, the draft goes on.
			await sidebar(page, "Questions").click();
			const answer = page.getByRole("textbox").first();
			await expect(answer).toBeVisible({ timeout: 60_000 });
			await answer.fill("One month.");
			await page
				.getByRole("button", { name: /save|answer/i })
				.first()
				.click();
			await expect
				.poll(stateOf, { timeout: 120_000 })
				.toMatch(/^(ready_for_review|needs_human)$/);
		}
		await sidebar(page, "Inbox").click();
		await showStatus(page, /^To review/);
		await page
			.getByTestId("inbox-row")
			.filter({ hasText: "Kestrel Freight" })
			.click();
		await expect(page.getByTestId("approve")).toBeVisible({ timeout: 60_000 });
		await page.screenshot({ path: path.join(SHOTS, "3-demo-review.png") });
		const approve = page.getByRole("button", { name: /^Approve/ }).first();
		await expect
			.poll(
				async () => {
					if (await approve.isEnabled()) return true;
					await settleOneFlag(page);
					return approve.isEnabled();
				},
				{ timeout: 150_000, intervals: [1_500] },
			)
			.toBe(true);
		await approve.click();
		// A sample job is handed off: Mark applied, then it is in Applied.
		await expect(page.getByTestId("handoff")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId("handoff")).toContainText(/sample job/i);
		// The hand-off step names the form without a link, and the posting has none.
		expect(
			await page.getByTestId("handoff-link").evaluate((e) => e.tagName),
		).toBe("SPAN");
		await expect(
			page.locator('a[href^="https://jobs.sample.invalid"]'),
		).toHaveCount(0);
		await page.getByTestId("mark-submitted").click();
		await expect.poll(stateOf, { timeout: 60_000 }).toBe("applied");
		await sidebar(page, "Applied").click();
		await expect(page.getByText("Kestrel Freight").first()).toBeVisible({
			timeout: 30_000,
		});
		await expect(banner).toBeVisible();
		await page.screenshot({ path: path.join(SHOTS, "4-demo-applied.png") });
		expect(fingerprint()).toEqual(before);

		await page.getByTestId("demo-leave").click();
		await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 60_000 });
		await expect(banner).toHaveCount(0);
		await page.screenshot({ path: path.join(SHOTS, "5-back-to-welcome.png") });
		expect(fs.existsSync(demoDir)).toBe(false);
		expect(
			await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0]?.getTitle(),
			),
		).toBe("OfferFinch");
		expect(errors.filter((e) => !/ERR_ABORTED|net::/.test(e))).toEqual([]);
	} finally {
		await app.close();
	}
	// Until the real worker reopened it on leaving, the real database was never written.
	expect(fs.existsSync(realDb)).toBe(true);
});
