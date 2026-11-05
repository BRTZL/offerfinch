import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE, EARLIER_DB_FILE } from "../src/main/database-file";
import { startFixtureBoards } from "./fixture-boards";
import {
	chirps,
	fakeChrome,
	launchApp,
	notices,
	openRoute,
	overlaySiteView,
	pickFakeModels,
	RESUME,
	siteTabs,
	standInClick,
	tempUserData,
	workerPid,
} from "./launch";
import { showStatus } from "./matches-setup";

/**
 * The desktop app end to end, with fake models and fixture job boards on 127.0.0.1: onboarding,
 * a first scan, notifications, a question, flagged lines, approval, the hand-off and "I
 * submitted this", then the worker and the whole app killed mid-flow and recovered.
 */
const SHOTS = process.env.E2E_SHOTS
	? path.resolve(process.env.E2E_SHOTS)
	: null;
const PLANTED = "Ran Kubernetes clusters for 300 services at Google.";

/** A page in the window's sidebar. */
const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });
/** A section in Settings' own column. */
const settingsNav = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Settings" })
		.getByRole("link", { name: new RegExp(`^${name}`) });
/** Who does a step: the pop-up button, then the choice. */
async function chooseMode(page: Page, role: string, mode: string) {
	await page.getByTestId(`role-${role}-mode`).click();
	await page.getByTestId(`role-${role}-${mode}`).click();
}
/** A tab of the document pane (CV, Letter, Answers). */
const docTab = (page: Page, name: RegExp) =>
	page.getByRole("tablist", { name: "Document" }).getByRole("tab", { name });

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.describe.configure({ mode: "serial" });

const userData = tempUserData();
let boards: Awaited<ReturnType<typeof startFixtureBoards>>;

test.beforeAll(async () => {
	boards = await startFixtureBoards();
});
test.afterAll(async () => {
	await boards.close();
});

