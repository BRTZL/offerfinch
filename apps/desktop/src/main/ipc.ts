import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	nativeImage,
	shell,
} from "electron";
import {
	type AppInfo,
	IPC,
	isProofShot,
	isSiteTabId,
	type LoginItemState,
	NOTIFICATION_SOUNDS,
	type NotificationSound,
} from "../shared/bridge";
import {
	checkBackup,
	discardBackup,
	restoreBackup,
	saveBackup,
} from "./backup-actions";
import { DEMO_REFUSAL, demoStatus, switchDemo } from "./demo-actions";
import {
	discardDiagnostics,
	prepareDiagnostics,
	releaseNotes,
	saveDiagnostics,
} from "./diagnostics-export";
import { openExternalLink } from "./external-links";
import { saveInterviewEvent } from "./interview-event";
import { contextMenu } from "./menu";
import { NOTIFICATION_SETTINGS_URL } from "./notifications";
import { APP_ORIGIN } from "./protocol";
import { mainState, TEST_MODE } from "./state";
import { testHooks } from "./test-hooks";
import { connectRenderer } from "./window";

/* ---------------------------------------------------------------- windows */

function isAppSender(event: IpcMainInvokeEvent): boolean {
	const url = event.senderFrame?.url ?? "";
	return url.startsWith(`${APP_ORIGIN}/`);
}

function handle<A extends unknown[], R>(
	channel: string,
	fn: (...args: A) => R | Promise<R>,
) {
	ipcMain.handle(channel, async (event, ...args) => {
		if (!isAppSender(event)) throw new Error("Refused: not the app's window");
		return fn(...(args as A));
	});
}

/* ------------------------------------------------------------- login item */

function loginItemState(): LoginItemState {
	const settings = app.getLoginItemSettings(
		process.platform === "win32" ? { args: ["--hidden"] } : {},
	);
	const status = (settings as { status?: string }).status;
	return {
		openAtLogin: settings.openAtLogin,
		status:
			status === "enabled" ||
			status === "requires-approval" ||
			status === "not-registered" ||
			status === "not-found"
				? status
				: settings.openAtLogin
					? "enabled"
					: "unknown",
	};
}

/* --------------------------------------------------------------- the IPC */

/** Export Diagnostics' bundle (built and saved in main) and What's new's release notes. */
function registerDiagnosticsIpc() {
	handle(IPC.diagnosticsPrepare, () => prepareDiagnostics());
	handle(IPC.diagnosticsSave, (id: unknown) => {
		if (typeof id !== "string") throw new Error("Bad request");
		return saveDiagnostics(id);
	});
	handle(IPC.diagnosticsDiscard, (id: unknown) => {
		if (typeof id !== "string") throw new Error("Bad request");
		discardDiagnostics(id);
	});
	handle(IPC.releaseNotes, () => releaseNotes());
}

/**
 * Backup and restore, in main. Refused in try-it mode: a backup would hold the sample data, a
 * restore would replace it.
 */
function registerBackupIpc() {
	handle(IPC.backupSave, () =>
		mainState.demo
			? { status: "failed" as const, error: DEMO_REFUSAL }
			: saveBackup(),
	);
	handle(IPC.backupCheck, () =>
		mainState.demo
			? { status: "refused" as const, error: DEMO_REFUSAL }
			: checkBackup(),
	);
	handle(IPC.backupDiscard, (id: unknown) => {
		if (typeof id !== "string") throw new Error("Bad request");
		discardBackup(id);
	});
	handle(IPC.backupRestore, (id: unknown) => {
		if (typeof id !== "string") throw new Error("Bad request");
		if (mainState.demo)
			return { status: "failed" as const, error: DEMO_REFUSAL };
		return restoreBackup(id);
	});
}

/** Try-it mode: whether it runs, and the switch both ways (main/demo-actions.ts). */
function registerDemoIpc() {
	handle(IPC.demoState, () => demoStatus());
	handle(IPC.demoEnter, () => switchDemo(true));
	handle(IPC.demoLeave, () => switchDemo(false));
}

