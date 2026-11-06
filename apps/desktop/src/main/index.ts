import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	nativeTheme,
	powerMonitor,
} from "electron";
import { IPC } from "../shared/bridge";
import type { WorkerInit } from "../shared/worker-protocol";
import { createUpdates } from "./app-updates";
import { isAutomated } from "./automation";
import { recoverInterruptedRestore } from "./backup";
import { moveDatabaseOnce } from "./database-file";
import { demoFolder, eraseLeftoverDemo } from "./demo";
import { openSignInPage } from "./external-links";
import { registerIpc } from "./ipc";
import { buildMenu } from "./menu";
import { noticeActionDeps } from "./notice-action-deps";
import { runNoticeAction } from "./notice-actions";
import { showNotice } from "./notices";
import { CHIRP_SOUND, chirpPlayer, Notifier } from "./notifications";
import { forgetOldKeys } from "./old-keys";
import { registerAppScheme } from "./protocol";
import { shutdownForQuit } from "./quit-shutdown";
import { SiteBrowser } from "./site-browser";
import { connectSiteTabs } from "./site-wiring";
import { BACKGROUND, log, mainState, outDir, TEST_MODE } from "./state";
import { testHooks, testSiteOrigins } from "./test-hooks";
import { createTray, updateTray } from "./tray";
import { createWindow, showWindow, windowBackground } from "./window";
import { WorkerHost } from "./worker-host";

/* ------------------------------------------------------------------ setup */

if (process.platform === "win32")
	app.setAppUserModelId("app.offerfinch.desktop");

// Tests and screenshots run against their own folder (logs included), never the user's data.
if (process.env.OFFERFINCH_USER_DATA) {
	app.setPath("userData", path.resolve(process.env.OFFERFINCH_USER_DATA));
	app.setAppLogsPath(path.join(app.getPath("userData"), "logs"));
}

if (TEST_MODE) app.commandLine.appendSwitch("use-mock-keychain");

// Driven by a test tool without its own data folder: refuse, before touching the real folder or
// signalling a running copy (its single-instance lock would bring that window forward).
const automated = isAutomated(process.argv, process.env.NODE_OPTIONS);

if (automated && !process.env.OFFERFINCH_USER_DATA) {
	process.stderr.write(
		"OfferFinch under automation needs OFFERFINCH_USER_DATA (a test data folder).\n",
	);
	process.exit(4);
}

// One theme source for the window and the page: macOS's appearance as Electron resolves it
// (nativeTheme), which also decides the vibrancy material. The page asks before it paints and
// hears every change; it never decides light or dark by itself.
ipcMain.on(IPC.themeGet, (event) => {
	event.returnValue = nativeTheme.shouldUseDarkColors;
});

registerAppScheme();

if (!app.requestSingleInstanceLock()) {
	// Another copy runs (and owns the database and the job queue): it shows its window.
	app.quit();
	process.exit(0);
}
mainState.startedAt = Date.now();

if (TEST_MODE)
	(globalThis as Record<string, unknown>).__offerfinchTest = testHooks;

/* ------------------------------------------------------------- lifecycle */

async function workerInit(): Promise<WorkerInit> {
	// Try-it mode: the worker gets the demo folder and no keys; the real data stays shut.
	const demo = mainState.demo;
	const userData = demo
		? demoFolder(app.getPath("userData"))
		: app.getPath("userData");
	const test = TEST_MODE
		? {
				fakeModels: process.env.OFFERFINCH_FAKE_MODELS === "1",
				boardBases: process.env.OFFERFINCH_BOARD_BASES
					? JSON.parse(process.env.OFFERFINCH_BOARD_BASES)
					: undefined,
				noSchedule: process.env.OFFERFINCH_NO_SCHEDULE === "1",
				fakeDelayMs: Number(process.env.OFFERFINCH_FAKE_DELAY_MS) || undefined,
				linkedinOrigin: process.env.OFFERFINCH_LINKEDIN_ORIGIN || undefined,
				fakeCodex: process.env.OFFERFINCH_FAKE_CODEX === "1",
				fetchRewrite: process.env.OFFERFINCH_FETCH_REWRITE
					? JSON.parse(process.env.OFFERFINCH_FETCH_REWRITE)
					: undefined,
				checkTimeoutMs:
					Number(process.env.OFFERFINCH_CHECK_TIMEOUT_MS) || undefined,
				stallProbe: process.env.OFFERFINCH_TEST_STALL === "1",
				// The CLI stand-in (worker/fake-clis.ts) reads a file in the data folder: never in a
				// shipped build, even one launched in test mode (the release launch check).
				fakeClis: !app.isPackaged,
			}
		: undefined;
	return {
		type: "init",
		userData,
		dbFile: mainState.databaseFile,
		version: app.getVersion(),
		claudeHost: path
			.join(outDir, "worker", "claude-host.mjs")
			.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
		...(demo ? { demo: true } : {}),
		test,
	};
}

