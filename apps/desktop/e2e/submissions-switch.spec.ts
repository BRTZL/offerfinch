import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	APP_DIR,
	launchApp,
	openRoute,
	tempUserData,
	toastsGone,
} from "./launch";
import { countIn } from "./matches-setup";

/**
 * Settings › Applying: automatic submissions start off; turning them on asks first (Keep them
 * off changes nothing), and turning them off is immediate. The rest of the path (the paused line
 * linking here, and going away once on) is in apply-proof.spec.ts. Screenshots of the switch and
 * the confirmation go to test-results/submissions-switch (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ??
		path.join(APP_DIR, "test-results", "submissions-switch"),
);

const pausedRows = (userData: string) =>
	countIn(
		userData,
		"select count(*) n from submission_settings where paused = 1",
	);
const onRows = (userData: string) =>
	countIn(
		userData,
		"select count(*) n from submission_settings where paused = 0",
	);

test("the submissions switch asks before turning on and turns off at once", async () => {
	const userData = tempUserData();
	const { app, page, errors } = await launchApp({ userData });
	try {
		await page.setViewportSize({ width: 1280, height: 800 });
		// A new user starts in setup; Settings opens from there.
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe("/onboarding");
		await openRoute(app, page, "/settings/applying");
		const toggle = page.getByTestId("submissions-switch");
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await expect(page.getByTestId("real-site-greenhouse")).toHaveAttribute(
			"aria-checked",
			"false",
		);
		fs.mkdirSync(SHOTS, { recursive: true });
		await toastsGone(page);
		await page.screenshot({ path: path.join(SHOTS, "submissions-switch.png") });

		// Keep them off: nothing changes.
		await toggle.click();
		const dialog = page.getByTestId("submissions-confirm-dialog");
		await expect(dialog).toBeVisible();
		for (const line of [
			"right after you approve it",
			"scored as automated",
			"Real job sites stay closed until you open each one below",
		])
			await expect(dialog).toContainText(line);
		await page.waitForTimeout(400);
		await page.screenshot({
			path: path.join(SHOTS, "submissions-confirm.png"),
		});
		await page.getByRole("button", { name: "Keep them off" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(onRows(userData)).toBe(0);

		// Turn On: on, once.
		await toggle.click();
		await page.getByTestId("submissions-confirm").click();
		await expect(dialog).toHaveCount(0);
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect.poll(() => onRows(userData)).toBe(1);

		// Off needs no confirmation.
		await toggle.click();
		await expect(dialog).toHaveCount(0);
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await expect.poll(() => pausedRows(userData)).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});

const openSites = (userData: string) =>
	countIn(userData, "select count(*) n from submission_boards");

test("real job sites start closed; opening Greenhouse names its risks and shows its hosts", async () => {
	const userData = tempUserData();
	const { app, page, errors } = await launchApp({ userData });
	try {
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe("/onboarding");
		await openRoute(app, page, "/settings/applying");
		const sites = page.getByTestId("submissions-real-sites");
		for (const name of [
			"Ashby",
			"Greenhouse",
			"Lever",
			"Workable",
			"Recruitee",
			"Teamtailor",
			"Personio",
			"Employers' own forms",
		])
			await expect(sites.getByText(name, { exact: true })).toBeVisible();
		for (const board of ["ashby", "greenhouse", "web"])
			await expect(page.getByTestId(`real-site-${board}`)).toHaveAttribute(
				"aria-checked",
				"false",
			);
		const hosts = page.getByTestId("real-site-hosts-greenhouse");
		await expect(hosts).toContainText("Closed. Opens job-boards.greenhouse.io");
		await expect(hosts).toContainText(
			"grnhse-prod-jben-us-east-1.s3.amazonaws.com",
		);
		await expect(page.getByTestId("real-site-hosts-recruitee")).toContainText(
			"<company>.recruitee.com",
		);
		await expect(page.getByTestId("real-site-hosts-web")).toContainText(
			"the form's own site only",
		);
		expect(openSites(userData)).toBe(0);

		// Keep it closed: nothing changes.
		const greenhouse = page.getByTestId("real-site-greenhouse");
		await greenhouse.click();
		const dialog = page.getByTestId("real-site-confirm-dialog");
		await expect(dialog).toContainText("Open Greenhouse?");
		await expect(dialog).toContainText("reCAPTCHA Enterprise");
		await page.getByRole("button", { name: "Keep it closed" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(greenhouse).toHaveAttribute("aria-checked", "false");
		expect(openSites(userData)).toBe(0);

		// Open it: one row, Greenhouse only.
		await greenhouse.click();
		await expect(dialog).toBeVisible();
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.waitForTimeout(400);
		await page.screenshot({ path: path.join(SHOTS, "real-site-confirm.png") });
		await page.getByTestId("real-site-confirm").click();
		await expect(dialog).toHaveCount(0);
		await expect(greenhouse).toHaveAttribute("aria-checked", "true");
		await expect(hosts).toContainText("Open. Opens job-boards.greenhouse.io");
		await expect
			.poll(() =>
				countIn(
					userData,
					"select count(*) n from submission_boards where board = 'greenhouse'",
				),
			)
			.toBe(1);
		expect(openSites(userData)).toBe(1);
		await toastsGone(page);
		await sites.scrollIntoViewIfNeeded();
		await sites.screenshot({ path: path.join(SHOTS, "real-sites.png") });

		// Closing needs no confirmation.
		await greenhouse.click();
		await expect(dialog).toHaveCount(0);
		await expect(greenhouse).toHaveAttribute("aria-checked", "false");
		await expect.poll(() => openSites(userData)).toBe(0);
		// A run that already started keeps its hosts: closing says so, never "nothing is sent".
		await expect(
			page.getByText(
				"Greenhouse is closed for new runs. A run already started may finish.",
			),
		).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
