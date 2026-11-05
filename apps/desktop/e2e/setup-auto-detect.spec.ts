import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

import { chirps, fakeClis, launchApp } from "./launch";

/**
 * Setup's Connect AI finds Claude Code and Codex by itself. Never the real CLIs: a test run
 * reads them from `fake-clis.json` (src/worker/fake-clis.ts), and the stand-ins answer like the
 * test models, so no model is called.
 */
const newUser = () =>
	fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-autodetect-"));

const roleMode = (page: Page, role: string) =>
	page.getByTestId(`role-${role}-mode`);

async function openConnectAi(page: Page) {
	await page.getByTestId("welcome-start").click({ timeout: 30_000 });
	await expect(page.getByTestId("setup-ai")).toBeVisible({ timeout: 30_000 });
}

test("both signed in: Claude takes every step by itself, all set, one chirp", async () => {
	const userData = newUser();
	fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		const summary = page.getByTestId("setup-ai-summary");
		await expect(summary).toHaveAttribute("data-all-set", "true");
		await expect(summary).toContainText("You're all set");
		// Said out loud too: a polite status region that is there from the start.
		const live = page.getByTestId("setup-ai-live");
		await expect(live).toHaveAttribute("role", "status");
		await expect(live).toContainText("You're all set");
		await expect(page.getByTestId("setup-cli-claude")).toHaveAttribute(
			"data-state",
			"ready",
		);
		await expect(page.getByTestId("setup-cli-claude")).toContainText(
			"Claude Code, signed in",
		);
		await expect(page.getByTestId("setup-cli-claude")).toContainText(
			"Drafts, scores and checks drafts",
		);
		await expect(page.getByTestId("setup-cli-codex")).toContainText(
			"Not used: you chose another way below",
		);
		await expect.poll(async () => (await chirps(app)).length).toBe(1);
		// The terms stay on screen; the models to choose by hand are folded away.
		await expect(page.getByTestId("subscription-terms")).toBeVisible();
		await expect(roleMode(page, "scoring")).toHaveCount(0);
		// Test the connection: the stand-ins answer, no model is called.
		await page.getByTestId("setup-ai-test").click();
		await expect(page.getByTestId("setup-ai-test-result")).toContainText(
			"Works",
		);
		await expect(live).toContainText("Works");
		// The choices are stored, and shown in the folded settings.
		await page.getByTestId("models-manual").getByRole("button").first().click();
		await expect(roleMode(page, "scoring")).toHaveText(/Claude Opus 5\.5/);
		await expect(roleMode(page, "tailoring")).toHaveText(/Claude Sonnet 5\.5/);
		await expect(roleMode(page, "claims")).toHaveText(/Claude Opus 5\.5/);
		// Any model may do any step: Codex can check Claude's drafts, or Claude its own.
		await roleMode(page, "claims").click();
		await page.getByTestId("role-claims-codex:").click();
		await expect(roleMode(page, "claims")).toHaveText(/Codex account default/);
		await expect(page.getByTestId("role-claims-state")).toHaveText(
			/codex-subscription/,
		);
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
		const summary = page.getByTestId("setup-ai-summary");
		await expect(summary).toHaveAttribute("data-all-set", "true");
		await expect(page.getByTestId("setup-cli-codex")).toContainText(
			"Drafts, scores and checks drafts",
		);
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
			"ready",
			{ timeout: 30_000 },
		);
		await page.getByTestId("models-manual").getByRole("button").first().click();
		for (const role of ["scoring", "tailoring", "claims"])
			await expect(roleMode(page, role)).toHaveText(/Codex account default/);
		await expect.poll(async () => (await chirps(app)).length).toBe(1);
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("nothing found: install hints for both, no Skip, and Continue waits for a model", async () => {
	const userData = newUser();
	// A run without the test models, as a real first start: no model to choose at all.
	const { app, page, errors } = await launchApp({
		userData,
		env: { OFFERFINCH_FAKE_MODELS: "0" },
	});
	try {
		await openConnectAi(page);
		await expect(page.getByTestId("setup-ai-summary")).toContainText(
			"Connect an AI",
		);
		await expect(page.getByTestId("setup-cli-claude-command")).toHaveText(
			"curl -fsSL https://claude.ai/install.sh | bash",
		);
		await expect(page.getByTestId("setup-cli-codex-command")).toHaveText(
			"npm install -g @openai/codex",
		);
		await expect(page.getByTestId("step-continue")).toBeDisabled();
		await expect(page.getByTestId("step-skip")).toBeHidden();
		await page
			.getByTestId("models-manual")
			.getByRole("button", { name: "Choose models yourself" })
			.click();
		await expect(roleMode(page, "scoring")).toHaveText(/Choose a model/);
		await expect(page.getByTestId("role-scoring-state")).toHaveText(
			"not connected",
		);
		// Claude Code signs in: Check again fills every step and Continue opens.
		fakeClis(userData, { claude: "logged_in", codex: "missing" });
		await page.getByTestId("setup-ai-check").click();
		await expect(page.getByTestId("setup-ai-summary")).toHaveAttribute(
			"data-all-set",
			"true",
			{ timeout: 30_000 },
		);
		await expect(page.getByTestId("step-continue")).toBeEnabled();
		await expect(page.getByTestId("step-skip")).toBeHidden();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("a choice already made is kept when setup is opened again", async () => {
	const userData = newUser();
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		await page.getByTestId("models-manual").getByRole("button").first().click();
		await roleMode(page, "tailoring").click();
		await page.getByTestId("role-tailoring-fake").click();
		await expect(page.getByTestId("role-tailoring-state")).toHaveText(/fake/);
		// Claude and Codex appear; Check again fills only what is still open.
		fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
		await page.getByTestId("setup-ai-check").click();
		// Check again reads PATH from the login shell again: allow it a few seconds.
		await expect(page.getByTestId("setup-ai-summary")).toHaveAttribute(
			"data-all-set",
			"true",
			{ timeout: 30_000 },
		);
		await expect(roleMode(page, "scoring")).toHaveText(/Claude Opus 5\.5/);
		await expect(roleMode(page, "tailoring")).toHaveText(/Test models/);
		await expect(roleMode(page, "claims")).toHaveText(/Claude Opus 5\.5/);
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
		const summary = page.getByTestId("setup-ai-summary");
		await expect(summary).toHaveAttribute("data-all-set", "true");
		// Claude Code is signed out (or removed) later; setup is checked again.
		fakeClis(userData, { claude: "logged_out", codex: "logged_in" });
		await page.getByTestId("setup-ai-check").click();
		await expect(page.getByTestId("setup-cli-claude")).toHaveAttribute(
			"data-state",
			"signed-out",
			{ timeout: 30_000 },
		);
		await expect(summary).not.toHaveAttribute("data-all-set", /.*/);
		await expect(summary).toContainText("Choose a model for every step");
		await expect(page.getByTestId("setup-cli-claude")).toContainText(
			"Drafts, scores and checks drafts once it's back and signed in",
		);
		await expect(page.getByTestId("setup-cli-claude-command")).toHaveText(
			"claude",
		);
		await expect(page.getByTestId("setup-ai-test")).toHaveCount(0);
		// The choice is the user's: still Claude for every step, listed while it is signed out.
		await page.getByTestId("models-manual").getByRole("button").first().click();
		await expect(roleMode(page, "scoring")).toHaveText(
			/claude:claude-opus-5-5 \(not available now\)/,
		);
		await expect(roleMode(page, "tailoring")).toHaveText(
			/claude:claude-sonnet-5-5 \(not available now\)/,
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});
