import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type ElectronApplication,
	expect,
	type Page,
	test,
} from "@playwright/test";

import { launchApp, tempUserData } from "./launch";

/**
 * The sidebar over the real window's vibrancy, in every theme combination: the window is captured
 * as macOS draws it (screencapture -l: the material included, which a page capture cannot show),
 * and the text's contrast with the sidebar behind it is measured from the pixels.
 *
 * App appearance follows macOS; `nativeTheme.themeSource` stands in for "the app forced light or
 * dark". E2E_SYSTEM_APPEARANCE=1 also flips macOS's own appearance (and puts it back), for the
 * macOS-light combinations. Without window capture (a locked screen, or no Screen Recording
 * permission for the terminal) the test is skipped, never passed.
 */
test.describe.configure({ mode: "serial" });

const windowIdTool = path.join(os.tmpdir(), "offerfinch-window-id");
/** A fresh data folder, or a copy of a set-up one (E2E_PREPARED) to see the sidebar with data. */
function preparedUserData(): string {
	const from = process.env.E2E_PREPARED;
	const dir = tempUserData();
	if (from && fs.existsSync(from)) {
		fs.cpSync(from, dir, { recursive: true });
		for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
			fs.rmSync(path.join(dir, f), { force: true });
	}
	return dir;
}
const userData = preparedUserData();

type Rgb = [number, number, number];
const luminance = ([r, g, b]: Rgb) => {
	const c = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const contrast = (a: Rgb, b: Rgb) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (hi + 0.05) / (lo + 0.05);
};

function systemDark(): boolean {
	try {
		return (
			execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() === "Dark"
		);
	} catch {
		return false;
	}
}
function setSystemDark(dark: boolean) {
	execFileSync("osascript", [
		"-e",
		`tell application "System Events" to tell appearance preferences to set dark mode to ${dark}`,
	]);
}

async function capture(app: ElectronApplication): Promise<string | null> {
	try {
		if (!fs.existsSync(windowIdTool))
			execFileSync("swiftc", [
				"-O",
				path.join(import.meta.dirname, "../scripts/window-id.swift"),
				"-o",
				windowIdTool,
			]);
		const id = execFileSync(windowIdTool, [String(app.process().pid)], {
			encoding: "utf8",
		}).trim();
		if (!id) return null;
		const file = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "of-theme-")),
			"window.png",
		);
		execFileSync("screencapture", ["-o", "-x", "-l", id, file], {
			stdio: "pipe",
		});
		return fs.existsSync(file) && fs.statSync(file).size > 0 ? file : null;
	} catch {
		return null;
	}
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * From the captured window: the background as the median of an empty strip, and the text as the
 * pixel in the label's box that differs most from it (an antialiased glyph's core).
 */
async function measure(
	app: ElectronApplication,
	file: string,
	label: Box,
	empty: Box,
) {
	return app.evaluate(
		({ BrowserWindow, nativeImage }, { file, label, empty }) => {
			const image = nativeImage.createFromPath(file);
			const { width, height } = image.getSize();
			const bounds = BrowserWindow.getAllWindows()[0]?.getContentBounds();
			const scale = width / (bounds?.width ?? width);
			const bitmap = image.toBitmap(); // BGRA
			const px = (x: number, y: number): [number, number, number] => {
				const i =
					(Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4;
				return [bitmap[i + 2] ?? 0, bitmap[i + 1] ?? 0, bitmap[i] ?? 0];
			};
			const area = (b: {
				x: number;
				y: number;
				width: number;
				height: number;
			}) => {
				const out: [number, number, number][] = [];
				for (
					let y = Math.round(b.y * scale);
					y < Math.round((b.y + b.height) * scale);
					y++
				)
					for (
						let x = Math.round(b.x * scale);
						x < Math.round((b.x + b.width) * scale);
						x++
					)
						out.push(px(x, y));
				return out;
			};
			const strip = area(empty).sort(
				(a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]),
			);
			const bg = strip[Math.floor(strip.length / 2)] ?? [0, 0, 0];
			let ink = bg;
			let far = -1;
			for (const p of area(label)) {
				const d =
					Math.abs(p[0] - bg[0]) +
					Math.abs(p[1] - bg[1]) +
					Math.abs(p[2] - bg[2]);
				if (d > far) {
					far = d;
					ink = p;
				}
			}
			return { bg, ink };
		},
		{ file, label, empty },
	);
}

