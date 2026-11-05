import { app, BrowserWindow } from "electron";
import type { DemoResult, DemoStatus } from "../shared/bridge";
import { enterDemo, leaveDemo } from "./demo";
import { DEMO_SWITCHING, lifecycle } from "./lifecycle";
import { APP_ORIGIN } from "./protocol";
import { log, mainState } from "./state";

/**
 * Whether the app shows itself as the demo: while it runs, and while a leave is unfinished (so
 * the strip, the title and the menu bar keep offering Leave).
 */
export const showsDemo = () => mainState.demo || mainState.leaveFailed !== null;

/** What the renderer is told (the strip along the bottom). */
export const demoStatus = (): DemoStatus => ({
	demo: showsDemo(),
	leaveFailed: mainState.leaveFailed,
});

/** The window's title: says so while the sample data is shown (Mission Control, ⌘`). */
export const windowTitle = () =>
	showsDemo() ? "OfferFinch (sample data)" : "OfferFinch";

/** Said wherever the app does not do something with sample data. */
export const DEMO_REFUSAL =
	"Not with sample data: leave demo first. Nothing real is used in try-it mode.";

function reloadWindows() {
	for (const win of BrowserWindow.getAllWindows()) {
		win.setTitle(windowTitle());
		void win.webContents.loadURL(`${APP_ORIGIN}/`);
	}
}

/**
 * Enters or leaves try-it mode (main/demo.ts): the worker restarts on the other database, update
 * checks are suspended while the demo runs (no network; a running check or download is cancelled
 * first), and every window reloads at Home, so no screen keeps data from the other side.
 *
 * Holds the app's one lock (main/lifecycle.ts): refused while a backup, a restore, a key save or
 * another switch runs, and none of those starts while it runs. A leave that did not finish is
 * tried again by leaving again.
 */
export async function switchDemo(on: boolean): Promise<DemoResult> {
	const hold = lifecycle.take(DEMO_SWITCHING);
	if ("busy" in hold) return { ok: false, error: hold.busy };
	const shown = showsDemo();
	try {
		if (on === mainState.demo && mainState.leaveFailed === null)
			return { ok: true };
		const sw = {
			userData: app.getPath("userData"),
			// Its exit lets go of the site tabs its runs held (site-wiring.ts).
			stopWorker: () => mainState.worker.stop(),
			startWorker: () => mainState.worker.restart(),
			log,
		};
		mainState.lastStatus = null;
		if (on) {
			await mainState.updates.suspend();
			await enterDemo(mainState, sw);
		} else {
			await leaveDemo(mainState, sw);
			mainState.updates.resume();
		}
		reloadWindows();
		return { ok: true };
	} catch (error) {
		log("demo switch failed", String(error));
		if (!mainState.demo && mainState.leaveFailed === null)
			mainState.updates.resume();
		// The windows show the side the app is on now: the strip carries a failed leave's error
		// and its retry. Otherwise they stay (and show the error themselves).
		if (mainState.leaveFailed !== null || showsDemo() !== shown)
			reloadWindows();
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		hold.release();
	}
}
