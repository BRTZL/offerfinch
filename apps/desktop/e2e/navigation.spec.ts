import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { launchApp, openRoute } from "./launch";

/**
 * Moving between screens draws the new one at once, also on its first visit: screens' code is
 * loaded at idle and rendered without suspending (React holds a suspended reveal ~300 ms), and
 * their data is prefetched. Measured from the click to the last DOM change.
 */
test("every screen settles quickly on its first visit", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-nav-"));
	const { app, page, errors } = await launchApp({ userData });
	try {
		expect(
			await app.evaluate(
				() =>
					(
						globalThis as unknown as {
							__offerfinchTest: { trayShown: boolean };
						}
					).__offerfinchTest.trayShown,
			),
		).toBe(false);
		// A new user starts in setup; Settings shows the sidebar.
		await expect
			.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
			.toBe("/onboarding");
		await openRoute(app, page, "/settings/general");
		const sidebar = page.locator("[data-ds=sidebar]");
		await expect(sidebar).toBeVisible({ timeout: 30_000 });
		// Idle preloading has run.
		await page.waitForTimeout(2_000);
		const timings: Record<string, number> = {};
		for (const name of [
			"Inbox",
			"Questions",
			"Applied",
			"Rejected",
			"Profile",
		]) {
			await page.evaluate(() => {
				const w = window as unknown as {
					__nav: { start: number; last: number; obs?: MutationObserver };
				};
				w.__nav = { start: 0, last: 0 };
				w.__nav.obs = new MutationObserver(() => {
					w.__nav.last = performance.now();
				});
				w.__nav.obs.observe(document.body, {
					subtree: true,
					childList: true,
					characterData: true,
				});
				document.addEventListener(
					"click",
					() => {
						w.__nav.start = performance.now();
					},
					{ capture: true, once: true },
				);
			});
			await sidebar.getByRole("link", { name }).first().click();
			await page.waitForTimeout(1_000);
			timings[name] = await page.evaluate(() => {
				const w = window as unknown as {
					__nav: { start: number; last: number; obs?: MutationObserver };
				};
				w.__nav.obs?.disconnect();
				return Math.round(w.__nav.last - w.__nav.start);
			});
		}
		console.log("first-visit settle (ms)", JSON.stringify(timings));
		for (const [name, ms] of Object.entries(timings))
			expect(ms, `${name} settled in ${ms} ms`).toBeLessThan(150);

		// Anything clickable shows the pointing hand; a disabled control keeps the arrow.
		const cursors = await page.evaluate(() => {
			const cursorOf = (selector: string) => {
				const el = document.querySelector(selector);
				return el ? getComputedStyle(el).cursor : null;
			};
			const probe = document.createElement("button");
			probe.disabled = true;
			document.body.append(probe);
			const disabled = getComputedStyle(probe).cursor;
			probe.remove();
			return {
				link: cursorOf("[data-ds=sidebar] a[href]"),
				button: cursorOf("button:not(:disabled)"),
				disabled,
			};
		});
		expect(cursors).toEqual({
			link: "pointer",
			button: "pointer",
			disabled: "default",
		});

		// Scrollbars float over the content: a box that starts to scroll keeps its full width,
		// and its thumb shows over its right edge while it scrolls, and can be dragged.
		const scroll = await page.evaluate(async () => {
			const box = document.createElement("div");
			box.style.cssText =
				"position:fixed;left:40px;top:40px;width:300px;height:200px;overflow-y:auto;z-index:50";
			box.innerHTML = '<div style="height:2000px"></div>';
			document.body.append(box);
			const taken = box.offsetWidth - box.clientWidth;
			box.scrollTop = 900;
			await new Promise((r) => setTimeout(r, 100));
			const thumb = document.querySelector<HTMLElement>(
				"[data-testid=overlay-thumb]",
			);
			const rect = thumb?.getBoundingClientRect();
			return {
				taken,
				visible: thumb ? getComputedStyle(thumb).opacity === "1" : false,
				right: rect ? Math.round(rect.right) : null,
				inside: rect ? rect.top >= 40 && rect.bottom <= 240 : false,
			};
		});
		expect(scroll).toEqual({
			taken: 0,
			visible: true,
			right: 338,
			inside: true,
		});
		const thumb = page.getByTestId("overlay-thumb");
		const box = await thumb.boundingBox();
		if (!box) throw new Error("no thumb");
		// A pointer at the box's right edge brings the thumb back (after it faded out).
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await expect(thumb).toHaveAttribute("data-visible", "true");
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, {
			steps: 4,
		});
		await page.mouse.up();
		const after = await page.evaluate(() => {
			const boxes = [...document.body.children].filter(
				(el) => (el as HTMLElement).style.overflowY === "auto",
			) as HTMLElement[];
			const top = boxes[0]?.scrollTop ?? 0;
			for (const el of boxes) el.remove();
			return top;
		});
		expect(after).toBeGreaterThan(900 + 100);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
