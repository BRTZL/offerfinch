import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startFixtureBoards } from "./fixture-boards";
import { APP_DIR, launchApp, tempUserData } from "./launch";
import {
	countIn,
	onboardWithFakes,
	openMatches,
	scanOnce,
	shootBothThemes,
	withDb,
} from "./matches-setup";

/**
 * Prepare's cost estimate (issue #66), in the background against the fixture boards and fake
 * models: before any preparation it says there is none; with recorded preparations it shows the
 * median and the recorded range on hover, and a selection shows the sum beside Prepare N.
 * Screenshots go to test-results/estimate-shots (or E2E_SHOTS).
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "estimate-shots"),
);
const userData = tempUserData();

const count = (query: string) => countIn(userData, query);

/** Past preparations, recorded as the app records them: drafting and checking per job. */
const DRAFTS = [100_000, 200_000, 600_000];
const CHECKS = [20_000, 30_000, 40_000];

/** Records three finished preparations on the fake models (which record no cost themselves). */
function seedPreparations() {
	withDb(
		userData,
		(db) => {
			const { user_id: userId } = db
				.prepare("select user_id from applications limit 1")
				.get() as { user_id: string };
			const ids = (
				db
					.prepare("select id from applications order by rowid limit 3")
					.all() as { id: string }[]
			).map((r) => r.id);
			expect(ids).toHaveLength(3);
			const usage = db.prepare(`insert into llm_usage
			(id, user_id, application_id, task, provider, status, estimate_micros, cost_micros,
			 billing, created_at)
			values (?, ?, ?, ?, 'fake', 'settled', 0, ?, 'api', ?)`);
			const reviewed = db.prepare(`insert into application_transitions
			(id, user_id, application_id, from_state, to_state, reason, actor, created_at)
			values (?, ?, ?, 'preparing', 'ready_for_review', 'e2e seed', 'workflow', ?)`);
			const at = Date.now() - 86_400_000;
			ids.forEach((id, i) => {
				usage.run(crypto.randomUUID(), userId, id, "tailor", DRAFTS[i], at + i);
				usage.run(
					crypto.randomUUID(),
					userId,
					id,
					"claims-check",
					CHECKS[i],
					at + i + 1,
				);
				reviewed.run(crypto.randomUUID(), userId, id, at + i + 2);
			});
		},
		false,
	);
}

const dollars = (text: string) =>
	[...text.matchAll(/\$(\d+\.\d\d)/g)].map((m) =>
		Math.round(Number(m[1]) * 1e6),
	);

test("Prepare shows its likely cost from past preparations, and a selection's total", async () => {
	const boards = await startFixtureBoards();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		fs.mkdirSync(SHOTS, { recursive: true });
		await page.setViewportSize({ width: 1280, height: 800 });
		await onboardWithFakes(page);
		await scanOnce(page, userData);

		const rows = await openMatches(page);
		await rows.first().click();
		const prepare = page.getByTestId("prepare");
		await expect(prepare).toBeVisible();
		await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
			timeout: 15_000,
		});

		// Nothing prepared yet: no figure is made up.
		await prepare.hover();
		const tip = page.getByTestId("prepare-tip");
		await expect(tip).toBeVisible();
		await expect(page.getByTestId("prepare-tip-estimate")).toContainText(
			"No estimate yet",
		);
		await page.mouse.move(10, 400);
		await expect(tip).toHaveCount(0);

		// Three recorded preparations: the median and the recorded range, per job.
		seedPreparations();
		await prepare.hover();
		const estimate = page.getByTestId("prepare-tip-estimate");
		await expect(estimate).toContainText("About $0.23 ($0.12–$0.64)");
		await expect(estimate).toContainText("3 past preparations");
		const [median = 0, low = 0, high = 0] = dollars(
			(await estimate.textContent()) ?? "",
		);
		const sums = DRAFTS.map((d, i) => d + (CHECKS[i] ?? 0));
		expect(median).toBeGreaterThanOrEqual(Math.min(...sums));
		expect(median).toBeLessThanOrEqual(Math.max(...sums));
		expect(low).toBeLessThanOrEqual(median);
		expect(high).toBeGreaterThanOrEqual(median);
		await shootBothThemes(app, page, (t) =>
			path.join(SHOTS, `prepare-tooltip-${t}.png`),
		);
		await page.mouse.move(10, 400);

		// Two matches selected: the total beside Prepare 2, which prepares both.
		await rows.nth(0).click();
		await rows.nth(1).click({ modifiers: ["Meta"] });
		const summary = page.getByTestId("selection-summary");
		await expect(summary).toContainText("2 jobs selected");
		await expect(page.getByTestId("prepare-selection-estimate")).toContainText(
			"For 2 jobs: about $0.46 ($0.24–$1.28)",
		);
		await shootBothThemes(app, page, (t) =>
			path.join(SHOTS, `prepare-selection-${t}.png`),
		);
		await page.getByTestId("prepare-selection").click();
		await expect
			.poll(() =>
				count(
					"select count(*) n from applications where prepare_requested_at is not null",
				),
			)
			.toBe(2);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
