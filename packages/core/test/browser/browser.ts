import { PlaywrightBrowserProvider } from "@offerfinch/core/scrape/browser";
import { USER_AGENT } from "@offerfinch/core/sources/types";
import { chromium } from "playwright-core";

export const chromePath =
	process.env.OFFERFINCH_CHROME ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Headless system Chrome for fixture-only browser safety tests. No stealth settings. */
export function localBrowser(): PlaywrightBrowserProvider {
	return new PlaywrightBrowserProvider(
		"local-playwright",
		() => chromium.launch({ headless: true, executablePath: chromePath }),
		USER_AGENT,
	);
}

/**
 * Headless Chromium with its Local Network Access checks off. A page the guard fulfills has no
 * address, so Chromium treats it as public and blocks its requests to localhost by itself, which
 * would hide a leak to the away host these tests look for. Test-only; never used on a real board.
 */
export function fixtureBrowser(): PlaywrightBrowserProvider {
	return new PlaywrightBrowserProvider(
		"fixture-playwright",
		() =>
			chromium.launch({
				headless: true,
				executablePath: chromePath,
				args: [
					"--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
				],
			}),
		USER_AGENT,
	);
}
