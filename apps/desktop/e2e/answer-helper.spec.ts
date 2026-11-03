import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import {
	APP_DIR,
	launchApp,
	openRoute,
	RESUME,
	skipRestOfSetup,
	tempUserData,
} from "./launch";

/**
 * The answer helper on the Questions page, with fake models in the background: Improve turns
 * "All of them and more" into an answer naming the question's own tools and lists what is still
 * missing; Use this fills the box; a [ blank ] left in it blocks Save; Save stores the final
 * text as a profile fact. Screenshots of the proposal (light and dark) go to
 * test-results/answer-helper-shots, or to E2E_SHOTS.
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ??
		path.join(APP_DIR, "test-results", "answer-helper-shots"),
);
const userData = tempUserData();

const QUESTION =
	"Which profiling tools have you used to diagnose frontend performance (for example Lighthouse, Chrome DevTools, React Profiler, bundle analyzers), and have you worked to a JS bundle-size budget?";

function db() {
	return new Database(path.join(userData, DB_FILE), { fileMustExist: true });
}

function readDb<T>(query: string, ...params: unknown[]): T[] {
	const handle = db();
	try {
		return handle.prepare(query).all(...params) as T[];
	} finally {
		handle.close();
	}
}

async function shot(page: Page, name: string) {
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
		timeout: 15_000,
	});
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test("answer helper: Help me remember composes ticks, Improve proposes from the user's words, Use this fills the box, blanks block Save", async () => {
	const { app, page, errors } = await launchApp({ userData });
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
		await skipRestOfSetup(page);

		const handle = db();
		handle
			.prepare(
				"insert into questions (id, user_id, key, question, context, status, created_at) values (?, 'local', 'k-profiling', ?, ?, 'open', ?)",
			)
			.run(
				crypto.randomUUID(),
				QUESTION,
				"The profile records no tools or figures.",
				Date.now(),
			);
		handle.close();
		await openRoute(app, page, "/questions");
		const question = page.getByTestId("question");
		await expect(question).toContainText("Which profiling tools", {
			timeout: 30_000,
		});

		const box = question.getByRole("textbox", { name: QUESTION });
		const width = async (testId: string) =>
			(await page.getByTestId(testId).boundingBox())?.width ?? 0;

		// Help me remember: the question as choices; only what is ticked reaches the box.
		await page.getByTestId("answer-choices").click();
		const card = page.getByTestId("answer-choices-card");
		await expect(card).toBeVisible({ timeout: 30_000 });
		const groups = card.getByTestId("answer-choice-group");
		await expect(groups).toHaveCount(2);
		const tools = groups.nth(0);
		for (const tool of ["Lighthouse", "Chrome DevTools", "WebPageTest"])
			await expect(tools.getByTestId("answer-choice")).toContainText([tool]);
		// Nothing here is in the profile (it names React, not React Profiler): no chip is marked
		// as the user's. The mark itself is unit-tested against the profile's evidence.
		await expect(tools.getByText("in profile")).toHaveCount(0);
		const use = card.getByTestId("answer-choices-use");
		await expect(use).toBeDisabled();
		// Ticking never changes a chip's width.
		const chip = tools
			.getByTestId("answer-choice")
			.filter({ hasText: "Lighthouse" });
		const chipWidth = (await chip.boundingBox())?.width;
		await chip.click();
		await expect(chip).toHaveAttribute("aria-pressed", "true");
		expect((await chip.boundingBox())?.width).toBe(chipWidth);
		await tools
			.getByTestId("answer-choice")
			.filter({ hasText: "WebPageTest" })
			.click();
		await groups
			.nth(1)
			.getByTestId("answer-choice")
			.filter({ hasText: "No" })
			.click();
		await box.blur();
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "light";
		});
		await expect(page.locator("html")).not.toHaveClass(/dark/);
		await shot(page, "choices-light");
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "dark";
		});
		await expect(page.locator("html")).toHaveClass(/dark/);
		await shot(page, "choices-dark");
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "system";
		});
		await use.click();
		await expect(card).toHaveCount(0);
		const picked =
			"Which profiling tools have you used to diagnose frontend performance? Lighthouse and WebPageTest.\nHave you worked to a JS bundle-size budget? No.";
		await expect(box).toHaveValue(picked);
		// Improve runs on the picks at once; nothing is saved until Save answer.
		await expect(page.getByTestId("answer-proposal")).toBeVisible({
			timeout: 30_000,
		});
		await page.getByTestId("answer-dismiss").click();
		expect(
			readDb("select 1 from profile_facts where question = ?", QUESTION),
		).toEqual([]);
		await box.fill("");

		// An empty box offers Suggest; typing turns it into Improve, at the same width.
		await expect(page.getByTestId("answer-suggest")).toBeVisible();
		const suggestWidth = await width("answer-suggest");
		await box.fill("All of them and more");
		await expect(page.getByTestId("answer-suggest")).toHaveCount(0);
		expect(await width("answer-improve")).toBe(suggestWidth);
		// Pressed, it shows a spinner and keeps its width.
		await page.getByTestId("answer-improve").click();
		expect(await width("answer-improve")).toBe(suggestWidth);

		const proposal = page.getByTestId("answer-proposal");
		await expect(proposal).toBeVisible({ timeout: 30_000 });
		for (const tool of ["Lighthouse", "Chrome DevTools", "React Profiler"])
			await expect(proposal.getByTestId("chat-diff")).toContainText(tool);
		const missing = proposal.getByTestId("answer-missing");
		await expect(missing).toContainText("bundle-size budget");
		await expect(missing).toContainText('"and more"');
		// Nothing is saved, and the box is untouched, until the user acts.
		await expect(box).toHaveValue("All of them and more");
		await box.blur();
		// Both appearances, whatever this Mac's own is.
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "light";
		});
		await expect(page.locator("html")).not.toHaveClass(/dark/);
		await shot(page, "improve-light");
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "dark";
		});
		await expect(page.locator("html")).toHaveClass(/dark/);
		await shot(page, "improve-dark");
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "system";
		});

		// Editing the box after the proposal turns Use this off, so it can't overwrite the edit.
		await box.fill("All of them and more, mostly Lighthouse");
		await expect(proposal.getByTestId("answer-use")).toBeDisabled();
		await expect(proposal.getByTestId("answer-proposal-stale")).toBeVisible();
		await box.fill("All of them and more");
		await expect(proposal.getByTestId("answer-use")).toBeEnabled();

		// Use this puts the proposal in the box, still editable.
		await proposal.getByTestId("answer-use").click();
		await expect(proposal).toHaveCount(0);
		const proposed =
			"I have used Lighthouse, Chrome DevTools, React Profiler and bundle analyzers, and other tools.";
		await expect(box).toHaveValue(proposed);
		await expect(box).toBeFocused();

		// A blank in [ brackets ] blocks Save, by button and by ⌘↩.
		const save = page.getByRole("button", { name: "Save answer" });
		await box.fill(`${proposed} My budget was [size?].`);
		await expect(page.getByTestId("answer-blank")).toHaveText(
			"Fill in or remove [ … ] first.",
		);
		await expect(save).toBeDisabled();
		await box.press("Meta+Enter");
		await page.waitForTimeout(500);
		await expect(question).toBeVisible();
		expect(
			readDb("select 1 from profile_facts where question = ?", QUESTION),
		).toEqual([]);

		// Filled in, it saves the final text as the user's profile fact.
		const final = `${proposed} I have not worked to a bundle-size budget.`;
		await box.fill(final);
		await expect(page.getByTestId("answer-blank")).toHaveCount(0);
		await save.click();
		await expect(page.getByText("No open questions")).toBeVisible();
		expect(
			readDb<{ answer: string }>(
				"select answer from profile_facts where question = ?",
				QUESTION,
			).map((r) => r.answer),
		).toEqual([final]);
		// Each call metered like every other model call: Improve twice (once on the picks), and
		// Help me remember once.
		const calls = (task: string) =>
			readDb<{ n: number }>(
				"select count(*) n from llm_usage where task = ?",
				task,
			)[0]?.n;
		expect(calls("answer-helper")).toBe(2);
		expect(calls("answer-choices")).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
