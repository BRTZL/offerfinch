import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import {
	APP_DIR,
	launchApp,
	openRoute,
	RESUME,
	skipRestOfSetup,
	tempUserData,
} from "./launch";

/**
 * A match's header and posting, in the background against the fixture boards: a posting open
 * in 140 countries reads as one summary line whose full list opens on hover, and in dark mode
 * the posting is on a dark surface, not white paper. Screenshots go to
 * test-results/posting-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "posting-shots"),
);
const userData = tempUserData();

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

function db() {
	return new Database(path.join(userData, DB_FILE), { fileMustExist: true });
}

// 140 remote places, one of them the user's country.
const MANY = Array.from({ length: 140 }, (_, i) =>
	i === 3 ? "Remote (Turkey)" : `Remote (Country ${i})`,
);

test("a long location list is one line; the posting is dark in dark mode", async () => {
	const boards = await startFixtureBoards();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.getByTestId("welcome-start").click();
		for (const role of ["scoring", "tailoring", "claims"]) {
			await page.getByTestId(`role-${role}-mode`).click();
			await page.getByTestId(`role-${role}-fake`).click();
		}
		await page.getByTestId("step-continue").click();
		await page.getByTestId("resume-option-paste").click();
		await page.getByTestId("onboarding-text").fill(RESUME);
		await page.getByTestId("onboarding-structure").click();
		await page.getByTestId("onboarding-save").click({ timeout: 60_000 });
		await skipRestOfSetup(page);

		await page.getByTestId("scan-status").click();
		await page.getByTestId("scan-now").first().click();
		let matchId = "";
		await expect
			.poll(
				() => {
					const d = db();
					try {
						const row = d
							.prepare(
								"select a.id from applications a where a.state = 'scored' and a.ended_reason is null limit 1",
							)
							.get() as { id: string } | undefined;
						matchId = row?.id ?? "";
						return matchId;
					} finally {
						d.close();
					}
				},
				{ timeout: 120_000 },
			)
			.not.toBe("");

		// The match is open in 140 places, one of them the user's country.
		const d = db();
		try {
			d.prepare(
				"update jobs set locations = ? where id = (select job_id from applications where id = ?)",
			).run(JSON.stringify(MANY), matchId);
			const row = d
				.prepare("select settings from filter_settings where user_id = 'local'")
				.get() as { settings: string } | undefined;
			const settings = JSON.parse(row?.settings ?? "{}");
			// A fresh profile may have no saved settings row yet: insert or update it.
			d.prepare(
				`insert into filter_settings (user_id, settings, updated_at) values ('local', ?, ?)
				on conflict(user_id) do update set settings = excluded.settings, updated_at = excluded.updated_at`,
			).run(JSON.stringify({ ...settings, livesIn: "Turkey" }), Date.now());
		} finally {
			d.close();
		}

		// The settings were changed behind the app's back: start the page afresh so it reads them.
		await page.reload();
		await expect(sidebar(page, "Inbox")).toBeVisible({ timeout: 30_000 });
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "dark";
		});
		await sidebar(page, "Inbox").click();
		await openRoute(app, page, `/applications/${matchId}?view=all`);

		const summary = page.getByTestId("locations-summary");
		await expect(summary).toHaveText(
			"Remote in 140 countries, including Turkey",
			{ timeout: 30_000 },
		);
		// One line, not a wall of places.
		const box = await summary.boundingBox();
		expect(box?.height ?? 999).toBeLessThan(30);
		await summary.hover();
		const list = page.getByTestId("locations-list");
		await expect(list).toBeVisible();
		await expect(list.getByRole("listitem")).toHaveCount(140);
		await expect(list.getByRole("listitem").first()).toHaveText(
			"Remote (Turkey)",
		);
		fs.mkdirSync(SHOTS, { recursive: true });
		// Past the popup's 150 ms fade-in, so the screenshot shows it as the user sees it.
		await page.waitForTimeout(400);
		await page.screenshot({ path: path.join(SHOTS, "locations-hover.png") });
		await page.mouse.move(5, 5);
		await expect(list).toBeHidden();

		// Dark mode: the posting is on the dark surface, with light text.
		const posting = page.getByTestId("posting");
		await expect(posting).toBeVisible();
		const colors = await posting.evaluate((el) => {
			const style = getComputedStyle(el);
			return { background: style.backgroundColor, color: style.color };
		});
		const luminance = (rgb: string) => {
			const [r = 0, g = 0, b = 0] = (rgb.match(/[\d.]+/g) ?? []).map(Number);
			return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		};
		expect(luminance(colors.background)).toBeLessThan(0.2);
		expect(luminance(colors.color)).toBeGreaterThan(0.6);
		await page.screenshot({ path: path.join(SHOTS, "posting-dark.png") });
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
