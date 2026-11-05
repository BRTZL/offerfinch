import { app, BrowserWindow } from "electron";
import { type DemoResult, type DemoStatus, IPC } from "../shared/bridge";
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
 * checks are suspended while the demo runs (no network; a running check or download must end
 * first, or entering is refused), every site tab closes and none opens until the real worker
 * runs again, and every window reloads at Home, so no screen keeps data from the other side.
 *
 * Holds the app's one lock (main/lifecycle.ts): refused while a backup, a restore, a key save or
 * another switch runs, and none of those starts while it runs. A leave that did not finish is
 * tried again by leaving again.
 */
export async function switchDemo(on: boolean): Promise<DemoResult> {
	const hold = lifecycle.take(DEMO_SWITCHING);
	if ("busy" in hold) return { ok: false, error: hold.busy };
	const shown = showsDemo();
	/** Whether the worker was stopped (and so restarted, or tried to be). */
	let stopped = false;
	try {
		if (on === mainState.demo && mainState.leaveFailed === null)
			return { ok: true };
		// No site tab opens while the worker switches, nor while the demo runs (no real source
		// runs there). The ones open close once the worker has stopped: a run's, a sheet's, and a
		// sign-in tab kept after its sheet closed, which still holds the real session.
		mainState.sites.block(DEMO_SWITCHING);
		const sw = {
			userData: app.getPath("userData"),
			stopWorker: async () => {
				stopped = true;
				await mainState.worker.stop();
				mainState.sites.closeAll();
			},
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
		// Back on the same side with a new worker (an entry rolled back): the windows keep their
		// page and its error, and take a port to the new worker, as after a crash's restart.
		else if (stopped)
			for (const win of BrowserWindow.getAllWindows())
				win.webContents.send(IPC.workerRestart);
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		mainState.sites.block(showsDemo() ? DEMO_REFUSAL : null);
		hold.release();
	}
}
