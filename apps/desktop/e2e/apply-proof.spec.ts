import fs from "node:fs";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { startFixtureBoards as startFormBoards } from "../../../packages/core/test/browser/fixture-boards";
import { startFixtureBoards } from "./fixture-boards";
import {
	APP_DIR,
	launchApp,
	openRoute,
	tempUserData,
	toastsGone,
} from "./launch";
import {
	countIn,
	onboardWithFakes,
	scanOnce,
	showStatus,
	withDb,
} from "./matches-setup";

/**
 * Proof and the stop sheet (docs/auto-apply-plan.md, step 7), on the local stand-in of the
 * Greenhouse form with fabricated data only: an approved application is submitted once and its
 * proof (when, the final page, the board's confirmation, every filled field, both screenshots)
 * is on the application page in Applied; a CAPTCHA on the form stops the run before anything is
 * sent and the stop sheet offers Finish it yourself, which opens the form in the user's browser
 * (stubbed here) with every approved answer ready to copy. Screenshots go to
 * test-results/apply-proof (or E2E_SHOTS); E2E_VIDEO records the stop sheet to a .webm there.
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "apply-proof"),
);
const JOB = "4001";
const TITLE = "Senior Full-Stack Engineer";

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

async function shot(page: Page, name: string) {
	fs.mkdirSync(SHOTS, { recursive: true });
	await toastsGone(page, 15_000);
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

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

/**
 * Onboards, scans, prepares the fixture's full-stack role, answers its question if one waits,
 * turns submissions on (they start paused) from the link in After you approve, through the
 * switch and its confirmation in Settings, and approves it. Returns its id.
 */
async function approveFullStack(page: Page, userData: string) {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await onboardWithFakes(page);
	await scanOnce(page, userData);
	await sidebar(page, "Inbox").click();
	await showStatus(page, /^Matches/);
	await page
		.getByTestId("inbox-group")
		.filter({ hasText: "Acme Robotics" })
		.click();
	await page.getByTestId("inbox-row").filter({ hasText: TITLE }).click();
	await page.getByTestId("interested").click();

	// The posting asks for a notice period: answered in Questions when it is asked.
	await expect
		.poll(() => appRow(userData)?.state, { timeout: 120_000 })
		.toMatch(/needs_answers|ready_for_review/);
	if (appRow(userData)?.state === "needs_answers") {
		await sidebar(page, "Questions").click();
		const answer = page.getByRole("textbox").first();
		await expect(answer).toBeVisible({ timeout: 30_000 });
		await answer.fill("One month.");
		await page
			.getByRole("button", { name: /save|answer/i })
			.first()
			.click();
	}
	await expect
		.poll(() => appRow(userData)?.state, { timeout: 120_000 })
		.toBe("ready_for_review");
	const id = appRow(userData)?.id ?? "";

	// Submissions are paused until the user turns them on; nothing is sent while paused.
	expect(
		countIn(
			userData,
			"select count(*) n from submission_settings where paused = 0",
		),
	).toBe(0);
	await sidebar(page, "Inbox").click();
	await showStatus(page, /^To review/);
	await page.getByTestId("inbox-row").filter({ hasText: TITLE }).click();
	// After you approve says so and links to the switch in Settings › Applying.
	const pausedLine = (await inspectorOf(page)).getByTestId(
		"after-approve-paused",
	);
	await expect(pausedLine).toBeVisible({ timeout: 30_000 });
	await pausedLine.getByTestId("submissions-settings-link").click();
	await turnSubmissionsOn(page);
	await expect
		.poll(() =>
			countIn(
				userData,
				"select count(*) n from submission_settings where paused = 0",
			),
		)
		.toBe(1);

	await sidebar(page, "Inbox").click();
	await showStatus(page, /^To review/);
	await page.getByTestId("inbox-row").filter({ hasText: TITLE }).click();
	await expect(
		(await inspectorOf(page)).getByTestId("after-approve"),
	).toBeVisible();
	await expect(page.getByTestId("after-approve-paused")).toHaveCount(0);
	// The fake checker flags lines of its own draft: settle each, as a user would, until Approve
	// opens. A required field with no value would keep it closed, with its own caption.
	const approve = page.getByTestId("approve");
	await expect
		.poll(
			async () => {
				if (await approve.isEnabled()) return "open";
				const caption =
					(await page
						.getByTestId("action-bar-caption")
						.textContent()
						.catch(() => "")) ?? "";
				if (/would be sent empty/.test(caption)) return caption;
				await settleOpenFlag(page);
				return (await approve.isEnabled()) ? "open" : caption;
			},
			{ timeout: 150_000, intervals: [1_500] },
		)
		.toBe("open");
	await approve.click();
	return id;
}

/** Settings › Applying: the switch asks first; Turn On confirms. */
async function turnSubmissionsOn(page: Page) {
	await expect(page).toHaveURL(/\/settings\/applying$/);
	const toggle = page.getByTestId("submissions-switch");
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await toggle.click();
	await expect(page.getByTestId("submissions-confirm-dialog")).toBeVisible();
	await page.getByTestId("submissions-confirm").click();
	await expect(page.getByTestId("submissions-confirm-dialog")).toHaveCount(0);
	await expect(toggle).toHaveAttribute("aria-checked", "true");
}

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

const inspectorOf = async (page: Page) => {
	const inspector = page.getByTestId("inspector");
	if (!(await inspector.isVisible()))
		await page.getByTestId("inspector-toggle").click();
	await expect(inspector).toBeVisible();
	return inspector;
};

