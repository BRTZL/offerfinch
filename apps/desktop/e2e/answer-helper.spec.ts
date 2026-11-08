import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import {
	APP_DIR,
	launchApp,
	openRoute,
	pickFakeModels,
	RESUME,
	skipRestOfSetup,
	tempUserData,
} from "./launch";

/**
 * The Questions page with fake models in the background: a question opens with its answers
 * already written, as numbered cards with the first picked and guesses underlined; 2 picks
 * another, E edits it in place; 4 is Write my own, where Improve turns "All of them and more"
 * into an answer naming the question's own tools and lists what is still missing; Use this
 * fills the box; a [ blank ] blocks Save; ⌘↩ stores the final text as a profile fact.
 * Screenshots (light and dark) go to test-results/answer-helper-shots, or to E2E_SHOTS.
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

test("answer helper: suggested answers are ready as cards, keys pick and edit, Improve proposes from the user's words, blanks block Save, ⌘↩ saves", async () => {
	const { app, page, errors } = await launchApp({ userData });
	try {
		// A profile and test models, as onboarding does; the rest of setup is put off.
		await page.getByTestId("welcome-start").click();
		await pickFakeModels(page);
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

		// The answers were written in the background: numbered cards, the first one picked, guesses
		// underlined, no [ blanks ] and no questions back.
		const cards = question.getByTestId("answer-card");
		await expect(cards).toHaveCount(3, { timeout: 30_000 });
		await expect(cards.locator("p.font-semibold")).toHaveText([
			"Used them all, with a budget",
			"Mostly Lighthouse, no budget",
			"Not used them",
		]);
		await expect(cards.nth(0)).toHaveAttribute("data-picked", "true");
		await expect(cards.nth(0)).toContainText(
			"I have used Lighthouse, Chrome DevTools, React Profiler and bundle analyzers. I have worked to a bundle-size budget.",
		);
		await expect(question).not.toContainText("[");
		// Every guessed tool is underlined: the profile names none of them.
		await expect(
			cards
				.nth(0)
				.getByTestId("answer-guess")
				.filter({ hasText: "Lighthouse" }),
		).toHaveCount(1);
		await expect(page.getByTestId("answer-choices")).toHaveCount(0);
		await page.getByTestId("question-row").first().click();
		for (const theme of ["light", "dark"] as const) {
			await app.evaluate(({ nativeTheme }, t) => {
				nativeTheme.themeSource = t;
			}, theme);
			await expect(page.locator("html")).toHaveClass(
				theme === "dark" ? /dark/ : /^(?!.*dark)/,
			);
			// Colours ease between themes: let them settle.
			await page.waitForTimeout(800);
			await shot(page, `cards-${theme}`);
		}
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = "system";
		});

		// 2 picks the second answer; E opens it for editing in its card; Esc closes it again.
		await page.keyboard.press("2");
		await expect(cards.nth(1)).toHaveAttribute("data-picked", "true");
		await expect(cards.nth(0)).not.toHaveAttribute("data-picked");
		await page.keyboard.press("e");
		const editor = question.getByTestId("answer-editor");
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue(
			"I have mostly used Lighthouse. I have not worked to a bundle-size budget.",
		);
		await editor.press("Escape");
		await expect(editor).toHaveCount(0);
		expect(
			readDb("select 1 from profile_facts where question = ?", QUESTION),
		).toEqual([]);

		// 4 is Write my own: an empty box, focused, with Improve.
		await page.keyboard.press("4");
		const box = question.getByTestId("answer-editor");
		await expect(box).toBeFocused();
		await expect(box).toHaveValue("");
		await box.fill("All of them and more");
		await page.getByTestId("answer-improve").click();

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
		for (const theme of ["light", "dark"] as const) {
			await app.evaluate(({ nativeTheme }, t) => {
				nativeTheme.themeSource = t;
			}, theme);
			await expect(page.locator("html")).toHaveClass(
				theme === "dark" ? /dark/ : /^(?!.*dark)/,
			);
			// Colours ease between themes: let them settle.
			await page.waitForTimeout(800);
			await shot(page, `improve-${theme}`);
		}
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
		const save = page.getByRole("button", { name: "Save & next" });
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
		// ⌘↩ saves and opens the next; this was the last one.
		await box.press("Meta+Enter");
		await expect(page.getByText("No open questions")).toBeVisible();
		expect(
			readDb<{ answer: string }>(
				"select answer from profile_facts where question = ?",
				QUESTION,
			).map((r) => r.answer),
		).toEqual([final]);
		// Each call metered like every other model call: the background suggestion and Improve.
		const calls = (task: string) =>
			readDb<{ n: number }>(
				"select count(*) n from llm_usage where task = ?",
				task,
			)[0]?.n;
		expect(calls("answer-helper")).toBe(2);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
