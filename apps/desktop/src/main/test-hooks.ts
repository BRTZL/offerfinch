import type { SiteTabId } from "../shared/bridge";
import type { NativeNotice } from "../shared/worker-protocol";
import { noticeActionDeps } from "./notice-action-deps";
import { runNoticeAction } from "./notice-actions";
import { mainState } from "./state";
import { showWindow } from "./window";

/* ---------------------------------------------------------- notifications */

/** Test runs: every notice shown, and the worker's pid, for the e2e to read and kill. */
export const testHooks = {
	trayShown: false,
	notices: [] as NativeNotice[],
	/** Files the app saved where a real run would ask the user (an interview's .ics). */
	savedFiles: [] as string[],
	updateNotices: [] as { title: string; body: string; path: string }[],
	workerPid: () => mainState.worker?.pid,
	/**
	 * Presses button `index` of the `n`th notice shown, as Notification Center would (test runs
	 * show none): the same routing a real button's `action` event runs.
	 */
	noticeAction: (n: number, index: number) => {
		const notice = testHooks.notices[n];
		if (!notice) return Promise.resolve(false);
		return runNoticeAction(notice, index, noticeActionDeps).then(() => true);
	},
	open: (p: string) => showWindow(p),
	/** The site tabs: which exist, which run, which sheet shows them and where. */
	siteTabs: () => mainState.sites.describe(),
	/**
	 * Test runs only: acts on a local stand-in page as the user would (its fake check's button).
	 * Never reachable from the worker or the renderer.
	 */
	siteStandInClick: async (site: SiteTabId, selector: string) => {
		const wc = mainState.sites.contents(site);
		if (!wc) return false;
		return wc.executeJavaScript(
			`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
		);
	},
	/** A PNG of the site's tab (page screenshots cannot see a native view), as base64. */
	siteCapture: async (site: SiteTabId) => {
		const wc = mainState.sites.contents(site);
		if (!wc) return null;
		const image = await wc.capturePage();
		return image.isEmpty() ? null : image.toPNG().toString("base64");
	},
	/** Background tests: act as if the window were hidden or shown, without putting it on screen. */
	setShown: (shown: boolean) => {
		mainState.testShown = shown;
		mainState.mainWindow?.emit("show");
	},
};

/**
 * Test runs only: the local stand-ins the site tabs load instead of the real sites
 * (OFFERFINCH_LINKEDIN_ORIGIN, and OFFERFINCH_SITE_ORIGINS, a JSON map of site to origin).
 */
export function testSiteOrigins(): Partial<Record<SiteTabId, string>> {
	const out: Partial<Record<SiteTabId, string>> = {};
	try {
		Object.assign(out, JSON.parse(process.env.OFFERFINCH_SITE_ORIGINS ?? "{}"));
	} catch {}
	if (process.env.OFFERFINCH_LINKEDIN_ORIGIN)
		out.linkedin = process.env.OFFERFINCH_LINKEDIN_ORIGIN;
	return out;
}
