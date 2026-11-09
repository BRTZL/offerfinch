import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { startFixtureBoards } from "./fixture-boards";
import {
	APP_DIR,
	launchApp,
	openRoute,
	tempUserData,
	toastsGone,
} from "./launch";
import { countIn, onboardWithFakes, withDb } from "./matches-setup";

/**
 * An employer's own form (decision 2026-11-09), on a local stand-in with fabricated data only: a
 * job added from its link is read before review, approved, filled and sent once. Whatever the
 * page shows after the click, it reads "Sent — check your email"; Got the email moves it to
 * Applied. Screenshots go to test-results/web-sent (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "web-sent"),
);
const TITLE = "Robotics Software Engineer";

async function shot(page: Page, name: string) {
	fs.mkdirSync(SHOTS, { recursive: true });
	await toastsGone(page, 15_000);
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** The posting and its application form on one page, as many employers' careers sites have. */
const POSTING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TITLE} | Quarry Robotics</title>
<meta property="og:site_name" content="Quarry Robotics"></head><body>
<main><h1>${TITLE}</h1>
<p>Quarry Robotics builds the software that steers warehouse robots. You will write TypeScript services and React tools for the people who run our fleets.</p>
<p>Our operators rely on what you build every day, so careful, well-tested code matters more than speed here.</p>
<h2>Requirements</h2><ul><li>4 years of TypeScript</li><li>React</li><li>Remote - Worldwide</li></ul>
<h2>Apply</h2>
<form method="post" action="/careers/robotics/apply">
<label for="full_name">Full name</label><input id="full_name" name="full_name" type="text" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<button type="submit">Submit application</button>
</form></main></body></html>`;

const THANKS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Thank you | Quarry Robotics</title></head>
<body><main><h1>Thank you for applying!</h1><p>We received your application and will be in touch by email.</p></main></body></html>`;

/** The stand-in employer site on 127.0.0.1: the posting with its form, and the thank-you. */
async function startEmployer() {
	const posts: string[] = [];
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stand-in");
		if (req.method === "POST" && url.pathname === "/careers/robotics/apply") {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				posts.push(body);
				res.writeHead(303, { location: "/careers/robotics/thanks" });
				res.end();
			});
			return;
		}
		res.writeHead(url.pathname.startsWith("/careers/robotics") ? 200 : 404, {
			"content-type": "text/html",
		});
		res.end(url.pathname === "/careers/robotics/thanks" ? THANKS : POSTING);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		link: `${origin}/careers/robotics`,
		posts,
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

const appRow = (userData: string) =>
	withDb(
		userData,
		(db) =>
			db
				.prepare(
					"select a.id, a.state from applications a join jobs j on j.id = a.job_id where j.title = ?",
				)
				.get(TITLE) as { id: string; state: string } | undefined,
	);

const inspectorOf = async (page: Page) => {
	const inspector = page.getByTestId("inspector");
	if (!(await inspector.isVisible()))
		await page.getByTestId("inspector-toggle").click();
	await expect(inspector).toBeVisible();
	return inspector;
};

const docTab = (page: Page, name: RegExp) =>
	page.getByRole("tablist", { name: "Document" }).getByRole("tab", { name });

/** Settles the first open flag: confirms it when it can be confirmed, else deletes the line. */
async function settleOpenFlag(page: Page) {
	for (const tab of [/^CV/, /^Letter/, /^Answers/]) {
		await docTab(page, tab).click();
		const open = page.getByTestId("flag").filter({
			has: page.getByTestId("flag-delete"),
		});
		if ((await open.count()) === 0) continue;
		const first = open.first();
		const confirm = first.getByTestId("flag-confirm");
		if (await confirm.count()) {
			await confirm.click();
			await page.getByTestId("flag-confirm-yes").click();
		} else await first.getByTestId("flag-delete").click();
		return;
	}
}

