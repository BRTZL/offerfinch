import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { DB_FILE } from "../src/main/database-file";
import { APP_DIR, launchApp, tempUserData } from "./launch";
import { showStatus } from "./matches-setup";

/**
 * ⌘F in an open application (components/system/find-bar.tsx), on the sample data: in the
 * posting of a match, then in its drafted CV. Matches are painted with the CSS Custom Highlight
 * API; ↩, ⇧↩ and ⌘G step through them, Esc closes and clears them. The sidebar and the lists
 * are never searched. Screenshots and a recording go to test-results/find-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "find-shots"),
);
const userData = tempUserData();
const demoDir = path.join(userData, "demo");

function demoState(id: string | undefined) {
	const db = new Database(path.join(demoDir, DB_FILE), {
		readonly: true,
		fileMustExist: true,
	});
	db.pragma("busy_timeout = 5000");
	try {
		return (
			db.prepare("select state from applications where id = ?").get(id) as
				| { state: string }
				| undefined
		)?.state;
	} finally {
		db.close();
	}
}

const highlights = (page: Page) =>
	page.evaluate(() => ({
		all: CSS.highlights.get("find")?.size ?? 0,
		current: [...(CSS.highlights.get("find-current") ?? [])].map((r) =>
			String(r),
		),
	}));

test("⌘F finds text in the posting and the CV, steps through matches, and Esc clears them", async () => {
	fs.mkdirSync(SHOTS, { recursive: true });
	const { app, page, errors } = await launchApp({
		userData,
		env: { OFFERFINCH_FAKE_MODELS: "0" },
		recordVideoDir: SHOTS,
	});
	try {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.getByTestId("welcome-demo").click({ timeout: 30_000 });
		await expect(page.getByTestId("demo-banner")).toBeVisible({
			timeout: 60_000,
		});
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: /^Inbox/ })
			.click();
		const kestrel = page
			.getByTestId("inbox-row")
			.filter({ hasText: "Kestrel Freight" });
		await expect(kestrel).toBeVisible({ timeout: 120_000 });
		await kestrel.click();
		await expect(page.getByTestId("posting")).toBeVisible();

		// The posting: a word it has more than once.
		const posting = (
			(await page.getByTestId("posting").textContent()) ?? ""
		).trim();
		const word =
			posting
				.split(/[^\p{L}]+/u)
				.filter((w) => w.length > 4)
				.find(
					(w) => posting.toLowerCase().split(w.toLowerCase()).length - 1 >= 2,
				) ?? "";
		expect(word).not.toBe("");
		await page.keyboard.press("ControlOrMeta+f");
		const input = page.getByTestId("find-input");
		await expect(input).toBeFocused();
		await input.fill(word.toUpperCase());
		const count = page.getByTestId("find-count");
		await expect(count).toHaveText(/^1 of \d+$/);
		const total = Number(((await count.textContent()) ?? "").split(" of ")[1]);
		expect(total).toBeGreaterThanOrEqual(2);
		expect((await highlights(page)).all).toBe(total);
		expect((await highlights(page)).current[0]?.toLowerCase()).toBe(
			word.toLowerCase(),
		);
		await page.screenshot({ path: path.join(SHOTS, "1-posting-find.png") });

		await input.press("Enter");
		await expect(count).toHaveText(`2 of ${total}`);
		await input.press("Shift+Enter");
		await expect(count).toHaveText(`1 of ${total}`);
		await input.press("Shift+Enter");
		await expect(count).toHaveText(`${total} of ${total}`);
		await page.keyboard.press("ControlOrMeta+g");
		await expect(count).toHaveText(`1 of ${total}`);

		// Edit › Find › Find Next and Find Previous step once each (menu, preload, page).
		const clickMenu = (id: string) =>
			app.evaluate(({ Menu }, itemId) => {
				Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click();
			}, id);
		// Past the window in which a command right after the key counts as the same press.
		await page.waitForTimeout(200);
		await clickMenu("find-next");
		await expect(count).toHaveText(`2 of ${total}`);
		await clickMenu("find-previous");
		await expect(count).toHaveText(`1 of ${total}`);

		// New text elsewhere in the detail repaints but does not pull the page back.
		const column = page.getByTestId("posting").locator("xpath=..");
		const scroller = page
			.locator("#application-detail .overflow-auto")
			.filter({ has: page.getByTestId("posting") })
			.first();
		// Away from the current (first) match, to the foot of the posting.
		const away = await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
			return el.scrollTop;
		});
		expect(away).toBeGreaterThan(0);
		await column.evaluate((el) =>
			el.append(
				Object.assign(document.createElement("p"), { textContent: "x" }),
			),
		);
		await page.waitForTimeout(400);
		expect(await scroller.evaluate((el) => el.scrollTop)).toBe(away);

		// Another inbox row's company, not in this posting: the list is not searched.
		await input.fill("Lumen Clinics");
		await expect(count).toHaveText("No results");
		expect((await highlights(page)).all).toBe(0);

		await input.fill("zzqxj-not-there");
		await expect(count).toHaveText("No results");
		await input.press("Escape");
		await expect(page.getByTestId("find-bar")).toHaveCount(0);
		expect((await highlights(page)).all).toBe(0);

		// Draft the CV and letter, then find in the CV.
		const appId = new URL(page.url()).pathname.split("/").pop();
		await page.getByTestId("interested").click();
		await expect
			.poll(() => demoState(appId), { timeout: 120_000 })
			.toMatch(/^(needs_answers|ready_for_review|needs_human)$/);
		test.skip(
			demoState(appId) === "needs_answers",
			"The sample draft waits for an answer; the posting part ran",
		);
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: /^Inbox/ })
			.click();
		await showStatus(page, /^To review/);
		await page
			.getByTestId("inbox-row")
			.filter({ hasText: "Kestrel Freight" })
			.click();
		await page
			.getByRole("tablist", { name: "Document" })
			.getByRole("tab", { name: /^CV/ })
			.click();
		const cv = page.locator(".doc-page--sheet").last();
		await expect(cv).toBeVisible({ timeout: 60_000 });
		const cvWord =
			((await cv.textContent()) ?? "")
				.split(/[^\p{L}]+/u)
				.find((w) => w.length > 5) ?? "";
		expect(cvWord).not.toBe("");
		await page.keyboard.press("ControlOrMeta+f");
		await expect(input).toBeFocused();
		await input.fill(cvWord);
		await expect(count).toHaveText(/^1 of \d+$/);
		expect((await highlights(page)).current[0]?.toLowerCase()).toBe(
			cvWord.toLowerCase(),
		);
		await page.screenshot({ path: path.join(SHOTS, "2-cv-find.png") });

		// ⌘F again keeps the query and selects it, so typing replaces it.
		await input.press("Escape");
		await page.keyboard.press("ControlOrMeta+f");
		await expect(input).toHaveValue(cvWord);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
