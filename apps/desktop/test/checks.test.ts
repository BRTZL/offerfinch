import { detectSiteStop } from "@offerfinch/core/sites/read";
import { SITES } from "@offerfinch/core/sites/sites";
import { describe, expect, it } from "vitest";

import {
	openTabReader,
	siteActivity,
	waitOutCheck,
} from "../src/worker/checks";
import type { PageDriver, ReadPage } from "../src/worker/site-tab";

const ORIGIN = "https://www.indeed.com";
const detect = (page: ReadPage) =>
	detectSiteStop(page, SITES.indeed, "www.indeed.com");
const CHECK: ReadPage = {
	url: `${ORIGIN}/jobs?q=x`,
	status: 200,
	html: "<html><body><h1>Verify you're human</h1></body></html>",
};
const RESULTS: ReadPage = {
	url: `${ORIGIN}/jobs?q=x`,
	status: 200,
	html: '<html><body><div id="mosaic-provider-jobcards"></div></body></html>',
};

/** A clock that moves only when the code sleeps. */
function clock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

/** A tab whose page is whatever `pages` says, read by read. */
function fakeDriver(pages: ReadPage[]) {
	const calls: string[] = [];
	let i = 0;
	const current = () => pages[Math.min(i, pages.length - 1)] as ReadPage;
	const driver: PageDriver = {
		navigate: async (url) => {
			calls.push(`navigate ${url}`);
			return { url, status: 200 };
		},
		waitFor: async () => true,
		snapshot: async () => {
			const page = current();
			i++;
			return { ...page, title: "" };
		},
		release: async () => {
			calls.push("release");
		},
	};
	return { driver, calls };
}

describe("waiting out a check (PLAN rule 4: the user solves it)", () => {
	it("returns a normal page at once", async () => {
		let peeks = 0;
		const page = await waitOutCheck(RESULTS, RESULTS.url, {
			detect,
			peek: async () => {
				peeks++;
				return RESULTS;
			},
			settle: async () => RESULTS,
			reopen: async () => RESULTS,
			onWait: () => {
				throw new Error("must not wait");
			},
			onDone: () => {},
		});
		expect(page).toBe(RESULTS);
		expect(peeks).toBe(0);
	});

	it("never waits on a stop a person cannot clear (a refusal stops at once)", async () => {
		const refused = { ...RESULTS, status: 429 };
		const waited: string[] = [];
		const page = await waitOutCheck(refused, refused.url, {
			detect,
			peek: async () => refused,
			settle: async () => refused,
			reopen: async () => refused,
			onWait: (s) => {
				waited.push(s.kind);
			},
			onDone: () => {},
		});
		expect(page).toBe(refused);
		expect(waited).toEqual([]);
	});

	it("waits while the check shows, then continues with the cleared page", async () => {
		const c = clock();
		const seen = [CHECK, CHECK, RESULTS];
		const events: string[] = [];
		const page = await waitOutCheck(CHECK, CHECK.url, {
			detect,
			peek: async () => seen.shift() ?? RESULTS,
			settle: async () => RESULTS,
			reopen: async () => {
				throw new Error("same page: no reload");
			},
			onWait: (s) => {
				events.push(`wait ${s.kind}`);
			},
			onDone: (_s, outcome) => {
				events.push(outcome);
			},
			pollMs: 1_000,
			...c,
		});
		expect(page).toBe(RESULTS);
		expect(events).toEqual(["wait security_check", "cleared"]);
		expect(c.now()).toBe(3_000);
	});

	it("opens the page asked for once more when the solve left the tab elsewhere", async () => {
		const c = clock();
		let reopened = 0;
		const home = { ...RESULTS, url: `${ORIGIN}/` };
		const page = await waitOutCheck(CHECK, CHECK.url, {
			detect,
			peek: async () => home,
			settle: async () => home,
			reopen: async () => {
				reopened++;
				return RESULTS;
			},
			onWait: () => {},
			onDone: () => {},
			...c,
		});
		expect(page).toBe(RESULTS);
		expect(reopened).toBe(1);
	});

	it("hands back the check page after the time runs out, for the reader to stop on", async () => {
		const c = clock();
		const events: string[] = [];
		const page = await waitOutCheck(CHECK, CHECK.url, {
			detect,
			peek: async () => CHECK,
			settle: async () => CHECK,
			reopen: async () => CHECK,
			onWait: () => {},
			onDone: (_s, outcome) => {
				events.push(outcome);
			},
			timeoutMs: 10 * 60_000,
			pollMs: 2_000,
			...c,
		});
		expect(detect(page)?.kind).toBe("security_check");
		expect(events).toEqual(["timeout"]);
		expect(c.now()).toBeGreaterThanOrEqual(10 * 60_000);
	});

	it("keeps looking when a read fails mid-navigation", async () => {
		const c = clock();
		let n = 0;
		const page = await waitOutCheck(CHECK, CHECK.url, {
			detect,
			peek: async () => {
				n++;
				if (n === 1) throw new Error("navigating");
				return RESULTS;
			},
			settle: async () => RESULTS,
			reopen: async () => RESULTS,
			onWait: () => {},
			onDone: () => {},
			...c,
		});
		expect(page).toBe(RESULTS);
	});
});

