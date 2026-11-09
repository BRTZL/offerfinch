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

/**
 * `fixtureBrowser`, with every host under `acme.test` answered by the local fixture server on
 * `port`, so host rules can be tested on real names (`jobs.acme.test`, `sink.acme.test`) whose
 * registrable domain is shared. The browser resolves them to 127.0.0.1 itself; requests the guard
 * fetches (Playwright's own HTTP client) are sent to 127.0.0.1 with the name in `x-fixture-host`.
 * Test-only.
 */
export function siteBrowser(port: number): PlaywrightBrowserProvider {
	return new PlaywrightBrowserProvider(
		"site-playwright",
		async () => {
			const browser = await chromium.launch({
				headless: true,
				executablePath: chromePath,
				args: [
					"--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
					"--host-resolver-rules=MAP *.acme.test 127.0.0.1",
				],
			});
			const newContext = browser.newContext.bind(browser);
			browser.newContext = async (options) => {
				const context = await newContext(options);
				const route = context.route.bind(context);
				context.route = (async (pattern, handler) =>
					route(pattern, (r, request) => {
						const fetch = r.fetch.bind(r);
						r.fetch = (opts = {}) => {
							const url = new URL(opts.url ?? request.url());
							if (!url.hostname.endsWith(".acme.test")) return fetch(opts);
							const host = url.hostname;
							url.hostname = "127.0.0.1";
							url.port = String(port);
							return fetch({
								...opts,
								url: url.href,
								headers: {
									...request.headers(),
									...opts.headers,
									"x-fixture-host": host,
								},
							});
						};
						return handler(r, request);
					})) as typeof context.route;
				return context;
			};
			return browser;
		},
		USER_AGENT,
	);
}