test("onboarding, first scan, question, flagged lines, approval and hand-off", async () => {
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		// First start opens setup, on the welcome.
		await expect(page.getByTestId("welcome")).toBeVisible();
		await shot(page, "onboarding-welcome");
		await page.getByTestId("welcome-start").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 1 of 5");
		await shot(page, "onboarding-ai");

		// 1. Connect AI: Claude Code and Codex read as not installed in this run, so the step
		// shows how to install them and offers API keys; test models here, each role tested live.
		await expect(page.getByTestId("setup-cli-claude")).toHaveAttribute(
			"data-state",
			"missing",
		);
		await pickFakeModels(page);
		for (const role of ["scoring", "tailoring", "claims"])
			await expect(page.getByTestId(`role-${role}-state`)).toHaveText(/fake/);
		await page.getByTestId("role-scoring-test").click();
		await expect(page.getByTestId("role-scoring-test-result")).toContainText(
			"Works",
		);
		await expect(page.getByTestId("setup-ai-summary")).toHaveAttribute(
			"data-all-set",
			"true",
		);
		// Connected: one chirp (the default notification sound).
		await expect.poll(async () => (await chirps(app)).length).toBe(1);
		await page.getByTestId("step-continue").click();

		// 2. Your resume: paste, draft, then review in the same step, and save.
		await expect(page.getByTestId("step-count")).toContainText("Step 2 of 5");
		await page.getByTestId("resume-option-paste").click();
		await expect(page.getByTestId("onboarding-structure")).toBeDisabled();
		await page.getByTestId("onboarding-text").fill(RESUME);
		await page.getByTestId("onboarding-structure").click();
		await expect(page.getByTestId("onboarding-draft")).toBeVisible();
		await expect(page.getByTestId("step-count")).toContainText("Step 2 of 5");
		await shot(page, "onboarding-review");
		await page.getByTestId("onboarding-save").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 3 of 5");

		// 3. What you want: the rules (the defaults: no country; remote roles open worldwide are
		// kept), and where to look: job-board search through DuckDuckGo (a local stand-in here),
		// with nothing to set up. No companies.
		await expect(page.getByTestId("source-job-board-search-status")).toHaveText(
			"Not run yet",
		);
		await expect(
			page.getByTestId("source-job-board-search").locator("[title]").first(),
		).toHaveAttribute("title", /found with DuckDuckGo/);
		await expect(page.getByTestId("backend-brave")).toHaveCount(0);
		await shot(page, "onboarding-sources");
		// Continue saves what is on screen, a field still being typed in included.
		await expect(page.locator("#f-searchTitles")).toHaveCount(0);
		await page.locator("#f-roleKeywords").fill("design systems");
		await page.getByTestId("step-continue").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 4 of 5");
		const rules = readDb<{ settings: string }>(
			"select settings from filter_settings",
		);
		expect(rules).toHaveLength(1);
		expect(JSON.parse(rules[0]?.settings ?? "{}")).toMatchObject({
			roleKeywords: expect.arrayContaining(["design systems"]),
			searchTitles: [],
			rightToWork: [],
			languages: ["English"],
		});

		// 4. Stay in the loop: Continue works before any test (Home asks for one later if none is
		// shown); a test notification is shown (captured in test runs). Open at login stays off.
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		await page.getByTestId("notify-test").click();
		await expect(page.getByTestId("notify-status")).toHaveAttribute(
			"data-status",
			"delivered",
		);
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		await expect
			.poll(async () => (await notices(app)).length)
			.toBeGreaterThanOrEqual(1);
		await page.getByTestId("step-continue").click();
		await expect(page.getByTestId("step-count")).toContainText("Step 5 of 5");

		// 5. First search, live; the first match arrives with a chirp.
		await page.getByTestId("first-scan-start").click();
		await expect(page.getByTestId("first-scan-progress")).toContainText(
			"Done:",
			{ timeout: 90_000 },
		);
		await shot(page, "onboarding-first-scan");
		await expect(page.getByTestId("first-scan-progress")).toContainText(
			"3 jobs read",
		);
		// Scored matches: "N matches. They are waiting in your Inbox", with the second chirp.
		await expect(page.getByTestId("first-scan-progress")).toContainText(
			/match(es)?\. (They are|It is) waiting in your Inbox\./,
		);
		await expect.poll(async () => (await chirps(app)).length).toBe(2);
		// The searches came from the profile's role titles; no company board was listed by name.
		expect(boards.searches.length).toBeGreaterThan(0);
		expect(
			boards.searches.every((q) =>
				/"(?:Senior Frontend Engineer|Senior Full-Stack Engineer|Software Engineer)"/.test(
					q,
				),
			),
		).toBe(true);
		await page.getByTestId("onboarding-finish").click();

		// Tailoring is on demand: matches are listed, nothing is drafted until Interested.
		await sidebar(page, "Inbox").click();
		await showStatus(page, /^Matches/);
		// Acme's matches are one line that opens to its roles.
		const acme = page
			.getByTestId("inbox-group")
			.filter({ hasText: "Acme Robotics" });
		await expect(acme).toBeVisible({ timeout: 90_000 });
		await acme.click();
		const match = page
			.getByTestId("inbox-row")
			.filter({ hasText: "Senior Full-Stack Engineer" });
		await expect(match).toBeVisible();
		expect(
			readDb<{ n: number }>("select count(*) n from documents")[0]?.n,
		).toBe(0);
		await match.click();
		await expect(page.getByTestId("fit-card")).toBeVisible();
		await shot(page, "application-match");
		await page.getByTestId("interested").click();
		// It left Matches (it is drafting now), and the next match opened.
		await expect(match).toHaveCount(0);

		// The posting asks for a notice period: a question waits.
		await sidebar(page, "Questions").click();
		const answer = page.getByRole("textbox").first();
		await expect(answer).toBeVisible({ timeout: 90_000 });
		await shot(page, "questions");
		await answer.fill("One month.");
		await page
			.getByRole("button", { name: /save|answer/i })
			.first()
			.click();

		// The application is drafted again and reaches review.
		await sidebar(page, "Inbox").click();
		await showStatus(page, /^To review/);
		const row = page
			.getByTestId("inbox-row")
			.filter({ hasText: "Senior Full-Stack Engineer" });
		await expect(row).toBeVisible({ timeout: 90_000 });
		await row.click();
		await expect(
			page.locator("[data-testid=action-bar][data-kind=review]"),
		).toBeVisible({
			timeout: 90_000,
		});
		await shot(page, "application-review");

		// In dark mode the CV page takes the theme's dark surface and light ink, not white paper.
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "dark";
		});
		const cvPage = page.locator("[data-testid=doc-cv]");
		await expect(cvPage).toBeVisible();
		await expect
			.poll(() =>
				cvPage.evaluate((el) => {
					const lum = (rgb: string) => {
						const [r = 0, g = 0, b = 0] = (rgb.match(/[\d.]+/g) ?? []).map(
							Number,
						);
						return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
					};
					const style = getComputedStyle(el);
					return lum(style.backgroundColor) < 0.2 && lum(style.color) > 0.6;
				}),
			)
			.toBe(true);
		await shot(page, "application-review-dark");
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "system";
		});

		// Notifications: the first scan's strong matches came as one notification, then a
		// question and a review; a click on the review opens that application.
		await expect
			.poll(
				async () => {
					const kinds = (await notices(app)).map((n) => n.kind);
					return kinds.includes("question") && kinds.includes("review");
				},
				{ timeout: 90_000 },
			)
			.toBe(true);
		const shown = await notices(app);
		const matches = shown.filter(
			(n) => n.kind === "match" && n.path !== "/settings/notifications",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.title).toMatch(/strong match/);
		// One application opens itself; several (grouped) open the list they are in.
		const review = shown.find((n) => n.kind === "review");
		expect(review?.path).toMatch(
			/^\/(applications\/[0-9a-f-]{36}|inbox\?view=review)$/,
		);
		await sidebar(page, "Home").click();
		await openRoute(app, page, review?.path ?? "");
		await expect(
			page.locator("[data-testid=action-bar][data-kind=review]"),
		).toBeVisible();
		if (!review?.path.startsWith("/applications/")) await row.click();
		await expect(page.getByTestId("approve")).toBeVisible();

		// Plant an unsupported line in the CV: the check flags it, approval is refused.
		await docTab(page, /^CV/).click();
		await page.getByRole("button", { name: /^Edit/ }).first().click();
		const editor = page.locator("textarea").first();
		const text = await editor.inputValue();
		await editor.fill(text.replace("## Skills", `- ${PLANTED}\n\n## Skills`));
		await page.getByRole("button", { name: /^Save/ }).first().click();
		const flag = page.getByTestId("flag").filter({ hasText: PLANTED }).first();
		await expect(flag).toBeVisible({ timeout: 90_000 });
		// A flag cannot be missed: Approve is locked, the action bar counts what is open and jumps
		// to it, and the details open by themselves.
		await expect(page.getByTestId("approve")).toBeDisabled();
		await expect(page.getByTestId("jump-to-flag")).toContainText(/^Resolve \d/);
		await expect(page.getByTestId("action-bar-caption")).toContainText(
			"Approve opens once",
		);
		await expect(page.getByTestId("inspector")).toBeVisible();
		// Fit notes read as formatted text, not Markdown source.
		await page.getByRole("button", { name: "Fit notes" }).click();
		const notes = page.getByTestId("fit-notes");
		await expect(notes.locator("h2").first()).toBeVisible();
		await expect(notes).not.toContainText("## ");
		await page.getByTestId("jump-to-flag").click();
		await shot(page, "flagged-line");
		await flag.getByTestId("flag-delete").click();
		await expect(
			page.getByTestId("flag").filter({ hasText: PLANTED }),
		).toHaveCount(0, {
			timeout: 90_000,
		});

		// The fake checker also flagged lines of its own draft: settle each open one, tab by tab,
		// as a user would, until Approve opens (each settle may start a short re-check).
		const approve = page.getByRole("button", { name: /^Approve/ }).first();
		const settleOpenFlags = async () => {
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
		};
		await expect
			.poll(
				async () => {
					if (await approve.isEnabled()) return true;
					await settleOpenFlags();
					return approve.isEnabled();
				},
				{ timeout: 150_000, intervals: [1_500] },
			)
			.toBe(true);
		await shot(page, "before-approve");
		await approve.click();
		await expect(page.getByTestId("handoff")).toBeVisible({ timeout: 60_000 });
		const appId = new URL(page.url()).pathname.split("/").pop();
		expect(
			readDb<{ state: string }>(
				"select state from applications where id = ?",
				appId,
			)[0]?.state,
		).toBe("approved");
		await shot(page, "hand-off");
		await page.getByTestId("mark-submitted").click();
		await expect
			.poll(
				() =>
					readDb<{ state: string; applied_via: string }>(
						"select state, applied_via from applications where id = ?",
						appId,
					)[0],
				{ timeout: 60_000 },
			)
			.toEqual({ state: "applied", applied_via: "manual" });
		await expect(page.getByText(/Applied by you on/)).toBeVisible({
			timeout: 30_000,
		});
		// Sent: its progress after Applied opens beside it, at Applied.
		await expect(
			page.getByTestId("tracking").getByTestId("stage-chip"),
		).toHaveText("Applied", { timeout: 30_000 });
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