export function registerIpc() {
	registerDemoIpc();
	handle(
		IPC.info,
		(): AppInfo => ({
			name: app.getName(),
			version: app.getVersion(),
			electron: process.versions.electron,
			chrome: process.versions.chrome,
			node: process.versions.node,
			arch: process.arch,
			userData: app.getPath("userData"),
		}),
	);
	handle(IPC.updateState, () => mainState.updates.get());
	// Try-it mode makes no network call: Updates itself refuses while suspended.
	handle(IPC.updateCheck, () => mainState.updates.check());
	handle(IPC.updateInstall, () => mainState.updates.install());
	// The page that asked is told when a link is refused (try-it mode): main/external-links.ts.
	ipcMain.handle(IPC.openExternal, async (event, url: unknown) => {
		if (!isAppSender(event)) throw new Error("Refused: not the app's window");
		if (typeof url !== "string" || !/^https?:\/\//.test(url))
			throw new Error("Only web links open outside the app");
		await openExternalLink(url, event.sender);
	});
	const tempFile = async (name: string, bytes: Uint8Array) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offerfinch-"));
		const file = path.join(dir, name.replace(/[^\w.-]+/g, "_"));
		await fs.promises.writeFile(file, bytes);
		return file;
	};
	handle(IPC.openDocument, async (documentId: unknown) => {
		if (typeof documentId !== "string") throw new Error("Bad id");
		const file = await mainState.worker.request<{
			name: string;
			bytes: Uint8Array;
		}>("fileBytes", documentId);
		const opened = await shell.openPath(await tempFile(file.name, file.bytes));
		if (opened) throw new Error(opened);
	});
	handle(IPC.saveDocument, async (documentId: unknown) => {
		if (typeof documentId !== "string") throw new Error("Bad id");
		const file = await mainState.worker.request<{
			name: string;
			bytes: Uint8Array;
		}>("fileBytes", documentId);
		const target = await dialog.showSaveDialog({
			defaultPath: path.join(app.getPath("downloads"), file.name),
		});
		if (target.canceled || !target.filePath) return false;
		await fs.promises.writeFile(target.filePath, file.bytes);
		return true;
	});
	handle(IPC.openProof, async (attemptId: unknown, which: unknown) => {
		if (typeof attemptId !== "string" || !isProofShot(which))
			throw new Error("Bad request");
		const file = await mainState.worker.request<{
			name: string;
			bytes: Uint8Array;
		}>("proofBytes", attemptId, which);
		await shell.openPath(await tempFile(file.name, file.bytes));
	});
	registerProofImageIpc();
	handle(IPC.saveDataExport, async () => {
		const target = await dialog.showSaveDialog({
			defaultPath: path.join(
				app.getPath("downloads"),
				`offerfinch-export-${new Date().toISOString().slice(0, 10)}.json`,
			),
		});
		if (target.canceled || !target.filePath) return false;
		const json = await mainState.worker.request<string>("dataExport");
		await fs.promises.writeFile(target.filePath, json, { mode: 0o600 });
		return true;
	});
	registerBackupIpc();
	handle(IPC.saveInterviewEvent, saveInterviewEvent);
	registerDiagnosticsIpc();
	handle(IPC.openLoginItems, async () => {
		if (TEST_MODE) return;
		await shell.openExternal(
			process.platform === "win32"
				? "ms-settings:startupapps"
				: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
		);
	});
	handle(IPC.loginGet, () => loginItemState());
	handle(IPC.loginSet, (open: unknown) => {
		if (typeof open !== "boolean") throw new Error("Bad request");
		if (mainState.demo) throw new Error(DEMO_REFUSAL);
		if (!TEST_MODE)
			app.setLoginItemSettings({
				openAtLogin: open,
				...(process.platform === "win32" ? { args: ["--hidden"] } : {}),
			});
		return loginItemState();
	});
	handle(IPC.contextMenu, (items: unknown) => contextMenu(items));
	handle(IPC.clipboardLink, async () => {
		const text = (await clipboard.readText()).trim();
		return /^https?:\/\/\S+$/i.test(text) && text.length <= 2000 ? text : null;
	});
	handle(IPC.copyText, (text: unknown) => {
		if (typeof text !== "string" || text.length > 1_000_000)
			throw new Error("Bad request");
		clipboard.writeText(text);
	});
	handle(IPC.notifyTest, async () => {
		if (mainState.demo) throw new Error(DEMO_REFUSAL);
		await mainState.notifier.show({
			title: "Notifications are on",
			body: "You'll hear about strong matches, questions and applications ready for review.",
			path: "/settings/notifications",
		});
		if (TEST_MODE)
			testHooks.notices.push({
				title: "Notifications are on",
				body: "",
				path: "/settings/notifications",
				kind: "match",
			});
		return mainState.notifier.get();
	});
	handle(IPC.notifyState, () => mainState.notifier.get());
	handle(IPC.notifyClearMissed, () => {
		if (mainState.demo) throw new Error(DEMO_REFUSAL);
		return mainState.notifier.clearMissed();
	});
	handle(IPC.notifySetSound, (sound: unknown) => {
		if (!NOTIFICATION_SOUNDS.includes(sound as NotificationSound))
			throw new Error("Bad request");
		if (mainState.demo) throw new Error(DEMO_REFUSAL);
		return mainState.notifier.setSound(sound as NotificationSound);
	});
	handle(IPC.notifyChirp, () => {
		const played = mainState.notifier.chirp();
		if (TEST_MODE && played) testHooks.chirps.push(Date.now());
		return played;
	});
	handle(IPC.notifyOpenSettings, async () => {
		if (TEST_MODE) return;
		await shell.openExternal(NOTIFICATION_SETTINGS_URL);
	});
	handle(IPC.siteShow, (site: unknown, mode: unknown, bounds: unknown) => {
		if (
			!isSiteTabId(site) ||
			(mode !== "sign-in" && mode !== "live") ||
			typeof bounds !== "object" ||
			bounds === null
		)
			throw new Error("Bad request");
		// Try-it mode opens no site: a sign-in would reach the real one.
		if (mainState.demo) throw new Error(DEMO_REFUSAL);
		const win = mainState.mainWindow;
		if (!win || win.isDestroyed()) throw new Error("No window");
		return mainState.sites.show(site, mode, win, bounds as never);
	});
	handle(IPC.siteHide, (site: unknown) => {
		if (!isSiteTabId(site)) throw new Error("Bad request");
		mainState.sites.hide(site);
	});
	ipcMain.on(IPC.siteBounds, (event, site: unknown, bounds: unknown) => {
		if (!event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`)) return;
		if (!isSiteTabId(site) || typeof bounds !== "object" || bounds === null)
			return;
		mainState.sites.setBounds(site, bounds as never);
	});
	ipcMain.on(IPC.rpcConnect, (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || !event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`)) return;
		connectRenderer(win);
	});
}

/** Proof screenshots for the application page: a thumbnail, or the full page as stored. */
function registerProofImageIpc() {
	handle(
		IPC.proofImage,
		async (attemptId: unknown, which: unknown, size: unknown) => {
			if (typeof attemptId !== "string" || !isProofShot(which))
				throw new Error("Bad request");
			const file = await mainState.worker.request<{
				name: string;
				bytes: Uint8Array;
			}>("proofBytes", attemptId, which);
			const image = nativeImage.createFromBuffer(Buffer.from(file.bytes));
			if (image.isEmpty()) throw new Error("The screenshot could not be read");
			// Full-page shots run long: the thumbnail keeps the top at a readable width.
			return (
				size === "thumb" && image.getSize().width > 480
					? image.resize({ width: 480, quality: "good" })
					: image
			).toDataURL();
		},
	);
}
