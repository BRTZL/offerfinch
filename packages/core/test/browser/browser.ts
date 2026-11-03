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