/** Reads the app's database directly (WAL allows a reader beside the running app). */
function readDb<T>(sql: string, ...params: unknown[]): T[] {
	const db = new Database(path.join(userData, DB_FILE), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

test("the Inbox by keyboard and right-click; nothing approves by key, menu or ⌘K", async () => {
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await sidebar(page, "Inbox").click();
		await showStatus(page, /^All/);
		const rows = page.getByTestId("inbox-row");
		await expect(rows.first()).toBeVisible({ timeout: 30_000 });
		// The list fills in as it loads: wait for the rest, not only the first row.
		await expect
			.poll(() => rows.count(), { timeout: 30_000 })
			.toBeGreaterThan(1);
		const selected = () => new URL(page.url()).pathname.split("/").pop();

		// Arrow keys move the selection, Home and End jump, as in Mail.
		await rows.first().click();
		const firstId = selected();
		await page.keyboard.press("ArrowDown");
		await expect.poll(selected).not.toBe(firstId);
		await page.keyboard.press("ArrowUp");
		await expect.poll(selected).toBe(firstId);
		await page.keyboard.press("End");
		await expect
			.poll(async () => rows.last().getAttribute("aria-selected"))
			.toBe("true");
		await page.keyboard.press("Home");
		await expect.poll(selected).toBe(firstId);

		// A row waiting for review: prepare a second match (Interested is a button here).
		const listed = readDb<{ id: string }>(
			"select id from applications where state = 'scored' limit 1",
		)[0];
		expect(listed).toBeDefined();
		await page.goto(`app://local/applications/${listed?.id}?view=all`);
		await page.getByTestId("interested").click();
		await expect
			.poll(
				() =>
					readDb<{ state: string }>(
						"select state from applications where id = ?",
						listed?.id,
					)[0]?.state,
				{ timeout: 90_000 },
			)
			.toBe("ready_for_review");
		// No key in the list or the detail approves it.
		const pending = readDb<{ id: string }>(
			"select id from applications where state = 'ready_for_review' limit 1",
		)[0];
		if (pending) {
			await page.goto(`app://local/applications/${pending.id}?view=all`);
			await expect(page.getByTestId("approve")).toBeVisible({
				timeout: 30_000,
			});
			await page.getByRole("listbox", { name: "Applications" }).focus();
			for (const key of ["Space", "Meta+Enter", "Control+Enter", "a", "Enter"])
				await page.keyboard.press(key);
			// ↩ moved focus into the application, never onto Approve.
			expect(await page.evaluate(() => document.activeElement?.id ?? "")).toBe(
				"application-detail",
			);
			for (const key of ["Enter", "Space", "Meta+Enter"])
				await page.keyboard.press(key);
			await page.waitForTimeout(1_000);
			expect(
				readDb<{ state: string }>(
					"select state from applications where id = ?",
					pending.id,
				)[0]?.state,
			).toBe("ready_for_review");
		}

		// Native feel: app chrome, rows, labels and headers are not selectable text; the document,
		// the posting and fields are.
		await page.getByTestId("posting-toggle").click();
		const selectable = await page.evaluate(() => {
			const us = (sel: string) => {
				const el = document.querySelector(sel);
				return el ? getComputedStyle(el).userSelect : "missing";
			};
			return {
				sidebar: us("[data-ds=sidebar] a"),
				title: us("[data-ds=page-title]"),
				row: us("[data-testid=inbox-row]"),
				button: us("[data-testid=approve]"),
				document: us(".doc-page"),
				posting: us("[data-testid=posting]"),
				field: us("input"),
				cursor: getComputedStyle(
					document.querySelector("[data-testid=inbox-row]") as Element,
				).cursor,
			};
		});
		expect(selectable).toEqual({
			sidebar: "none",
			title: "none",
			row: "none",
			button: "none",
			document: "text",
			posting: "text",
			field: "text",
			cursor: "pointer",
		});

		// The list, the posting and the details resize by dragging their edge; double-click resets.
		const widthOf = (sel: string) =>
			page.evaluate(
				(s) =>
					Math.round(
						(document.querySelector(s) as Element).getBoundingClientRect()
							.width,
					),
				sel,
			);
		const drag = async (label: string, dx: number) => {
			const box = await page
				.getByRole("separator", { name: label })
				.boundingBox();
			if (!box) throw new Error(`no ${label} handle`);
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			await page.mouse.move(x, y);
			await page.mouse.down();
			await page.mouse.move(x + dx / 2, y, { steps: 4 });
			await page.mouse.move(x + dx, y, { steps: 4 });
			await page.mouse.up();
		};
		const openedDetails = !(await page.getByTestId("inspector").isVisible());
		if (openedDetails) await page.getByTestId("fit-card").click();
		const listCol = () =>
			page.evaluate(() => {
				const handle = document.querySelector("[aria-label='Resize the list']");
				const column = handle?.parentElement;
				if (!column) throw new Error("no list column");
				return Math.round(column.getBoundingClientRect().width);
			});
		const list0 = await listCol();
		await drag("Resize the list", 60);
		expect(await listCol()).toBe(list0 + 60);
		const posting0 = await widthOf("aside[aria-label=Posting]");
		await drag("Resize the posting", -40);
		expect(await widthOf("aside[aria-label=Posting]")).toBe(posting0 - 40);
		const details0 = await widthOf("[data-testid=inspector]");
		await drag("Resize the details", -40);
		await page.getByRole("separator", { name: "Resize the posting" }).hover();
		await shot(page, "resized-panels");
		expect(await widthOf("[data-testid=inspector]")).toBe(details0 + 40);
		expect(
			await page.evaluate(() => localStorage.getItem("offerfinch.width.list")),
		).toBe(String(list0 + 60));
		for (const label of [
			"Resize the list",
			"Resize the posting",
			"Resize the details",
		])
			await page.getByRole("separator", { name: label }).dblclick();
		expect(await listCol()).toBe(list0);
		expect(await widthOf("aside[aria-label=Posting]")).toBe(posting0);
		expect(await widthOf("[data-testid=inspector]")).toBe(details0);
		if (openedDetails) await page.getByTestId("inspector-close").click();
		await page.getByTestId("posting-toggle").click();

		// Right-click a row: the native menu (recorded here) offers no Approve; Copy works.
		await app.evaluate(({ Menu }) => {
			const g = globalThis as unknown as {
				__menus: string[][];
				__pick: string;
			};
			g.__menus = [];
			g.__pick = "Copy Posting Link";
			Menu.prototype.popup = function (options) {
				g.__menus.push(this.items.map((i) => i.label));
				this.items.find((i) => i.label === g.__pick)?.click();
				options?.callback?.();
			};
		});
		await rows.first().click({ button: "right" });
		const menus = await app.evaluate(
			() => (globalThis as unknown as { __menus: string[][] }).__menus,
		);
		expect(menus.at(-1)).toContain("Open Posting");
		expect(menus.flat().filter((l) => /approve/i.test(l))).toEqual([]);
		await expect(page.getByText("Posting link copied.")).toBeVisible();

		// ⌘K: pages, settings and applications, and no Approve command.
		await page.getByTestId("search-button").click();
		await expect(page.getByTestId("command-menu")).toBeVisible();
		const labels = await page.getByTestId("command-item").allTextContents();
		expect(labels.some((l) => /Inbox/.test(l))).toBe(true);
		expect(labels.filter((l) => /approve/i.test(l))).toEqual([]);
		await page.getByTestId("command-input").fill("approve");
		await expect(page.getByTestId("command-item")).toHaveCount(0);
		await page.getByTestId("command-input").fill("sources");
		await page.keyboard.press("Enter");
		await expect
			.poll(() => new URL(page.url()).pathname)
			.toBe("/settings/sources");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("the profile as records: a view per section, add, edit, move and remove in a sheet", async () => {
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await sidebar(page, "Profile").click();
		await expect
			.poll(() => new URL(page.url()).pathname)
			.toBe("/profile/about");
		await expect(page.getByText("Sam Rivera")).toBeVisible();
		const sections = page.getByRole("navigation", { name: "Profile sections" });
		await sections.getByRole("link", { name: /^Experience/ }).click();
		const rows = page.getByTestId("record-row");
		await expect(rows.first()).toContainText("Tidewater Health");
		const before = await rows.count();

		await page.getByTestId("profile-add").click();
		await page.getByTestId("record-company").fill("Harbor Mills");
		await page.getByTestId("record-title").fill("Frontend Engineer");
		await page.getByTestId("record-start").fill("Jan 2019");
		await page.getByTestId("record-end").fill("Dec 2020");
		await page
			.getByTestId("record-bullets")
			.fill("Built the billing page in React.");
		await page.getByTestId("record-save").click();
		await expect(rows).toHaveCount(before + 1);
		await expect(rows.last()).toContainText("Harbor Mills · Frontend Engineer");

		await rows.last().click();
		await page.getByTestId("record-title").fill("Senior Frontend Engineer");
		await page.getByTestId("record-save").click();
		await expect(rows.last()).toContainText("Senior Frontend Engineer");
		const saved = readDb<{ data: string; source: string }>(
			"select data, source from profile_records where kind = 'experience' and data like '%Harbor Mills%'",
		);
		expect(saved).toHaveLength(1);
		expect(JSON.parse(saved[0]?.data ?? "{}")).toMatchObject({
			title: "Senior Frontend Engineer",
			bullets: ["Built the billing page in React."],
		});
		expect(saved[0]?.source).toBe("you, in the app");

		await rows.last().getByRole("button", { name: "Move up" }).click();
		await expect(rows.nth(before - 1)).toContainText("Harbor Mills");
		await shot(page, "profile-experience");

		await rows.nth(before - 1).click();
		await page.getByTestId("record-remove").click();
		await page.getByTestId("record-remove-confirm").click();
		await expect(rows).toHaveCount(before);

		await sections.getByRole("link", { name: /^Answers/ }).click();
		await expect(page.getByTestId("fact").first()).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("an earlier version's Brave Search key and SearXNG choice are removed at start", async () => {
	// What an earlier version left: an encrypted Brave key and SearXNG as the search service.
	const secretsFile = path.join(userData, "secrets.json");
	const before = fs.existsSync(secretsFile)
		? JSON.parse(fs.readFileSync(secretsFile, "utf8"))
		: {};
	fs.writeFileSync(
		secretsFile,
		JSON.stringify({ ...before, brave: "bm90LWEtcmVhbC1rZXk=" }),
	);
	const db = new Database(path.join(userData, DB_FILE));
	try {
		db.prepare(
			"update source_providers set config = ? where provider = 'job-board-search'",
		).run(JSON.stringify({ backend: "searxng", searxngUrl: boards.base }));
	} finally {
		db.close();
	}
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		await expect(
			page.getByTestId("source-job-board-search").locator("[title]").first(),
		).toHaveAttribute("title", /found with DuckDuckGo/);
		await expect(page.getByTestId("backend-searxng")).toHaveCount(0);
		expect(
			Object.keys(JSON.parse(fs.readFileSync(secretsFile, "utf8"))),
		).not.toContain("brave");
		const rows = readDb<{ config: string }>(
			"select config from source_providers where provider = 'job-board-search'",
		);
		expect(rows.map((r) => JSON.parse(r.config))).toEqual([{}]);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

test("Indeed and Glassdoor read local stand-ins only: jobs handed off, a check stops and holds", async () => {
	const SITES_DIR = path.resolve(
		import.meta.dirname,
		"../../../packages/core/test/fixtures/sites",
	);
	const served: string[] = [];
	const PAGES: Record<string, Record<string, string>> = {
		"127.0.0.1": {
			"/jobs": "indeed-search.html",
			"/viewjob": "indeed-job.html",
		},
		localhost: { "/Job/jobs.htm": "glassdoor-check.html" },
	};
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stand-in");
		const host = String(req.headers.host ?? "");
		served.push(`${host}${url.pathname}`);
		const name = PAGES[host.split(":")[0] ?? ""]?.[url.pathname];
		if (!name) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end(fs.readFileSync(path.join(SITES_DIR, name)));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const indeedPort = (server.address() as AddressInfo).port;
	// Glassdoor on another origin of the same server: localhost instead of 127.0.0.1.
	const origins = {
		indeed: `http://127.0.0.1:${indeedPort}`,
		glassdoor: `http://localhost:${indeedPort}`,
	};
	const chrome = fakeChrome();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		env: {
			OFFERFINCH_SITE_ORIGINS: JSON.stringify(origins),
			// Glassdoor's stand-in check is never solved: the wait ends quickly and it stops.
			OFFERFINCH_CHECK_TIMEOUT_MS: "1500",
			OFFERFINCH_CHROME: chrome.executable,
		},
	});
	try {
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		await expect(page.getByTestId("source-indeed-status")).toHaveText("Off");
		await page.getByTestId("source-indeed-enabled").click();
		await page.getByTestId("source-glassdoor-enabled").click();
		await expect(page.getByTestId("source-indeed-status")).toHaveText(
			"Not run yet",
		);
		const sources = async () => {
			await sidebar(page, "Settings").click();
			await settingsNav(page, "Sources").click();
		};
		await sidebar(page, "Home").click();
		await page.getByTestId("scan-now").click();
		await expect
			.poll(
				() =>
					readDb<{ n: number }>(
						"select count(*) n from jobs where source = 'indeed'",
					)[0]?.n,
				{ timeout: 90_000 },
			)
			.toBe(2);
		await sources();
		await expect(page.getByTestId("source-glassdoor-status")).toHaveText(
			/^Stopped: Glassdoor bot check/,
			{ timeout: 90_000 },
		);
		await expect(page.getByTestId("source-indeed-status")).toHaveText(
			// One search per role title in the profile (Job search no longer sets titles).
			/2 searches, 2 new postings, 2 new jobs/,
			{ timeout: 30_000 },
		);
		await shot(page, "settings-sources-sites");
		// Only the stand-ins were read: the search page for each search, each job page once.
		expect(served.filter((s) => s.startsWith("127.0.0.1")).sort()).toEqual([
			`127.0.0.1:${indeedPort}/jobs`,
			`127.0.0.1:${indeedPort}/jobs`,
			`127.0.0.1:${indeedPort}/viewjob`,
			`127.0.0.1:${indeedPort}/viewjob`,
		]);
		expect(served.filter((s) => s.startsWith("localhost"))).toEqual([
			`localhost:${indeedPort}/Job/jobs.htm`,
		]);

		// A stopped source opens nothing on the next scan until it is cleared.
		const scansDone = () =>
			readDb<{ n: number }>(
				"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
			)[0]?.n ?? 0;
		const before = scansDone();
		await sidebar(page, "Home").click();
		await expect(page.getByTestId("scan-now")).toBeEnabled({ timeout: 60_000 });
		await page.getByTestId("scan-now").click();
		await expect.poll(scansDone, { timeout: 90_000 }).toBeGreaterThan(before);
		await sources();
		expect(served.filter((s) => s.startsWith("localhost"))).toHaveLength(1);
		// Its one fix: Retry now (lifts the hold and scans again).
		await expect(page.getByTestId("source-glassdoor-retry")).toBeVisible();
		await page.getByTestId("source-glassdoor-enabled").click();
		await page.getByTestId("source-indeed-enabled").click();

		// Indeed jobs are handed off: never submitted by the app.
		const indeedApp = readDb<{ id: string }>(
			"select a.id from applications a join jobs j on j.id = a.job_id where j.source = 'indeed' limit 1",
		)[0];
		expect(indeedApp).toBeDefined();
		// Read in the app's own hidden tabs: no Chrome was started, no Chrome profile made.
		expect(chrome.launches()).toEqual([]);
		expect(fs.existsSync(path.join(userData, "indeed-chrome"))).toBe(false);
		expect(fs.existsSync(path.join(userData, "glassdoor-chrome"))).toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await new Promise<void>((r) => server.close(() => r()));
	}
});

test("site tabs inside the app: the sign-in sheet, a check that pauses and notifies, Watch live, resume", async () => {
	const SITES_DIR = path.resolve(
		import.meta.dirname,
		"../../../packages/core/test/fixtures/sites",
	);
	const served: string[] = [];
	// Indeed's stand-in: a sign-in page, and a search page behind a fake "verify you're human"
	// check that clears when its button is clicked (by the test, as a person would).
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stand-in");
		served.push(url.pathname);
		const cookies = String(req.headers.cookie ?? "");
		const html = (body: string) => {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(body);
		};
		if (url.pathname === "/auth")
			return html(
				`<!doctype html><html><head><title>Sign in | Indeed stand-in</title></head><body style="font:16px system-ui;padding:40px"><h1>Sign in to the Indeed stand-in</h1><p><input name="email" placeholder="Email"></p><p><input name="password" type="password" placeholder="Password"></p><button id="sign-in" onclick="document.cookie='session=1; path=/'; location.href='/'">Sign in</button></body></html>`,
			);
		if (url.pathname === "/")
			return html(
				"<!doctype html><html><head><title>Indeed stand-in</title></head><body><p>Home</p></body></html>",
			);
		if (url.pathname === "/jobs") {
			if (!cookies.includes("verified=1"))
				return html(
					`<!doctype html><html><head><title>Just a moment | Indeed stand-in</title></head><body style="font:16px system-ui;padding:40px"><h1>Verify you're human</h1><p>A fabricated check on a local stand-in page.</p><button id="verify" onclick="document.cookie='verified=1; path=/'; location.reload()">I'm human</button></body></html>`,
				);
			// New postings (ids the earlier Indeed run has not seen).
			return html(
				fs
					.readFileSync(path.join(SITES_DIR, "indeed-search.html"), "utf8")
					.replace("a1b2c3d4e5f60718", "b1b2c3d4e5f60718")
					.replace("0f1e2d3c4b5a6978", "1f1e2d3c4b5a6978"),
			);
		}
		if (url.pathname === "/viewjob")
			return html(
				fs.readFileSync(path.join(SITES_DIR, "indeed-job.html"), "utf8"),
			);
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const chrome = fakeChrome();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		env: {
			OFFERFINCH_SITE_ORIGINS: JSON.stringify({
				indeed: `http://127.0.0.1:${port}`,
			}),
			OFFERFINCH_CHROME: chrome.executable,
		},
	});
	const indeedTab = async () =>
		(await siteTabs(app)).find((t) => t.site === "indeed");
	const row = page.getByTestId("source-indeed");
	try {
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		await expect(page.getByTestId("source-indeed-status")).toHaveText("Off");
		await expect(row).toContainText("Not signed in (optional)");
		await shot(page, "settings-sources");

		// Sign in: the stand-in's sign-in page in Indeed's own view, attached inside the window
		// exactly over the sheet's hole.
		await page.getByTestId("source-indeed-sign-in").click();
		const sheet = page.getByTestId("site-sheet");
		await expect(sheet).toHaveAttribute("data-mode", "sign-in");
		await expect
			.poll(async () => {
				const t = await indeedTab();
				return Boolean(t?.attached && t.url.endsWith("/auth"));
			})
			.toBe(true);
		const hole = await page.getByTestId("site-sheet-view").boundingBox();
		const tab = (await indeedTab()) as NonNullable<
			Awaited<ReturnType<typeof indeedTab>>
		>;
		expect(tab.sheet).toBe("sign-in");
		expect(tab.run).toBe(false);
		expect(hole).not.toBeNull();
		if (!hole || !tab.content) throw new Error("no hole or no window");
		expect(Math.abs(tab.bounds.x - hole.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(tab.bounds.y - hole.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(tab.bounds.width - hole.width)).toBeLessThanOrEqual(1);
		expect(Math.abs(tab.bounds.height - hole.height)).toBeLessThanOrEqual(1);
		expect(tab.bounds.width).toBeGreaterThan(400);
		expect(tab.bounds.x + tab.bounds.width).toBeLessThanOrEqual(
			tab.content.width,
		);
		expect(tab.bounds.y + tab.bounds.height).toBeLessThanOrEqual(
			tab.content.height,
		);
		await expect(page.getByTestId("site-sheet-host")).toContainText(
			`127.0.0.1:${port}`,
		);
		await expect(sheet).toContainText("Sign in with Google");
		if (await overlaySiteView(app, page, "indeed"))
			await shot(page, "sheet-sign-in");
		// The user signs in (on the stand-in, the test clicks for them), then presses Done.
		expect(await standInClick(app, "indeed", "#sign-in")).toBe(true);
		await expect.poll(async () => (await indeedTab())?.url).toMatch(/\/$/);
		await page.getByTestId("site-sheet-close").click();
		await expect(row).toContainText("Signed in", { timeout: 15_000 });
		// Detached, then closed once the sign-in was read.
		await expect.poll(indeedTab).toBeUndefined();

		// A scan reads Indeed in its hidden tab; the search page is a check: the run pauses,
		// a notification says so, and the row says "Needs you".
		await page.getByTestId("source-indeed-enabled").click();
		await sidebar(page, "Home").click();
		await expect(page.getByTestId("scan-now")).toBeEnabled({ timeout: 60_000 });
		await page.getByTestId("scan-now").click();
		await expect
			.poll(
				async () =>
					(await notices(app)).find((n) => n.title === "Indeed needs you"),
				{ timeout: 90_000 },
			)
			.toMatchObject({
				kind: "check",
				path: "/settings/sources?live=indeed",
			});
		// The worker dies while its run holds Indeed's tab (kill -9). Main lets the dead
		// process's claim go: the restarted worker recovers the scan, claims the tab again and
		// meets the check again (a second notification), instead of "already being read".
		expect((await indeedTab())?.run).toBe(true);
		const pid = (await workerPid(app)) as number;
		process.kill(pid, "SIGKILL");
		await expect.poll(() => workerPid(app), { timeout: 30_000 }).not.toBe(pid);
		await expect
			.poll(
				async () =>
					(await notices(app)).filter((n) => n.title === "Indeed needs you")
						.length,
				{ timeout: 90_000 },
			)
			.toBe(2);
		await expect
			.poll(async () => {
				const t = await indeedTab();
				return t?.run ? t.owner : null;
			})
			.toBeGreaterThan(1);
		await page.reload();
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		await expect(page.getByTestId("source-indeed-status")).toContainText(
			"Needs you",
		);
		await shot(page, "settings-sources-needs-you");

		// Needs you opens the live sheet: the very tab the run is using, attached in the window.
		await page.getByTestId("source-indeed-needs-you").click();
		await expect(sheet).toHaveAttribute("data-mode", "live");
		await expect
			.poll(async () => {
				const t = await indeedTab();
				return Boolean(t?.attached && t.run && t.sheet === "live");
			})
			.toBe(true);
		expect(
			(await siteTabs(app)).filter((t) => t.site === "indeed"),
		).toHaveLength(1);
		await expect(page.getByTestId("site-sheet-check")).toContainText(
			"a browser check",
		);
		// The page polls the run's status every second and rerenders: the view stays attached.
		await page.waitForTimeout(3_000);
		expect(await indeedTab()).toMatchObject({ attached: true, sheet: "live" });
		if (await overlaySiteView(app, page, "indeed"))
			await shot(page, "sheet-live");
		expect(served.filter((p) => p === "/viewjob")).toHaveLength(0);

		// The user solves it in the page: the run sees the check gone and goes on by itself.
		expect(await standInClick(app, "indeed", "#verify")).toBe(true);
		await expect
			.poll(() => served.filter((p) => p === "/viewjob").length, {
				timeout: 60_000,
			})
			.toBe(2);
		// The check is gone from the status (a rerender with a new note): still attached.
		await expect(page.getByTestId("site-sheet-check")).toHaveCount(0);
		await page.waitForTimeout(1_500);
		expect(await indeedTab()).toMatchObject({ attached: true, sheet: "live" });
		await expect(sheet).toBeVisible();
		await page.getByTestId("site-sheet-close").click();
		await expect(page.getByTestId("source-indeed-status")).toHaveText(
			/2 searches, 2 new postings/,
			{ timeout: 60_000 },
		);
		// Closed with the run; read only (GETs of the stand-in's pages, no other origin).
		await expect.poll(indeedTab).toBeUndefined();
		// The check page once before the kill, once after, then the cleared search, then the
		// second search (one per role title in the profile).
		expect(served.filter((p) => p === "/jobs")).toHaveLength(4);
		expect(chrome.launches()).toEqual([]);

		// Signed in, with nothing to fix: the row offers no action but its switch.
		await expect(row).toContainText("Signed in");
		await expect(
			row.getByRole("button", { name: /Sign in|Retry now/ }),
		).toHaveCount(0);
		await page.getByTestId("source-indeed-enabled").click();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await new Promise<void>((r) => server.close(() => r()));
	}
});

const NEW_TITLE = "Staff Full-Stack Engineer";
const runOfNewJob = () =>
	readDb<{ id: string; status: string; executions: number }>(
		`select r.id, r.status, r.executions from flow_runs r join jobs j on r.id = 'job-' || j.id where j.title = ?`,
		NEW_TITLE,
	)[0];
const runningStep = (runId: string) =>
	readDb<{ key: string }>(
		"select key from flow_steps where run_id = ? and status = 'running'",
		runId,
	)[0]?.key;

test("kill -9: the worker mid-step, then the whole app mid-step; work resumes and nothing runs twice", async () => {
	boards.addJob(4005, NEW_TITLE);
	// Slow models, so a step is still running when the process dies.
	const first = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		fakeDelayMs: 2_500,
	});
	let killedStep: string | undefined;
	try {
		await expect(first.page.getByTestId("scan-now")).toBeEnabled({
			timeout: 30_000,
		});
		await first.page.getByTestId("scan-now").click();
		await expect
			.poll(() => runOfNewJob()?.id ?? "", { timeout: 60_000 })
			.not.toBe("");
		const runId = runOfNewJob()?.id as string;
		await expect
			.poll(() => runningStep(runId) ?? "", { timeout: 60_000 })
			.not.toBe("");
		killedStep = runningStep(runId);
		const pid = (await workerPid(first.app)) as number;
		process.kill(pid, "SIGKILL");
		// Main starts a new worker (after the old one exited); its runner recovers the run.
		await expect
			.poll(() => workerPid(first.app), { timeout: 30_000 })
			.not.toBe(pid);
		await expect
			.poll(() => runOfNewJob()?.executions ?? 0, { timeout: 60_000 })
			.toBeGreaterThanOrEqual(2);
		// Now kill the whole app while the run is mid-step again.
		await expect
			.poll(() => runningStep(runId) ?? "", { timeout: 60_000 })
			.not.toBe("");
	} finally {
		first.app.process().kill("SIGKILL");
	}

	const again = await launchApp({ userData, rewrite: boards.rewrite });
	try {
		const runId = runOfNewJob()?.id as string;
		await expect
			.poll(() => runOfNewJob()?.status, { timeout: 120_000 })
			.toMatch(/waiting|complete/);
		// The run was started at least three times (start, after the worker kill, after the app
		// kill), and each step it completed ran once: no step has a second attempt except the
		// ones a kill interrupted, and none is left running.
		const steps = readDb<{ key: string; status: string; attempts: number }>(
			"select key, status, attempts from flow_steps where run_id = ?",
			runId,
		);
		expect(runOfNewJob()?.executions).toBeGreaterThanOrEqual(3);
		expect(steps.filter((s) => s.status === "running")).toEqual([]);
		expect(steps.filter((s) => s.attempts > 1).length).toBeLessThanOrEqual(2);
		expect(steps.find((s) => s.key === killedStep)?.status).toMatch(
			/complete|waiting/,
		);
		// One application per job, one scoring call recorded as settled per scoring step run.
		const apps = readDb<{ n: number }>(
			"select count(*) as n from applications a join jobs j on j.id = a.job_id where j.title = ?",
			NEW_TITLE,
		);
		expect(apps[0]?.n).toBe(1);
		const { page } = again;
		await sidebar(page, "Inbox").click();
		await showStatus(page, /^All/);
		await expect(
			page.getByTestId("inbox-row").filter({ hasText: NEW_TITLE }),
		).toHaveCount(1);
		await expect(
			page
				.getByTestId("inbox-row")
				.filter({ hasText: "Senior Full-Stack Engineer" }),
		).toHaveCount(1);
	} finally {
		await again.app.close();
	}
});

test("a scan reads every source from the shared plan, LinkedIn's Top picks first, read only", async () => {
	const { startLinkedInFixture } = await import("./linkedin-fixture");
	const fixture = await startLinkedInFixture();
	const chrome = fakeChrome();
	const { app, page } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		linkedinOrigin: fixture.origin,
		env: { OFFERFINCH_CHROME: chrome.executable },
	});
	try {
		await sidebar(page, "Settings").click();
		// LinkedIn is one of the sources, off until turned on, with nothing to set.
		await settingsNav(page, "Sources").click();
		await expect(page.getByTestId("source-linkedin-status")).toHaveText("Off");
		await page.getByTestId("source-linkedin-enabled").click();
		await expect(page.getByTestId("source-linkedin-status")).toHaveText(
			"Not run yet",
		);
		const list = page.getByTestId("sources-list");
		await expect(list.getByRole("textbox")).toHaveCount(0);
		await expect(list).not.toContainText("Searching for");
		await expect(list).not.toContainText("custom searches");
		await expect(page.getByTestId("source-linkedin-run")).toHaveCount(0);

		// One plan for every source, edited once in Job search.
		await settingsNav(page, "Job search").click();
		const plan = page.getByTestId("search-plan");
		await expect(plan).toContainText(
			"Senior Frontend Engineer · remote, worldwide",
		);
		await page.getByTestId("search-plan-keywords").fill("Platform Engineer");
		await page.getByTestId("search-plan-add").click();
		await expect(plan.getByTestId("search-plan-entry").first()).toContainText(
			"Platform Engineer · remote, worldwide",
		);
		await expect(plan.getByTestId("search-plan-entry").first()).toContainText(
			"Yours",
		);

		const scansDone = () =>
			readDb<{ n: number }>(
				"select count(*) as n from flow_runs where kind = 'scan' and status = 'complete'",
			)[0]?.n ?? 0;
		const scansBefore = scansDone();
		const searchesBefore = boards.searches.length;
		await sidebar(page, "Home").click();
		await expect(page.getByTestId("scan-now")).toBeEnabled({ timeout: 60_000 });
		await page.getByTestId("scan-now").click();
		await expect
			.poll(
				() =>
					readDb<{ n: number }>(
						"select count(*) as n from linkedin_runs where trigger = 'scan' and finished_at is not null",
					)[0]?.n ?? 0,
				{ timeout: 90_000 },
			)
			.toBe(1);
		const [run] = readDb<{
			outcome: string;
			pages_used: number;
			jobs_inserted: number;
		}>(
			"select outcome, pages_used, jobs_inserted from linkedin_runs where trigger = 'scan'",
		);
		// Its share of a read: 6 pages. Top picks and its two new jobs, then the plan's first
		// search (the user's own) and its new jobs.
		expect(run).toMatchObject({ outcome: "done", pages_used: 6 });
		const paths = fixture.requests.map((r) => r.path);
		expect(paths[0]).toBe("/jobs/collections/recommended/");
		expect(paths.slice(1, 3)).toEqual([
			"/jobs/view/4100000004/",
			"/jobs/view/4100000002/",
		]);
		expect(paths[3]).toMatch(
			/^\/jobs\/search\/\?keywords=Platform\+Engineer&location=Worldwide&f_WT=2&sortBy=DD$/,
		);
		// Read only: GETs of list and job pages, never an apply control or link.
		expect(fixture.requests.every((r) => r.method === "GET")).toBe(true);
		expect(paths.some((p) => /apply/i.test(p))).toBe(false);
		// Job-board search made its DuckDuckGo queries from the same plan, one board each.
		// At most 6 a scan, rotating through the plan across scans, so the user's own search may
		// come in a later scan.
		const queries = boards.searches.slice(searchesBefore);
		expect(queries.length).toBeGreaterThan(0);
		for (const q of queries.filter((x) => x.includes("site:")))
			expect(q.match(/site:/g)).toHaveLength(1);
		// Read in LinkedIn's hidden tab inside the app: no Chrome started, no profile made, and
		// the tab closed when the read ended.
		expect(chrome.launches()).toEqual([]);
		expect(fs.existsSync(path.join(userData, "linkedin-chrome"))).toBe(false);
		await expect.poll(() => siteTabs(app)).toEqual([]);

		// Scans: Top picks has its own row; Sources says when LinkedIn is read next.
		await expect.poll(scansDone, { timeout: 90_000 }).toBe(scansBefore + 1);
		await sidebar(page, "Home").click();
		await page.getByTestId("scan-status").click();
		const picks = page.getByTestId("scan-source-linkedin-top-picks");
		// The list can still be loading the scan that just finished: until it does, the first row
		// is the scan before it. Open the newest row until it is this scan.
		await expect(async () => {
			await page.getByTestId("scan-row").first().click();
			await expect(picks).toBeVisible({ timeout: 2_000 });
		}).toPass({ timeout: 30_000 });
		await expect(picks).toContainText("LinkedIn Top picks");
		await expect(picks).toContainText("Top job picks for you");
		await expect(page.getByTestId("scan-source-linkedin")).toContainText(
			"Platform Engineer",
		);
		await shot(page, "scans-linkedin-top-picks");
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		// Sources refreshes its list every few seconds.
		await expect(page.getByTestId("source-linkedin")).toContainText(
			/Next read in ~[23] h/,
			{ timeout: 20_000 },
		);
		await expect(page.getByTestId("source-linkedin-status")).toContainText(
			"new job",
		);
		await shot(page, "settings-sources");

		// The next scan within 3 hours does not read LinkedIn, and says when it will.
		const opened = fixture.requests.length;
		await sidebar(page, "Home").click();
		await expect(page.getByTestId("scan-now")).toBeEnabled({ timeout: 60_000 });
		await page.getByTestId("scan-now").click();
		await expect.poll(scansDone, { timeout: 90_000 }).toBe(scansBefore + 2);
		expect(fixture.requests.length).toBe(opened);
		await sidebar(page, "Home").click();
		await page.getByTestId("scan-status").click();
		// The list may still show the cached runs (it refreshes every 15 s when none is running):
		// open the newest row until it is this scan's.
		await expect
			.poll(
				async () => {
					await page.getByTestId("scan-row").first().click();
					return page.getByTestId("scan-source-linkedin").textContent();
				},
				{ timeout: 30_000 },
			)
			.toMatch(/Next LinkedIn read in ~[23] h/);
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Sources").click();
		await page.getByTestId("source-linkedin-enabled").click();
	} finally {
		await app.close();
		await fixture.close();
	}
});

test("a paid Codex call stops Codex across a worker kill until resumed", async () => {
	const calls = () =>
		fs.existsSync(path.join(userData, "fake-codex-calls"))
			? fs
					.readFileSync(path.join(userData, "fake-codex-calls"), "utf8")
					.trim()
					.split("\n").length
			: 0;
	const { app, page } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
		fakeCodex: true,
	});
	try {
		await sidebar(page, "Settings").click();
		await settingsNav(page, "Models").click();
		await chooseMode(page, "claims", "codex-subscription");
		await expect(page.getByTestId("role-claims-state")).toHaveText(
			/codex-subscription/,
		);
		await page.getByTestId("role-claims-test").click();
		await expect(page.getByTestId("role-claims-test-result")).toContainText(
			/credits/,
		);
		expect(calls()).toBe(1);

		// The worker dies; main starts a new one, with no breaker in memory.
		const pid = (await workerPid(app)) as number;
		process.kill(pid, "SIGKILL");
		await expect.poll(() => workerPid(app), { timeout: 30_000 }).not.toBe(pid);
		await page.reload();
		await expect(page.getByTestId("stopped-openai")).toContainText(
			/Codex used paid credits on .+\. Calls are stopped\./,
			{ timeout: 30_000 },
		);
		// Only Codex stopped; no held call, nothing to reconcile.
		await expect(page.getByTestId("stopped-anthropic")).toHaveCount(0);
		await expect(page.getByTestId("held-call")).toHaveCount(0);
		await shot(page, "paid-codex-stop");

		// Still stopped after the restart: refused before the call starts.
		await page.getByTestId("role-claims-test").click();
		await expect(page.getByTestId("role-claims-test-result")).toContainText(
			/Calls are stopped/,
		);
		expect(calls()).toBe(1);

		// Resumed: the next call runs (the stand-in now answers).
		fs.writeFileSync(path.join(userData, "fake-codex-ok"), "");
		await page.getByTestId("resume-openai").click();
		await expect(page.getByTestId("stopped-openai")).toHaveCount(0);
		await page.getByTestId("role-claims-test").click();
		await expect(page.getByTestId("role-claims-test-result")).toContainText(
			"Works",
		);
		expect(calls()).toBe(2);
	} finally {
		await app.close();
	}
});

