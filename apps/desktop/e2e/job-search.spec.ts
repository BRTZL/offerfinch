import crypto from "node:crypto";
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
} from "./launch";

/**
 * Settings › Job search, in the background: "I live in", citizenship and right to work are
 * filled from the profile's location at the first start after the update, the pickers search
 * and pick with the keyboard, the fit-score preferences (level, pay, company, industries) are
 * saved, and what is saved stays after a restart. Neither the update nor a save touches a job
 * already here: no rule sets a job aside. A screenshot goes to test-results/job-search-shots
 * (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ??
		path.join(APP_DIR, "test-results", "job-search-shots"),
);
const userData = tempUserData();
const dbFile = path.join(userData, DB_FILE);
/** The seeded matches' application ids (the API takes UUIDs). */
const APP_IDS = {
	us: crypto.randomUUID(),
	emea: crypto.randomUUID(),
	tr: crypto.randomUUID(),
} as const;

function readSettings(): Record<string, unknown> {
	const db = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		const row = db.prepare("select settings from filter_settings").get() as
			| { settings: string }
			| undefined;
		return JSON.parse(row?.settings ?? "{}");
	} finally {
		db.close();
	}
}

/** The seeded applications' state, rank and the reason of their last move. */
function readApps(): Record<
	string,
	{ state: string; rank: number | null; reason: string | null }
> {
	const db = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		const rows = db
			.prepare(
				"select j.external_id id, a.state, a.rank, (select t.reason from application_transitions t where t.application_id = a.id order by t.created_at desc limit 1) reason from applications a join jobs j on j.id = a.job_id where j.id like 'j-%'",
			)
			.all() as {
			id: string;
			state: string;
			rank: number | null;
			reason: string | null;
		}[];
		return Object.fromEntries(rows.map(({ id, ...r }) => [id, r]));
	} finally {
		db.close();
	}
}

async function openJobSearch(page: Page) {
	await page
		.getByRole("navigation", { name: "Main" })
		.getByRole("link", { name: /^Settings/ })
		.click();
	await page
		.getByRole("navigation", { name: "Settings" })
		.getByRole("link", { name: /^Job search/ })
		.click();
	await expect(page.getByTestId("lives-in")).toBeVisible();
}

/** The chips a multi-picker shows. */
const chips = (page: Page, testId: string) =>
	page.getByTestId(testId).locator("[data-slot=combobox-chip]");

