import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

import {
	APP_DIR,
	launchApp,
	openRoute,
	RESUME,
	skipRestOfSetup,
} from "./launch";

/**
 * Home's mark is a frame sheet stepped like a GIF: at chosen moments of its loop the strip sits
 * exactly on one frame (no in-between positions), and the frames differ. Each moment is saved
 * to test-results/mark-frames (or E2E_SHOTS) so the loop can be turned into a GIF.
 */
const SHOTS = path.resolve(
	process.env.E2E_SHOTS ?? path.join(APP_DIR, "test-results", "mark-frames"),
);

// Seconds into the 9 s loop, and the frame the sheet must show then.
const MOMENTS: [number, number][] = [
	[1, 0],
	[3.65, 1],
	[5.05, 2],
	[6.6, 3],
	[7.8, 4],
	[8.05, 5],
	[8.3, 6],
];

test("Home's mark steps through its frame sheet", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-mark-"));
	const { app, page, errors } = await launchApp({ userData });
	try {
		// Setup with test models and a pasted resume, then put off: Home opens.
		await page.getByTestId("welcome-start").click();
		for (const role of ["scoring", "tailoring", "claims"]) {
			await page.getByTestId(`role-${role}-mode`).click();
			await page.getByTestId(`role-${role}-fake`).click();
		}
		await page.getByTestId("step-continue").click();
		await page.getByTestId("resume-option-paste").click();
		await page.getByTestId("onboarding-text").fill(RESUME);
		await page.getByTestId("onboarding-structure").click();
		await page.getByTestId("onboarding-save").click({ timeout: 60_000 });
		await skipRestOfSetup(page);
		await openRoute(app, page, "/");
		const mark = page.getByTestId("animated-mark");
		await expect(mark).toBeVisible({ timeout: 30_000 });
		const strip = mark.locator("svg");
		fs.mkdirSync(SHOTS, { recursive: true });
		const seen = new Set<string>();
		for (const [i, [at, frame]] of MOMENTS.entries()) {
			const offset = await strip.evaluate((el, seconds) => {
				const svg = el as unknown as SVGElement;
				// Seek the running animation itself: a new delay on a paused animation would add
				// to however long it had already run.
				const [loop] = svg.getAnimations();
				if (!loop) throw new Error("the mark is not animated");
				loop.pause();
				loop.currentTime = seconds * 1000;
				// The strip's left edge, in frames: whole numbers only (stepped, never tweened).
				const matrix = new DOMMatrix(getComputedStyle(svg).transform);
				const frameWidth =
					svg.parentElement?.getBoundingClientRect().width ?? 1;
				return -matrix.m41 / frameWidth;
			}, at);
			expect(offset).toBeCloseTo(frame, 5);
			const shot = await mark.screenshot({
				path: path.join(SHOTS, `frame-${String(i).padStart(2, "0")}.png`),
			});
			seen.add(shot.toString("base64"));
		}
		// Every moment shows a different picture.
		expect(seen.size).toBe(MOMENTS.length);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
