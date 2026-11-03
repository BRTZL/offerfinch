import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type ElectronApplication,
	_electron as electron,
	expect,
	type Page,
} from "@playwright/test";

export const APP_DIR = path.resolve(import.meta.dirname, "..");

export function tempUserData(): string {
	// E2E_USER_DATA keeps the run's data (the measurements start from it).
	if (process.env.E2E_USER_DATA) {
		fs.rmSync(process.env.E2E_USER_DATA, { recursive: true, force: true });
		fs.mkdirSync(process.env.E2E_USER_DATA, { recursive: true });
		return process.env.E2E_USER_DATA;
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-e2e-"));
}

/** Launches the built app against its own data folder, fake models and fixture boards. */
export async function launchApp(options: {
	userData: string;
	rewrite?: Record<string, string>;
	/**
	 * Site tabs' local stand-ins (fixture boards' DuckDuckGo), merged with any the test sets in
	 * env.OFFERFINCH_SITE_ORIGINS. A site with none loads nothing in a test run.
	 */
	siteOrigins?: Record<string, string>;
	executablePath?: string;
	fakeDelayMs?: number;
	linkedinOrigin?: string;
	fakeCodex?: boolean;
	env?: Record<string, string>;
	/** Take focus like a real launch (tests that check the focused window). Default: background. */
	foreground?: boolean;
}): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([k, v]) => k !== "ELECTRON_RUN_AS_NODE" && v !== undefined,
		),
	) as Record<string, string>;
	const origins = {
		...(options.siteOrigins ?? {}),
		...JSON.parse(options.env?.OFFERFINCH_SITE_ORIGINS ?? "{}"),
	};
	const app = await electron.launch({
		args: options.executablePath ? [] : [APP_DIR],
		executablePath: options.executablePath,
		cwd: APP_DIR,
		env: {
			...env,
			OFFERFINCH_USER_DATA: options.userData,
			OFFERFINCH_TEST: "1",
			...(options.foreground ? {} : { OFFERFINCH_TEST_BACKGROUND: "1" }),
			OFFERFINCH_FAKE_MODELS: "1",
			OFFERFINCH_NO_SCHEDULE: "1",
			...(options.fakeCodex ? { OFFERFINCH_FAKE_CODEX: "1" } : {}),
			...options.env,
			...(Object.keys(origins).length
				? { OFFERFINCH_SITE_ORIGINS: JSON.stringify(origins) }
				: {}),
			...(options.linkedinOrigin
				? { OFFERFINCH_LINKEDIN_ORIGIN: options.linkedinOrigin }
				: {}),
			...(options.fakeDelayMs
				? { OFFERFINCH_FAKE_DELAY_MS: String(options.fakeDelayMs) }
				: {}),
			...(options.rewrite
				? { OFFERFINCH_FETCH_REWRITE: JSON.stringify(options.rewrite) }
				: {}),
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("pageerror", (e) => errors.push(String(e)));
	return { app, page, errors };
}

export type Notice = {
	kind: string;
	title: string;
	body: string;
	path: string;
	actions?: string[];
	applicationId?: string;
};

export function notices(app: ElectronApplication): Promise<Notice[]> {
	return app.evaluate(
		() =>
			(globalThis as unknown as { __offerfinchTest: { notices: Notice[] } })
				.__offerfinchTest.notices,
	);
}

/**
 * Presses button `index` of the `n`th notice shown, as Notification Center would; resolves once
 * the action ran (false when there is no such notice).
 */
export function pressNoticeAction(
	app: ElectronApplication,
	n: number,
	index: number,
): Promise<boolean> {
	return app.evaluate(
		(_e, [i, button]) =>
			(
				globalThis as unknown as {
					__offerfinchTest: {
						noticeAction: (n: number, index: number) => Promise<boolean>;
					};
				}
			).__offerfinchTest.noticeAction(i as number, button as number),
		[n, index],
	);
}

export function workerPid(
	app: ElectronApplication,
): Promise<number | undefined> {
	return app.evaluate(() =>
		(
			globalThis as unknown as {
				__offerfinchTest: { workerPid: () => number };
			}
		).__offerfinchTest.workerPid(),
	);
}

export const RESUME = `Sam Rivera
sam.rivera@example.test · +1 555 010 0199 · linkedin.com/in/samrivera-example
Fabricated resume for end-to-end runs. Nothing here describes a real person.
Skills: TypeScript, React, Next.js, Node.js, PostgreSQL, Cloudflare Workers, Go, Tailwind
Senior Frontend Engineer at Tidewater Health, Jan 2025 - Present
- Rebuilt the CarePortal appointment booking flow in React with server-rendered pages.
- Led a WCAG accessibility pass across the patient web app with screen reader testing on every release.
- Wrote the design-system components the patient web app and the clinic dashboard share.
- Moved the patient web app from client-side rendering to Next.js server rendering.
Senior Full-Stack Engineer at Northwind Logistics, Mar 2024 - Dec 2024
- Built TypeScript services on Node.js and PostgreSQL for shipment tracking.
- Designed event-driven workflows with queues, retries and webhooks on Cloudflare Workers.
- Tuned slow PostgreSQL queries behind the carrier dashboard and added the missing indexes.
- Reviewed code for a team of five engineers and wrote the team's deployment checklist.
Software Engineer at Bluefin Labs, Feb 2021 - Feb 2024
- Shipped React and Next.js interfaces used by warehouse operators every day.
- Wrote two internal Go services for label printing and stock counts.
- Built the Node.js API that the operator interfaces and the mobile scanners share.
- Ran the weekly on-call rotation and wrote incident reviews for the platform team.
Software Engineer at Quarry Systems, Jun 2018 - Jan 2021
- Built production web applications in TypeScript and React for construction clients.
- Wrote PostgreSQL schemas and migrations for the project scheduling product.
- Added end-to-end tests that ran on every pull request.
- Built the invoice export that construction clients used to send monthly statements.
- Moved the scheduling product's front end from jQuery to React and TypeScript, one screen at a time.
- Wrote the onboarding guide new engineers used in their first week.
`;

/**
 * A stand-in for Chrome (OFFERFINCH_CHROME): any launch writes its arguments to a file and
 * fails. Site readers run in the app's own hidden tabs, so a run must leave the file absent.
 */
export function fakeChrome(): { executable: string; launches: () => string[] } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-fake-chrome-"));
	const marker = path.join(dir, "launched.txt");
	const executable = path.join(dir, "chrome");
	fs.writeFileSync(
		executable,
		`#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`,
		{ mode: 0o755 },
	);
	return {
		executable,
		launches: () =>
			fs.existsSync(marker)
				? fs.readFileSync(marker, "utf8").trim().split("\n")
				: [],
	};
}

export type SiteTabInfo = {
	site: string;
	webContentsId: number;
	run: boolean;
	owner: number | null;
	sheet: "sign-in" | "live" | null;
	attached: boolean;
	bounds: { x: number; y: number; width: number; height: number };
	content: { x: number; y: number; width: number; height: number } | null;
	url: string;
};

/** Main's site tabs as they are now (src/main/site-browser.ts `describe`). */
export function siteTabs(app: ElectronApplication): Promise<SiteTabInfo[]> {
	return app.evaluate(() =>
		(
			globalThis as unknown as {
				__offerfinchTest: { siteTabs: () => SiteTabInfo[] };
			}
		).__offerfinchTest.siteTabs(),
	);
}

/** Clicks an element of a local stand-in page in a site's tab (its fake check or sign-in). */
export function standInClick(
	app: ElectronApplication,
	site: string,
	selector: string,
): Promise<boolean> {
	return app.evaluate(
		(_electron, [s, sel]) =>
			(
				globalThis as unknown as {
					__offerfinchTest: {
						siteStandInClick: (s: string, sel: string) => Promise<boolean>;
					};
				}
			).__offerfinchTest.siteStandInClick(s, sel),
		[site, selector] as const,
	);
}

/**
 * A page screenshot cannot see the native view main attaches over the sheet: the view's own
 * capture is laid over its hole (test only) so the picture shows what the user sees.
 */
export async function overlaySiteView(
	app: ElectronApplication,
	page: Page,
	site: string,
): Promise<boolean> {
	const png = await app.evaluate(
		(_electron, s) =>
			(
				globalThis as unknown as {
					__offerfinchTest: {
						siteCapture: (s: string) => Promise<string | null>;
					};
				}
			).__offerfinchTest.siteCapture(s),
		site,
	);
	if (!png) return false;
	await page.evaluate((data) => {
		const hole = document.querySelector('[data-testid="site-sheet-view"]');
		if (!hole) return;
		const img = document.createElement("img");
		img.src = `data:image/png;base64,${data}`;
		img.setAttribute("data-test-overlay", "");
		img.style.cssText =
			"position:absolute;inset:0;width:100%;height:100%;object-fit:cover";
		hole.appendChild(img);
	}, png);
	await page.waitForTimeout(100);
	return true;
}

/**
 * Waits until no toast shows. The pointer moves off first: a toast under the pointer pauses its
 * timer, and on a busy runner a click that lands there holds it open for good.
 */
export async function toastsGone(page: Page, timeout = 15_000): Promise<void> {
	await page.mouse.move(1, 1);
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout });
}

