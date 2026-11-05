import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";

import { DB_FILE } from "../src/main/database-file";
import {
	APP_DIR,
	launchApp,
	pickFakeModels,
	RESUME,
	skipRestOfSetup,
	tempUserData,
	toastsGone,
} from "./launch";

/**
 * The chat, with fake models (OFFERFINCH_FAKE_MODELS=1), in the background: beside an
 * application it proposes a letter edit that Accept saves as a new version, and a fact that Save
 * puts in Profile › Answers; beside the profile it proposes a project that Add lists under
 * Projects. Screenshots of both panels with a proposal card go to test-results/chat-shots, or to
 * E2E_SHOTS (E2E_SHOTS=../../docs/screenshots/desktop refreshes the committed ones).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "chat-shots"),
);
const userData = tempUserData();

const POSTING =
	"Harbor Mills builds billing software for small shops. We are hiring a Frontend Engineer to build our customer pages in React and TypeScript, with Next.js server rendering and a shared design system. Requirements: 4 years of React, TypeScript, accessibility work. Remote - Worldwide.";

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });
const docTab = (page: Page, name: RegExp) =>
	page.getByRole("tablist", { name: "Document" }).getByRole("tab", { name });

function readDb<T>(query: string, ...params: unknown[]): T[] {
	const db = new Database(path.join(userData, DB_FILE), {
		readonly: true,
		fileMustExist: true,
	});
	try {
		return db.prepare(query).all(...params) as T[];
	} finally {
		db.close();
	}
}

/** Screenshots without toasts over the composer. */
async function quietShot(page: Page, name: string) {
	await toastsGone(page, 15_000);
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function send(page: Page, text: string) {
	await page.getByTestId("chat-input").fill(text);
	await page.getByTestId("chat-input").press("Enter");
}

test("chat beside an application and the profile: proposals accepted through the app's own paths", async () => {
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

		// A pasted posting (no network), prepared to review.
		await page.getByTestId("search-button").click();
		await page.getByTestId("command-input").fill("Add job");
		await page.keyboard.press("Enter");
		await page.getByTestId("add-job-paste-toggle").click();
		await page
			.getByTestId("add-job-link")
			.fill("https://careers.harbor-mills.example/jobs/frontend-engineer");
		await page.getByTestId("add-job-title").fill("Frontend Engineer");
		await page.getByTestId("add-job-company").fill("Harbor Mills");
		await page.getByTestId("add-job-location").fill("Remote - Worldwide");
		await page.getByTestId("add-job-text").fill(POSTING);
		await page.getByTestId("add-job-submit").click();
		await expect(page.getByTestId("interested")).toBeVisible({
			timeout: 60_000,
		});
		await page.getByTestId("interested").click();
		await expect(page.getByText(/Ready for review/).first()).toBeVisible({
			timeout: 120_000,
		});
		const appId = new URL(page.url()).pathname.split("/").pop() ?? "";
		const letterVersion = () =>
			readDb<{ v: number }>(
				"select max(version) v from documents where application_id = ? and kind = 'cover_letter' and format = 'markdown'",
				appId,
			)[0]?.v ?? 0;
		const before = letterVersion();
		expect(before).toBeGreaterThan(0);

		// 1. Chat from the action bar: the empty state offers examples.
		await page.getByTestId("chat-toggle").click();
		const chat = page.getByTestId("chat-panel");
		await expect(chat).toBeVisible();
		await expect(chat.getByTestId("chat-example")).toHaveCount(3);
		await send(page, "Make the letter warmer");
		await expect(chat.getByTestId("chat-message-user")).toContainText(
			"Make the letter warmer",
		);
		const edit = chat.getByTestId("chat-proposal-document");
		await expect(edit).toBeVisible({ timeout: 30_000 });
		await expect(edit.locator('[data-op="add"]')).toContainText(
			"I'd welcome a conversation about the role.",
		);
		await expect(edit.locator('[data-op="del"]')).toContainText(
			"I would welcome a conversation",
		);
		// Nothing changed before Accept.
		expect(letterVersion()).toBe(before);
		await expect(edit.getByTestId("chat-accept")).toBeEnabled({
			timeout: 30_000,
		});
		await quietShot(page, "chat-application");

		await edit.getByTestId("chat-accept").click();
		await expect(edit).toHaveAttribute("data-status", "accepted");
		await expect(edit.getByTestId("chat-outcome")).toContainText(
			`Saved as version ${before + 1}`,
		);
		expect(letterVersion()).toBe(before + 1);
		await docTab(page, /^Letter/).click();
		await expect(
			page.getByText(`Version ${before + 1}, edited by you`),
		).toBeVisible();
		await expect(page.getByTestId("doc-cover_letter")).toContainText(
			"I'd welcome a conversation about the role.",
		);

		// 2. A new fact: Save puts it in the profile's answers, where drafts may cite it.
		const fact =
			"I actually led the move of the patient web app to Next.js server rendering in 2025";
		await send(page, fact);
		const card = chat.getByTestId("chat-proposal-fact");
		await expect(card).toBeVisible({ timeout: 30_000 });
		await card.getByTestId("chat-accept").click();
		await expect(card).toHaveAttribute("data-status", "accepted");
		await sidebar(page, "Profile").click();
		await page
			.getByRole("navigation", { name: "Profile sections" })
			.getByRole("link", { name: /^Answers/ })
			.click();
		await expect(
			page.getByTestId("fact").filter({ hasText: fact }),
		).toBeVisible();
		expect(
			readDb<{ source: string }>(
				"select source from profile_facts where answer = ?",
				fact,
			)[0]?.source,
		).toBe("you, in chat");

		// 3. The profile chat drafts a project from the user's words; Add lists it.
		await page
			.getByRole("navigation", { name: "Profile sections" })
			.getByRole("link", { name: /^Projects/ })
			.click();
		await page.getByTestId("profile-chat-toggle").click();
		const profileChat = page.getByTestId("chat-panel");
		await expect(profileChat.getByTestId("chat-example")).toHaveCount(3);
		await send(
			page,
			"I built Ledgerline at Bluefin Labs in 2024 with Go and Postgres, it cut latency 40%",
		);
		const record = profileChat.getByTestId("chat-proposal-record");
		await expect(record).toBeVisible({ timeout: 30_000 });
		await expect(record).toContainText("Ledgerline");
		await expect(record).toContainText("Cut latency 40%");
		await quietShot(page, "chat-profile");
		await record.getByTestId("chat-accept").click();
		await expect(record).toHaveAttribute("data-status", "accepted");
		await expect(
			page.getByTestId("record-row").filter({ hasText: "Ledgerline" }),
		).toBeVisible();

		// Each turn is metered like every other model call.
		const tasks = readDb<{ task: string; n: number }>(
			"select task, count(*) n from llm_usage where task like 'chat-%' group by task order by task",
		);
		expect(tasks).toEqual([
			{ task: "chat-application", n: 2 },
			{ task: "chat-profile", n: 1 },
		]);

		// The chat lives in the database: a fresh visit shows the same thread.
		await sidebar(page, "Inbox").click();
		await sidebar(page, "Profile").click();
		await expect(
			page.getByTestId("chat-panel").getByTestId("chat-proposal-record"),
		).toHaveAttribute("data-status", "accepted");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
