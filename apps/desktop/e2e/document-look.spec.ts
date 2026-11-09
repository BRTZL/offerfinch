import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { DB_FILE } from "../src/main/database-file";
import { APP_DIR, launchApp, tempUserData } from "./launch";
import { showStatus } from "./matches-setup";

/**
 * Settings › Documents in try-it mode: the four controls and the live preview, then one sample
 * job prepared in each template. Each export's file is named for its look, its PDF passes the ATS
 * check (no findings recorded) within the page limit, and the PDF is kept for a look at it.
 * Screenshots and PDFs go to test-results/document-look (or E2E_SHOTS).
 */
const OUT = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "document-look"),
);
const userData = tempUserData();
const demoDir = path.join(userData, "demo");

function demoDb<T>(query: string, ...params: unknown[]): T[] {
	const db = new Database(path.join(demoDir, DB_FILE), {
		readonly: true,
		fileMustExist: true,
	});
	db.pragma("busy_timeout = 5000");
	try {
		return db.prepare(query).all(...params) as T[];
	} finally {
		db.close();
	}
}

const sidebar = (page: Page, name: string) =>
	page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: new RegExp(`^${name}`) });

const docTab = (page: Page, name: RegExp) =>
	page.getByRole("tablist", { name: "Document" }).getByRole("tab", { name });

/** The fake checker flags lines of its own draft: settle one open flag, as a user would. */
async function settleOneFlag(page: Page) {
	for (const tab of [/^CV/, /^Letter/, /^Answers/]) {
		const t = docTab(page, tab);
		if ((await t.count()) === 0) continue;
		await t.click();
		const open = page
			.getByTestId("flag")
			.filter({ has: page.getByTestId("flag-delete") });
		if ((await open.count()) === 0) continue;
		const first = open.first();
		const confirm = first.getByTestId("flag-confirm");
		if (await confirm.count()) {
			await confirm.click();
			await page.getByTestId("flag-confirm-yes").click();
		} else await first.getByTestId("flag-delete").click();
		return;
	}
}

async function choose(page: Page, control: string, value: string) {
	await page.getByTestId(control).click();
	await page.getByTestId(`${control}-${value}`).click();
	await expect(page.getByTestId(control)).toBeVisible();
}

async function openDocuments(page: Page) {
	await sidebar(page, "Settings").click();
	await page
		.getByRole("navigation", { name: "Settings" })
		.getByRole("link", { name: "Documents" })
		.click();
	await expect(page.getByTestId("settings-documents")).toBeVisible();
	await expect(page.getByTestId("look-preview")).toBeVisible();
}

interface ExportRow {
	storage_key: string;
	meta: string;
}

const RUNS = [
	{ template: "classic", company: "Orchid Studio", slug: "" },
	{
		template: "modern",
		company: "Basalt Cloud",
		slug: "-modern-georgia-navy-letter",
	},
	{
		template: "compact",
		company: "Kestrel Freight",
		slug: "-compact-georgia-navy-letter",
	},
] as const;