test("job search pickers: filled from the profile, changed with the keyboard, kept", async () => {
	// First start: a profile from the fabricated resume and test models; setup put off.
	let run = await launchApp({ userData });
	try {
		await run.page.getByTestId("welcome-start").click();
		await pickFakeModels(run.page);
		await run.page.getByTestId("step-continue").click();
		await run.page.getByTestId("resume-option-paste").click();
		await run.page.getByTestId("onboarding-text").fill(RESUME);
		await run.page.getByTestId("onboarding-structure").click();
		await run.page.getByTestId("onboarding-save").click({ timeout: 60_000 });
		await skipRestOfSetup(run.page);
	} finally {
		await run.app.close();
	}

	// An install from before this update: the About location set, older free-text settings and
	// no record of the new job filter yet.
	const db = new Database(dbFile);
	try {
		const about = db
			.prepare("select id, data from profile_records where kind = 'about'")
			.get() as { id: string; data: string };
		const data = JSON.parse(about.data);
		data.location = "Izmir, Turkey (GMT+3)";
		db.prepare("update profile_records set data = ? where id = ?").run(
			JSON.stringify(data),
			about.id,
		);
		db.prepare(
			"insert into filter_settings (user_id, settings, updated_at) values ('local', ?, ?) on conflict(user_id) do update set settings = excluded.settings",
		).run(JSON.stringify({ rightToWork: [], minScore: 60 }), Date.now());
		db.prepare("delete from app_settings where key = 'jobSearchVersion'").run();
		// Three open matches scored before the update: one in the US that needs citizenship and a
		// clearance, one remote that names no place, one remote in Turkey.
		const now = Date.now();
		const seed = (
			id: keyof typeof APP_IDS,
			{
				title,
				locations,
				workplace,
				text,
				score,
			}: {
				title: string;
				locations: string[];
				workplace: string;
				text: string;
				score: number;
			},
		) => {
			// One company each, so the Inbox lists them as single rows.
			db.prepare(
				"insert into companies (id, user_id, name, name_key, source, source_key, created_at, updated_at) values (?, 'local', ?, ?, 'greenhouse', ?, ?, ?)",
			).run(
				`c-${id}`,
				`Fixture ${id}`,
				`fixture ${id}`,
				`fixture-${id}`,
				now,
				now,
			);
			db.prepare(
				"insert into jobs (id, user_id, company_id, source, external_id, url, url_normalized, title, locations, workplace_type, description_text, first_seen_at, last_seen_at, created_at) values (?, 'local', ?, 'greenhouse', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				`j-${id}`,
				`c-${id}`,
				id,
				`https://jobs.example/${id}`,
				`jobs.example/${id}`,
				title,
				JSON.stringify(locations),
				workplace,
				text,
				now,
				now,
				now,
			);
			db.prepare(
				"insert into applications (id, user_id, job_id, state, flags, score, scored_at, state_changed_at, created_at, updated_at) values (?, 'local', ?, 'scored', '[]', ?, ?, ?, ?, ?)",
			).run(APP_IDS[id], `j-${id}`, score, now, now, now, now);
		};
		const body = "Build web products with TypeScript and React.";
		seed("us", {
			title: "Software Engineer, Mission Systems",
			locations: ["Owego, NY"],
			workplace: "unknown",
			text: `${body} Must be a US Citizen; this position will require a DoD government security clearance.`,
			score: 90,
		});
		seed("emea", {
			title: "Frontend Engineer, Distributed Team",
			locations: ["Remote"],
			workplace: "remote",
			text: body,
			score: 85,
		});
		seed("tr", {
			title: "Frontend Engineer, Turkey",
			locations: ["Remote – Turkey"],
			workplace: "remote",
			text: body,
			score: 75,
		});
	} finally {
		db.close();
	}

	run = await launchApp({ userData });
	try {
		const { page, errors } = run;
		await openJobSearch(page);
		// Filled from "Izmir, Turkey (GMT+3)".
		await expect(page.locator("#f-livesIn")).toHaveValue("Türkiye");
		await expect(chips(page, "citizenship")).toHaveText(["Türkiye"]);
		await expect(chips(page, "right-to-work")).toHaveText(["Türkiye"]);
		expect(readSettings()).toMatchObject({
			livesIn: "Türkiye",
			citizenship: ["Türkiye"],
			rightToWork: ["Türkiye"],
			locationPrefilled: true,
			minScore: 60,
		});

		// No job is filtered or ranked again: the three matches stay as they were scored,
		// the US one included (its fit score would cap it; it was scored before).
		const seeded = {
			us: { state: "scored", rank: null },
			emea: { state: "scored", rank: null },
			tr: { state: "scored", rank: null },
		};
		expect(readApps()).toMatchObject(seeded);
		await page
			.getByRole("navigation", { name: "Main" })
			.getByRole("link", { name: /^Inbox/ })
			.click();
		const rows = page.getByTestId("inbox-row");
		await expect(rows.filter({ hasText: "Frontend Engineer" })).toHaveCount(2);
		await expect(rows.filter({ hasText: "Mission Systems" })).toHaveCount(1);
		await openJobSearch(page);

		// Citizenship: type to search, arrow down, Enter.
		const citizenship = page.locator("#f-citizenship");
		await citizenship.click();
		await citizenship.fill("Germ");
		await expect(page.getByRole("option", { name: "Germany" })).toBeVisible();
		await citizenship.press("ArrowDown");
		await citizenship.press("Enter");
		await expect(chips(page, "citizenship")).toHaveText(["Türkiye", "Germany"]);
		// Escape closes the list and keeps the picks.
		await citizenship.press("Escape");
		await citizenship.press("Escape");
		await expect(chips(page, "citizenship")).toHaveText(["Türkiye", "Germany"]);

		// Relocation on, then the countries the user would move to.
		await page.getByTestId("relocation").click();
		const move = page.locator("#f-relocationCountries");
		await move.click();
		await move.fill("nether");
		await expect(
			page.getByRole("option", { name: "Netherlands" }),
		).toBeVisible();
		await move.press("ArrowDown");
		await move.press("Enter");
		await move.press("Escape");
		await expect(chips(page, "relocation-countries")).toHaveText([
			"Netherlands",
		]);

		// "I live in": one country, picked by typing.
		const livesIn = page.locator("#f-livesIn");
		await livesIn.click();
		await livesIn.fill("Turk");
		await expect(page.getByRole("option", { name: "Türkiye" })).toBeVisible();
		await livesIn.press("ArrowDown");
		await livesIn.press("Enter");
		await expect(livesIn).toHaveValue("Türkiye");

		// What the fit score weighs: a level, pay, company size and industries to avoid.
		const level = page.locator("#f-seniority");
		await level.click();
		await level.fill("Sen");
		await expect(page.getByRole("option", { name: "Senior" })).toBeVisible();
		await level.press("ArrowDown");
		await level.press("Enter");
		await level.press("Escape");
		await expect(chips(page, "seniority")).toHaveText(["Senior"]);
		await page.getByTestId("min-salary").fill("60000");
		const currency = page.locator("#f-salaryCurrency");
		await currency.click();
		await currency.fill("EU");
		await expect(page.getByRole("option", { name: "EUR" })).toBeVisible();
		await currency.press("ArrowDown");
		await currency.press("Enter");
		await expect(currency).toHaveValue("EUR");
		const sizes = page.locator("#f-companySizes");
		await sizes.click();
		await sizes.fill("Scale");
		await expect(page.getByRole("option", { name: "Scale-up" })).toBeVisible();
		await sizes.press("ArrowDown");
		await sizes.press("Enter");
		await sizes.press("Escape");
		await page.locator("#f-avoidIndustries").fill("Gambling, Defense");
		// Typed words: Enter adds one, and a word still being typed is added when the field is left.
		const avoid = page.locator("#f-excludeTitleKeywords");
		await avoid.fill("Contractor");
		await avoid.press("Enter");
		await avoid.fill("Lead");
		// Languages by their own names: typing the English name finds Türkçe.
		const languages = page.locator("#f-languages");
		await languages.click();
		await languages.fill("Türk");
		await expect(page.getByRole("option", { name: "Türkçe" })).toBeVisible();
		await languages.press("ArrowDown");
		await languages.press("Enter");
		await languages.press("Escape");
		await expect(chips(page, "languages")).toHaveText(["English", "Türkçe"]);

		await page.getByTestId("save-settings").click();
		await expect(
			page.getByText(
				"Saved. New jobs are scored with it; jobs already here keep their score.",
			),
		).toBeVisible();
		expect(readSettings()).toMatchObject({
			livesIn: "Türkiye",
			citizenship: ["Türkiye", "Germany"],
			rightToWork: ["Türkiye"],
			relocation: true,
			relocationCountries: ["Netherlands"],
			minScore: 60,
			seniority: ["Senior"],
			minSalary: 60000,
			salaryCurrency: "EUR",
			companySizes: ["Scale-up"],
			avoidIndustries: ["Gambling", "Defense"],
			languages: ["English", "Türkçe"],
			searchTitles: [],
		});
		expect(readSettings().excludeTitleKeywords).toEqual(
			expect.arrayContaining(["intern", "Contractor", "Lead"]),
		);
		// Saving applies to new jobs only: the matches are as they were.
		expect(readApps()).toMatchObject(seeded);
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.getByText("Where you can work").scrollIntoViewIfNeeded();
		await page.screenshot({ path: path.join(SHOTS, "job-search.png") });
		await page
			.getByText("Role and language", { exact: true })
			.evaluate((el) => el.scrollIntoView({ block: "start" }));
		await page.screenshot({ path: path.join(SHOTS, "job-search-roles.png") });
		await page.getByText("Level and kind of role").scrollIntoViewIfNeeded();
		await page.screenshot({
			path: path.join(SHOTS, "job-search-preferences.png"),
		});
		expect(errors).toEqual([]);
	} finally {
		await run.app.close();
	}

	// Kept after a restart, and not filled again from the profile.
	run = await launchApp({ userData });
	try {
		await openJobSearch(run.page);
		await expect(run.page.locator("#f-livesIn")).toHaveValue("Türkiye");
		await expect(chips(run.page, "citizenship")).toHaveText([
			"Türkiye",
			"Germany",
		]);
		await expect(chips(run.page, "relocation-countries")).toHaveText([
			"Netherlands",
		]);
		await expect(chips(run.page, "seniority")).toHaveText(["Senior"]);
		await expect(run.page.getByTestId("min-salary")).toHaveValue("60000");
		await expect(
			run.page
				.getByTestId("tags-avoidIndustries")
				.locator("[data-slot=tag-chip]"),
		).toHaveText(["Gambling", "Defense"]);
		await expect(chips(run.page, "languages")).toHaveText([
			"English",
			"Türkçe",
		]);
	} finally {
		await run.app.close();
	}
});
