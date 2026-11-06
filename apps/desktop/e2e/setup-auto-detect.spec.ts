import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

import { chirps, fakeClis, launchApp } from "./launch";

/**
 * Setup's Connect AI finds the providers by itself. Never the real CLIs: a test run reads them
 * from `fake-clis.json` (src/worker/fake-clis.ts), and the stand-ins answer like the test
 * models, so no model is called.
 */
const newUser = () =>
	fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-autodetect-"));

const roleMode = (page: Page, role: string) =>
	page.getByTestId(`role-${role}-mode`);

async function openConnectAi(page: Page) {
	await page.getByTestId("welcome-start").click({ timeout: 30_000 });
	await expect(page.getByTestId("setup-ai")).toBeVisible({ timeout: 30_000 });
}

const allSet = (page: Page) => page.getByTestId("setup-ai");

test("both signed in: Claude takes every step by itself, all set, one chirp", async () => {
	const userData = newUser();
	fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		await expect(allSet(page)).toHaveAttribute("data-all-set", "true");
		// Said out loud too: a polite status region that is there from the start.
		const live = page.getByTestId("setup-ai-live");
		await expect(live).toHaveAttribute("role", "status");
		await expect(live).toContainText("You're all set");
		for (const id of ["claude", "codex"]) {
			await expect(page.getByTestId(`setup-cli-${id}`)).toHaveAttribute(
				"data-state",
				"signed-in",
			);
			await expect(page.getByTestId(`setup-cli-${id}`)).toContainText(
				"3 models",
			);
		}
		// OpenCode and Gemini are listed too, not installed.
		await expect(page.getByTestId("setup-cli-opencode")).toHaveAttribute(
			"data-state",
			"missing",
		);
		await expect(page.getByTestId("setup-cli-antigravity")).toContainText(
			"via Antigravity",
		);
		await expect.poll(async () => (await chirps(app)).length).toBe(1);
		await expect(page.getByTestId("subscription-terms")).toBeVisible();
		// Starting models: filled from what was found.
		await expect(roleMode(page, "scoring")).toHaveText(/Opus 5\.5/);
		await expect(roleMode(page, "tailoring")).toHaveText(/Sonnet 5\.5/);
		await expect(roleMode(page, "claims")).toHaveText(/Opus 5\.5/);
		// Any model may do any step: Codex can check Claude's drafts.
		await roleMode(page, "claims").click();
		await page.getByTestId("role-claims-codex:").click();
		await expect(roleMode(page, "claims")).toHaveText(/Account default/);
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		await expect(page.getByTestId("step-skip")).toBeHidden();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("Codex only: Codex takes every step, Claude missing with the fix", async () => {
	const userData = newUser();
	fakeClis(userData, { claude: "missing", codex: "logged_in" });
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		await expect(allSet(page)).toHaveAttribute("data-all-set", "true");
		await expect(page.getByTestId("setup-cli-claude")).toHaveAttribute(
			"data-state",
			"missing",
		);
		await expect(page.getByTestId("setup-cli-claude-command")).toHaveText(
			"curl -fsSL https://claude.ai/install.sh | bash",
		);
		// Claude signs in later: Check again changes nothing already chosen.
		fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
		await page.getByTestId("setup-ai-check").click();
		await expect(page.getByTestId("setup-cli-claude")).toHaveAttribute(
			"data-state",
			"signed-in",
			{ timeout: 30_000 },
		);
		for (const role of ["scoring", "tailoring", "claims"])
			await expect(roleMode(page, role)).toHaveText(/Account default/);
		await expect.poll(async () => (await chirps(app)).length).toBe(1);
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("nothing found: install hints, no Skip, and Continue waits for a model", async () => {
	const userData = newUser();
	// A run without the test models, as a real first start: no model to choose at all.
	const { app, page, errors } = await launchApp({
		userData,
		env: { OFFERFINCH_FAKE_MODELS: "0" },
	});
	try {
		await openConnectAi(page);
		await expect(page.getByTestId("setup-ai-live")).toContainText(
			"No AI account is signed in yet",
		);
		await expect(page.getByTestId("setup-cli-claude-command")).toHaveText(
			"curl -fsSL https://claude.ai/install.sh | bash",
		);
		await expect(page.getByTestId("setup-cli-codex-command")).toHaveText(
			"npm install -g @openai/codex",
		);
		await expect(page.getByTestId("step-continue")).toBeDisabled();
		await expect(page.getByTestId("step-skip")).toBeHidden();
		await expect(roleMode(page, "scoring")).toHaveText(/Choose a model/);
		// Claude Code signs in: Check again fills every step and Continue opens.
		fakeClis(userData, { claude: "logged_in", codex: "missing" });
		await page.getByTestId("setup-ai-check").click();
		await expect(allSet(page)).toHaveAttribute("data-all-set", "true", {
			timeout: 30_000,
		});
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		await expect(page.getByTestId("step-skip")).toBeHidden();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("a choice already made is kept when setup is checked again", async () => {
	const userData = newUser();
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		await roleMode(page, "tailoring").click();
		await page.getByTestId("role-tailoring-fake").click();
		await expect(roleMode(page, "tailoring")).toHaveText(/Test models/);
		// Claude and Codex appear; Check again fills only what is still open.
		fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
		await page.getByTestId("setup-ai-check").click();
		// Check again reads PATH from the login shell again: allow it a few seconds.
		await expect(allSet(page)).toHaveAttribute("data-all-set", "true", {
			timeout: 30_000,
		});
		await expect(roleMode(page, "scoring")).toHaveText(/Opus 5\.5/);
		await expect(roleMode(page, "tailoring")).toHaveText(/Test models/);
		await expect(roleMode(page, "claims")).toHaveText(/Opus 5\.5/);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("a plan chosen before, then signed out: the choice stays, not all set, the fix shows", async () => {
	const userData = newUser();
	fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		await expect(allSet(page)).toHaveAttribute("data-all-set", "true");
		// Claude Code is signed out (or removed) later; setup is checked again.
		fakeClis(userData, { claude: "logged_out", codex: "logged_in" });
		await page.getByTestId("setup-ai-check").click();
		await expect(page.getByTestId("setup-cli-claude")).toHaveAttribute(
			"data-state",
			"signed-out",
			{ timeout: 30_000 },
		);
		await expect(allSet(page)).not.toHaveAttribute("data-all-set", /.*/);
		await expect(page.getByTestId("setup-cli-claude-command")).toHaveText(
			"claude",
		);
		// The choice is the user's: still Claude for every step, shown as not available now.
		await expect(roleMode(page, "scoring")).toHaveText(
			/Opus 5\.5 \(not available now\)/,
		);
		await expect(roleMode(page, "tailoring")).toHaveText(
			/Sonnet 5\.5 \(not available now\)/,
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("OpenCode and Gemini: plan model first, sources grouped, keyboard picker, Sign in", async () => {
	const userData = newUser();
	fakeClis(userData, {
		claude: "missing",
		codex: "missing",
		opencode: "logged_in",
		antigravity: "logged_out",
	});
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		// The first plan model takes every step; a pay-per-use one is never picked by itself.
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		for (const role of ["scoring", "tailoring", "claims"])
			await expect(roleMode(page, role)).toHaveText(/GLM-5\.1/);
		await expect(page.getByTestId("setup-cli-opencode")).toContainText(
			"5 models",
		);
		// The picker by keyboard only: open, search, pick, Esc back to the button.
		const mode = roleMode(page, "tailoring");
		await mode.focus();
		await page.keyboard.press("Enter");
		const menu = page.getByTestId("role-tailoring-mode-menu");
		await expect(menu).toBeVisible();
		await expect(page.getByTestId("role-tailoring-mode-search")).toBeFocused();
		// Plan sources first, then pay per use with its price; Gemini dimmed with Sign in.
		const groups = menu.locator("[data-group=opencode]");
		await expect(groups).toContainText("Go plan");
		await expect(groups).toContainText("OpenRouter · Pay per use");
		await expect(groups).toContainText("$0.30 / $1.20 per M");
		const text = (await groups.textContent()) ?? "";
		expect(text.indexOf("Go plan")).toBeLessThan(text.indexOf("Pay per use"));
		await expect(menu.locator("[data-group=antigravity]")).toHaveAttribute(
			"data-unavailable",
			"true",
		);
		await expect(menu.locator("[data-group=antigravity]")).toContainText(
			"Sign in",
		);
		// No effort levels for GLM-5.1: no effort control.
		await expect(page.getByTestId("role-tailoring-mode-effort")).toHaveCount(0);
		await page.keyboard.type("qwen");
		await page.keyboard.press("Enter");
		await expect(menu).toBeHidden();
		await expect(mode).toHaveText(/Qwen 4 Coder/);
		await expect(mode).toBeFocused();
		// Its effort levels, and only those.
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("role-tailoring-mode-effort")).toHaveText(
			"LowMediumHigh",
		);
		await page.getByTestId("role-tailoring-mode-effort-high").click();
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(mode).toHaveText(/Qwen 4 Coder.*High/);
		await expect(mode).toBeFocused();

		// Gemini is installed, signed out: OfferFinch signs in itself (the stand-in skips Google).
		await page
			.getByTestId("setup-cli-antigravity")
			.getByTestId("fix-antigravity")
			.click();
		await expect(page.getByText(/Signed in to Gemini/)).toBeVisible();
		await expect(page.getByTestId("setup-cli-antigravity")).toContainText(
			"Signed in",
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});
