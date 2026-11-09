import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import { APP_DIR, launchApp, tempUserData, toastsGone } from "./launch";

/**
 * The remote feeds end to end, against a local stand-in only: the worker's fetch sends
 * remotive.com, remoteok.com, weworkremotely.com and hn.algolia.com to a server on 127.0.0.1
 * that answers with core's fabricated fixtures (a test run refuses a feed host without one). The
 * feeds are off at first; turned on in Sources, a scan reads each once, keeps the plan's matches,
 * links them back to the feed, and shows each feed's row in Sources and in the scan history.
 * Screenshots go to E2E_SHOTS (default test-results/remote-feeds-shots).
 */

const SHOTS =
	process.env.E2E_SHOTS ??
	path.join(APP_DIR, "test-results", "remote-feeds-shots");
const FIXTURES = path.resolve(
	APP_DIR,
	"../../packages/core/test/fixtures/feeds",
);
const userData = tempUserData();

const FILES: Record<string, string> = {
	"/remotive.com/api/remote-jobs": "remotive.json",
	"/remoteok.com/api": "remoteok.json",
	"/weworkremotely.com/remote-jobs.rss": "weworkremotely-rss.txt",
	"/hn.algolia.com/api/v1/search_by_date": "hn-search.json",
	"/hn.algolia.com/api/v1/items/9001": "hn-thread.json",
};

let server: http.Server;
let base = "";
const requests: { path: string; ua: string }[] = [];

test.beforeAll(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stand-in");
		requests.push({
			path: url.pathname,
			ua: String(req.headers["user-agent"] ?? ""),
		});
		const file = FILES[url.pathname];
		if (!file) {
			res.writeHead(404).end();
			return;
		}
		let body = fs.readFileSync(path.join(FIXTURES, file), "utf8");
		// The fixture HN thread is from the start of this month: keep it this month's.
		if (file === "hn-search.json")
			body = body.replace(
				/"2026-11-02T16:01:37.000Z"/,
				JSON.stringify(new Date(Date.now() - 86_400_000).toISOString()),
			);
		res
			.writeHead(200, {
				"content-type": file.endsWith(".txt")
					? "application/rss+xml"
					: "application/json",
			})
			.end(body);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
	await new Promise((r) => server.close(r));
});

const rewrite = () => ({
	"remotive.com": base,
	"remoteok.com": base,
	"weworkremotely.com": base,
	"hn.algolia.com": base,
});

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });
const settingsNav = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Settings" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