test("Documents: the look's controls and preview, and a sample job exported in each template", async () => {
	test.setTimeout(900_000);
	fs.mkdirSync(OUT, { recursive: true });
	const { app, page, errors } = await launchApp({
		userData,
		env: { OFFERFINCH_FAKE_MODELS: "0" },
	});
	const theme = async (scheme: "light" | "dark") => {
		await app.evaluate(({ nativeTheme }, s) => {
			nativeTheme.themeSource = s;
		}, scheme);
		await page.waitForTimeout(400);
	};
	try {
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
		);
		await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 30_000 });
		await page.getByTestId("welcome-demo").click();
		await expect(page.getByTestId("demo-banner")).toBeVisible({
			timeout: 60_000,
		});
		await expect(page.getByTestId("home")).toBeVisible({ timeout: 30_000 });
		await expect
			.poll(
				() =>
					demoDb<{ n: number }>(
						"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
					)[0]?.n,
				{ timeout: 120_000 },
			)
			.toBe(1);

		// The defaults: classic, Helvetica Neue, ink, A4.
		await openDocuments(page);
		const preview = page.getByTestId("look-preview");
		await expect(preview).toHaveAttribute("data-template", "classic");
		await expect(preview).toHaveAttribute("data-page-size", "A4");
		await expect(page.getByTestId("look-font")).toContainText("Helvetica Neue");
		await expect(page.getByTestId("look-accent")).toContainText("Ink");

		for (const [i, run] of RUNS.entries()) {
			await openDocuments(page);
			await choose(page, "look-template", run.template);
			await expect(preview).toHaveAttribute("data-template", run.template);
			if (i === 1) {
				// The rest of the look once; it stays for the next run.
				await choose(page, "look-font", "georgia");
				await choose(page, "look-accent", "navy");
				await choose(page, "look-page-size", "Letter");
				await expect(preview).toHaveAttribute("data-page-size", "Letter");
				// Saved in the worker, not only on screen.
				await page.reload();
				await expect(page.getByTestId("look-preview")).toHaveAttribute(
					"data-page-size",
					"Letter",
				);
				await expect(page.getByTestId("look-font")).toContainText("Georgia");
			}
			await page.mouse.move(1, 899);
			for (const scheme of ["light", "dark"] as const) {
				await theme(scheme);
				// Hidden windows have no native material behind the sidebar.
				await page.evaluate(() =>
					document.documentElement.classList.remove("vibrant"),
				);
				await page.screenshot({
					path: path.join(
						OUT,
						`settings-documents-${run.template}-${scheme}.png`,
					),
					animations: "disabled",
				});
			}
			await page.evaluate(() =>
				document.documentElement.classList.add("vibrant"),
			);
			await theme("light");

			// Prepare one sample job in this look; it exports once its review passes.
			await sidebar(page, "Inbox").click();
			await showStatus(page, /^All/);
			const row = page
				.getByTestId("inbox-row")
				.filter({ hasText: run.company });
			await expect(row).toBeVisible({ timeout: 120_000 });
			await row.click();
			await expect(page.getByTestId("interested")).toBeVisible();
			const appId = new URL(page.url()).pathname.split("/").pop() ?? "";
			await page.getByTestId("interested").click();
			const cvPdf = () =>
				demoDb<ExportRow>(
					"select storage_key, meta from documents where application_id = ? and kind = 'cv' and format = 'pdf' order by version desc limit 1",
					appId,
				)[0];
			const stateOf = () =>
				demoDb<{ state: string }>(
					"select state from applications where id = ?",
					appId,
				)[0]?.state;
			await expect
				.poll(stateOf, { timeout: 180_000 })
				.toMatch(/^(needs_answers|ready_for_review|needs_human)$/);
			expect(stateOf(), "the sample job asked a question").not.toBe(
				"needs_answers",
			);
			await sidebar(page, "Inbox").click();
			await showStatus(page, /^To review/);
			await page
				.getByTestId("inbox-row")
				.filter({ hasText: run.company })
				.click();
			await expect(page.getByTestId("approve")).toBeVisible({
				timeout: 60_000,
			});
			await expect
				.poll(
					async () => {
						if (cvPdf()) return true;
						await settleOneFlag(page);
						return Boolean(cvPdf());
					},
					{ timeout: 180_000, intervals: [1_500] },
				)
				.toBe(true);
			const row1 = cvPdf();
			if (!row1) throw new Error("no CV export");
			expect(row1.storage_key).toMatch(
				new RegExp(`/cv-v\\d+-r2${run.slug}\\.pdf$`),
			);
			const meta = JSON.parse(row1.meta) as {
				pages: number;
				atsIssues: unknown[];
				look: { template: string };
			};
			expect(meta.atsIssues).toEqual([]);
			expect(meta.look.template).toBe(run.template);
			expect(meta.pages).toBe(1);
			fs.copyFileSync(
				path.join(demoDir, "files", row1.storage_key),
				path.join(OUT, `cv-${run.template}.pdf`),
			);
		}
		expect(errors.filter((e) => !/ERR_ABORTED|net::/.test(e))).toEqual([]);
	} finally {
		await app.close();
	}
});