/** The app's own navigation (main's test hook), as a click in the menu would do. */
async function open(app: ElectronApplication, to: string) {
	await app.evaluate(
		(_e, path) =>
			(
				globalThis as unknown as {
					__offerfinchTest: { open: (p: string) => void };
				}
			).__offerfinchTest.open(path),
		to,
	);
}

async function box(page: Page, selector: string): Promise<Box> {
	const b = await page.locator(selector).first().boundingBox();
	if (!b) throw new Error(`no box for ${selector}`);
	return b;
}

async function check(app: ElectronApplication, page: Page, combo: string) {
	await page.waitForTimeout(900);
	const native = await app.evaluate(
		({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
	);
	const pageDark = await page.evaluate(() =>
		document.documentElement.classList.contains("dark"),
	);
	// One theme: the page follows the same appearance the window's material does.
	expect
		.soft(pageDark, `${combo}: page theme matches the native appearance`)
		.toBe(native);
	const file = await capture(app);
	test.skip(
		!file,
		"window capture unavailable: locked screen or no Screen Recording permission",
	);
	if (!file) return;
	const sidebar = await box(page, '[data-ds="sidebar"]');
	const empty = {
		x: sidebar.x + 16,
		y: sidebar.y + sidebar.height - 140,
		width: 160,
		height: 40,
	};
	const results: Record<string, number> = {};
	for (const [name, selector] of [
		["sidebar label", '[data-ds="sidebar"] a:has-text("Home")'],
		["sidebar group", '[data-ds="sidebar"] p:has-text("You")'],
	] as const) {
		const { bg, ink } = await measure(
			app,
			file,
			await box(page, selector),
			empty,
		);
		results[name] = Math.round(contrast(bg, ink) * 100) / 100;
	}
	// The Settings section column sits on the page, not the material: it must read too.
	await open(app, "/settings/models");
	const column = page.getByRole("navigation", { name: "Settings" });
	await expect(column).toBeVisible();
	await page.waitForTimeout(500);
	const file2 = await capture(app);
	if (file2) {
		const nav = await box(page, 'nav[aria-label="Settings"]');
		const navEmpty = {
			x: nav.x + 12,
			y: nav.y + nav.height - 80,
			width: 150,
			height: 30,
		};
		const { bg, ink } = await measure(
			app,
			file2,
			await box(page, 'nav[aria-label="Settings"] a:has-text("Spending")'),
			navEmpty,
		);
		results["settings column"] = Math.round(contrast(bg, ink) * 100) / 100;
	}
	await open(app, "/settings/general");
	console.log(combo, JSON.stringify({ native, results }));

	for (const [name, ratio] of Object.entries(results))
		expect
			.soft(ratio, `${combo}: ${name} contrast`)
			.toBeGreaterThanOrEqual(4.5);
}

test("the sidebar is readable over the real window in every theme combination", async () => {
	// It reads the real, focused window's pixels, so it takes focus: run with E2E_FOREGROUND=1.
	test.skip(
		process.env.E2E_FOREGROUND !== "1",
		"takes focus; set E2E_FOREGROUND=1 to run it",
	);
	// E2E_APP: the packaged OfferFinch.app instead of this build (as the user runs it).
	const { app, page } = await launchApp({
		userData,
		foreground: true,
		executablePath: process.env.E2E_APP
			? path.join(process.env.E2E_APP, "Contents/MacOS/OfferFinch")
			: undefined,
	});
	const originalDark = systemDark();
	try {
		// A new user is sent to setup first; once that has happened, Settings shows the sidebar.
		if (!process.env.E2E_PREPARED)
			await expect
				.poll(() => new URL(page.url()).pathname, { timeout: 30_000 })
				.toBe("/onboarding");
		await open(app, "/settings/general");
		await expect(page.locator('[data-ds="sidebar"]')).toBeVisible({
			timeout: 30_000,
		});
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]?.focus(),
		);
		const sources = ["system", "light", "dark"] as const;
		const appearances =
			process.env.E2E_SYSTEM_APPEARANCE === "1"
				? [true, false]
				: [originalDark];
		for (const dark of appearances) {
			if (dark !== systemDark()) setSystemDark(dark);
			for (const source of sources) {
				await app.evaluate(({ nativeTheme }, s) => {
					nativeTheme.themeSource = s;
				}, source);
				await check(
					app,
					page,
					`macOS ${dark ? "dark" : "light"}, app ${source}`,
				);
			}
		}
	} finally {
		if (systemDark() !== originalDark) setSystemDark(originalDark);
		await app.close();
	}
});
