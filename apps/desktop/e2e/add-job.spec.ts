import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from "@playwright/test";

import { startFixtureBoards } from "./fixture-boards";
import {
	launchApp,
	notices,
	RESUME,
	skipRestOfSetup,
	tempUserData,
} from "./launch";

/**
 * Add job from link, against local stand-ins only: a Greenhouse link (the fixture board), an
 * unknown site (a page on 127.0.0.1, allowed in test runs only), an Indeed link whose stand-in
 * shows a sign-in wall (paste fallback), a refused link, a job the filter would set aside
 * staying in the Inbox, and links read in the background: several at once, one slow and one
 * failing, the Inbox updating live, and a quit in the middle of a read. No real site is
 * contacted.
 */
test.describe.configure({ mode: "serial" });

const userData = tempUserData();
const SITES_DIR = path.resolve(
	import.meta.dirname,
	"../../../packages/core/test/fixtures/sites",
);
let boards: Awaited<ReturnType<typeof startFixtureBoards>>;
let server: http.Server;
let origin = "";

const POSTING = `<!doctype html><html><head><title>Frontend Engineer</title>
<meta property="og:site_name" content="Harbor Mills"></head><body>
<h1>Frontend Engineer</h1>
<p>Harbor Mills builds billing software for small shops. You will build our customer pages in React and TypeScript.</p>
<h2>Requirements</h2><ul><li>4 years of React</li><li>TypeScript</li><li>Remote - Worldwide</li></ul>
</body></html>`;

const SLOW_POSTING = `<!doctype html><html><head><title>Data Engineer | Tidewater</title>
<meta property="og:site_name" content="Tidewater"></head><body>
<nav>Our Jobs · Saved jobs</nav>
<main><h1>Data Engineer</h1>
<p>Tidewater moves freight data between ports. You will build the pipelines our planners rely on, in Python and SQL, with a small team that ships weekly.</p>
<p>Planners in twelve ports use what you build every morning, so reliability matters more than novelty here.</p>
<h2>Requirements</h2><ul><li>3 years of Python</li><li>SQL and dbt</li><li>Remote - Worldwide</li></ul>
<h2>What we offer</h2><ul><li>A yearly learning budget</li></ul></main></body></html>`;
let slowHits = 0;

test.beforeAll(async () => {
	boards = await startFixtureBoards();
	server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stand-in");
		// Slow the first time (the app is quit while it waits), quick after.
		if (url.pathname === "/careers/slow") {
			slowHits += 1;
			setTimeout(
				() => {
					res.writeHead(200, { "content-type": "text/html" });
					res.end(SLOW_POSTING);
				},
				slowHits === 1 ? 25_000 : 1_500,
			);
			return;
		}
		if (url.pathname === "/careers/frontend-engineer") {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(POSTING);
			return;
		}
		// Indeed's job page, answered with its sign-in wall.
		if (url.pathname === "/viewjob") {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(fs.readFileSync(path.join(SITES_DIR, "indeed-login.html")));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
const sql = (query: string) =>
	execFileSync("sqlite3", [path.join(userData, "offerfinch.sqlite"), query], {
		encoding: "utf8",
	}).trim();

test.afterAll(async () => {
	await boards.close();
	await new Promise<void>((r) => server.close(() => r()));
});

async function launch(env: Record<string, string> = {}) {
	return launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		env: {
			OFFERFINCH_LINK_ALLOW_LOCAL: "1",
			OFFERFINCH_SITE_ORIGINS: JSON.stringify({ indeed: origin }),
			...env,
		},
	});
}

const inbox = (page: Page) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: /^Inbox/ })
		.click();
const row = (page: Page, text: string | RegExp) =>
	page.getByTestId("inbox-row").filter({ hasText: text });

/** ⌘N as the menu bar sends it (accelerators can't be pressed through the test driver). */
async function openDialog(app: ElectronApplication, page: Page) {
	await app.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()?.getMenuItemById("add-job")?.click(),
	);
	await expect(page.getByTestId("add-job")).toBeVisible();
}

