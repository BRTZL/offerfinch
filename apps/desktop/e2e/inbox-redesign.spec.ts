import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";

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
 * The Inbox as one list with a floating action bar, in the background against the fixture
 * boards: the first row opens by itself (also after a status is picked), new rows carry a dot
 * until open for five seconds, Not interested and Interested sit in the bar, a draft in review
 * has Resolve, More, Reject and Approve (off while a flag is open, with the reason under the
 * bar), Rejected filters by reason chips and Applied groups by stage with a chip that moves it.
 * Screenshots go to test-results/redesign-shots (or E2E_SHOTS); with E2E_VIDEO set, a short
 * recording of a row leaving the list is saved there as list-animation.webm (and .gif when
 * ffmpeg is installed).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "redesign-shots"),
);
const userData = tempUserData();

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

async function dark(app: ElectronApplication, page: Page) {
	await app.evaluate(({ nativeTheme }) => {
		nativeTheme.themeSource = "dark";
	});
	await expect
		.poll(() =>
			page.evaluate(() => document.documentElement.classList.contains("dark")),
		)
		.toBe(true);
}

async function shot(page: Page, name: string, keepToasts = false) {
	fs.mkdirSync(SHOTS, { recursive: true });
	if (!keepToasts) await toastsGone(page, 20_000);
	await page.waitForTimeout(400);
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** A box's width in whole pixels. */
const widthOf = async (locator: Locator) =>
	Math.round((await locator.boundingBox())?.width ?? 0);

const selectedRow = (page: Page) =>
	page.locator("[data-testid=inbox-row][aria-selected=true]");

const stateOf = (id: string) =>
	withDb(
		userData,
		(db) =>
			(
				db.prepare("select state from applications where id = ?").get(id) as {
					state: string;
				}
			).state,
	);

test("Inbox redesign: one list, unread dots, the action bar, Rejected chips and Applied stages", async () => {
	const boards = await startFixtureBoards();
	// Enough matches for a list: the fixture's own and four more.
	for (const [id, title] of [
		[4101, "Staff Full-Stack Engineer"],
		[4102, "Lead Full-Stack Engineer"],
		[4103, "Senior Product Engineer"],
		[4104, "Full-Stack Engineer, Growth"],
	] as const)
		boards.addJob(id, title);
	let launched = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		const { app, page, errors } = launched;
		await page.setViewportSize({ width: 1440, height: 900 });
		await onboardWithFakes(page);
		await scanOnce(page, userData);
		await dark(app, page);

		// One list of everything; its first row opens by itself, so the detail is never empty.
		await sidebar(page, "Inbox").click();
		await expect(page.getByTestId("inbox-status")).toContainText("All");
		await expect(selectedRow(page)).toHaveCount(1, { timeout: 30_000 });
		await expect(page.getByTestId("inbox-row").first()).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(page.getByTestId("action-bar")).toBeVisible();
		// No segments, no in-list filter, no page actions in the header: the title, the count,
		// the add button and the search.
		await expect(page.getByRole("tab", { name: /^Matches/ })).toHaveCount(0);
		await expect(page.getByRole("searchbox")).toHaveCount(0);
		const header = page.locator("[data-ds=page-header]");
		await expect(header.getByTestId("search-button")).toBeVisible();
		await expect(header.getByTestId("scan-now")).toHaveCount(0);
		await expect(
			header.getByRole("button", { name: /Chat|Details/ }),
		).toHaveCount(0);
		// Every row says where it stands.
		const chips = page.getByTestId("status-chip");
		await expect(chips.first()).toBeVisible();
		expect(await chips.allTextContents()).toContain("Match");

		// Picking a status opens its first line.
		await showStatus(page, /^Matches/);
		await expect(page.getByTestId("inbox-status")).toContainText("Matches");
		await expect(
			page.locator(
				"[data-testid=inbox-scroll] [role=option][aria-selected=true]",
			),
		).toHaveCount(1, { timeout: 30_000 });
		await expect(page).toHaveURL(/company=|applications\//);
		await showStatus(page, /^All/);
		await expect(selectedRow(page)).toHaveCount(1, { timeout: 30_000 });

		// New rows carry a dot until opened for about five seconds; leaving sooner keeps it.
		const rows = page.getByTestId("inbox-row");
		const matchRows = rows.filter({
			has: page.getByText("Match", { exact: true }),
		});
		await expect(matchRows.nth(2)).toBeVisible();
		const second = matchRows.nth(1);
		const third = matchRows.nth(2);
		await expect(third.getByTestId("unread-dot")).toHaveCount(1);
		await third.click();
		await page.waitForTimeout(1_500);
		await second.click();
		await expect(second.getByTestId("unread-dot")).toHaveCount(1);
		await expect(third.getByTestId("unread-dot")).toHaveCount(1);
		await expect(second.getByTestId("unread-dot")).toHaveCount(0, {
			timeout: 9_000,
		});
		await expect(third.getByTestId("unread-dot")).toHaveCount(1);

		// A match: the fit card under the title, and Chat, Not interested and Interested in the bar.
		const bar = page.getByTestId("action-bar");
		await expect(bar).toHaveAttribute("data-kind", "match");
		await expect(bar).toHaveAttribute("role", "toolbar");
		await expect(page.getByTestId("fit-card")).toBeVisible();
		await expect(page.getByTestId("fit-card")).toContainText("Fit details");
		await expect(page.getByTestId("action-bar-caption")).toHaveText(
			"Interested drafts your CV and letter",
		);
		await expect(page.getByTestId("open-posting")).toBeVisible();
		const notInterested = bar.getByTestId("not-interested");
		const interested = bar.getByTestId("interested");
		const [a, b] = await Promise.all([
			notInterested.boundingBox(),
			interested.boundingBox(),
		]);
		expect(Math.round(a?.width ?? 0)).toBe(Math.round(b?.width ?? 1));
		expect(Math.round(a?.height ?? 0)).toBe(Math.round(b?.height ?? 1));
		await shot(page, "inbox-match");

		// The fit card opens the details from the right.
		await page.getByTestId("fit-card").click();
		await expect(page.getByTestId("inspector")).toBeVisible();
		await page.getByTestId("fit-card").click();
		await expect(page.getByTestId("inspector")).toHaveCount(0);
		// The sheet closes from its own button too (it can open over the card).
		await page.getByTestId("fit-card").click();
		await page.getByTestId("inspector-close").click();
		await expect(page.getByTestId("inspector")).toHaveCount(0);

		// Docked (wide window): no backdrop, the layout as before.
		const backdrop = page.getByTestId("focus-backdrop");
		await page.getByTestId("fit-card").click();
		await expect(page.getByTestId("inspector")).toBeVisible();
		await expect(backdrop).toHaveCount(0);
		await shot(page, "sheet-wide");
		await page.getByTestId("inspector-close").click();
		await expect(page.getByTestId("inspector")).toHaveCount(0);
		// Over the document (narrow window): the whole window behind the sheet dims and blurs, and
		// a click on it (here over the sidebar) closes the sheet.
		await page.setViewportSize({ width: 1100, height: 800 });
		await expect(backdrop).toBeHidden();
		await page.getByTestId("fit-card").click();
		await expect(page.getByTestId("inspector")).toBeVisible();
		await expect(backdrop).toBeVisible();
		expect(await backdrop.boundingBox()).toEqual({
			x: 0,
			y: 0,
			width: 1100,
			height: 800,
		});
		await shot(page, "sheet-backdrop-open");
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "light";
		});
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.documentElement.classList.contains("dark"),
				),
			)
			.toBe(false);
		await shot(page, "sheet-backdrop-open-light");
		await dark(app, page);
		await backdrop.click({ position: { x: 100, y: 400 } });
		await expect(page.getByTestId("inspector")).toHaveCount(0);
		await expect(backdrop).toBeHidden();
		// The chat over the document closes the same way.
		await page.getByTestId("chat-toggle").click();
		await expect(page.getByTestId("chat-panel")).toBeVisible();
		await expect(backdrop).toBeVisible();
		await backdrop.click({ position: { x: 100, y: 400 } });
		await expect(page.getByTestId("chat-panel")).toHaveCount(0);
		await expect(backdrop).toBeHidden();
		await page.setViewportSize({ width: 1440, height: 900 });

		// Not interested from the bar: the bar grows upward into a tray with the form, the window
		// dimmed behind it, and its button becomes the confirm; the row leaves, the next opens.
		await page.setViewportSize({ width: 1280, height: 800 });
		const leaving = await selectedRow(page).getAttribute("id");
		const before = await rows.count();
		const closedWidth = await widthOf(bar);
		const trayBackdrop = page.getByTestId("tray-backdrop");
		await expect(trayBackdrop).toBeHidden();
		await notInterested.click();
		const popover = page.getByTestId("not-interested-popover");
		await expect(popover).toContainText("Not interested in this job?");
		await expect(trayBackdrop).toBeVisible();
		await expect(notInterested).toHaveAttribute("data-confirm");
		await expect(notInterested).toBeFocused();
		// Chat and Interested go quiet and out of reach; the caption fades.
		await expect(interested).toHaveJSProperty("inert", true);
		await expect(bar.getByTestId("chat-toggle")).toHaveJSProperty(
			"inert",
			true,
		);
		await expect(page.getByTestId("action-bar-caption")).toHaveCSS(
			"opacity",
			"0",
		);
		// As wide as the bar was, and whole on screen once it has grown.
		await page.waitForTimeout(600);
		expect(await widthOf(bar)).toBe(closedWidth);
		expect(await widthOf(popover)).toBe(closedWidth);
		expect((await popover.boundingBox())?.y).toBeGreaterThan(0);
		await shot(page, "tray-open-dark");
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "light";
		});
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.documentElement.classList.contains("dark"),
				),
			)
			.toBe(false);
		await page.waitForTimeout(300);
		await shot(page, "tray-open-light");
		await dark(app, page);
		// A click on the backdrop cancels, and the bar is a bar again.
		await trayBackdrop.click({ position: { x: 100, y: 400 } });
		await expect(popover).toBeHidden();
		await expect(trayBackdrop).toBeHidden();
		await expect(notInterested).not.toHaveAttribute("data-confirm");
		await expect(interested).toHaveJSProperty("inert", false);
		// From the list: X opens it with focus on the confirm, so X then ↩ dismisses with no reasons.
		await page.getByTestId("inbox-scroll").focus();
		await page.keyboard.press("x");
		await expect(popover).toBeVisible();
		await expect(notInterested).toBeFocused();
		await shot(page, "not-interested-popover");
		await page.keyboard.press("Enter");
		await expect(popover).toBeHidden();
		await expect(trayBackdrop).toBeHidden();
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect(page.locator(`[id="${leaving}"]`)).toHaveCount(0);
		await expect(rows).toHaveCount(before - 1);
		await expect(selectedRow(page)).toHaveCount(1);
		// Focus is back on the list, so X ↩ X ↩ goes on down it.
		await expect(page.getByTestId("inbox-scroll")).toBeFocused();
		await expect(
			page
				.locator("[data-sonner-toast]")
				.filter({ hasText: /^Not interested in/ }),
		).toContainText("Undo");

		// Interested from the bar drafts it; in All the row stays, now Drafting, and the next opens.
		await toastsGone(page, 20_000);
		await page.waitForTimeout(6_000);
		const match = selectedRow(page);
		await expect(match.getByTestId("status-chip")).toHaveText("Match");
		const draftId =
			(await match.getAttribute("id"))?.replace(/^row-/, "") ?? "";
		await page.getByTestId("action-bar").getByTestId("interested").click();
		await expect(
			page.locator("[data-sonner-toast]").filter({ hasText: /^Drafting/ }),
		).toBeVisible();
		await expect(
			page.locator(`[id="row-${draftId}"]`).getByTestId("status-chip"),
		).not.toHaveText("Match", { timeout: 30_000 });
		await expect(selectedRow(page)).not.toHaveAttribute("id", `row-${draftId}`);

		// The draft may need an answer first: Questions has the search and no Saved answers link.
		await expect
			.poll(() => stateOf(draftId), { timeout: 120_000 })
			.toMatch(/needs_answers|ready_for_review/);
		if (stateOf(draftId) === "needs_answers") {
			await sidebar(page, "Questions").click();
			await expect(
				page.locator("[data-ds=page-header]").getByTestId("search-button"),
			).toBeVisible();
			await expect(page.getByText("Saved answers are in Profile")).toHaveCount(
				0,
			);
			const answer = page.getByRole("textbox").first();
			await expect(answer).toBeVisible({ timeout: 60_000 });
			await shot(page, "questions");
			while (
				countIn(
					userData,
					"select count(*) n from questions where status = 'open'",
				) > 0
			) {
				const open = countIn(
					userData,
					"select count(*) n from questions where status = 'open'",
				);
				await page.getByRole("textbox").first().fill("One month.");
				await page
					.getByRole("button", { name: /save|answer/i })
					.first()
					.click();
				await expect
					.poll(
						() =>
							countIn(
								userData,
								"select count(*) n from questions where status = 'open'",
							),
						{ timeout: 30_000 },
					)
					.toBeLessThan(open);
			}
		}
		await expect
			.poll(() => stateOf(draftId), { timeout: 180_000 })
			.toBe("ready_for_review");

		// To review: its first row opens; Resolve, Chat, More, Reject and Approve in the bar.
		await sidebar(page, "Inbox").click();
		await showStatus(page, /^To review/);
		await expect(selectedRow(page)).toHaveAttribute("id", `row-${draftId}`, {
			timeout: 30_000,
		});
		await expect(bar).toHaveAttribute("data-kind", "review");
		await expect(page.getByTestId("fit-card")).toHaveAttribute(
			"data-folded",
			"",
		);
		await expect(page.getByTestId("posting-toggle")).toBeVisible();
		const approve = bar.getByTestId("approve");
		await expect(approve).toBeVisible();
		// Wait for the check of this version: then either a flag holds Approve, or it opens.
		await expect
			.poll(
				async () =>
					(await bar.getByTestId("jump-to-flag").count()) > 0 ||
					(await approve.isEnabled()),
				{ timeout: 120_000 },
			)
			.toBe(true);
		if ((await bar.getByTestId("jump-to-flag").count()) > 0) {
			await expect(bar.getByTestId("jump-to-flag")).toContainText(
				/^Resolve \d/,
			);
			await expect(approve).toBeDisabled();
			await expect(page.getByTestId("action-bar-caption")).toContainText(
				"Approve opens once",
			);
			await bar.getByTestId("jump-to-flag").click();
			await expect(page.getByTestId("flag").first()).toBeInViewport();
		}
		await page.locator("#application-detail").focus();
		await shot(page, "inbox-review");

		// More: the review's secondary actions, with real labels.
		await bar.getByTestId("more-actions").click();
		const menu = page.getByTestId("more-menu");
		await expect(menu).toBeVisible();
		for (const label of [
			"Redraft",
			"Open Posting",
			"Copy Posting Link",
			"Save PDF",
			"Open Word Document",
			"Copy Text",
		])
			await expect(menu.getByRole("menuitem", { name: label })).toBeVisible();
		expect(
			await menu.getByRole("menuitem").allTextContents(),
		).not.toContainEqual(expect.stringMatching(/(…|\.\.\.)$/));
		await shot(page, "inbox-review-more");
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		// The toolbar is reachable by keyboard: arrows move between its buttons.
		await bar.getByTestId("chat-toggle").focus();
		await page.keyboard.press("ArrowRight");
		await expect(bar.getByTestId("more-actions")).toBeFocused();

		// Reject, with its reason, from the bar.
		await bar.getByTestId("reject").click();
		await page.getByTestId("reject-reason").fill("Too much travel");
		await page.getByTestId("reject-confirm").click();
		await expect
			.poll(() => stateOf(draftId), { timeout: 30_000 })
			.toBe("rejected");

		// Rejected: the reasons are chips on top of the list, with counts.
		await sidebar(page, "Rejected").click();
		const reasons = page.getByTestId("reason-filter");
		await expect(reasons).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("reason-all")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		// By you: the rejected draft with its reason, and the match marked Not interested earlier.
		await page.getByTestId("reason-user").click();
		await expect(page.getByTestId("rejected-row")).toHaveCount(2);
		await expect(
			page.getByTestId("rejected-row").filter({ hasText: "Too much travel" }),
		).toHaveCount(1);
		await expect(
			page.getByTestId("rejected-row").filter({ hasText: "Not interested" }),
		).toHaveCount(1);
		await page.getByTestId("reason-all").click();
		await page.getByTestId("rejected-row").first().click();
		await shot(page, "rejected");

		// Not interested on every match, one by one: when the last one leaves, the list is
		// empty and nothing stays open beside it (the leaving row is never opened again).
		await sidebar(page, "Inbox").click();
		await showStatus(page, /^Matches/);
		const lines = page.locator(
			"[data-testid=inbox-row], [data-testid=inbox-group]",
		);
		await expect(lines.first()).toBeVisible({ timeout: 30_000 });
		for (let i = 0; i < 12 && (await lines.count()) > 0; i++) {
			const group = page.getByTestId("inbox-group").first();
			if (
				(await group.count()) > 0 &&
				(await group.getAttribute("aria-expanded")) !== "true"
			)
				await group.click();
			const left = await page.getByTestId("inbox-row").count();
			await page.getByTestId("inbox-row").first().click();
			const dismissButton = page
				.getByTestId("action-bar")
				.getByTestId("not-interested");
			await dismissButton.click();
			// Open, the bar's own button confirms.
			await expect(dismissButton).toHaveAttribute("data-confirm");
			await dismissButton.click();
			await expect(page.getByTestId("inbox-row")).toHaveCount(left - 1);
		}
		await expect(lines).toHaveCount(0);
		await expect(page.getByTestId("inbox-empty")).toBeVisible();
		// Past the leaving row's fade: still nothing open.
		await page.waitForTimeout(1_000);
		await expect(page.locator("#application-detail")).toHaveCount(0);
		await expect(page.getByTestId("action-bar")).toHaveCount(0);
		expect(new URL(page.url()).pathname).toBe("/inbox");
		expect(errors).toEqual([]);
	} finally {
		await launched.app.close();
	}

	// Three jobs sent while the app is closed: Applied groups them by stage.
	const sent = withDb(userData, (db) =>
		db
			.prepare(
				"select a.id from applications a where a.state in ('scored', 'dismissed') order by a.rowid limit 3",
			)
			.all(),
	) as { id: string }[];
	expect(sent).toHaveLength(3);
	withDb(
		userData,
		(db) => {
			const mark = db.prepare(
				"update applications set state = 'applied', applied_via = 'manual', applied_at = ?, state_changed_at = ? where id = ?",
			);
			for (const [i, row] of sent.entries())
				mark.run(Date.now() - (i + 1) * 86_400_000, Date.now(), row.id);
		},
		false,
	);

	launched = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		...(process.env.E2E_VIDEO ? { recordVideoDir: SHOTS } : {}),
	});
	try {
		const { app, page, errors } = launched;
		await page.setViewportSize({ width: 1440, height: 900 });
		await dark(app, page);
		await openRoute(app, page, `/applied/${sent[0]?.id}`);
		const groups = page.getByTestId("list-group");
		await expect(groups.first()).toBeVisible({ timeout: 30_000 });
		await expect(groups.filter({ hasText: "Applied" })).toContainText("3");
		await expect(page.getByTestId("stage-filter")).toHaveCount(0);
		// A row's stage chip moves it to another stage, and the list regroups.
		const row = page.getByTestId("applied-row").first();
		await row.getByTestId("stage-menu").click();
		await page.getByTestId("stage-option-interviewing").click();
		await expect(groups.filter({ hasText: "Interviewing" })).toContainText(
			"1",
			{
				timeout: 30_000,
			},
		);
		await expect(groups.filter({ hasText: "Applied" })).toContainText("2");
		// A group closes and opens.
		await groups.filter({ hasText: "Applied" }).click();
		await expect(page.getByTestId("applied-row")).toHaveCount(1);
		await groups.filter({ hasText: "Applied" }).click();
		await expect(page.getByTestId("applied-row")).toHaveCount(3);
		await shot(page, "applied");

		if (process.env.E2E_VIDEO) {
			// A row leaving the Inbox: it fades, and the rows below slide up.
			await sidebar(page, "Inbox").click();
			await expect(selectedRow(page)).toHaveCount(1, { timeout: 30_000 });
			const match = page
				.getByTestId("inbox-row")
				.filter({ has: page.getByText("Match", { exact: true }) })
				.first();
			await match.click();
			await page.waitForTimeout(800);
			const dismissButton = page
				.getByTestId("action-bar")
				.getByTestId("not-interested");
			await dismissButton.click();
			await page.waitForTimeout(600);
			await dismissButton.click();
			await page.waitForTimeout(1_500);
		}
		expect(errors).toEqual([]);
	} finally {
		const video = launched.page.video();
		await launched.app.close();
		if (video) {
			const webm = path.join(SHOTS, "list-animation.webm");
			await video.saveAs(webm);
			try {
				execFileSync("ffmpeg", [
					"-y",
					"-loglevel",
					"error",
					"-sseof",
					"-6",
					"-i",
					webm,
					"-vf",
					"fps=20,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
					path.join(SHOTS, "list-animation.gif"),
				]);
			} catch {
				// No ffmpeg: the .webm is the recording.
			}
		}
	}
});
