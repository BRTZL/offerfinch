import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { launchApp, openRoute } from "./launch";

/**
 * Answering a question opens the next one, its answer field ready, instead of an empty pane;
 * the last answer leaves the "no open questions" state.
 */
test("saving an answer opens the next question", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-q-"));
	const { app, page, errors } = await launchApp({ userData });
	try {
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe("/onboarding");
		const db = new Database(path.join(userData, "offerfinch.sqlite"));
		const now = Date.now();
		const insert = db.prepare(
			"insert into questions (id, user_id, key, question, status, created_at) values (?, 'local', ?, ?, 'open', ?)",
		);
		const asked = [
			"What is your notice period?",
			"Do you need visa sponsorship for the EU?",
			"Which time zones can you overlap with?",
		];
		for (const [i, q] of asked.entries())
			insert.run(crypto.randomUUID(), `k${i}`, q, now + i);
		db.close();

		await openRoute(app, page, "/questions");
		const rows = page.getByTestId("question-row");
		await expect(rows).toHaveCount(3, { timeout: 30_000 });
		const order = await rows.allInnerTexts();
		const titleOf = (text: string) => asked.find((q) => text.includes(q)) ?? "";
		const question = page.getByTestId("question");

		// The question's text can be selected and copied; the Save button cannot be selected.
		const first = titleOf(order[0] ?? "");
		await question.getByText(first).first().click({ clickCount: 3 });
		expect(
			await page.evaluate(() => window.getSelection()?.toString() ?? ""),
		).toContain(first);
		expect(
			await page
				.getByRole("button", { name: "Save answer" })
				.evaluate((el) => getComputedStyle(el).userSelect),
		).toBe("none");
		await page.getByRole("textbox").first().focus();

		for (let i = 0; i < asked.length; i++) {
			const current = titleOf(order[i] ?? "");
			await expect(question).toContainText(current);
			const box = page.getByRole("textbox").first();
			await expect(box).toBeFocused();
			await box.fill(`Answer ${i + 1}.`);
			await page.getByRole("button", { name: "Save answer" }).click();
			if (i < asked.length - 1)
				// The next one opens by itself, ready to type into.
				await expect(question).toContainText(titleOf(order[i + 1] ?? ""));
		}
		await expect(page.getByText("No open questions")).toBeVisible();
		await expect(page.getByText("Nothing selected")).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
