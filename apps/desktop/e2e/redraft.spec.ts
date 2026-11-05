import fs from "node:fs";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from "@playwright/test";
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
 * Redraft, with fake models (OFFERFINCH_FAKE_MODELS=1), in the background: a prepared
 * application's letter is redrafted with an instruction; the letter gets version 2, the CV stays
 * as it was, the claims check runs on the new version and it is ready to approve again; version 1
 * stays readable from the version picker. Screenshots of the dialog and the redrafted letter, in
 * light and dark, go to test-results/redraft-shots, or to E2E_SHOTS.
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "redraft-shots"),
);
const userData = tempUserData();

const POSTING =
	"Harbor Mills builds billing software for small shops. We are hiring a Frontend Engineer to build our customer pages in React and TypeScript, with Next.js server rendering and a shared design system. Requirements: 4 years of React, TypeScript, accessibility work. Remote - Worldwide.";

const INSTRUCTION = "Shorter, and lead with my React work";

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

/** The page in light and dark, as the app draws it when macOS asks for either. */
async function shots(app: ElectronApplication, page: Page, name: string) {
	fs.mkdirSync(SHOTS, { recursive: true });
	await toastsGone(page, 15_000);
	for (const theme of ["light", "dark"] as const) {
		await app.evaluate(({ nativeTheme }, t) => {
			nativeTheme.themeSource = t;
		}, theme);
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.documentElement.classList.contains("dark"),
				),
			)
			.toBe(theme === "dark");
		await page.waitForTimeout(800);
		await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
	}
	await app.evaluate(({ nativeTheme }) => {
		nativeTheme.themeSource = "system";
	});
}

test("Redraft the letter with an instruction: version 2 of the letter, the CV unchanged, checked again", async () => {
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
		await expect(page.getByTestId("passed")).toBeVisible({ timeout: 120_000 });
		const appId = new URL(page.url()).pathname.split("/").pop() ?? "";
		const latest = (kind: string) =>
			readDb<{ version: number; content: string }>(
				"select version, content from documents where application_id = ? and kind = ? and format in ('markdown', 'json') order by version desc limit 1",
				appId,
				kind,
			)[0];
		const cv = latest("cv");
		const letter = latest("cover_letter");
		expect(letter?.version).toBe(1);
		const checks = () =>
			readDb<{ n: number }>(
				"select count(*) n from llm_usage where application_id = ? and task = 'claims-check'",
				appId,
			)[0]?.n ?? 0;
		const checksBefore = checks();

		// The dialog: four scopes, an optional instruction, no cost line.
		await docTab(page, /^Letter/).click();
		// Redraft is in the action bar's More menu.
		await page.getByTestId("more-actions").click();
		await page.getByTestId("more-redraft").click();
		const dialog = page.getByTestId("redraft-dialog");
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId("redraft-scope-cover_letter")).toBeChecked();
		for (const scope of ["cv", "cover_letter", "form_answers", "all"])
			await expect(page.getByTestId(`redraft-scope-${scope}`)).toBeVisible();
		await page.getByTestId("redraft-instruction").fill(INSTRUCTION);
		await expect(dialog).not.toContainText("$");
		await expect(dialog).not.toContainText(/estimate|cost/i);
		await shots(app, page, "redraft-dialog");
		await page.getByTestId("redraft-confirm").click();
		await expect(dialog).toBeHidden();

		// The letter's version 2, from one more tailoring call; the CV byte-identical.
		await expect
			.poll(() => latest("cover_letter")?.version, {
				timeout: 60_000,
			})
			.toBe(2);
		expect(latest("cover_letter")?.content).not.toBe(letter?.content);
		expect(latest("cv")).toEqual(cv);
		const meta = readDb<{ meta: string }>(
			"select meta from documents where application_id = ? and kind = 'cover_letter' and version = 2",
			appId,
		)[0]?.meta;
		expect(JSON.parse(meta ?? "{}").redraft).toMatchObject({
			scope: "cover_letter",
			instruction: INSTRUCTION,
		});

		// The page shows version 2, and the claims check ran on it: ready to approve again.
		await expect(page.getByTestId("version-picker")).toContainText(
			"Version 2, redrafted",
			{ timeout: 30_000 },
		);
		await expect
			.poll(
				() =>
					readDb<{ n: number }>(
						"select count(*) n from review_checks where application_id = ? and ats_checked_at is not null",
						appId,
					)[0]?.n ?? 0,
				{ timeout: 60_000 },
			)
			.toBe(2);
		await expect(page.getByTestId("passed")).toBeVisible({ timeout: 30_000 });
		expect(checks()).toBeGreaterThan(checksBefore);
		await expect(page.getByTestId("approve")).toBeEnabled();
		await shots(app, page, "redraft-version-2");

		// Version 1 stays readable, read only.
		await page.getByTestId("version-picker").click();
		await page.getByTestId("version-1").click();
		await expect(page.getByTestId("earlier-version")).toContainText(
			"Version 1, read only",
		);
		await expect(page.getByTestId("doc-cover_letter-v1")).toBeVisible();
		// Read only: no Edit, and no PDF or copy menu that would act on version 2.
		await expect(
			page.getByRole("button", { name: "Edit Cover letter" }),
		).toHaveCount(0);
		await expect(page.getByTestId("view-toggle")).toHaveCount(0);
		// The bar's More keeps Redraft and the posting, but no export that would act on
		// version 2 while version 1 is on screen.
		await page.getByTestId("more-actions").click();
		const more = page.getByTestId("more-menu");
		await expect(more.getByTestId("more-redraft")).toBeVisible();
		await expect(more.getByTestId("more-open-posting")).toBeVisible();
		await expect(more.getByTestId("more-copy-link")).toBeVisible();
		for (const id of ["more-copy-text", "more-save-pdf", "more-open-docx"])
			await expect(more.getByTestId(id)).toHaveCount(0);
		await page.keyboard.press("Escape");
		await expect(more).toHaveCount(0);
		await shots(app, page, "redraft-version-1");
		await page
			.getByTestId("earlier-version")
			.getByRole("button", { name: /Back to version 2/ })
			.click();
		await expect(page.getByTestId("doc-cover_letter")).toBeVisible();
		// Back on version 2, Copy Text copies version 2, not version 1.
		await app.evaluate(({ clipboard }) => clipboard.writeText(""));
		await page.getByTestId("more-actions").click();
		await page.getByTestId("more-copy-text").click();
		await expect
			.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
			.toBe(latest("cover_letter")?.content);
		expect(latest("cover_letter")?.content).not.toBe(letter?.content);

		// Metered like any tailoring call.
		expect(
			readDb<{ n: number }>(
				"select count(*) n from llm_usage where application_id = ? and task = 'tailor'",
				appId,
			)[0]?.n,
		).toBeGreaterThanOrEqual(2);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
