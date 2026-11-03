import { describe, expect, it } from "vitest";

import { detectLinkedInStop } from "../src/linkedin/detect";
import {
	type LinkedInBrowser,
	LinkedInRunBlockedError,
	type LinkedInStore,
	runLinkedIn,
} from "../src/linkedin/runner";
import { detectSiteStop, type SitePage } from "../src/sites/read";
import { SITES } from "../src/sites/sites";
import { isHeldStop, stopRecord } from "../src/sites/stops";
import { detectDuckDuckGoStop } from "../src/sources/duckduckgo";

/**
 * The rule every detector keeps: a page that shows a check or a sign-in wall is held for the
 * user, whatever its HTTP status; only a page with no such marker can be a transient stop
 * (retried with backoff).
 */
type Detect = (page: SitePage) => { kind: string } | null;

const DETECTORS: Record<string, { url: string; detect: Detect }> = {
	indeed: {
		url: "https://www.indeed.com/jobs?q=x",
		detect: (p) => detectSiteStop(p, SITES.indeed),
	},
	glassdoor: {
		url: "https://www.glassdoor.com/Job/jobs.htm",
		detect: (p) => detectSiteStop(p, SITES.glassdoor),
	},
	linkedin: {
		url: "https://www.linkedin.com/jobs/search/",
		detect: (p) => detectLinkedInStop(p, "www.linkedin.com"),
	},
	duckduckgo: {
		url: "https://html.duckduckgo.com/html/?q=x",
		detect: (p) => detectDuckDuckGoStop(p),
	},
};

/** Check and sign-in pages, as each site (or any site) shows them. */
const MARKED: Record<string, string[]> = {
	indeed: [
		"<h1>Additional Verification Required</h1>",
		"<title>Just a moment...</title><body>x</body>",
		"<h1>Sign in to continue</h1>",
		'<iframe src="https://hcaptcha.com/checkbox"></iframe>',
		"<p>Please verify you are a human.</p>",
	],
	glassdoor: [
		"<h1>Humans only</h1><p>Please verify you are a human.</p>",
		"<h1>Humans only</h1>",
		"<h1>Help Us Protect Glassdoor</h1>",
		'<div id="px-captcha"></div>',
		'<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
	],
	linkedin: [
		"<h1>Security verification</h1>",
		"<h1>Let's do a quick security check</h1>",
		'<form><input name="session_key"></form>',
		"<div>Your account has been temporarily restricted</div>",
	],
	duckduckgo: [
		'<form id="challenge-form"><div class="anomaly-modal__modal">Bots use DuckDuckGo too</div></form>',
		"<div>Unfortunately, bots use DuckDuckGo too.</div>",
	],
};

const STATUSES = [200, 403, 429, 500, 999, null];

describe("a check or sign-in is held whatever the HTTP status", () => {
	for (const [site, { url, detect }] of Object.entries(DETECTORS))
		for (const html of MARKED[site] ?? [])
			for (const status of STATUSES)
				it(`${site} ${status}: ${html.slice(0, 50)}`, () => {
					const stop = detect({ url, status, html });
					expect(stop, "a stop").not.toBeNull();
					expect(isHeldStop(stop as { kind: string })).toBe(true);
					// Held: no retry time, so no scan revisits it by itself.
					const record = stopRecord(
						stop as never,
						null,
						new Date("2026-11-02T10:00:00Z"),
					);
					expect(record.retryAt).toBeUndefined();
				});
});

describe("only an unmarked page is transient", () => {
	for (const [site, { url, detect }] of Object.entries(DETECTORS))
		for (const status of [403, 429, 500])
			it(`${site} ${status} with nothing on the page`, () => {
				const stop = detect({
					url,
					status,
					html: "<html><body><p>Error</p></body></html>",
				});
				// LinkedIn's 429 is its own refusal page: a check it shows.
				if (site === "linkedin" && status === 429)
					expect(stop?.kind).toBe("security_check");
				else expect(isHeldStop(stop as { kind: string })).toBe(false);
			});

	it("a refusal in the page's text is transient; the same words in a script are nothing", () => {
		const { url, detect } = DETECTORS.glassdoor as (typeof DETECTORS)[string];
		expect(
			detect({ url, status: 429, html: "<h1>Too many requests</h1>" })?.kind,
		).toBe("blocked");
		expect(
			detect({
				url,
				status: 200,
				html: '<script>translations={error:"too many requests"}</script><main>Results</main>',
			}),
		).toBeNull();
	});
});

describe("check markers read what the page shows", () => {
	const { url, detect } = DETECTORS.glassdoor as (typeof DETECTORS)[string];

	it("not hidden elements", () => {
		for (const hidden of [
			"<div hidden>Sign in to see more</div>",
			'<div style="display:none">Sign in to see more</div>',
			'<div style="visibility: hidden">Humans only</div>',
			"<template><h1>Humans only</h1></template>",
		])
			expect(
				detect({
					url,
					status: 200,
					html: `${hidden}<main>Normal search results</main>`,
				}),
				hidden,
			).toBeNull();
	});

	it("the browser's rendered text when it gives it", () => {
		// The markup says nothing; the rendered text shows the wall.
		expect(
			detect({
				url,
				status: 200,
				html: "<main><div class='x'></div></main>",
				text: "Sign in to see more jobs",
			})?.kind,
		).toBe("login_wall");
		// The markup holds the words, but the browser did not render them.
		expect(
			detect({
				url,
				status: 200,
				html: '<div class="sr-only-hidden">Sign in to see more</div><main>Results</main>',
				text: "Results",
			}),
		).toBeNull();
	});
});

describe("the LinkedIn runner at a check shown with HTTP 403", () => {
	it("blocks (held), keeps no page and refuses the next run", async () => {
		const blocks: string[] = [];
		const kept: string[] = [];
		let blocked: { at: Date; kind: string; reason: string } | null = null;
		const store = {
			blocked: async () => blocked,
			pagesUsedSince: async () => 0,
			reservePage: async () => ({ ok: true as const }),
			startRun: async () => "r1",
			updateRun: async () => {},
			finishRun: async () => {},
			block: async (_u: string, stop: { kind: string; reason: string }) => {
				blocks.push(stop.kind);
				blocked = { at: new Date(), ...stop };
			},
			isKnown: async () => false,
			saveListing: async () => ({ outcome: "inserted" as const, jobId: "j" }),
		} as unknown as LinkedInStore;
		const options = {
			userId: "u1",
			trigger: "t",
			lists: [
				{
					kind: "search" as const,
					label: "a",
					url: "https://www.linkedin.com/jobs/search/?keywords=a",
				},
			],
		};
		const browser: LinkedInBrowser = {
			open: async (url) => ({
				url,
				status: 403,
				html: "<h1>Security verification</h1>",
			}),
		};
		const result = await runLinkedIn(
			{
				store,
				browser,
				alert: async () => {},
				sleep: async () => {},
				debug: async (_page, stop) => {
					kept.push(stop.kind);
				},
			},
			options,
		);
		expect(result.outcome).toBe("security_check");
		expect(blocks).toEqual(["security_check"]);
		expect(kept).toEqual([]);
		await expect(
			runLinkedIn(
				{ store, browser, alert: async () => {}, sleep: async () => {} },
				options,
			),
		).rejects.toBeInstanceOf(LinkedInRunBlockedError);
	});
});