/** The theme set and every transition finished, so a capture shows the settled page. */
async function theme(
	app: Awaited<ReturnType<typeof launchApp>>["app"],
	page: Page,
	source: "light" | "dark",
) {
	await app.evaluate(({ nativeTheme }, s) => {
		nativeTheme.themeSource = s;
	}, source);
	if (source === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
	else await expect(page.locator("html")).not.toHaveClass(/dark/);
	await page.evaluate(async () => {
		await Promise.all(document.getAnimations().map((a) => a.finished));
		await new Promise((r) => requestAnimationFrame(() => r(null)));
	});
}

function read<T>(sql: string): T[] {
	const d = new Database(path.join(userData, DB_FILE));
	try {
		return d.prepare(sql).all() as T[];
	} finally {
		d.close();
	}
}

function setUp() {
	const d = new Database(path.join(userData, DB_FILE));
	try {
		const now = Date.now();
		d.prepare(
			"insert or replace into filter_settings (user_id, settings, updated_at) values ('local', ?, ?)",
		).run(
			JSON.stringify({
				searchTitles: ["Frontend Engineer"],
				livesIn: "Türkiye",
				rightToWork: ["Türkiye"],
				locationPrefilled: true,
			}),
			now,
		);
		// Nothing else reads: job-board search (on by default) would need DuckDuckGo.
		d.prepare(
			"insert or replace into source_providers (user_id, provider, enabled, config, created_at, updated_at) values ('local', 'job-board-search', 0, '{}', ?, ?)",
		).run(now, now);
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
}

test("remote feeds: off at first, on with one switch, read once, matches linked back to the feed", async () => {
	const first = await launchApp({ userData, rewrite: rewrite() });
	await first.page.getByTestId("welcome").waitFor();
	await first.app.close();
	setUp();

	const { app, page, errors } = await launchApp({
		userData,
		rewrite: rewrite(),
	});
	try {
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		for (const id of ["remotive", "remoteok", "weworkremotely", "hn-hiring"]) {
			await expect(page.getByTestId(`source-${id}-status`)).toHaveText("Off");
			await expect(page.getByTestId(`source-${id}-enabled`)).not.toBeChecked();
		}
		// Turned on: nothing else to set up.
		for (const id of ["remotive", "remoteok", "weworkremotely", "hn-hiring"])
			await page.getByTestId(`source-${id}-enabled`).click();
		await expect(page.getByTestId("source-remotive-status")).toHaveText(
			"Not run yet",
		);

		await page.getByTestId("scan-status").click();
		await page.getByTestId("scan-now").first().click();
		await expect
			.poll(
				() =>
					read<{ n: number }>(
						"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
					)[0]?.n,
				{ timeout: 120_000 },
			)
			.toBe(1);
		const stored = read<{ source: string; title: string; url: string }>(
			"select source, title, url from jobs order by source, title",
		);
		// Nimbus Cloud's Senior Frontend Engineer is on HN and Remotive with no shared link: kept
		// twice, since a company and title alone never prove one vacancy (decisions.md, 2026-11-03).
		// Remote roles limited to another country are stored too: the fit score judges where a
		// job hires (decisions.md, 2026-11-05).
		expect(stored.map((j) => `${j.source}: ${j.title}`)).toEqual([
			"hackernews: Frontend Engineer, Backend Engineer",
			"hackernews: Senior Frontend Engineer",
			"remoteok: Front End Engineer",
			"remoteok: Frontend Engineer",
			"remoteok: Software Engineer",
			"remotive: Frontend Developer",
			"remotive: Senior Frontend Engineer",
			"weworkremotely: Frontend Engineer",
			"weworkremotely: Senior Front-End Engineer",
		]);
		// Each feed read once (HN twice: the thread, then its comments), as OfferFinch.
		expect(requests.map((r) => r.path).sort()).toEqual(
			Object.keys(FILES).sort(),
		);
		expect(requests.every((r) => r.ua.startsWith("OfferFinchBot/"))).toBe(true);

		// The scan history: a row per feed with what it read and kept.
		const detail = page.getByTestId("scan-detail");
		await expect(page.getByTestId("scan-outcome")).toBeVisible({
			timeout: 30_000,
		});
		const remotive = detail.getByTestId("scan-source-remotive");
		await expect(remotive).toContainText("Remotive");
		await expect(remotive).toContainText("Ran");
		await expect(remotive.getByTestId("scan-dropped")).toContainText(
			/outside the search/i,
		);
		for (const id of ["remoteok", "weworkremotely", "hn-hiring"])
			await expect(detail.getByTestId(`scan-source-${id}`)).toContainText(
				"Ran",
			);
		await toastsGone(page, 15_000);
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.screenshot({ path: path.join(SHOTS, "scan-history.png") });

		// Sources: each feed's last run, and when it reads next (every 6 hours).
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		await expect(page.getByTestId("source-remotive-status")).toContainText(
			"new job",
			{ timeout: 20_000 },
		);
		await expect(page.getByTestId("source-remotive")).toContainText(
			/Next read in ~(6|5) h/,
		);
		await page.getByTestId("source-hn-hiring").scrollIntoViewIfNeeded();
		await theme(app, page, "light");
		await page.screenshot({ path: path.join(SHOTS, "sources-light.png") });
		await theme(app, page, "dark");
		await page.screenshot({ path: path.join(SHOTS, "sources-dark.png") });
		await theme(app, page, "light");

		// A second scan within the pace makes no request: the feeds are not due.
		const before = requests.length;
		await page.getByTestId("scan-status").click();
		await page.getByTestId("scan-now").first().click();
		await expect
			.poll(
				() =>
					read<{ n: number }>(
						"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
					)[0]?.n,
				{ timeout: 120_000 },
			)
			.toBe(2);
		expect(requests.length).toBe(before);
		await expect(
			page.getByTestId("scan-detail").getByTestId("scan-source-remotive"),
		).toContainText("Not due", { timeout: 30_000 });

		// The posting names the feed and links back to its page there.
		const [job] = read<{ id: string }>(
			"select a.id from applications a join jobs j on j.id = a.job_id where j.source = 'remotive'",
		);
		await page.goto(`app://local/applications/${job?.id}?view=all`);
		// The page names the application; the worker opens the stored job's link (worker/links.ts).
		await app.evaluate(({ shell }) => {
			const opened: string[] = [];
			(globalThis as unknown as { __opened: string[] }).__opened = opened;
			shell.openExternal = async (url: string) => {
				opened.push(url);
			};
		});
		const link = page.getByRole("button", { name: "Open on Remotive" });
		await expect(link).toBeVisible({ timeout: 30_000 });
		await link.click();
		await expect
			.poll(() =>
				app.evaluate(
					() => (globalThis as unknown as { __opened: string[] }).__opened,
				),
			)
			.toEqual([
				"https://remotive.com/remote-jobs/software-development/senior-frontend-engineer-1001",
			]);
		// The feed gave the whole posting: nothing reads its page there again.
		await expect(page.getByText("Re-read posting")).toHaveCount(0);
		await theme(app, page, "light");
		await page.screenshot({ path: path.join(SHOTS, "posting-light.png") });
		await theme(app, page, "dark");
		await page.screenshot({ path: path.join(SHOTS, "posting-dark.png") });
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