test("an employer's form is sent, check your email; Got the email moves it to Applied", async () => {
	const userData = tempUserData();
	const boards = await startFixtureBoards();
	const employer = await startEmployer();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		env: { OFFERFINCH_LINK_ALLOW_LOCAL: "1" },
	});
	try {
		await page.setViewportSize({ width: 1440, height: 1000 });
		await onboardWithFakes(page);

		// The job from its link: the posting is read, then its form, before review.
		await sidebar(page, "Inbox").click();
		await page.getByTestId("add-job-button").click();
		await page.getByTestId("add-job-url").fill(employer.link);
		await page.getByTestId("add-job-submit").click();
		await expect(page.getByTestId("add-job")).toBeHidden();
		await expect(page.getByTestId("interested")).toBeVisible({
			timeout: 60_000,
		});
		// A job added by hand is always the user's to send. Stand in for one the web search
		// found instead (source "web", whose link is followed to the employer's own form).
		withDb(
			userData,
			(db) =>
				db.prepare("update jobs set source = 'web' where title = ?").run(TITLE),
			false,
		);
		await page.getByTestId("interested").click();
		await expect
			.poll(() => appRow(userData)?.state, { timeout: 120_000 })
			.toBe("ready_for_review");
		const id = appRow(userData)?.id ?? "";

		// Submissions start paused: on through the switch in Settings › Applying.
		await openRoute(app, page, "/settings/applying");
		const toggle = page.getByTestId("submissions-switch");
		await toggle.click();
		await page.getByTestId("submissions-confirm").click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await openRoute(app, page, `/applications/${id}`);
		const approve = page.getByTestId("approve");
		await expect
			.poll(
				async () => {
					if (await approve.isEnabled()) return "open";
					await settleOpenFlag(page);
					return (await approve.isEnabled()) ? "open" : "closed";
				},
				{ timeout: 150_000, intervals: [1_500] },
			)
			.toBe("open");
		await approve.click();

		// Sent once, and the page thanked: still "Sent — check your email", never Applied.
		await expect
			.poll(() => appRow(userData)?.state, { timeout: 120_000 })
			.toBe("needs_human");
		expect(employer.posts).toHaveLength(1);
		expect(employer.posts[0]).toContain("email=");
		expect(
			countIn(
				userData,
				`select count(*) n from submission_attempts where application_id = '${id}' and status = 'needs_human' and json_extract(proof, '$.outcome') = 'web_sent'`,
			),
		).toBe(1);

		await openRoute(app, page, `/applications/${id}`);
		await expect(page.getByTestId("needs-human")).toContainText(
			"Sent — check your email",
			{ timeout: 30_000 },
		);
		const inspector = await inspectorOf(page);
		const attempt = inspector.getByTestId("attempt").first();
		await expect(attempt.getByTestId("attempt-status")).toHaveText(
			"Sent — check your email",
			{ timeout: 60_000 },
		);
		// What the run saw is information in the proof, not the decision.
		await expect(attempt.getByTestId("proof-evidence")).toContainText(
			"The employer's page showed",
		);
		await expect(attempt.getByTestId("proof-field").first()).toBeVisible();

		await page.getByTestId("stop-sheet-open").click();
		const sheet = page.getByTestId("stop-sheet");
		await expect(sheet).toHaveAttribute("data-case", "web_sent");
		await expect(sheet).toContainText("Sent — check your email");
		await expect(sheet.getByTestId("stop-got_email")).toBeEnabled();
		// No plain Retry; Retry and Finish it yourself wait for It didn't go through.
		await expect(sheet.getByTestId("stop-retry")).toHaveCount(0);
		await expect(sheet.getByTestId("stop-retry_confirmed")).toBeDisabled();
		await expect(sheet.getByTestId("stop-finish_confirmed")).toBeDisabled();
		await expect(
			sheet
				.locator("[data-testid=proof-thumb][data-which=after]")
				.getByTestId("proof-thumb-image"),
		).toBeVisible({ timeout: 20_000 });
		await shot(page, "web-sent");

		// Got the email: Applied, nothing sent again.
		await sheet.getByTestId("stop-got_email").click();
		await expect
			.poll(() => appRow(userData)?.state, { timeout: 30_000 })
			.toBe("applied");
		expect(employer.posts).toHaveLength(1);
		await sidebar(page, "Applied").click();
		await expect(
			page.getByTestId("applied-row").filter({ hasText: "Quarry Robotics" }),
		).toBeVisible();
		await openRoute(app, page, `/applications/${id}`);
		await expect(
			(await inspectorOf(page))
				.getByTestId("attempt")
				.filter({ hasText: "Sent, and you got the email" }),
		).toBeVisible();
		await shot(page, "web-sent-applied");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
		await employer.close();
	}
});
