import { app, BrowserWindow } from "electron";
import type { DemoResult } from "../shared/bridge";
import { enterDemo, leaveDemo } from "./demo";
import { APP_ORIGIN } from "./protocol";
import { log, mainState } from "./state";

/** One switch at a time: a second click while the worker restarts is refused. */
let busy = false;

/** The window's title: says so while the sample data is shown (Mission Control, ⌘`). */
export const windowTitle = () =>
	mainState.demo ? "OfferFinch (sample data)" : "OfferFinch";

/** Said wherever the app does not do something with sample data. */
export const DEMO_REFUSAL =
	"Not with sample data: leave demo first. Nothing real is used in try-it mode.";

/**
 * Enters or leaves try-it mode (main/demo.ts): the worker restarts on the other database, update
 * checks pause while the demo runs (no network), and every window reloads at Home, so no screen
 * keeps data from the other side.
 */
export async function switchDemo(on: boolean): Promise<DemoResult> {
	if (busy) return { ok: false, error: "Already switching. Try again." };
	if (on === mainState.demo) return { ok: true };
	busy = true;
	try {
		const sw = {
			userData: app.getPath("userData"),
			// Its exit lets go of the site tabs its runs held (site-wiring.ts).
			stopWorker: () => mainState.worker.stop(),
			startWorker: () => mainState.worker.restart(),
			log,
		};
		mainState.lastStatus = null;
		if (on) {
			mainState.updates.stop();
			await enterDemo(mainState, sw);
		} else {
			await leaveDemo(mainState, sw);
			mainState.updates.start();
		}
		for (const win of BrowserWindow.getAllWindows()) {
			win.setTitle(windowTitle());
			void win.webContents.loadURL(`${APP_ORIGIN}/`);
		}
		return { ok: true };
	} catch (error) {
		log("demo switch failed", String(error));
		if (!mainState.demo) mainState.updates.start();
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		busy = false;
	}
}
