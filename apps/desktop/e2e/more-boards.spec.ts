import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import {
	APP_DIR,
	fakeChrome,
	launchApp,
	pickFakeModels,
	RESUME,
	skipRestOfSetup,
	tempUserData,
} from "./launch";

/**
 * Job-board search on the five boards added on 2026-11-07 (SmartRecruiters, Workable,
 * Recruitee, Teamtailor, Personio), against local stand-ins only: one scan searches every board,
 * reads each board's public data from its stand-in (Recruitee, Teamtailor and Personio on their
 * company subdomains), saves one job per board, and Settings › Sources shows each board's counts.
 * A screenshot goes to test-results/more-boards-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ??
		path.join(APP_DIR, "test-results", "more-boards-shots"),
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

test("job-board search finds and reads postings on the five new boards", async () => {
	const boards = await startFixtureBoards({ moreBoards: true });
	const chrome = fakeChrome();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		env: { OFFERFINCH_CHROME: chrome.executable },
	});
	try {
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
					readDb<{ n: number }>(
						"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
					)[0]?.n,
				{ timeout: 120_000 },
			)
			.toBe(1);

		// Ten searches, one site each, every board among them.
		const queries = boards.searches.filter((q) => q.includes("site:"));
		expect(queries).toHaveLength(10);
		for (const q of queries) expect(q.match(/site:/g)).toHaveLength(1);
		for (const site of [
			"site:jobs.smartrecruiters.com",
			"site:apply.workable.com",
			"site:recruitee.com",
			"site:teamtailor.com",
			"site:jobs.personio.de",
		])
			expect(
				queries.some((q) => q.includes(site)),
				site,
			).toBe(true);

		// Each board's data was read from its stand-in, the subdomain boards on their company's
		// host; SmartRecruiters only the found posting's page.
		for (const read of [
			"/api.smartrecruiters.com/v1/companies/AcmeRobotics/postings/744000200000001",
			"/apply.workable.com/api/v1/widget/accounts/acme-robotics",
			"/acmerobotics.recruitee.com/api/offers/",
			"/acmerobotics.teamtailor.com/jobs.rss",
			"/acmerobotics.jobs.personio.de/xml",
		])
			expect(boards.requests, read).toContain(read);

		// One job per board, with the company named by the board.
		const saved = readDb<{ source: string; title: string; company: string }>(
			"select jobs.source, jobs.title, companies.name company from jobs join companies on companies.id = jobs.company_id where jobs.source in ('smartrecruiters', 'workable', 'recruitee', 'teamtailor', 'personio') order by jobs.source",
		);
		expect(saved).toEqual([
			{
				source: "personio",
				title: "Senior Data Engineer",
				company: "Acme Robotics GmbH",
			},
			{
				source: "recruitee",
				title: "Senior Backend Engineer",
				company: "Acme Robotics",
			},
			{
				source: "smartrecruiters",
				title: "Senior Platform Engineer",
				company: "Acme Robotics",
			},
			{
				source: "teamtailor",
				title: "Senior Mobile Engineer",
				company: "Acme Robotics",
			},
			{
				source: "workable",
				title: "Senior Design Engineer",
				company: "Acme Robotics",
			},
		]);

		// Sources: the last run's counts per board.
		await sidebar(page, "Settings").click();
		await page
			.getByRole("navigation", { name: "Settings" })
			.getByRole("link", { name: /^Sources/ })
			.click();
		const row = page.getByTestId("source-job-board-search");
		// Greenhouse, Lever and Ashby searches list the Greenhouse stand-in's postings.
		await expect(row).toContainText(
			/By board: Greenhouse \d+ found, \d+ new · SmartRecruiters 1 found, 1 new · Workable 1 found, 1 new · Recruitee 1 found, 1 new · Teamtailor 1 found, 1 new · Personio 1 found, 1 new/,
			{ timeout: 30_000 },
		);
		fs.mkdirSync(SHOTS, { recursive: true });
		await row.scrollIntoViewIfNeeded();
		await page.screenshot({ path: path.join(SHOTS, "sources-by-board.png") });
		expect(chrome.launches()).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