test("onboarding says clearly when Chrome is missing", async () => {
	const { app, page } = await launchApp({
		// Its own folder even when E2E_USER_DATA keeps the main run's data.
		userData: fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-e2e-")),
		env: { OFFERFINCH_CHROME: "none" },
	});
	try {
		await expect(page.getByTestId("onboarding-no-chrome")).toContainText(
			"Google Chrome is not installed",
		);
		await shot(page, "onboarding-no-chrome");
	} finally {
		await app.close();
	}
});

test("a database under its earlier file name opens, moved once, every row kept", async () => {
	const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-dbmove-"));
	const source = new Database(path.join(userData, DB_FILE), {
		readonly: true,
	});
	await source.backup(path.join(fresh, EARLIER_DB_FILE));
	const rows = (
		source.prepare("select count(*) as n from applications").get() as {
			n: number;
		}
	).n;
	source.close();
	expect(rows).toBeGreaterThan(0);
	const { app, page, errors } = await launchApp({ userData: fresh });
	try {
		await expect(page.getByTestId("home")).toBeVisible({ timeout: 30_000 });
		expect(fs.existsSync(path.join(fresh, DB_FILE))).toBe(true);
		expect(fs.existsSync(path.join(fresh, EARLIER_DB_FILE))).toBe(false);
		expect(
			fs
				.readdirSync(fresh)
				.some((f) => f.startsWith(`${EARLIER_DB_FILE}.moved-`)),
		).toBe(true);
		const moved = new Database(path.join(fresh, DB_FILE), {
			readonly: true,
		});
		expect(
			(
				moved.prepare("select count(*) as n from applications").get() as {
					n: number;
				}
			).n,
		).toBe(rows);
		moved.close();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(fresh, { recursive: true, force: true });
	}
});
