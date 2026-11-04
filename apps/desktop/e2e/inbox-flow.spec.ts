import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import {
	APP_DIR,
	launchApp,
	pickFakeModels,
	RESUME,
	skipRestOfSetup,
	tempUserData,
	toastsGone,
} from "./launch";

/**
 * The Inbox as a decision list, in the background against the fixture boards: it opens on
 * Matches, a company with several matches is one line that opens to its roles, Not interested
 * takes reasons and can hide the company (with Undo), and a hidden company's new posting is set
 * aside on the next scan without being scored. Screenshots go to test-results/inbox-shots (or
 * E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "inbox-shots"),
);
const userData = tempUserData();

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

function readDb<T>(query: string, ...params: unknown[]): T[] {
	const db = new Database(path.join(userData, DB_FILE), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		return db.prepare(query).all(...params) as T[];
	} finally {
		db.close();
	}
}

const ACME = `select a.id, a.state, a.ended_reason, j.external_id from applications a
	join jobs j on j.id = a.job_id join companies c on c.id = j.company_id
	where c.name = 'Acme Robotics'`;
type AcmeRow = {
	id: string;
	state: string;
	ended_reason: string | null;
	external_id: string;
};
const acme = () => readDb<AcmeRow>(ACME);
const acmeMatches = () =>
	acme().filter((r) => r.state === "scored" && r.ended_reason === null);

async function scanAndSettle(page: Page, scans: number) {
	await page.getByTestId("scan-status").click();
	await page.getByTestId("scan-now").first().click();
	await expect
		.poll(
			() =>
				readDb<{ n: number }>(
					"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
				)[0]?.n,
			{ timeout: 120_000 },
		)
		.toBe(scans);
	// Every new job checked and scored (or set aside).
	await expect
		.poll(
			() =>
				readDb<{ n: number }>(
					"select count(*) n from applications where state = 'found'",
				)[0]?.n,
			{ timeout: 120_000 },
		)
		.toBe(0);
}

test("Inbox: matches first, grouped by company, Not interested with reasons, hide and undo", async () => {
	const boards = await startFixtureBoards();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await page.setViewportSize({ width: 1280, height: 800 });
		// A profile and test models, as onboarding does; the rest of setup is put off.
		await page.getByTestId("welcome-start").click();
		await pickFakeModels(page);
		await page.getByTestId("step-continue").click();
		await page.getByTestId("resume-option-paste").click();
		await page.getByTestId("onboarding-text").fill(RESUME);
		await page.getByTestId("onboarding-structure").click();
		await page.getByTestId("onboarding-save").click({ timeout: 60_000 });
		await skipRestOfSetup(page);

		await scanAndSettle(page, 1);
		expect(acmeMatches().length).toBeGreaterThanOrEqual(2);

		// The Inbox opens on Matches, which says what to do there.
		await sidebar(page, "Inbox").click();
		await expect(page.getByTestId("inbox-view-matches")).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(page.getByTestId("inbox-hint")).toHaveText(
			"Decide on each match: Prepare to draft an application, or Not interested.",
		);

		// Acme's matches are one line, closed; selecting it opens it and shows the company.
		const group = page
			.getByTestId("inbox-group")
			.filter({ hasText: "Acme Robotics" });
		await expect(group).toContainText(`${acmeMatches().length} roles`);
		await expect(group).toHaveAttribute("aria-expanded", "false");
		await expect(
			page.locator("[data-testid=inbox-row][data-child]"),
		).toHaveCount(0);
		await group.click();
		await expect(group).toHaveAttribute("aria-expanded", "true");
		const children = page.locator("[data-testid=inbox-row][data-child]");
		await expect(children).toHaveCount(acmeMatches().length);
		await expect(page.getByTestId("company-summary")).toContainText(
			"Acme Robotics",
		);
		await expect(page.getByTestId("summary-role")).toHaveCount(
			acmeMatches().length,
		);
		await expect(page.getByTestId("not-interested")).toContainText(
			"Not interested in all",
		);
		fs.mkdirSync(SHOTS, { recursive: true });
		await toastsGone(page, 15_000);
		await page.screenshot({ path: path.join(SHOTS, "matches-group.png") });

		// ⌘-click picks several: their summary offers Not interested for all of them.
		await children.nth(0).click();
		await children.nth(1).click({ modifiers: ["Meta"] });
		await expect(page.getByTestId("selection-summary")).toContainText(
			"2 jobs selected",
		);
		await expect(page.getByTestId("not-interested")).toContainText(
			"Not interested in 2",
		);
		await page.screenshot({ path: path.join(SHOTS, "matches-selection.png") });
		await group.click();

		// The keyboard moves through the company's roles; ← goes back to the company.
		await page.getByTestId("inbox-scroll").focus();
		await page.keyboard.press("j");
		await expect(page).toHaveURL(/\/applications\//);
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByTestId("company-summary")).toBeVisible();

		// One role: Not interested with a reason, hiding the company.
		await children.first().click();
		await expect(page).toHaveURL(/\/applications\//);
		const picked = page.url().match(/applications\/([^?]+)/)?.[1] ?? "";
		await toastsGone(page, 15_000);
		const trigger = page.getByTestId("not-interested");
		await trigger.click();
		const popover = page.getByTestId("not-interested-popover");
		await expect(popover).toBeVisible();
		// Focus starts on its confirm button and stays inside: Tab and ⇧Tab go round.
		await expect(popover.getByTestId("dismiss-confirm")).toBeFocused();
		const inside = () =>
			page.evaluate(() =>
				Boolean(
					document
						.querySelector("[data-testid=not-interested-popover]")
						?.contains(document.activeElement),
				),
			);
		for (let i = 0; i < 14; i++) {
			await page.keyboard.press("Tab");
			await expect.poll(inside, { timeout: 1_000 }).toBe(true);
		}
		for (let i = 0; i < 14; i++) {
			await page.keyboard.press("Shift+Tab");
			await expect.poll(inside, { timeout: 1_000 }).toBe(true);
		}
		// Esc closes it, and focus is back on the button that opened it.
		await page.keyboard.press("Escape");
		await expect(popover).toHaveCount(0);
		await expect(trigger).toBeFocused();
		// Cancel too.
		await trigger.click();
		await popover.getByTestId("dismiss-cancel").click();
		await expect(popover).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await trigger.click();
		await expect(popover).toBeVisible();
		await popover.getByTestId("dismiss-reason-location").click();
		await popover.getByTestId("dismiss-reason-seniority").click();
		await popover.getByTestId("dismiss-note").fill("Too far from home");
		await popover.getByTestId("dismiss-hide-company").click();
		await expect(popover).toContainText("Hide every job from Acme Robotics");
		await page.screenshot({ path: path.join(SHOTS, "not-interested.png") });
		await popover.getByTestId("dismiss-confirm").click();
		const toast = page
			.locator("[data-sonner-toast]")
			.filter({ hasText: "Hid Acme Robotics" });
		await expect(toast).toBeVisible();
		await expect(page.getByTestId("inbox-group")).toHaveCount(0);
		expect(acme().filter((r) => r.state === "dismissed").length).toBe(
			acme().filter((r) => r.state !== "rejected_by_filter").length,
		);
		const [stored] = readDb<{ reasons: string; note: string }>(
			"select reasons, note from dismissals where application_id = ?",
			picked,
		);
		expect(JSON.parse(stored?.reasons ?? "")).toEqual([
			"location",
			"seniority",
		]);
		expect(stored?.note).toBe("Too far from home");
		expect(
			readDb<{ n: number }>("select count(*) n from hidden_companies")[0]?.n,
		).toBe(1);

		// Undo: the matches and the company come back; the reasons are gone.
		await toast.getByRole("button", { name: "Undo" }).click();
		await expect.poll(() => acmeMatches().length).toBeGreaterThanOrEqual(2);
		expect(
			readDb<{ n: number }>("select count(*) n from hidden_companies")[0]?.n,
		).toBe(0);
		expect(
			readDb<{ n: number }>("select count(*) n from dismissals")[0]?.n,
		).toBe(0);
		await expect(
			page.getByTestId("inbox-group").filter({ hasText: "Acme Robotics" }),
		).toBeVisible();

		// From the keyboard this time: X on a role, hide the company, confirm.
		await page
			.getByTestId("inbox-group")
			.filter({ hasText: "Acme Robotics" })
			.click();
		await page.getByTestId("inbox-scroll").focus();
		await page.keyboard.press("j");
		await expect(page).toHaveURL(/\/applications\//);
		await expect(page.getByTestId("not-interested")).toBeEnabled();
		await page.keyboard.press("x");
		await expect(popover).toBeVisible();
		await popover.getByTestId("dismiss-hide-company").click();
		await popover.getByTestId("dismiss-confirm").click();
		await expect.poll(() => acmeMatches().length, { timeout: 15_000 }).toBe(0);
		expect(
			readDb<{ n: number }>("select count(*) n from hidden_companies")[0]?.n,
		).toBe(1);

		// Settings lists the hidden company.
		await sidebar(page, "Settings").click();
		await page
			.getByRole("navigation", { name: "Settings" })
			.getByRole("link", { name: /^Hidden companies/ })
			.click();
		await expect(page.getByTestId("hidden-company")).toContainText(
			"Acme Robotics",
		);

		// The next scan finds a new Acme posting: set aside at once, never scored.
		boards.addJob(4010, "Staff Frontend Engineer");
		await scanAndSettle(page, 2);
		const fresh = acme().find((r) => r.external_id === "4010");
		expect(fresh).toMatchObject({
			state: "dismissed",
			ended_reason: "company_hidden",
		});
		expect(
			readDb<{ n: number }>(
				"select count(*) n from llm_usage where application_id = ?",
				fresh?.id,
			)[0]?.n,
		).toBe(0);
		// The scan history says why: the page lists the finished second scan (the app's own
		// state, polled while a scan runs), and its detail names the hidden company.
		expect(
			readDb<{ n: number }>(
				"select count(*) n from scan_runs where finished_at is not null",
			)[0]?.n,
		).toBe(2);
		// The list refreshes every 15 s once no scan runs, so allow it one refresh.
		await expect(page.getByTestId("scan-row")).toHaveCount(2, {
			timeout: 30_000,
		});
		await expect(page.getByTestId("scan-detail")).toContainText(
			"from a company you hid",
			{ timeout: 30_000 },
		);

		// Closed holds the dismissed matches.
		await sidebar(page, "Inbox").click();
		await page.getByTestId("inbox-view-closed").click();
		await expect(page.getByTestId("inbox-hint")).toContainText(
			"not interested",
		);
		await expect(
			page
				.locator("[data-testid=inbox-row][data-state=dismissed]")
				.filter({ hasText: "Company hidden" })
				.first(),
		).toBeVisible();

		// Settings › Hidden companies: Show again brings back the jobs hidden with it.
		await sidebar(page, "Settings").click();
		await page
			.getByRole("navigation", { name: "Settings" })
			.getByRole("link", { name: /^Hidden companies/ })
			.click();
		await page.getByTestId("unhide-company").click();
		await expect(page.getByTestId("hidden-company")).toHaveCount(0);
		expect(
			readDb<{ n: number }>("select count(*) n from hidden_companies")[0]?.n,
		).toBe(0);
		// The new posting is checked and scored now, like any other.
		await expect
			.poll(() => acme().find((r) => r.external_id === "4010")?.state, {
				timeout: 60_000,
			})
			.toBe("scored");
		await expect.poll(() => acmeMatches().length).toBeGreaterThanOrEqual(2);

		// P prepares the one selected match, and the selection moves on.
		await sidebar(page, "Inbox").click();
		await page.getByTestId("inbox-view-matches").click();
		const back = page
			.getByTestId("inbox-group")
			.filter({ hasText: "Acme Robotics" });
		await back.click();
		// The list can still show the roles from before the new posting was scored: wait for it.
		await expect(children).toHaveCount(acmeMatches().length, {
			timeout: 30_000,
		});
		await page.getByTestId("inbox-scroll").focus();
		// ⌘-selecting two and pressing P prepares nothing.
		await children.nth(0).click();
		await children.nth(1).click({ modifiers: ["Meta"] });
		await page.getByTestId("inbox-scroll").focus();
		await page.keyboard.press("p");
		expect(
			readDb<{ n: number }>(
				"select count(*) n from applications where prepare_requested_at is not null",
			)[0]?.n,
		).toBe(0);
		await children.nth(0).click();
		await expect(page).toHaveURL(/\/applications\//);
		const chosen = page.url().match(/applications\/([^?]+)/)?.[1] ?? "";
		await page.keyboard.press("p");
		await expect
			.poll(
				() =>
					readDb<{ at: number | null; state: string }>(
						"select prepare_requested_at at, state from applications where id = ?",
						chosen,
					)[0],
			)
			.toMatchObject({ at: expect.any(Number) });
		await expect(page).not.toHaveURL(new RegExp(chosen));

		// What the job filter rejected is hidden everywhere: not in Closed, not in All.
		const europe = () => acme().find((r) => r.external_id === "4003");
		expect(europe()?.state).toBe("rejected_by_filter");
		for (const view of ["closed", "all"]) {
			await page.getByTestId(`inbox-view-${view}`).click();
			await expect(page.getByTestId("inbox-row").first()).toBeVisible();
			await expect(
				page.locator("[data-testid=inbox-row][data-state=rejected_by_filter]"),
			).toHaveCount(0);
		}
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
