import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { launchApp } from "./launch";

/**
 * The Mac window and menu bar: the app's own menu (Go ⌘1…⌘7, ⌘, for Settings, nothing that
 * approves), a window that starts in the system's colours, and drag regions whose controls
 * still take clicks. Native key equivalents do not reach the app through Playwright's key
 * events, so the menu items are clicked the way the menu bar would.
 */
test("the menu bar, the window and its drag regions", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-native-"));
	const { app, page, errors } = await launchApp({ userData });
	try {
		await page.waitForLoadState("domcontentloaded");
		const menu = await app.evaluate(({ Menu }) =>
			(Menu.getApplicationMenu()?.items ?? []).map((item) => ({
				label: item.label,
				items: (item.submenu?.items ?? []).map((s) => ({
					label: s.label,
					accelerator: s.accelerator ?? null,
				})),
			})),
		);
		expect(menu.map((m) => m.label)).toEqual([
			"OfferFinch",
			"File",
			"Edit",
			"View",
			"Go",
			"Window",
			"Help",
		]);
		const go = menu.find((m) => m.label === "Go")?.items ?? [];
		expect(go.map((g) => `${g.label} ${g.accelerator}`)).toEqual([
			"Home Command+1",
			"Inbox Command+2",
			"Questions Command+3",
			"Applied Command+4",
			"Rejected Command+5",
			"Profile Command+6",
			"Settings Command+7",
		]);
		const settings = menu[0]?.items.find((i) => i.label === "Settings…");
		expect(settings?.accelerator).toBe("Command+,");
		const all = menu.flatMap((m) => m.items.map((i) => i.label));
		// No menu item approves: an accidental key press must not approve (docs/ux-pass.md).
		expect(all.filter((l) => /approve/i.test(l))).toEqual([]);
		// Help links nowhere outside the app: the shortcut sheet (⌘/), the diagnostics bundle
		// (saved locally, never sent) and the logs.
		const help = menu.find((m) => m.label === "Help")?.items ?? [];
		expect(help.map((i) => i.label).filter(Boolean)).toEqual([
			"Keyboard Shortcuts",
			"Export Diagnostics…",
			"Show Logs in Finder",
		]);
		expect(help[0]?.accelerator).toBe("Command+/");

		const click = (id: string) =>
			app.evaluate(({ Menu }, id) => {
				Menu.getApplicationMenu()?.getMenuItemById(id)?.click();
			}, id);
		for (const [id, pathname] of [
			["go-2", "/inbox"],
			["go-3", "/questions"],
			["go-4", "/applied"],
			["go-5", "/rejected"],
			["go-6", "/profile/about"],
			// Home sends a new user (no profile yet) on to onboarding.
			["go-1", "/(onboarding)?$"],
			["settings", "/settings"],
		] as const) {
			await click(id);
			await expect
				.poll(() => new URL(page.url()).pathname)
				.toMatch(new RegExp(`^${pathname}`));
		}

		const window = await app.evaluate(({ BrowserWindow, nativeTheme }) => {
			const win = BrowserWindow.getAllWindows()[0];
			return {
				min: win?.getMinimumSize(),
				background: win?.getBackgroundColor(),
				dark: nativeTheme.shouldUseDarkColors,
			};
		});
		expect(window.min).toEqual([960, 600]);
		// Vibrancy: the window is see-through (Electron reports the colour without its alpha).
		expect(window.background?.toLowerCase()).toMatch(/^#000000(00)?$/);

		// Every control inside a drag region is excluded from it, or it could not be clicked.
		const stuck = await page.evaluate(() =>
			[
				...document.querySelectorAll(
					"a, button, input, select, textarea, [role=tab], [role=button]",
				),
			]
				.filter((el) => {
					const style = getComputedStyle(el) as CSSStyleDeclaration & {
						webkitAppRegion?: string;
					};
					return (
						el.closest(".drag") !== null && style.webkitAppRegion !== "no-drag"
					);
				})
				.map((el) => el.outerHTML.slice(0, 80)),
		);
		expect(stuck).toEqual([]);
		expect(
			await page.evaluate(() => document.querySelectorAll(".drag").length),
		).toBeGreaterThan(0);
		expect(
			await page.evaluate(() => getComputedStyle(document.body).fontFamily),
		).toMatch(/^-apple-system/);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});

test("the sidebar hides and comes back, remembered, without the header crossing the traffic lights", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-side-"));
	const { app, page, errors } = await launchApp({ userData });
	try {
		await page.evaluate(() => {
			history.pushState(null, "", "/settings/general");
			dispatchEvent(new PopStateEvent("popstate"));
		});
		const shell = page.locator("[data-ds=shell]");
		await expect(shell).toHaveAttribute("data-sidebar", "shown");
		await page.getByTestId("sidebar-hide").click();
		await expect(shell).toHaveAttribute("data-sidebar", "hidden");
		await expect(page.getByTestId("sidebar-show")).toBeVisible();
		// The header starts after the traffic lights (x 20 to about 80 at their largest), with a
		// clear gap before the show-sidebar button.
		const left = await page
			.getByTestId("sidebar-show")
			.evaluate((el) => el.getBoundingClientRect().left);
		expect(left).toBeGreaterThanOrEqual(96);
		await page.reload();
		await expect(shell).toHaveAttribute("data-sidebar", "hidden");
		await page.getByTestId("sidebar-show").click();
		await expect(shell).toHaveAttribute("data-sidebar", "shown");
		// The menu bar has the command too (⌘\).
		const item = await app.evaluate(({ Menu }) => {
			const i = Menu.getApplicationMenu()?.getMenuItemById("toggle-sidebar");
			return i ? `${i.label} ${i.accelerator}` : null;
		});
		expect(item).toBe("Show or Hide Sidebar Command+\\");
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		fs.rmSync(userData, { recursive: true, force: true });
	}
});
