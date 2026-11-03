import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import {
	APP_DIR,
	fakeChrome,
	launchApp,
	RESUME,
	tempUserData,
	toastsGone,
} from "./launch";

/**
 * Scan history against local stand-ins only, in the background: job-board search on the fixture
 * boards (one posting the job filter sets aside), Indeed on a stand-in search page, Glassdoor on
 * a stand-in check that pauses it. The Scans screen lists the run with its outcome, and its
 * detail shows each source's funnel, the jobs found, what was set aside and why, and the paused
 * source with what to do. A screenshot goes to test-results/scans-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "scans-shots"),
);
const SITES_DIR = path.resolve(
	import.meta.dirname,
	"../../../packages/core/test/fixtures/sites",
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

test("the scan history: found, set aside with reasons, and a paused source", async () => {
	const boards = await startFixtureBoards();
	const PAGES: Record<string, Record<string, string>> = {
		"127.0.0.1": {
			"/jobs": "indeed-search.html",
			"/viewjob": "indeed-job.html",
		},
		localhost: { "/Job/jobs.htm": "glassdoor-check.html" },
	};
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stand-in");
		const host = String(req.headers.host ?? "").split(":")[0] ?? "";
		const name = PAGES[host]?.[url.pathname];
		if (!name) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(fs.readFileSync(path.join(SITES_DIR, name)));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const chrome = fakeChrome();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: {
			...boards.siteOrigins,
			indeed: `http://127.0.0.1:${port}`,
			glassdoor: `http://localhost:${port}`,
		},
		env: {
			// Glassdoor's stand-in check is never solved: the wait ends quickly and it pauses.
			OFFERFINCH_CHECK_TIMEOUT_MS: "1500",
			OFFERFINCH_CHROME: chrome.executable,
		},
	});
	try {
		// A profile and test models, as onboarding does; the rest of setup is put off.
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
		await page.getByTestId("onboarding-later").click();

		// Before any scan: the sidebar's scan line opens the history, which says what to set up.
		await page.getByTestId("scan-status").click();
		await expect(page).toHaveURL(/\/scans$/);
		await expect(page.getByText("No scans yet").first()).toBeVisible();

		// Indeed and Glassdoor on (local stand-ins), beside job-board search.
		await sidebar(page, "Settings").click();
		await page
			.getByRole("navigation", { name: "Settings" })
			.getByRole("link", { name: /^Sources/ })
			.click();
		await page.getByTestId("source-indeed-enabled").click();
		await page.getByTestId("source-glassdoor-enabled").click();
		await expect(page.getByTestId("source-indeed-status")).toHaveText(
			"Not run yet",
		);

		// Scan now from the history: the run shows its progress while it reads.
		await page.getByTestId("scan-status").click();
		await page.getByTestId("scan-now").first().click();
		const row = page.getByTestId("scan-row").first();
		await expect(row).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("scan-progress")).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.getByTestId("scan-progress")).toContainText(/Reading /);
		await expect
			.poll(
				() =>
					readDb<{ n: number }>(
						"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
					)[0]?.n,
				{ timeout: 120_000 },
			)
			.toBe(1);
		// Every new job checked: the filter sets the Spanish-speaking, Europe-only posting aside.
		await expect
			.poll(
				() =>
					readDb<{ n: number }>(
						"select count(*) n from applications where state = 'found'",
					)[0]?.n,
				{ timeout: 120_000 },
			)
			.toBe(0);
		const filtered = readDb<{ n: number }>(
			"select count(*) n from applications where state = 'rejected_by_filter'",
		)[0]?.n;
		expect(filtered).toBeGreaterThan(0);

		const detail = page.getByTestId("scan-detail");
		await expect(page.getByTestId("scan-outcome")).toHaveText(
			/^Found \d+ new match/,
			{ timeout: 30_000 },
		);
		await expect(row).toContainText(/Found \d+ new match/);
		await expect(row).toContainText("Scan now");

		// Job-board search: its funnel, the jobs it saved, and what the filter set aside.
		const search = detail.getByTestId("scan-source-job-board-search");
		await expect(search.getByTestId("scan-funnel")).toContainText("read");
		await expect(search.getByTestId("scan-found")).toContainText(
			"Listed in Inbox",
		);
		await expect(search.getByTestId("scan-dropped")).toContainText(
			/Filtered by (language|location)/,
		);
		// Indeed ran on its stand-in and saved its two postings.
		const indeed = detail.getByTestId("scan-source-indeed");
		await expect(indeed).toContainText("Ran");
		await expect(
			indeed.getByTestId("scan-found").getByRole("link"),
		).toHaveCount(2);
		// Glassdoor met a check: paused, with where to solve it.
		const glassdoor = detail.getByTestId("scan-source-glassdoor");
		await expect(glassdoor).toContainText("Paused for a check");
		await expect(glassdoor.getByTestId("scan-problem")).toContainText(
			"Watch live in Sources",
		);
		// LinkedIn is off here: a row of its own that says so.
		await expect(detail.getByTestId("scan-source-linkedin")).toContainText(
			"Off",
		);

		// A found job opens its application.
		await search.getByTestId("scan-found").getByRole("link").first().click();
		await expect(page).toHaveURL(/\/applications\//);
		await page.getByTestId("scan-status").click();
		await expect(page.getByTestId("scan-outcome")).toBeVisible();
		await toastsGone(page, 15_000);
		// The toolbar and sidebar settle on the finished scan.
		await expect(page.getByTestId("scan-now").first()).toContainText(
			"Scan now",
			{ timeout: 30_000 },
		);
		await expect(page.getByTestId("scan-status")).toContainText("Scanned");
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.screenshot({ path: path.join(SHOTS, "scan-history.png") });
		await page
			.getByTestId("scan-detail")
			.getByTestId("scan-source-glassdoor")
			.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: path.join(SHOTS, "scan-history-paused.png"),
		});

		const [stored] = readDb<{ trigger: string; sources: string }>(
			"select trigger, sources from scan_runs",
		);
		expect(stored?.trigger).toBe("manual");
		expect(chrome.launches()).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
		await new Promise<void>((r) => server.close(() => r()));
	}
});
