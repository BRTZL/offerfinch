import { expect, test } from "@playwright/test";

import { startFixtureBoards } from "./fixture-boards";
import {
	launchApp,
	notices,
	openRoute,
	pressNoticeAction,
	tempUserData,
} from "./launch";
import { countIn, onboardWithFakes, withDb } from "./matches-setup";

const NEW_TITLE = "Principal Platform Engineer";

/** Index in the shown notices of the match notices, oldest first. */
async function matchNotices(app: Parameters<typeof notices>[0]) {
	return (await notices(app))
		.map((n, i) => ({ ...n, i }))
		.filter((n) => n.kind === "match");
}

const scansDone = (userData: string) =>
	countIn(
		userData,
		"select count(*) n from flow_runs where kind = 'scan' and status = 'complete'",
	);

/**
 * Match notifications' buttons, pressed through the test hook (test runs show no real
 * notification): several matches offer Open only, which opens Matches; one match offers Open and
 * Not interested, which dismisses it as the app's button does, and a second press changes nothing.
 */
test("notification actions: Open, and Not interested on one match", async () => {
	test.setTimeout(420_000);
	const boards = await startFixtureBoards();
	const userData = tempUserData();
	const { app, page, errors } = await launchApp({
		userData,
		rewrite: boards.rewrite,
		siteOrigins: boards.siteOrigins,
	});
	try {
		await onboardWithFakes(page);
		await page.getByTestId("scan-status").click();
		await page.getByTestId("scan-now").first().click();
		await expect.poll(() => scansDone(userData), { timeout: 120_000 }).toBe(1);

		// The first scan's matches: one notification, with Open only.
		await expect
			.poll(async () => (await matchNotices(app)).length, { timeout: 120_000 })
			.toBe(1);
		const [grouped] = await matchNotices(app);
		expect(grouped?.title).toMatch(/^\d+ new strong matches$/);
		expect(grouped?.actions).toEqual(["open"]);
		expect(grouped?.applicationId).toBeUndefined();
		await openRoute(app, page, "/");
		expect(await pressNoticeAction(app, grouped?.i ?? -1, 0)).toBe(true);
		// Matches, with its first line open.
		await expect
			.poll(() => new URL(page.url()).pathname + new URL(page.url()).search)
			.toMatch(/^\/(inbox|applications\/[^?]+)\?view=matches/);
		// A button it never had does nothing.
		expect(await pressNoticeAction(app, grouped?.i ?? -1, 1)).toBe(true);

		// A later scan finds one new match: its notification offers Not interested too.
		boards.addJob(4020, NEW_TITLE);
		await openRoute(app, page, "/");
		await page.getByTestId("scan-status").click();
		await page.getByTestId("scan-now").first().click();
		await expect.poll(() => scansDone(userData), { timeout: 120_000 }).toBe(2);
		// Kinds are sent at most once every two minutes: the second waits for its turn.
		await expect
			.poll(async () => (await matchNotices(app)).length, { timeout: 200_000 })
			.toBe(2);
		const single = (await matchNotices(app))[1];
		expect(single?.body).toContain(NEW_TITLE);
		expect(single?.actions).toEqual(["open", "dismiss"]);
		const id = single?.applicationId ?? "";
		expect(single?.path).toBe(`/applications/${id}`);
		const stateOf = () =>
			withDb(
				userData,
				(db) =>
					db
						.prepare(
							"select state, ended_reason from applications where id = ?",
						)
						.get(id) as { state: string; ended_reason: string | null },
			);
		expect(stateOf().state).toBe("scored");

		// Matches lists it (in Acme's line, opened); Not interested from the notification takes
		// it out.
		const acmeRows = async () => {
			const group = page
				.getByTestId("inbox-group")
				.filter({ hasText: "Acme Robotics" });
			await expect(group).toBeVisible({ timeout: 30_000 });
			if ((await group.getAttribute("aria-expanded")) !== "true")
				await group.click();
			await expect(group).toHaveAttribute("aria-expanded", "true");
			return page.locator("[data-testid=inbox-row][data-child]");
		};
		await openRoute(app, page, "/inbox?view=matches");
		const before = await acmeRows();
		await expect(before.filter({ hasText: NEW_TITLE })).toHaveCount(1, {
			timeout: 30_000,
		});
		const listed = await before.count();
		// The window gone (the app keeps running in the menu bar): the button still works.
		await app.evaluate(({ BrowserWindow }) => {
			for (const w of BrowserWindow.getAllWindows()) w.hide();
		});
		expect(await pressNoticeAction(app, single?.i ?? -1, 1)).toBe(true);
		expect(stateOf().state).toBe("dismissed");
		expect(
			countIn(
				userData,
				`select count(*) n from dismissals where application_id = '${id}'`,
			),
		).toBe(1);
		// Nothing opened for it.
		expect(new URL(page.url()).pathname).toBe("/inbox");
		await openRoute(app, page, "/inbox?view=matches");
		const after = await acmeRows();
		await expect(after).toHaveCount(listed - 1, { timeout: 15_000 });
		await expect(after.filter({ hasText: NEW_TITLE })).toHaveCount(0);

		// Pressed again: already decided, nothing changes.
		expect(await pressNoticeAction(app, single?.i ?? -1, 1)).toBe(true);
		expect(stateOf().state).toBe("dismissed");
		expect(
			countIn(
				userData,
				`select count(*) n from dismissals where application_id = '${id}'`,
			),
		).toBe(1);

		// Open on the single one opens that match.
		expect(await pressNoticeAction(app, single?.i ?? -1, 0)).toBe(true);
		await expect
			.poll(() => new URL(page.url()).pathname)
			.toBe(`/applications/${id}`);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await boards.close();
	}
});