describe("a tab reader", () => {
	it("pauses on a check, reports it, resumes, and releases the tab", async () => {
		const { driver, calls } = fakeDriver([CHECK, CHECK, RESULTS]);
		const checks: string[] = [];
		const reader = await openTabReader(
			{
				site: async () => {
					throw new Error("the fake driver is used");
				},
				checkPollMs: 1,
				onCheck: (site, stop) => {
					checks.push(`${site} ${stop.kind}`);
					expect(siteActivity("indeed").check?.kind).toBe("security_check");
				},
				onCheckDone: (site, _stop, outcome) => {
					checks.push(`${site} ${outcome}`);
				},
			},
			{
				site: "indeed",
				ready: "#mosaic-provider-jobcards",
				detect,
				waitForUser: true,
				driver,
				sleep: async () => {},
			},
		);
		expect(siteActivity("indeed").running).toBe(true);
		const page = await reader.open(CHECK.url);
		expect(detect(page)).toBeNull();
		expect(checks).toEqual(["indeed security_check", "indeed cleared"]);
		expect(siteActivity("indeed")).toMatchObject({
			running: true,
			check: null,
			lastCheck: { outcome: "cleared" },
		});
		await reader.close();
		expect(siteActivity("indeed").running).toBe(false);
		// One navigation for the one page asked for: waiting never reloads.
		expect(calls).toEqual([`navigate ${CHECK.url}`, "release"]);
	});

	it("without waitForUser (a link the user added) returns the check page at once", async () => {
		const { driver } = fakeDriver([CHECK]);
		const reader = await openTabReader(
			{
				site: async () => null,
				onCheck: () => {
					throw new Error("must not wait");
				},
				onCheckDone: () => {},
			},
			{
				site: "glassdoor",
				ready: "body",
				detect,
				waitForUser: false,
				driver,
			},
		);
		const page = await reader.open(CHECK.url);
		expect(detect(page)?.kind).toBe("security_check");
		await reader.close();
	});
});

describe("one budget for waiting on the user, per run", () => {
	it("splits the budget across checks; spent, a check is not waited on", async () => {
		let t = 0;
		const now = () => t;
		const sleep = async (ms: number) => {
			t += ms;
		};
		// Every page is a check that is never solved.
		const { driver } = fakeDriver([CHECK]);
		const waits: string[] = [];
		const reader = await openTabReader(
			{
				site: async () => null,
				checkTimeoutMs: 10 * 60_000,
				checkBudgetMs: 15 * 60_000,
				checkPollMs: 1_000,
				onCheck: () => {
					waits.push("wait");
				},
				onCheckDone: (_site, _stop, outcome) => {
					waits.push(outcome);
				},
			},
			{
				site: "indeed",
				ready: "body",
				detect,
				waitForUser: true,
				driver,
				sleep,
				now,
			},
		);
		// First check: the full 10 minutes. Second: only the 5 left. Third: none.
		await reader.open(CHECK.url);
		expect(t).toBe(10 * 60_000);
		await reader.open(CHECK.url);
		expect(t).toBe(15 * 60_000);
		const third = await reader.open(CHECK.url);
		expect(t).toBe(15 * 60_000);
		expect(detect(third)?.kind).toBe("security_check");
		expect(waits).toEqual(["wait", "timeout", "wait", "timeout"]);
		await reader.close();
	});
});

describe("a stopped run (its scan step ran out of time)", () => {
	it("stops waiting at once, clears Needs you, and the tab is released by close", async () => {
		const { driver, calls } = fakeDriver([CHECK]);
		const stop = new AbortController();
		const reader = await openTabReader(
			{
				site: async () => null,
				checkPollMs: 5,
				onCheck: () => {
					// The step gives up while the user has not solved the check.
					setTimeout(() => stop.abort(new Error("step timed out")), 20);
				},
				onCheckDone: () => {
					throw new Error("an abort is not a timeout or a clear");
				},
			},
			{
				site: "linkedin",
				ready: "body",
				detect,
				waitForUser: true,
				driver,
				signal: stop.signal,
			},
		);
		await expect(reader.open(CHECK.url)).rejects.toThrow("step timed out");
		expect(siteActivity("linkedin").check).toBeNull();
		await expect(reader.open(CHECK.url)).rejects.toThrow("step timed out");
		await reader.close();
		expect(calls.at(-1)).toBe("release");
		expect(siteActivity("linkedin").running).toBe(false);
	});
});