test("add a job from a link: a board, an unknown site, a wall, a filter miss kept, a refusal", async () => {
	const { app, page, errors } = await launch();
	try {
		// A profile and test models first (as onboarding does), then setup is put off.
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

		// Where the user lives, as onboarding fills it from a profile's location (this fabricated
		// resume has none). Without a country no place rules a job out, so step 4 needs one.
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: /^Settings/ })
			.click();
		await page
			.getByRole("navigation", { name: "Settings" })
			.getByRole("link", { name: /^Job search/ })
			.click();
		const livesIn = page.locator("#f-livesIn");
		await livesIn.click();
		await livesIn.fill("Turk");
		await expect(page.getByRole("option", { name: "Turkey" })).toBeVisible();
		await livesIn.press("ArrowDown");
		await livesIn.press("Enter");
		await page.getByTestId("save-settings").click();
		await expect(page.getByText(/^Saved\./)).toBeVisible();
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: /^Home/ })
			.click();

		// 1. From ⌘K: a Greenhouse link, read from the board's public data in the background.
		await page.getByTestId("search-button").click();
		await page.getByTestId("command-input").fill("Add job");
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("add-job")).toBeVisible();
		const board = "https://boards.greenhouse.io/acmerobotics/jobs/4001";
		await page.getByTestId("add-job-url").fill(board);
		await page.getByTestId("add-job-submit").click();
		// The dialog closes at once; the job opens, in progress, then with its result.
		await expect(page.getByTestId("add-job")).toBeHidden();
		await expect(
			page.getByText("Added to Inbox. Reading the posting in the background."),
		).toBeVisible();
		await expect
			.poll(() => new URL(page.url()).pathname)
			.toMatch(/^\/applications\//);
		const firstId = new URL(page.url()).pathname.split("/").pop();
		await expect(page.getByTestId("prepare")).toBeVisible({ timeout: 60_000 });
		await expect(
			page.getByRole("heading", {
				name: "Senior Full-Stack Engineer",
				level: 2,
			}),
		).toBeVisible();
		await expect(page.getByText("Acme Robotics").first()).toBeVisible();

		// The same link again, from the Inbox's + button: the job that exists opens.
		await inbox(page);
		await page.getByTestId("add-job-button").click();
		await page.getByTestId("add-job-url").fill(`${board}?gh_src=linkedin`);
		await page.getByTestId("add-job-submit").click();
		await expect(page.getByText("Already in your Inbox.")).toBeVisible();
		await expect
			.poll(() => new URL(page.url()).pathname)
			.toBe(`/applications/${firstId}`);

		// 2. Any other site: read once in the browser; structured data or main content, no AI.
		await openDialog(app, page);
		await page
			.getByTestId("add-job-url")
			.fill(`${origin}/careers/frontend-engineer`);
		await page.getByTestId("add-job-submit").click();
		await expect(page.getByTestId("add-job")).toBeHidden();
		// Wait for the new job to open: until then the first job, and its Prepare, is still shown.
		await expect
			.poll(() => new URL(page.url()).pathname)
			.not.toBe(`/applications/${firstId}`);
		await expect(page.getByTestId("prepare")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("Harbor Mills").first()).toBeVisible();
		// The posting, not the page: no doctype, title tag or furniture.
		await expect(
			page.getByRole("heading", { name: "Frontend Engineer", level: 2 }),
		).toBeVisible();
		await expect(page.getByTestId("posting")).toContainText("4 years of React");
		await expect(page.getByTestId("posting")).not.toContainText("DOCTYPE");
		await page.getByTestId("reread-posting").first().click();
		await expect(page.getByText("Posting read again.")).toBeVisible();

		// 3. An Indeed link whose page is a sign-in wall: the read stops and says so, with
		// Retry, Paste description and Remove.
		await openDialog(app, page);
		await page
			.getByTestId("add-job-url")
			.fill("https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60718");
		await page.getByTestId("add-job-submit").click();
		await expect(page.getByTestId("added-failed")).toContainText(
			/Indeed stopped the read/,
			{ timeout: 60_000 },
		);
		await page.getByTestId("added-failed").getByTestId("added-paste").click();
		await expect(page.getByTestId("add-job")).toBeVisible();
		await page.getByTestId("add-job-title").fill("Platform Engineer");
		await page.getByTestId("add-job-company").fill("Quarry Systems");
		await page
			.getByTestId("add-job-location")
			.fill("On-site in Berlin, Germany");
		await page
			.getByTestId("add-job-text")
			.fill(
				"Quarry Systems is hiring a platform engineer to work on-site in our Berlin office. Requirements: Go, Kubernetes, five years of backend work. Relocation is not offered.",
			);
		await page.getByTestId("add-job-submit").click();
		await expect(page.getByTestId("add-job")).toBeHidden();

		// 4. It fails the job filter (on-site abroad, relocation off), yet the user picked it: it
		// is in the Inbox, marked as theirs, with the reasons as a note, and Prepare stays.
		await expect(page.getByTestId("added-by-you")).toContainText(
			"doesn't match your job search",
			{ timeout: 60_000 },
		);
		await expect(page.getByTestId("added-by-you")).toContainText(
			"The posting says: “On-site in Berlin, Germany”",
		);
		await expect(page.getByTestId("prepare")).toBeVisible();
		await inbox(page);
		await page.getByRole("tab", { name: /^Matches/ }).click();
		await expect(row(page, "Platform Engineer")).toContainText(
			"Added by you · outside your search",
		);
		await expect(row(page, "Harbor Mills")).toContainText("Added by you");

		// 5. Refused before anything is saved: the dialog stays and says why.
		await openDialog(app, page);
		await page.getByTestId("add-job-url").fill("file:///etc/passwd");
		await page.getByTestId("add-job-submit").click();
		await expect(
			page.getByText("Only http and https links can be read."),
		).toBeVisible();
		await page.keyboard.press("Escape");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("several links at once: read in the background, live in the Inbox, through a quit", async () => {
	slowHits = 0;
	const slow = `${origin}/careers/slow`;
	const gone = `${origin}/careers/gone`;
	let { app, page, errors } = await launch();
	try {
		await inbox(page);
		await page.getByRole("tab", { name: /^All/ }).click();
		await page.getByTestId("add-job-button").click();
		await page.getByTestId("add-job-url").fill(`${slow}\n${gone}`);
		await page.getByTestId("add-job-submit").click();
		await expect(page.getByTestId("add-job")).toBeHidden();
		await expect(
			page.getByText("2 jobs added to Inbox. Reading them in the background."),
		).toBeVisible();
		// Both rows are there at once, by their site, in progress; the failing one says why.
		const slowRow = row(page, "/careers/slow");
		const goneRow = row(page, "/careers/gone");
		await expect(slowRow).toHaveAttribute("data-step", /reading|queued/);
		await expect(goneRow).toContainText(
			"Couldn't read: The page answered 404",
			{
				timeout: 30_000,
			},
		);
		await expect(goneRow.getByTestId("added-retry")).toBeVisible();
		await expect(goneRow.getByTestId("added-paste")).toBeVisible();
		await expect(slowRow).toHaveAttribute("data-step", "reading");
		await expect(slowRow).toContainText("Reading posting…");
		expect(slowHits).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		// Quit in the middle of the slow read.
		await app.close();
	}

	// After a restart the read starts again by itself and finishes; the row updates live, and
	// with the window not in front, a notification says it is ready.
	({ app, page, errors } = await launch({ OFFERFINCH_TEST_UNFOCUSED: "1" }));
	try {
		await inbox(page);
		await page.getByRole("tab", { name: /^All/ }).click();
		const slowRow = row(page, /Tidewater|\/careers\/slow/);
		await expect(slowRow).toContainText("Added by you", { timeout: 60_000 });
		await expect(slowRow).toContainText("Data Engineer");
		expect(slowHits).toBe(2);
		await expect
			.poll(
				async () =>
					(await notices(app)).filter(
						(n) =>
							n.kind === "added" && /Data Engineer at Tidewater/.test(n.title),
					).length,
				{ timeout: 30_000 },
			)
			.toBe(1);
		// The failed one stays failed (it is not read again by itself), and can be removed.
		const goneRow = row(page, "/careers/gone");
		await expect(goneRow).toContainText("Couldn't read");
		await goneRow.getByTestId("added-remove").click();
		await expect(goneRow).toHaveCount(0);
		expect(sql(`select count(*) from jobs where url = '${gone}'`)).toBe("0");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("on start, a posting stored as a whole page is read again and cleaned", async () => {
	// What an earlier version stored for a page link: the doctype, menus, a cookie notice.
	const raw = [
		"<!DOCTYPE html>",
		"",
		"Frontend Engineer | Harbor Mills",
		"",
		"This website uses cookies to improve your experience.",
		"JUMP TO CONTENT",
		"",
		"Search",
		"",
		"Saved jobs",
		"",
		"- Our Jobs",
	].join("\n");
	const url = `${origin}/careers/frontend-engineer`;
	sql(
		`update jobs set description_text = '${raw.replace(/'/g, "''")}', title = '<!DOCTYPE html>Frontend Engineer' where url = '${url}'`,
	);
	expect(
		sql(
			`select substr(description_text, 1, 15) from jobs where url = '${url}'`,
		),
	).toBe("<!DOCTYPE html>");
	const { app, errors } = await launch();
	try {
		await expect
			.poll(() => sql(`select title from jobs where url = '${url}'`), {
				timeout: 30_000,
			})
			.toBe("Frontend Engineer");
		const text = sql(`select description_text from jobs where url = '${url}'`);
		expect(text).toContain("## Requirements");
		expect(text).toContain("- 4 years of React");
		for (const word of ["DOCTYPE", "cookies", "JUMP TO CONTENT", "Saved jobs"])
			expect(text).not.toContain(word);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
