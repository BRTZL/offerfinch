import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { DB_FILE } from "../src/main/database-file";
import { launchApp, openRoute, tempUserData } from "./launch";

/**
 * Settings › Writing in try-it mode: a style is saved (tone, length, a word to avoid, guidance),
 * read back after a reload, and the test models still draft the next application with it set.
 * Demo mode turns the test models on itself (`OFFERFINCH_FAKE_MODELS=0`), as in a shipped build.
 */
const userData = tempUserData();
const demoDir = path.join(userData, "demo");

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

test("writing style: saved in Settings, kept after a reload, and the sample job still drafts", async () => {
	const { app, page, errors } = await launchApp({
		userData,
		env: { OFFERFINCH_FAKE_MODELS: "0" },
	});
	try {
		await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 30_000 });
		await page.getByTestId("welcome-demo").click();
		await expect(page.getByTestId("demo-banner")).toBeVisible({
			timeout: 60_000,
		});
		await expect(page.getByTestId("home")).toBeVisible({ timeout: 30_000 });

		await openRoute(app, page, "/settings/writing");
		await expect(page.getByTestId("settings-writing")).toBeVisible();
		await page.getByTestId("writing-tone").click();
		await page.getByTestId("writing-tone-formal").click();
		await page.getByTestId("writing-length").click();
		await page.getByTestId("writing-length-shorter").click();
		await page.getByLabel("Words to avoid").fill("synergy,");
		await page
			.getByTestId("writing-guidance")
			.fill("Always use British spelling.");
		await page.getByTestId("save-writing").click();
		await expect(page.getByText(/The next draft uses it/)).toBeVisible();
		await expect
			.poll(
				() =>
					demoDb<{ value: string }>(
						"select value from app_settings where key = 'writingStyle'",
					)[0]?.value,
			)
			.toBeTruthy();
		const stored = JSON.parse(
			demoDb<{ value: string }>(
				"select value from app_settings where key = 'writingStyle'",
			)[0]?.value ?? "{}",
		);
		expect(stored).toEqual({
			tone: "formal",
			coverLetterLength: "shorter",
			avoidWords: ["synergy"],
			guidance: "Always use British spelling.",
		});
		await page.reload();
		await expect(page.getByTestId("writing-tone")).toHaveText(/Formal/, {
			timeout: 30_000,
		});
		await expect(page.getByTestId("writing-length")).toHaveText(/Shorter/);
		await expect(page.getByTestId("writing-avoid")).toContainText("synergy");

		// Prepare a sample match: the test models draft it with the style set.
		await openRoute(app, page, "/inbox");
		await expect
			.poll(() => page.getByTestId("inbox-row").count(), { timeout: 120_000 })
			.toBeGreaterThanOrEqual(4);
		const row = page
			.getByTestId("inbox-row")
			.filter({ hasText: "Kestrel Freight" });
		await row.click();
		await expect(page.getByTestId("interested")).toBeVisible();
		const appId = new URL(page.url()).pathname.split("/").pop();
		await page.getByTestId("interested").click();
		await expect
			.poll(
				() =>
					demoDb<{ state: string }>(
						"select state from applications where id = ?",
						appId,
					)[0]?.state,
				{ timeout: 120_000 },
			)
			.toMatch(/^(needs_answers|ready_for_review|needs_human)$/);
		// The draft is saved before any question is asked, so a letter exists either way.
		const letters = demoDb<{ content: string }>(
			"select content from documents where application_id = ? and kind = 'cover_letter' and content is not null",
			appId,
		);
		expect(letters.length).toBeGreaterThan(0);
		expect(letters[0]?.content.length).toBeGreaterThan(200);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
