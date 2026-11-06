import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { launchApp, openRoute, skipRestOfSetup } from "./launch";

/**
 * Settings › Models › Plan usage: what each plan has left in its windows, as the stand-in CLIs
 * report it (src/worker/fake-clis.ts), and OfferFinch's share, which grows with each call the
 * app makes. No real CLI and no model is called.
 */
const newUser = () =>
	fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-plan-usage-"));

test("shows each plan's windows and attributes the app's own calls", async () => {
	const userData = newUser();
	fs.mkdirSync(userData, { recursive: true });
	fs.writeFileSync(
		path.join(userData, "fake-clis.json"),
		JSON.stringify({
			claude: "logged_in",
			codex: "logged_in",
			usage: {
				claude: { session: 42, weekly: 10 },
				codex: { session: 5 },
			},
		}),
	);
	const { app, page, errors } = await launchApp({ userData });
	try {
		// Setup's Connect AI finds both CLIs (stand-ins) and gives every role to them.
		await page.getByTestId("welcome-start").click({ timeout: 30_000 });
		await expect(page.getByTestId("setup-ai")).toHaveAttribute(
			"data-all-set",
			"true",
			{ timeout: 30_000 },
		);
		await skipRestOfSetup(page);
		await openRoute(app, page, "/settings/models");

		// The CLI checks already read each plan: the windows show what is left.
		const session = page.getByTestId("plan-window-anthropic-five_hour");
		await expect(session).toHaveAttribute("data-used", "42", {
			timeout: 30_000,
		});
		await expect(session).toHaveAttribute("data-app", "0");
		await expect(
			page.getByTestId("plan-window-anthropic-five_hour-left"),
		).toHaveText("58% left");
		await expect(
			page.getByTestId("plan-window-anthropic-seven_day"),
		).toHaveAttribute("data-used", "10");
		await expect(
			page.getByTestId("plan-window-openai-primary"),
		).toHaveAttribute("data-used", "5");
		await expect(page.getByTestId("plan-account-anthropic")).toContainText(
			"extra usage off",
		);
		await expect(page.getByTestId("plan-checked-anthropic")).toContainText(
			"Read just now",
		);
		await expect(
			page.getByTestId("plan-usage-anthropic").getByRole("img").first(),
		).toHaveAttribute("data-used", "42");

		// One call through the stand-in moves the plan by a point: that point is OfferFinch's.
		await page.getByTestId("role-scoring-test").click();
		await expect(page.getByTestId("role-scoring-test-result")).toContainText(
			"Works",
			{ timeout: 30_000 },
		);
		await page.getByTestId("plan-usage-refresh").click();
		await expect(session).toHaveAttribute("data-used", "43", {
			timeout: 30_000,
		});
		await expect(session).toHaveAttribute("data-app", "1");
		await expect(
			page.getByTestId("plan-window-anthropic-five_hour-app"),
		).toContainText("OfferFinch: 1% of the window");
		await expect(
			page.getByTestId("plan-window-anthropic-five_hour-calls"),
		).toContainText("1 call");
		// Codex was not called: its share stays at nothing.
		await expect(
			page.getByTestId("plan-window-openai-primary"),
		).toHaveAttribute("data-app", "0");

		// A worker restart keeps the share: it is stored, not re-measured.
		await app.close();
		const again = await launchApp({ userData });
		try {
			await openRoute(again.app, again.page, "/settings/models");
			const kept = again.page.getByTestId("plan-window-anthropic-five_hour");
			await expect(kept).toHaveAttribute("data-app", "1", { timeout: 30_000 });
			expect(again.errors).toEqual([]);
		} finally {
			await again.app.close();
		}
		expect(errors).toEqual([]);
	} finally {
		await app.close().catch(() => {});
	}
});