/** The window's route now (its pathname, without any query). */
function pathnameOf(page: Page): string {
	return new URL(page.url()).pathname;
}

/** The window shows this route, or an item inside it (a list opens on its first row). */
function onRoute(page: Page, want: string): boolean {
	const now = pathnameOf(page);
	return (
		now === want ||
		(want !== "/" && now.startsWith(`${want.replace(/\/$/, "")}/`))
	);
}

/**
 * Navigates as a notification or menu item does (main's test hook) and waits until the window
 * shows that route. The window may still be starting, or another navigation (Finish later's move
 * to Home) may land after this one on a slow machine, so the open is sent again until it holds.
 */
export async function openRoute(
	app: ElectronApplication,
	page: Page,
	to: string,
	timeout = 30_000,
): Promise<void> {
	const want = new URL(`app://local${to}`).pathname;
	let sent = false;
	await expect(async () => {
		if (!sent || !onRoute(page, want)) {
			sent = true;
			await app.evaluate(
				(_e, where) =>
					(
						globalThis as unknown as {
							__offerfinchTest: { open: (p: string) => void };
						}
					).__offerfinchTest.open(where),
				to,
			);
		}
		await expect
			.poll(() => onRoute(page, want) || pathnameOf(page), { timeout: 3_000 })
			.toBe(true);
	}).toPass({ timeout });
}

/**
 * Setup's Finish later, then waits until Home is on screen. Finish later saves first and then
 * moves to Home, so a test that navigates straight after the click can be sent back to Home.
 */
export async function skipRestOfSetup(page: Page): Promise<void> {
	await page.getByTestId("onboarding-later").click();
	await expect.poll(() => pathnameOf(page), { timeout: 30_000 }).toBe("/");
	await expect(page.getByTestId("home")).toBeVisible({ timeout: 30_000 });
}
