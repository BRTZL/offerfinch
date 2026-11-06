import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { DB_FILE } from "../src/main/database-file";
import { fakeClis, launchApp, openRoute, tempUserData } from "./launch";

/**
 * An upgrade from a version with API keys: the steps that ran on a key get a model at start
 * from what is signed in (Claude, a stand-in here), and Settings › Models says once that keys
 * were removed, until dismissed.
 */
test("API key steps get a model at start, and the notice shows once", async () => {
	const userData = tempUserData();
	// A first start makes the database; the earlier version's choices are written into it.
	const first = await launchApp({ userData });
	await expect(first.page.getByTestId("welcome")).toBeVisible({
		timeout: 30_000,
	});
	await first.app.close();
	const db = new Database(path.join(userData, DB_FILE));
	db.prepare(
		"insert or replace into app_settings (key, value, updated_at) values ('ai', ?, ?)",
	).run(
		JSON.stringify({
			scoring: { mode: "claude-subscription", model: "claude-opus-5-5" },
			tailoring: { mode: "api", model: "claude-opus-5-5" },
			claims: { mode: "api", model: "gpt-5.5-mini" },
		}),
		Date.now(),
	);
	db.close();
	fakeClis(userData, { claude: "logged_in", codex: "missing" });

	const { app, page, errors } = await launchApp({ userData });
	try {
		await openRoute(app, page, "/settings/models");
		const notice = page.getByTestId("keys-removed");
		await expect(notice).toBeVisible({ timeout: 30_000 });
		await expect(notice).toContainText("API keys were removed");
		await expect(notice).toContainText(
			"Drafting and Checking drafts used a key",
		);
		// Filled from Claude, signed in: its default for each step.
		await expect(page.getByTestId("role-tailoring-mode")).toHaveText(
			/Sonnet 5\.5/,
			{ timeout: 30_000 },
		);
		await expect(page.getByTestId("role-claims-mode")).toHaveText(/Opus 5\.5/);
		if (process.env.KEYS_SHOT)
			await page.screenshot({ path: process.env.KEYS_SHOT });
		await page.getByTestId("keys-removed-dismiss").click();
		await expect(notice).toHaveCount(0);
		await page.reload();
		await expect(page.getByTestId("role-scoring")).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.getByTestId("keys-removed")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});
