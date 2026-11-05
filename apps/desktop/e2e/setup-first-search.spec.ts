import { expect, type Page, test } from "@playwright/test";

import { startFixtureBoards } from "./fixture-boards";
import { launchApp, pickFakeModels, RESUME, tempUserData } from "./launch";

/**
 * Setup's first search waits for the scoring the search started, not for the scan alone: a scan
 * ends before its jobs are scored. With slow test models the matches arrive after the scan and
 * the no-match line never shows; with every job set aside by a rule, nothing is scored and the
 * no-match line does show. The list is live: every job shows as found first, a set-aside job
 * shows the rule it broke, and a scored one its fit.
 */
let boards: Awaited<ReturnType<typeof startFixtureBoards>>;
test.beforeAll(async () => {
	boards = await startFixtureBoards();
});
test.afterAll(async () => {
	await boards.close();
});

/** Records every line the first search showed, from the moment it is called. */
async function watchProgress(page: Page) {
	await page.evaluate(() => {
		const seen: string[] = [];
		const rows = { states: [] as string[], reasons: [] as string[] };
		Object.assign(window, { __progress: seen, __rows: rows });
		new MutationObserver(() => {
			const text = document.querySelector(
				'[data-testid="first-scan-progress"]',
			)?.textContent;
			if (text && seen[seen.length - 1] !== text) seen.push(text);
			// What the rows showed: each state once, and every set-aside reason.
			for (const row of document.querySelectorAll(
				'[data-testid="first-search-list"] [data-state]',
			)) {
				const state = row.getAttribute("data-state") ?? "";
				if (!rows.states.includes(state)) rows.states.push(state);
			}
			for (const reason of document.querySelectorAll(
				'[data-testid="first-search-reason"]',
			)) {
				const said = reason.textContent ?? "";
				if (!rows.reasons.includes(said)) rows.reasons.push(said);
			}
		}).observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["data-state"],
		});
	});
	return {
		lines: () =>
			page.evaluate(
				() => (window as unknown as { __progress: string[] }).__progress,
			),
		rows: () =>
			page.evaluate(
				() =>
					(
						window as unknown as {
							__rows: { states: string[]; reasons: string[] };
						}
					).__rows,
			),
	};
}

const DONE_WITH_MATCHES =
	/Done: \d+ jobs? read, \d+ set aside, \d+ match(es)?\. (They are|It is) waiting in your Inbox\./;

async function walkToFirstSearch(page: Page, excludeTitles?: string) {
	await page.getByTestId("welcome-start").click({ timeout: 30_000 });
	await pickFakeModels(page);
	await page.getByTestId("step-continue").click();
	await page.getByTestId("resume-option-paste").click();
	await page.getByTestId("onboarding-text").fill(RESUME);
	await page.getByTestId("onboarding-structure").click();
	await page.getByTestId("onboarding-save").click({ timeout: 60_000 });
	await expect(page.getByTestId("step-count")).toContainText("Step 3 of 5");
	if (excludeTitles)
		await page.locator("#f-excludeTitleKeywords").fill(excludeTitles);
	await page.getByTestId("step-continue").click();
	await expect(page.getByTestId("step-count")).toContainText("Step 4 of 5");
	await page.getByTestId("step-skip").click();
	await expect(page.getByTestId("step-count")).toContainText("Step 5 of 5");
}

test("matches scored after the scan ended still arrive; no false no-match line", async () => {
	const { app, page, errors } = await launchApp({
		userData: tempUserData(),
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		// Every test model call takes 3 s: the scan ends while its jobs are still being scored.
		fakeDelayMs: 3_000,
	});
	try {
		await walkToFirstSearch(page);
		const seen = await watchProgress(page);
		await page.getByTestId("first-scan-start").click();
		await expect(page.getByTestId("first-match").first()).toBeVisible({
			timeout: 120_000,
		});
		// A scored row shows its fit as a number.
		await expect(
			page.getByTestId("first-match").first().locator("[data-fit]"),
		).toHaveText(/^\d+$/);
		await expect(page.getByTestId("first-scan-progress")).toContainText(
			DONE_WITH_MATCHES,
			{ timeout: 120_000 },
		);
		const lines = await seen.lines();
		// The scan was done before any match was scored: setup waited, and said so.
		expect(lines.some((l) => l.includes("Scoring them"))).toBe(true);
		expect(lines.some((l) => l.includes("No matches this time"))).toBe(false);
		// Every row came in as found, then passed the rules and was scored.
		const rows = await seen.rows();
		expect(rows.states).toContain("found");
		expect(rows.states).toContain("scored");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("every job set aside by a rule: the friendly no-match line", async () => {
	const { app, page, errors } = await launchApp({
		userData: tempUserData(),
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await walkToFirstSearch(page, "Engineer");
		const seen = await watchProgress(page);
		await page.getByTestId("first-scan-start").click();
		await expect(page.getByTestId("first-scan-progress")).toContainText(
			"No matches this time. OfferFinch keeps looking every hour",
			{ timeout: 120_000 },
		);
		await expect(page.getByTestId("first-scan-progress")).toContainText(
			/Done: \d+ jobs? read, \d+ set aside\. No matches this time/,
		);
		await expect(page.getByTestId("first-match")).toHaveCount(0);
		// Each job showed as found, then as set aside with the rule it broke, then left.
		const rows = await seen.rows();
		expect(rows.states).toContain("found");
		expect(rows.states).toContain("rejected_by_filter");
		expect(rows.reasons).toContain('Title contains "Engineer".');
		await expect(
			page.locator('[data-testid="first-search-list"] li:not([aria-hidden])'),
		).toHaveCount(0);
		await expect(page.getByTestId("onboarding-finish")).toHaveText(
			"Open the Inbox",
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