test("a fixture submission's proof is on its page in Applied", async () => {
	const userData = tempUserData();
	const boards = await startFixtureBoards();
	const forms = await startFormBoards();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		env: {
			OFFERFINCH_BOARD_BASES: JSON.stringify({
				greenhouse: `${forms.url}/greenhouse`,
			}),
		},
	});
	try {
		const id = await approveFullStack(page, userData);
		await expect
			.poll(() => appRow(userData)?.state, { timeout: 120_000 })
			.toBe("applied");
		// Clicked once; the fixture received exactly one submission.
		expect(forms.count(JOB)).toBe(1);

		await sidebar(page, "Applied").click();
		await page.getByTestId("applied-row").filter({ hasText: "Acme" }).click();
		await expect(page).toHaveURL(new RegExp(id));
		const inspector = await inspectorOf(page);
		const attempt = inspector.getByTestId("attempt").first();
		// The page refreshes on its own from "Submitting" to the proof.
		await expect(attempt.getByTestId("attempt-status")).toHaveText(
			"Submitted (board confirmed)",
			{ timeout: 60_000 },
		);
		await expect(attempt.getByTestId("proof-confirmation")).toBeVisible();
		await expect(attempt.getByTestId("proof-final-url")).toContainText(
			forms.url,
		);
		// Every filled field with its value, and both screenshots.
		await expect(attempt.getByTestId("proof-field").first()).toBeVisible();
		expect(await attempt.getByTestId("proof-field").count()).toBeGreaterThan(5);
		await expect(attempt.getByTestId("proof-field")).toContainText([
			/One month\./,
		]);
		for (const which of ["before", "after"])
			await expect(
				attempt
					.locator(`[data-testid=proof-thumb][data-which=${which}]`)
					.getByTestId("proof-thumb-image"),
			).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId("applied-row").first()).toContainText(
			"Submitted (board confirmed)",
		);
		await attempt.scrollIntoViewIfNeeded();
		await shot(page, "apply-proof");

		// A thumbnail opens the page full size, in the app.
		await attempt
			.locator("[data-testid=proof-thumb][data-which=after]")
			.click();
		await expect(page.getByTestId("proof-full-image")).toBeVisible({
			timeout: 20_000,
		});
		await shot(page, "apply-proof-full");
		await page.keyboard.press("Escape");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
		await forms.close();
	}
});

/** Records every link handed to the default browser instead of opening it. */
async function stubBrowser(app: ElectronApplication) {
	await app.evaluate(({ shell }) => {
		const opened: string[] = [];
		(globalThis as unknown as { __opened: string[] }).__opened = opened;
		shell.openExternal = async (url: string) => {
			opened.push(url);
		};
	});
	return () =>
		app.evaluate(
			() => (globalThis as unknown as { __opened: string[] }).__opened,
		);
}

test("a fixture challenge stops the run and the stop sheet offers Finish it yourself", async () => {
	const userData = tempUserData();
	const boards = await startFixtureBoards();
	// The fixture form shows a CAPTCHA instead of its form for this posting.
	const forms = await startFormBoards(0, { variants: { [JOB]: ["captcha"] } });
	const video = process.env.E2E_VIDEO ? SHOTS : undefined;
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		env: {
			OFFERFINCH_BOARD_BASES: JSON.stringify({
				greenhouse: `${forms.url}/greenhouse`,
			}),
		},
		...(video ? { recordVideoDir: video } : {}),
	});
	try {
		const id = await approveFullStack(page, userData);
		await expect
			.poll(() => appRow(userData)?.state, { timeout: 120_000 })
			.toBe("needs_human");
		// Stopped before anything was sent: not_sent, nothing posted.
		expect(forms.count(JOB)).toBe(0);
		expect(
			countIn(
				userData,
				`select count(*) n from submission_attempts where application_id = '${id}' and status = 'not_sent'`,
			),
		).toBe(1);

		const opened = await stubBrowser(app);
		await openRoute(app, page, `/applications/${id}`);
		await page.getByTestId("stop-sheet-open").click();
		const sheet = page.getByTestId("stop-sheet");
		await expect(sheet).toHaveAttribute("data-case", "challenge");
		await expect(sheet).toContainText("The site asked for a human check");
		await expect(sheet.getByTestId("stop-reason")).toBeVisible();
		await expect(
			sheet
				.locator("[data-testid=proof-thumb][data-which=before]")
				.getByTestId("proof-thumb-image"),
		).toBeVisible({ timeout: 20_000 });
		// Nothing was clicked, so Retry is offered; an unknown outcome never gets a plain one.
		await expect(sheet.getByTestId("stop-retry")).toBeVisible();
		await expect(sheet.getByTestId("stop-retry_confirmed")).toHaveCount(0);
		await shot(page, "stop-sheet");

		await sheet.getByTestId("stop-finish").click();
		await expect(sheet.getByTestId("finish-panel")).toBeVisible();
		await expect
			.poll(opened)
			.toEqual([`${forms.url}/greenhouse/acmerobotics/jobs/${JOB}`]);
		const values = sheet.getByTestId("finish-values");
		await expect(values.getByTestId("copy-row").first()).toBeVisible();
		await expect(values).toContainText("One month.");
		await expect(sheet.getByTestId("finish-files")).toContainText("CV PDF");
		await values.getByRole("button", { name: /^Copy Email/ }).click();
		await expect(values.getByText("Copied")).toBeVisible();
		await shot(page, "stop-sheet-finish");

		// I submitted this, after sending it by hand: moves it to Applied, nothing sent from here.
		await sheet.getByTestId("stop-mark-submitted").click();
		await expect
			.poll(() => appRow(userData)?.state, { timeout: 30_000 })
			.toBe("applied");
		expect(forms.count(JOB)).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
		await forms.close();
	}
});