async function main() {
	await app.whenReady();
	if (BACKGROUND && process.platform === "darwin")
		app.setActivationPolicy("accessory");
	app.setAboutPanelOptions({
		applicationName: "OfferFinch",
		applicationVersion: app.getVersion(),
		version: `Electron ${process.versions.electron}`,
		credits:
			"A small bird that brings back offers: it finds jobs that fit, prepares each application and waits for your approval.",
		copyright: "Runs on this computer. Nothing is sent without your approval.",
	});
	fs.mkdirSync(app.getPath("logs"), { recursive: true });
	// A restore the app quit in the middle of is undone first, so the earlier data is in place.
	recoverInterruptedRestore(app.getPath("userData"), log);
	// Sample data a quit in try-it mode left behind: the demo ends with the app. A folder that
	// cannot be deleted is logged; the app starts on the real data all the same.
	eraseLeftoverDemo(app.getPath("userData"), log);
	// Before the worker opens it: the database's file is settled first.
	mainState.databaseFile = await moveDatabaseOnce(app.getPath("userData"), {
		open: (file, readonly) => new Database(file, { readonly }),
		log,
	});
	// The API keys of earlier versions: every model runs on the user's own sign-in now.
	try {
		if (forgetOldKeys(app.getPath("userData"))) log("old API keys removed");
	} catch (error) {
		log("old API keys not removed", { error: String(error) });
	}
	mainState.notifier = new Notifier(
		app.getPath("userData"),
		(p) => showWindow(p),
		log,
		TEST_MODE && process.env.OFFERFINCH_NOTIFY_PROBE !== "1",
		chirpPlayer(
			app.isPackaged
				? path.join(process.resourcesPath, CHIRP_SOUND)
				: path.join(app.getAppPath(), "build", CHIRP_SOUND),
			log,
		),
	);
	mainState.notifier.onAction = (notice, index) =>
		void runNoticeAction(notice, index, noticeActionDeps);

	mainState.sites = new SiteBrowser({
		testOrigins: TEST_MODE ? testSiteOrigins() : undefined,
		// Test runs reach no real site, unless made against the real sites on purpose.
		blockReal: TEST_MODE && process.env.OFFERFINCH_REAL_SITES !== "1",
		quiet: BACKGROUND,
		log,
	});
	mainState.worker = new WorkerHost(
		// Packaged: the worker bundle is unpacked next to the asar (see electron-builder.yml).
		path
			.join(outDir, "worker", "index.mjs")
			.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
		workerInit,
		() => {
			for (const win of BrowserWindow.getAllWindows())
				win.webContents.send(IPC.workerRestart);
		},
	);
	mainState.worker.onOutput = (text) => log(`worker output: ${text.trimEnd()}`);
	connectSiteTabs(mainState.worker, mainState.sites);
	mainState.worker.on((message) => {
		if (message.type === "ready")
			log("worker ready (since main started)", {
				ms: Date.now() - mainState.startedAt,
			});
		if (message.type === "status") {
			mainState.lastStatus = message.status;
			updateTray();
		} else if (message.type === "notify") void showNotice(message.notice);
		else if (message.type === "openSignIn") void openSignInPage(message.url);
		else if (message.type === "log")
			log(`worker ${message.level}: ${message.message}`, message.data);
		else if (message.type === "fatal") {
			log("worker fatal", message.error);
			mainState.lastStatus = {
				state: "error",
				error: message.error,
				lastScanAt: null,
				lastScanSummary: null,
				counts: { review: 0, questions: 0, applied: 0, new: 0 },
				paused: false,
			};
			updateTray();
		}
	});
	mainState.worker.start();
	mainState.updates = await createUpdates();
	registerIpc();
	buildMenu();
	if (!BACKGROUND) createTray();
	testHooks.trayShown = mainState.tray !== null;
	mainState.updates.start();
	// Test runs only: one real notification at start, its outcome in the log (for checking
	// delivery when started by LaunchServices, where no test tool can attach).
	if (TEST_MODE && process.env.OFFERFINCH_NOTIFY_PROBE === "1")
		void mainState.notifier
			.show({
				title: "OfferFinch test build",
				body: "Checking notification delivery.",
				path: "/settings/notifications",
			})
			.then((outcome) =>
				log("notification probe", { outcome, ...mainState.notifier.get() }),
			);
	nativeTheme.on("updated", () => {
		const dark = nativeTheme.shouldUseDarkColors;
		for (const win of BrowserWindow.getAllWindows()) {
			win.setBackgroundColor(windowBackground());
			// The page follows the same appearance the window's vibrancy material does.
			win.webContents.send(IPC.themeChanged, dark);
		}
	});

	// Catch up after sleep: the worker starts this hour's scan if it has not run. Updates are
	// checked again too, after a pause: right after waking the network is often not back yet.
	const checkUpdatesSoon = () => {
		setTimeout(() => mainState.updates?.checkIfStale(), 45_000).unref?.();
	};
	powerMonitor.on("resume", () => {
		mainState.worker.post({ type: "wake", reason: "resume" });
		checkUpdatesSoon();
	});
	powerMonitor.on("unlock-screen", () => {
		mainState.worker.post({ type: "wake", reason: "unlock" });
		checkUpdatesSoon();
	});
	// Coming back to the window hears of a new release without waiting for the timer.
	app.on("browser-window-focus", () => mainState.updates?.checkIfStale());

	const openedAtLogin =
		(process.platform === "darwin" &&
			app.getLoginItemSettings().wasOpenedAtLogin) ||
		process.argv.includes("--hidden");
	if ((openedAtLogin && !TEST_MODE) || process.argv.includes("--hidden")) {
		if (process.platform === "darwin") app.dock?.hide();
	} else mainState.mainWindow = createWindow();

	app.on("second-instance", () => showWindow());
	app.on("activate", () => showWindow());
	app.on("before-quit", () => {
		mainState.quitting = true;
	});
	app.on("will-quit", (event) => {
		const stopping = shutdownForQuit();
		if (mainState.worker.pid === undefined) return;
		event.preventDefault();
		void stopping
			.catch((error) => log("worker did not stop at quit", String(error)))
			.finally(() => app.exit(0));
	});
	app.on("window-all-closed", () => {
		// Stay in the menu bar.
	});
}

main().catch((error) => {
	log("startup failed", String(error?.stack ?? error));
	dialog.showErrorBox(
		"OfferFinch could not start",
		String(error?.message ?? error),
	);
	app.exit(1);
});
