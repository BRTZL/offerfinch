import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type PlaywrightBrowserLike,
	PlaywrightBrowserProvider,
} from "@offerfinch/core/scrape/browser";
import { USER_AGENT } from "@offerfinch/core/sources/types";

/** Chrome-family browsers the app can drive, in the order it looks for them. Nothing is downloaded. */
const CANDIDATES = [
	{
		name: "Google Chrome",
		app: "Google Chrome.app/Contents/MacOS/Google Chrome",
	},
	{ name: "Chromium", app: "Chromium.app/Contents/MacOS/Chromium" },
	{
		name: "Microsoft Edge",
		app: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	},
	{
		name: "Brave Browser",
		app: "Brave Browser.app/Contents/MacOS/Brave Browser",
	},
];

export interface FoundBrowser {
	name: string;
	executable: string;
}

export function findChrome(
	roots = ["/Applications", path.join(os.homedir(), "Applications")],
): FoundBrowser | null {
	const override = process.env.OFFERFINCH_CHROME;
	// "none": behave as on a Mac without Chrome (tests of the missing-Chrome messages).
	if (override === "none") return null;
	if (override && fs.existsSync(override))
		return { name: "Custom browser", executable: override };
	for (const candidate of CANDIDATES)
		for (const root of roots) {
			const executable = path.join(root, candidate.app);
			if (fs.existsSync(executable))
				return { name: candidate.name, executable };
		}
	return null;
}

class ChromeMissingError extends Error {
	constructor() {
		super(
			"Google Chrome is not installed. OfferFinch uses your installed Chrome (in the background) to read careers pages and print PDFs. Install Chrome from google.com/chrome, then try again.",
		);
		this.name = "ChromeMissingError";
	}
}

/**
 * The local browser: the user's own Chrome, headless, started only when a step needs it (a
 * careers page, a PDF) and closed when that step's session closes. Playwright's defaults, no
 * stealth or fingerprint changes (PLAN rule 4). `onActive` reports open sessions for the status.
 */
export function localChromeProvider(
	onActive?: (open: number) => void,
): PlaywrightBrowserProvider {
	let open = 0;
	return new PlaywrightBrowserProvider(
		"local-chrome",
		async (options) => {
			const found = findChrome();
			if (!found) throw new ChromeMissingError();
			// Loaded on first use: the worker starts without Playwright in memory.
			const { chromium } = await import("playwright-core");
			const browser = await chromium.launch({
				executablePath: found.executable,
				headless: true,
				args: [
					"--no-first-run",
					"--no-default-browser-check",
					...(options?.args ?? []),
				],
			});
			open++;
			onActive?.(open);
			const close = browser.close.bind(browser);
			browser.close = async () => {
				await close();
				open = Math.max(0, open - 1);
				onActive?.(open);
			};
			return browser as unknown as PlaywrightBrowserLike;
		},
		USER_AGENT,
		true,
	);
}
