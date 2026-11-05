import fs from "node:fs";
import path from "node:path";
import { app, type BrowserWindow, type Tray } from "electron";
import type { TrayStatus } from "../shared/worker-protocol";
import type { Notifier } from "./notifications";
import type { SiteBrowser } from "./site-browser";
import type { Updates } from "./updates";
import type { WorkerHost } from "./worker-host";

export const mainState = {
	mainWindow: null as BrowserWindow | null,
	tray: null as Tray | null,
	quitting: false,
	lastStatus: null as TrayStatus | null,
	worker: undefined as unknown as WorkerHost,
	sites: undefined as unknown as SiteBrowser,
	notifier: undefined as unknown as Notifier,
	updates: undefined as unknown as Updates,
	databaseFile: "",
	/** Try-it mode (main/demo.ts): the worker runs on the demo folder's database. */
	demo: false,
	/** The real database while demo mode runs, restored exactly on leaving. */
	realDatabaseFile: null as string | null,
	/** Leaving demo mode did not finish (main/demo.ts): why; Leave tries again. */
	leaveFailed: null as string | null,
	testShown: true,
	startedAt: 0,
};

export const TEST_MODE = process.env.OFFERFINCH_TEST === "1";

/**
 * Tests run in the background: the window is never put on screen (it still renders, so tests
 * drive and capture it), the app never becomes the active app and has no Dock icon, so whoever
 * is using the Mac keeps working. The app acts as if its window were in front and visible
 * (motion runs, "only if unfocused" notices stay quiet).
 */
export const BACKGROUND =
	TEST_MODE && process.env.OFFERFINCH_TEST_BACKGROUND === "1";

export const focused = (win: BrowserWindow) => BACKGROUND || win.isFocused();

export const visible = (win: BrowserWindow) =>
	BACKGROUND ? mainState.testShown : win.isVisible();

// Measurement only (scripts/measure.mjs --env): a sidebar-wide column in both arms of the A/B,
// opaque, or see-through with Electron's sidebar vibrancy behind it.
export const MEASURE_LAYOUT =
	TEST_MODE && process.env.OFFERFINCH_MEASURE_LAYOUT === "1";

export const MEASURE_VIBRANCY =
	MEASURE_LAYOUT && process.env.OFFERFINCH_MEASURE_VIBRANCY === "1";

export const outDir = __dirname;

export const rendererRoot = path.join(outDir, "renderer");

export const assets = app.isPackaged
	? path.join(process.resourcesPath, "assets")
	: path.join(outDir, "..", "assets");

export function log(message: string, data?: unknown) {
	const line = `${new Date().toISOString()} ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`;
	try {
		fs.appendFileSync(path.join(app.getPath("logs"), "main.log"), line);
	} catch {}
	if (!app.isPackaged) process.stdout.write(line);
}
