import path from "node:path";
import {
	app,
	BrowserWindow,
	nativeTheme,
	screen,
	session,
	shell,
} from "electron";
import { type AppCommand, IPC } from "../shared/bridge";
import { windowTitle } from "./demo-actions";
import { APP_ORIGIN, serveRenderer } from "./protocol";
import {
	BACKGROUND,
	focused,
	log,
	MEASURE_LAYOUT,
	MEASURE_VIBRANCY,
	mainState,
	outDir,
	rendererRoot,
	TEST_MODE,
	visible,
} from "./state";

export function connectRenderer(win: BrowserWindow) {
	const port = mainState.worker.connectPort();
	win.webContents.postMessage(IPC.rpcPort, null, [port]);
}

/**
 * The window's session: the app:// protocol with its CSP, every permission refused, every
 * request outside the app cancelled. Set up with the first window, not at start: touching the
 * default session makes Chromium start a renderer process even with no window open.
 */
let sessionReady = false;

function ensureSession() {
	if (sessionReady) return;
	sessionReady = true;
	// No remote content and no permissions: every permission request is refused.
	session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) =>
		cb(false),
	);
	session.defaultSession.setPermissionCheckHandler(() => false);
	session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
		const allowed =
			details.url.startsWith(`${APP_ORIGIN}/`) ||
			details.url.startsWith("devtools://") ||
			details.url.startsWith("data:") ||
			details.url.startsWith("blob:");
		callback({ cancel: !allowed });
	});
	serveRenderer(rendererRoot);
}

/**
 * The sidebar's material: macOS vibrancy behind a see-through sidebar, or the opaque sidebar
 * colour. Decided by the idle-memory A/B (docs/design/desktop/README.md, "Vibrancy A/B").
 */
const SIDEBAR_VIBRANCY = true;

/** The window's colour before and under the page: the content surface of each theme. */
export const windowBackground = () =>
	SIDEBAR_VIBRANCY
		? "#00000000"
		: nativeTheme.shouldUseDarkColors
			? "#000000"
			: "#fcfcfc";

export function createWindow(initialPath = "/"): BrowserWindow {
	ensureSession();
	// The design's window (1440 × 900), smaller on a smaller screen. Background test runs always
	// get the design's size: a CI runner's small display would narrow the layout (panels that
	// dock on a wide window float over it), and the tests would then depend on the machine.
	const area = screen.getPrimaryDisplay().workAreaSize;
	const win = new BrowserWindow({
		width: BACKGROUND ? 1440 : Math.max(960, Math.min(1440, area.width - 64)),
		height: BACKGROUND ? 900 : Math.max(600, Math.min(900, area.height - 48)),
		enableLargerThanScreen: BACKGROUND,
		minWidth: 960,
		minHeight: 600,
		show: false,
		// Tests never show the window; it still paints so they can drive and capture it.
		paintWhenInitiallyHidden: true,
		title: windowTitle(),
		// Painted before the page loads, so dark mode starts dark (no white flash).
		backgroundColor: windowBackground(),
		// No title bar: the traffic lights sit in the sidebar, centred in the 52 pt toolbar.
		titleBarStyle: "hidden",
		trafficLightPosition: { x: 20, y: 19 },
		...(SIDEBAR_VIBRANCY && !MEASURE_LAYOUT
			? {
					vibrancy: "sidebar" as const,
					visualEffectState: "followWindow" as const,
				}
			: {}),
		...(MEASURE_VIBRANCY
			? {
					vibrancy: "sidebar" as const,
					visualEffectState: "followWindow" as const,
					backgroundColor: "#00000000",
				}
			: {}),
		webPreferences: {
			// Tests keep the window off screen; it still runs at full speed.
			backgroundThrottling: !BACKGROUND,
			preload: path.join(outDir, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			// No DevTools in a packaged build (security audit, 2026-11-03); development keeps them.
			devTools: !app.isPackaged,
			spellcheck: false,
			v8CacheOptions: "bypassHeatCheck",
			additionalArguments:
				SIDEBAR_VIBRANCY && !MEASURE_LAYOUT ? ["--offerfinch-vibrant"] : [],
		},
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (!url.startsWith(`${APP_ORIGIN}/`)) {
			event.preventDefault();
			if (/^https?:\/\//.test(url)) void shell.openExternal(url);
		}
	});
	if (MEASURE_LAYOUT)
		win.webContents.on("dom-ready", () => {
			void win.webContents.insertCSS(
				`html,body{background:${MEASURE_VIBRANCY ? "transparent" : "#fafafa"}!important}#root{margin-left:220px;background:var(--background)}`,
			);
		});
	// The page runs motion (the first run's ambient field) only while this is true.
	const active = () =>
		win.webContents.send(
			IPC.windowActive,
			focused(win) && visible(win) && !win.isMinimized(),
		);
	for (const event of [
		"focus",
		"blur",
		"show",
		"hide",
		"minimize",
		"restore",
	] as const)
		win.on(event as "focus", active);
	// The page's <title> would replace it: the title says when sample data is shown.
	win.on("page-title-updated", (event) => {
		event.preventDefault();
		win.setTitle(windowTitle());
	});
	win.once("ready-to-show", () => {
		if (!BACKGROUND) win.show();
		log("window shown", { ms: Date.now() - mainState.startedAt });
	});
	win.on("close", () => {
		// A site sheet lets go of its view first: a run's tab must outlive the window.
		mainState.sites?.detachAll(win);
		// Closing the window keeps the app (and scans) running in the menu bar. The window and
		// its renderer are destroyed, so a closed app holds only main and the worker in memory.
		if (!mainState.quitting && process.platform === "darwin") app.dock?.hide();
	});
	win.on("closed", () => {
		if (mainState.mainWindow === win) mainState.mainWindow = null;
	});
	void win.loadURL(`${APP_ORIGIN}${initialPath}`);
	return win;
}

export function showWindow(pathname?: string) {
	if (process.platform === "darwin" && !BACKGROUND) void app.dock?.show();
	if (!mainState.mainWindow || mainState.mainWindow.isDestroyed()) {
		mainState.mainWindow = createWindow(pathname ?? "/");
		return;
	}
	if (pathname) mainState.mainWindow.webContents.send(IPC.navigate, pathname);
	if (BACKGROUND) return;
	mainState.mainWindow.show();
	mainState.mainWindow.focus();
}

/**
 * Shows the window and then sends it a command: a window opened just now gets it once its page
 * has loaded (Help › Export Diagnostics with the window closed).
 */
export function showWindowWith(command: AppCommand) {
	const existed = Boolean(
		mainState.mainWindow && !mainState.mainWindow.isDestroyed(),
	);
	showWindow();
	const win = mainState.mainWindow;
	if (!win) return;
	if (existed && !win.webContents.isLoading()) sendCommand(command);
	else win.webContents.once("did-finish-load", () => sendCommand(command));
}

/** Sends a menu command to the window (the renderer acts on the ones it knows). */
export function sendCommand(command: AppCommand) {
	if (!mainState.mainWindow || mainState.mainWindow.isDestroyed()) return;
	mainState.mainWindow.webContents.send(IPC.command, command);
}

/** The window is in front: a notice about what it already shows is not needed. */
export function windowInFront(): boolean {
	if (TEST_MODE && process.env.OFFERFINCH_TEST_UNFOCUSED === "1") return false;
	const win = mainState.mainWindow;
	return Boolean(
		win &&
			!win.isDestroyed() &&
			focused(win) &&
			visible(win) &&
			!win.isMinimized(),
	);
}
