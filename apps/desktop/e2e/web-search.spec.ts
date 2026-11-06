import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import { launchApp, tempUserData } from "./launch";

/**
 * Web search end to end, against local stand-ins only: DuckDuckGo's results pages and the
 * result pages themselves are served on 127.0.0.1 (the site tabs load nothing else), and the
 * model is the fake. Off by default; turned on, a scan writes the day's searches, reads a page's
 * JobPosting data, has the model read a page without it, and keeps nothing else.
 */

const userData = tempUserData();
let boards: Awaited<ReturnType<typeof startFixtureBoards>>;

test.beforeAll(async () => {
	boards = await startFixtureBoards();
});
test.afterAll(async () => {
	await boards.close();
});

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });
const settingsNav = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Settings" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

function db() {
	return new Database(path.join(userData, DB_FILE));
}
function read<T>(sql: string): T[] {
	const d = db();
	try {
		return d.prepare(sql).all() as T[];
	} finally {
		d.close();
	}
}

test("web search finds postings on any other site: job data read as is, others by the model, the rest kept out", async () => {
	const first = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	await first.page.getByTestId("welcome").waitFor();
	await first.app.close();
	// Setup done; one title to search for; web search on and nothing else.
	const d = db();
	try {
		const now = Date.now();
		d.prepare(
			"insert or replace into filter_settings (user_id, settings, updated_at) values ('local', ?, ?)",
		).run(JSON.stringify({ searchTitles: ["Design Systems Engineer"] }), now);
		for (const [provider, on] of [
			["job-board-search", 0],
			["web-search", 1],
		] as const)
			d.prepare(
				"insert or replace into source_providers (user_id, provider, enabled, config, created_at, updated_at) values ('local', ?, ?, '{}', ?, ?)",
			).run(provider, on, now, now);
		// The test models (this is a test run): web search's searches and page reads use them.
		d.prepare(
			"insert or replace into app_settings (key, value, updated_at) values ('ai', ?, ?)",
		).run(
			JSON.stringify({
				scoring: { mode: "fake" },
				tailoring: { mode: "fake" },
				claims: { mode: "fake" },
			}),
			now,
		);
		d.prepare(
			"insert or replace into app_settings (key, value, updated_at) values ('onboarding', ?, ?)",
		).run(
			JSON.stringify({
				done: [
					"ai",
					"resume",
					"profile",
					"rules",
					"watchlist",
					"notifications",
					"login",
					"scan",
				],
				skipped: [],
				dismissed: true,
				completedAt: "2026-11-02T00:00:00.000Z",
			}),
			now,
		);
	} finally {
		d.close();
	}

	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		await expect(page.getByTestId("source-web-search-status")).toHaveText(
			"Not run yet",
		);
		// Nothing to set per source: no search editor, no list of its own searches.
		await expect(
			page.getByTestId("sources-list").getByRole("textbox"),
		).toHaveCount(0);
		await expect(page.getByTestId("web-searches")).toHaveCount(0);
		await page.getByTestId("scan-status").click();
		await page.getByTestId("scan-now").click();
		await expect
			.poll(
				() =>
					read<{ title: string }>(
						"select title from jobs where source = 'web' order by title",
					).map((r) => r.title),
				{ timeout: 90_000 },
			)
			.toEqual(["Design Systems Engineer", "Platform Engineer"]);
		const companies = read<{ name: string }>(
			"select c.name from jobs j join companies c on c.id = j.company_id where j.source = 'web' order by c.name",
		).map((r) => r.name);
		expect(companies).toEqual(["Nimbus Cloud", "Tessera Labs"]);
		// The shared plan's searches, from the title: plain words, no site: operator.
		const searched = boards.searches.filter((q) => !q.includes("site:"));
		expect(searched).toContain("Design Systems Engineer jobs remote");
		// The list page, the article, the expired posting and the LinkedIn result were not kept.
		expect(
			read<{ n: number }>("select count(*) n from jobs where source = 'web'")[0]
				?.n,
		).toBe(2);
		expect(boards.requests).not.toContain(
			"/linkedin.com/jobs/view/4000000001/",
		);
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		// Sources refreshes its list every few seconds.
		await expect(page.getByTestId("source-web-search-status")).toContainText(
			"new job",
			{ timeout: 20_000 },
		);

		// The searches are edited once, in Job search, for every source: add one (plain words
		// only), take it out, have AI write the day's again.
		await settingsNav(page, "Job search").click();
		const plan = page.getByTestId("search-plan");
		await expect(plan).toContainText(
			"Design Systems Engineer · remote, worldwide",
		);
		await page
			.getByTestId("search-plan-keywords")
			.fill("design engineer site:example.com");
		await page.getByTestId("search-plan-add").click();
		await expect(plan.getByTestId("search-plan-entry").first()).toContainText(
			"design engineer · remote, worldwide",
		);
		await expect(plan).not.toContainText("site:");
		await page
			.getByRole("button", {
				name: "Remove design engineer · remote, worldwide",
			})
			.click();
		await expect(plan).not.toContainText("design engineer ·");
		await page.getByTestId("search-plan-regenerate").click();
		await expect(
			page.getByText("Today's searches written again."),
		).toBeVisible();
		await expect(plan).toContainText(
			"Design Systems Engineer · remote, worldwide",
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
