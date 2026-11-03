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

test("both signed in: every role set by itself, all set, one chirp", async () => {
	const userData = newUser();
	fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		const summary = page.getByTestId("setup-ai-summary");
		await expect(summary).toHaveAttribute("data-all-set", "true");
		await expect(summary).toContainText("You're all set");
		await expect(page.getByTestId("setup-cli-claude")).toHaveAttribute(
			"data-state",
			"ready",
		);
		await expect(page.getByTestId("setup-cli-claude")).toContainText(
			"Claude Code, signed in",
		);
		await expect(page.getByTestId("setup-cli-claude")).toContainText(
			"Drafts and scores",
		);
		await expect(page.getByTestId("setup-cli-codex")).toContainText(
			"Checks drafts",
		);
		await expect.poll(async () => (await chirps(app)).length).toBe(1);
		// The terms stay on screen; API keys are folded away.
		await expect(page.getByTestId("subscription-terms")).toBeVisible();
		await expect(roleMode(page, "scoring")).toHaveCount(0);
		// Test the connection: the stand-ins answer, no model is called.
		await page.getByTestId("setup-ai-test").click();
		await expect(page.getByTestId("setup-ai-test-result")).toContainText(
			"Works",
		);
		// The choices are stored, and shown in the folded settings.
		await page.getByTestId("models-manual").getByRole("button").first().click();
		await expect(roleMode(page, "scoring")).toHaveText(/Claude subscription/);
		await expect(roleMode(page, "tailoring")).toHaveText(/Claude subscription/);
		await expect(roleMode(page, "claims")).toHaveText(/Codex subscription/);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("Claude only: drafting set, the checker missing with the fix", async () => {
	const userData = newUser();
	fakeClis(userData, { claude: "logged_in", codex: "missing" });
	const { app, page, errors } = await launchApp({ userData });
	try {
		await openConnectAi(page);
		const summary = page.getByTestId("setup-ai-summary");
		await expect(summary).toContainText("One more: a checker");
		await expect(summary).not.toHaveAttribute("data-all-set", /.*/);
		await expect(page.getByTestId("setup-cli-codex")).toHaveAttribute(
			"data-state",
			"missing",
		);
		await expect(page.getByTestId("setup-cli-codex-command")).toHaveText(
			"npm install -g @openai/codex",
		);
		// Codex signs in later: Check again finds it and the step is done.
		fakeClis(userData, { claude: "logged_in", codex: "logged_out" });
		await page.getByTestId("setup-ai-check").click();
		await expect(page.getByTestId("setup-cli-codex")).toHaveAttribute(
			"data-state",
			"signed-out",
		);
		await expect(page.getByTestId("setup-cli-codex-command")).toHaveText(
			"codex login",
		);
		expect((await chirps(app)).length).toBe(0);
		fakeClis(userData, { claude: "logged_in", codex: "logged_in" });
		await page.getByTestId("setup-ai-check").click();
		await expect(summary).toHaveAttribute("data-all-set", "true");
		await expect.poll(async () => (await chirps(app)).length).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("nothing found: install hints for both, and the API key path", async () => {
	const userData = newUser();
	const { app, page, errors } = await launchApp({ userData });
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
		await page
			.getByTestId("models-manual")
			.getByRole("button", { name: "Use an API key instead" })
			.click();
		await expect(page.getByTestId("key-anthropic")).toBeVisible();
		await expect(page.getByTestId("key-openai")).toBeVisible();
		await expect(roleMode(page, "scoring")).toHaveText(/API key/);
		expect((await chirps(app)).length).toBe(0);
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
		await expect(roleMode(page, "scoring")).toHaveText(/Claude subscription/);
		await expect(roleMode(page, "tailoring")).toHaveText(/Test models/);
		await expect(roleMode(page, "claims")).toHaveText(/Codex subscription/);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});
